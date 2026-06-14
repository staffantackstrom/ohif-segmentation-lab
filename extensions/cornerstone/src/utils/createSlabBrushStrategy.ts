import { cache, metaData, utilities as csUtils } from '@cornerstonejs/core';
import { strategies } from '@cornerstonejs/tools/tools';
import { state, triggerSegmentationEvents } from '@cornerstonejs/tools/segmentation';

const { transformIndexToWorld } = csUtils;
const { fillInsideCircle } = strategies;
const { triggerSegmentationDataModified } = triggerSegmentationEvents;
const EPSILON = 1e-3;
const MAX_SLAB_VOXELS = 250000;

type Point3 = [number, number, number];

type DrawingPlaneInfo = {
  imageId?: string;
  imagePlaneModule?: unknown;
  normal?: Point3;
  sliceIndex?: number;
};

function asNumberArray(value): number[] {
  if (!value) {
    return [];
  }

  return Array.isArray(value) ? value.map(Number) : String(value).split('\\').map(Number);
}

function normalize(vector: number[]): Point3 | null {
  const length = Math.hypot(vector[0], vector[1], vector[2]);

  if (!Number.isFinite(length) || length < EPSILON) {
    return null;
  }

  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function toPoint3(point): Point3 | null {
  if (!point || point.length < 3) {
    return null;
  }

  return [Number(point[0]), Number(point[1]), Number(point[2])];
}

function subtract(a: Point3, b: Point3): Point3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot(a: Point3, b: Point3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function distanceSquared(a: Point3, b: Point3): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];

  return dx * dx + dy * dy + dz * dz;
}

function distance(a: Point3, b: Point3): number {
  return Math.sqrt(distanceSquared(a, b));
}

function getBrushRadiusMm(result): number {
  const points = result?.points || [];
  const first = toPoint3(points[0]);
  const second = toPoint3(points[1]);

  if (first && second) {
    return distance(first, second) / 2;
  }

  const center = toPoint3(result?.centerWorld);

  if (first && center) {
    return distance(first, center);
  }

  return 0;
}

function expandBounds(boundsIJK, dimensions, amount = 2) {
  if (!boundsIJK || !dimensions) {
    return boundsIJK;
  }

  return boundsIJK.map(([min, max], axis) => [
    Math.max(0, Math.floor(min - amount)),
    Math.min(dimensions[axis] - 1, Math.ceil(max + amount)),
  ]);
}

function getMetadataPlaneNormal(imagePlaneModule): Point3 | null {
  const rowCosines =
    imagePlaneModule?.rowCosines || asNumberArray(imagePlaneModule?.imageOrientationPatient).slice(0, 3);
  const columnCosines =
    imagePlaneModule?.columnCosines || asNumberArray(imagePlaneModule?.imageOrientationPatient).slice(3, 6);

  if (!rowCosines?.length || !columnCosines?.length) {
    return null;
  }

  return normalize([
    rowCosines[1] * columnCosines[2] - rowCosines[2] * columnCosines[1],
    rowCosines[2] * columnCosines[0] - rowCosines[0] * columnCosines[2],
    rowCosines[0] * columnCosines[1] - rowCosines[1] * columnCosines[0],
  ]);
}

function getDrawingPlaneInfo(viewport): DrawingPlaneInfo {
  const referenceData = viewport?.getImagePlaneReferenceData?.();
  const imageId = referenceData?.referencedImageId || viewport?.getCurrentImageId?.();
  const imagePlaneModule = imageId ? metaData.get('imagePlaneModule', imageId) : null;
  const referenceNormal = referenceData?.viewPlaneNormal
    ? normalize(referenceData.viewPlaneNormal)
    : null;
  const metadataNormal = getMetadataPlaneNormal(imagePlaneModule);
  const cameraNormal = viewport?.getCamera?.()?.viewPlaneNormal;
  const normal = referenceNormal || metadataNormal || (cameraNormal ? normalize(cameraNormal) : null);

  return {
    imageId,
    imagePlaneModule,
    normal,
    sliceIndex: Number.isFinite(referenceData?.sliceIndex)
      ? referenceData.sliceIndex
      : viewport?.getCurrentImageIdIndex?.(),
  };
}

function isDebugSlabBrushEnabled(): boolean {
  try {
    return window?.localStorage?.getItem('debugSlabBrush') === 'true';
  } catch {
    return false;
  }
}

function getSliceSpacingMm(viewport, planeInfo: DrawingPlaneInfo): number {
  const { imageId: currentImageId, imagePlaneModule, normal } = planeInfo;

  if (!normal) {
    return 1;
  }

  const image = currentImageId ? cache.getImage(currentImageId) : null;
  const spacingBetweenSlices =
    Number(imagePlaneModule?.spacingBetweenSlices) || Number(image?.spacingBetweenSlices);
  const sliceThickness = Number(imagePlaneModule?.sliceThickness) || Number(image?.sliceThickness);

  if (spacingBetweenSlices > EPSILON) {
    return spacingBetweenSlices;
  }

  if (sliceThickness > EPSILON) {
    return sliceThickness;
  }

  const imageIds = viewport.getImageIds?.() || [];
  const currentIndex = planeInfo.sliceIndex;
  const currentPosition = toPoint3(asNumberArray(imagePlaneModule?.imagePositionPatient));

  if (imageIds.length > 1 && currentPosition && Number.isFinite(currentIndex)) {
    const neighborSpacings = [currentIndex - 1, currentIndex + 1]
      .map(index => imageIds[index])
      .filter(Boolean)
      .map(imageId => toPoint3(asNumberArray(metaData.get('imagePlaneModule', imageId)?.imagePositionPatient)))
      .filter(Boolean)
      .map(position =>
        Math.abs(
          (position[0] - currentPosition[0]) * normal[0] +
            (position[1] - currentPosition[1]) * normal[1] +
            (position[2] - currentPosition[2]) * normal[2]
        )
      )
      .filter(spacing => Number.isFinite(spacing) && spacing > EPSILON);

    if (neighborSpacings.length) {
      return Math.min(...neighborSpacings);
    }
  }

  return 1;
}

function getNearestStrokeDistanceSquared(point: Point3, centers: Point3[]): number {
  if (centers.length === 1) {
    return distanceSquared(point, centers[0]);
  }

  let nearestDistanceSquared = Infinity;

  for (let index = 1; index < centers.length; index++) {
    const start = centers[index - 1];
    const end = centers[index];
    const vector = subtract(end, start);
    const lengthSquared = dot(vector, vector);

    if (lengthSquared < EPSILON) {
      nearestDistanceSquared = Math.min(nearestDistanceSquared, distanceSquared(point, start));
      continue;
    }

    const t = Math.max(0, Math.min(1, dot(subtract(point, start), vector) / lengthSquared));
    const projection: Point3 = [
      start[0] + vector[0] * t,
      start[1] + vector[1] * t,
      start[2] + vector[2] * t,
    ];

    nearestDistanceSquared = Math.min(nearestDistanceSquared, distanceSquared(point, projection));
  }

  return nearestDistanceSquared;
}

function createPlanarBrushPredicate(result, normal: Point3, planeToleranceMm?: number) {
  const radiusMm = getBrushRadiusMm(result);
  const radiusSquared = radiusMm * radiusMm;
  const centers = (result?.strokePointsWorld?.length ? result.strokePointsWorld : [result?.centerWorld])
    .map(toPoint3)
    .filter(Boolean) as Point3[];

  if (!centers.length || radiusMm <= 0) {
    return null;
  }

  const spacing = result.segmentationImageData?.getSpacing?.() || [1, 1, 1];
  const toleranceMm = planeToleranceMm ?? Math.max(Math.min(...spacing) / 2, 0.5);
  const planeOrigin = centers[0];

  return (pointLPS, pointIJK) => {
    const worldPoint = toPoint3(pointLPS) || transformIndexToWorld(result.segmentationImageData, pointIJK);

    if (!worldPoint) {
      return false;
    }

    const signedPlaneDistance = dot(subtract(worldPoint as Point3, planeOrigin), normal);

    if (Math.abs(signedPlaneDistance) > toleranceMm) {
      return false;
    }

    const nearestDistanceSquared = getNearestStrokeDistanceSquared(worldPoint as Point3, centers);

    return nearestDistanceSquared - signedPlaneDistance * signedPlaneDistance <= radiusSquared + EPSILON;
  };
}

function getBrushBoundsExpansion(result, extraMm = 0): number {
  const spacing = result.segmentationImageData?.getSpacing?.() || [1, 1, 1];
  const minSpacing = Math.max(Math.min(...spacing), 0.25);

  return Math.max(2, Math.ceil((getBrushRadiusMm(result) + extraMm) / minSpacing));
}

function fillPlanarBrushSlab(operationData, result, normal: Point3, halfThicknessMm: number, changedSlices) {
  const sourceVoxelManager = result?.segmentationVoxelManager;
  const targetVoxelManager = result?.memo?.voxelManager;

  if (
    !sourceVoxelManager ||
    !targetVoxelManager ||
    !result?.isInObjectBoundsIJK ||
    !result?.segmentationImageData
  ) {
    return 0;
  }

  const isInSlab = createPlanarBrushPredicate(
    result,
    normal,
    halfThicknessMm + EPSILON
  );

  if (!isInSlab) {
    return 0;
  }

  const lockedSegments = operationData.segmentsLocked || [];
  const boundsIJK = expandBounds(
    result.isInObjectBoundsIJK,
    sourceVoxelManager.dimensions,
    getBrushBoundsExpansion(result, halfThicknessMm)
  );
  let changedVoxelCount = 0;

  sourceVoxelManager.forEach(({ index, pointIJK }) => {
    const existingValue = sourceVoxelManager.getAtIndex(index);

    if (!lockedSegments.includes(existingValue)) {
      targetVoxelManager.setAtIJKPoint(pointIJK, operationData.segmentIndex);
      changedSlices.add(pointIJK[2]);
      changedVoxelCount++;
    }
  }, {
    imageData: result.segmentationImageData,
    isInObject: isInSlab,
    boundsIJK,
  });

  return changedVoxelCount;
}

function restoreNativeBrushOutsideSlab(operationData, result, normal: Point3, halfThicknessMm: number, changedSlices) {
  const sourceVoxelManager = result?.segmentationVoxelManager;
  const targetVoxelManager = result?.memo?.voxelManager;

  if (
    !sourceVoxelManager ||
    !targetVoxelManager ||
    !result?.isInObject ||
    !result?.isInObjectBoundsIJK ||
    !result?.segmentationImageData
  ) {
    return;
  }

  const desiredSlabPredicate = createPlanarBrushPredicate(
    result,
    normal,
    halfThicknessMm + EPSILON
  );

  if (!desiredSlabPredicate) {
    return;
  }

  const boundsIJK = expandBounds(
    result.isInObjectBoundsIJK,
    sourceVoxelManager.dimensions,
    getBrushBoundsExpansion(result, halfThicknessMm)
  );

  sourceVoxelManager.forEach(({ index, pointIJK, pointLPS }) => {
    if (sourceVoxelManager.getAtIndex(index) !== operationData.segmentIndex) {
      return;
    }

    if (desiredSlabPredicate(pointLPS, pointIJK)) {
      return;
    }

    targetVoxelManager.setAtIJKPoint(pointIJK, null);
    changedSlices.add(pointIJK[2]);
  }, {
    imageData: result.segmentationImageData,
    isInObject: result.isInObject,
    boundsIJK,
  });
}

function propagateModifiedPointsThroughSlab(operationData, result) {
  const segmentation = state.getSegmentation(operationData.segmentationId);

  if (!segmentation?.cachedStats?.isIsotropicLabelmap) {
    return;
  }

  const viewport = result?.viewport;
  const planeInfo = getDrawingPlaneInfo(viewport);
  const normal = planeInfo.normal;

  if (!normal) {
    return;
  }

  const spacingMm = getSliceSpacingMm(viewport, planeInfo);
  const halfThicknessMm = Math.max(spacingMm / 2, 0.5);
  const targetVoxelManager = result.memo?.voxelManager;
  const sourceVoxelManager = targetVoxelManager?.sourceVoxelManager;

  if (!targetVoxelManager || !sourceVoxelManager) {
    return;
  }

  const dimensions = sourceVoxelManager.dimensions;
  if (!dimensions?.[2]) {
    return;
  }

  const changedSlices = new Set<number>();

  if (isDebugSlabBrushEnabled()) {
    console.debug('[Circle slab brush]', {
      viewportId: viewport?.id,
      imageId: planeInfo.imageId,
      sliceIndex: planeInfo.sliceIndex,
      normal,
      spacingMm,
      halfThicknessMm,
      sliceThickness: planeInfo.imagePlaneModule?.sliceThickness,
      spacingBetweenSlices: planeInfo.imagePlaneModule?.spacingBetweenSlices,
      imagePositionPatient: planeInfo.imagePlaneModule?.imagePositionPatient,
      brushRadiusMm: getBrushRadiusMm(result),
    });
  }

  restoreNativeBrushOutsideSlab(operationData, result, normal, halfThicknessMm, changedSlices);
  const changedVoxelCount = fillPlanarBrushSlab(operationData, result, normal, halfThicknessMm, changedSlices);

  if (changedVoxelCount > MAX_SLAB_VOXELS) {
    console.warn(`Circle slab brush modified ${changedVoxelCount} voxels; this is unexpectedly large.`);
  }

  if (changedSlices.size) {
    triggerSegmentationDataModified(
      operationData.segmentationId,
      Array.from(changedSlices),
      operationData.segmentIndex
    );
  }
}

function fillInsideCircleWithSliceSlabStrategy(enabledElement, operationData) {
  if (!operationData?.points?.length) {
    return fillInsideCircle(enabledElement, operationData);
  }

  const result = fillInsideCircle(enabledElement, operationData);

  if (result) {
    propagateModifiedPointsThroughSlab(operationData, result);
  }

  return result;
}

export const fillInsideCircleWithSliceSlab = Object.assign(
  fillInsideCircleWithSliceSlabStrategy,
  fillInsideCircle
);
