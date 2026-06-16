import {
  PanTool,
  WindowLevelTool,
  SegmentBidirectionalTool,
  StackScrollTool,
  VolumeRotateTool,
  ZoomTool,
  MIPJumpToClickTool,
  LengthTool,
  RectangleROITool,
  RectangleROIThresholdTool,
  EllipticalROITool,
  CircleROITool,
  BidirectionalTool,
  ArrowAnnotateTool,
  DragProbeTool,
  ProbeTool,
  AngleTool,
  CobbAngleTool,
  MagnifyTool,
  CrosshairsTool,
  RectangleScissorsTool,
  SphereScissorsTool,
  CircleScissorsTool,
  BrushTool,
  PaintFillTool,
  init,
  addTool,
  annotation,
  segmentation,
  ReferenceLinesTool,
  TrackballRotateTool,
  AdvancedMagnifyTool,
  UltrasoundDirectionalTool,
  UltrasoundPleuraBLineTool,
  PlanarFreehandROITool,
  PlanarFreehandContourSegmentationTool,
  SplineROITool,
  LivewireContourTool,
  OrientationMarkerTool,
  WindowLevelRegionTool,
  SegmentSelectTool,
  RegionSegmentPlusTool,
  SegmentLabelTool,
  LivewireContourSegmentationTool,
  SculptorTool,
  SplineContourSegmentationTool,
  LabelMapEditWithContourTool,
} from '@cornerstonejs/tools';
import { cache, metaData, StackViewport, utilities as csUtils } from '@cornerstonejs/core';
import {
  LabelmapSlicePropagationTool,
  MarkerLabelmapTool,
  ONNXSegmentationController,
} from '@cornerstonejs/ai';
import ort from 'onnxruntime-web/webgpu';
import * as polySeg from '@cornerstonejs/polymorphic-segmentation';

import CalibrationLineTool from './tools/CalibrationLineTool';
import ImageOverlayViewerTool from './tools/ImageOverlayViewerTool';

const publicUrl = process.env.PUBLIC_URL || '/';
const ortWasmBasePath = `${publicUrl.replace(/\/?$/, '/')}ort/`;
const originalGetOnnxConfig = ONNXSegmentationController.prototype.getConfig;
const originalOnnxInitViewport = ONNXSegmentationController.prototype.initViewport;
const originalCreateOnnxLabelmap = ONNXSegmentationController.prototype.createLabelmap;
const { triggerSegmentationDataModified } = segmentation.triggerSegmentationEvents;
const { transformIndexToWorld } = csUtils;
const EPSILON = 1e-3;
const MARKER_OBLIQUE_SLAB_PADDING_MM = 0.25;

const patchStackViewportSlabThicknessForCrosshairs = () => {
  const prototype = StackViewport?.prototype;

  if (!prototype) {
    return;
  }

  if (!prototype.getSlabThickness) {
    prototype.getSlabThickness = () => 0;
  }

  if (!prototype.setSlabThickness) {
    prototype.setSlabThickness = () => {};
  }

  if (!prototype.resetSlabThickness) {
    prototype.resetSlabThickness = () => {};
  }
};

const forceMarkerVolumeLabelmapActorModified = preview => {
  const viewport = preview?.viewport;
  const segmentationId = preview?.segmentationId;
  const volumeId = preview?.volumeId;

  if (!viewport || !segmentationId || !volumeId) {
    return { updatedVolumeLabelmapActor: false };
  }

  const actors = viewport.getActors?.() || [];
  const labelmapActors = actors.filter(
    actorEntry =>
      actorEntry.representationUID?.startsWith(`${segmentationId}-Labelmap`) &&
      actorEntry.referencedId === volumeId
  );

  for (const actorEntry of labelmapActors) {
    const actor = actorEntry.actor;
    const mapper = actor?.getMapper?.();
    const inputData = mapper?.getInputData?.();

    inputData?.modified?.();
    mapper?.modified?.();
    actor?.modified?.();
    actor?.getProperty?.()?.modified?.();
    actor?.setVisibility?.(true);
  }

  return labelmapActors.length > 0;
};

const normalizeMarkerVector = vector => {
  const length = Math.hypot(vector?.[0] || 0, vector?.[1] || 0, vector?.[2] || 0);

  if (!Number.isFinite(length) || length < EPSILON) {
    return null;
  }

  return [vector[0] / length, vector[1] / length, vector[2] / length];
};

const dotMarker = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const subtractMarker = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

const crossMarker = (a, b) =>
  normalizeMarkerVector([
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]);

const asMarkerNumberArray = value => {
  if (!value) {
    return [];
  }

  return Array.isArray(value) ? value.map(Number) : String(value).split('\\').map(Number);
};

const getMarkerDrawingPlaneInfo = viewport => {
  const referenceData = viewport?.getImagePlaneReferenceData?.();
  const imageId = referenceData?.referencedImageId || viewport?.getCurrentImageId?.();
  const imagePlaneModule = imageId ? metaData.get('imagePlaneModule', imageId) : null;

  return {
    imageId,
    imagePlaneModule,
  };
};

const getMarkerSliceSpacingMm = viewport => {
  const { imageId, imagePlaneModule } = getMarkerDrawingPlaneInfo(viewport);
  const image = imageId ? cache.getImage(imageId) : null;
  const spacingBetweenSlices =
    Number(imagePlaneModule?.spacingBetweenSlices) || Number(image?.spacingBetweenSlices);
  const sliceThickness = Number(imagePlaneModule?.sliceThickness) || Number(image?.sliceThickness);

  if (spacingBetweenSlices > EPSILON) {
    return spacingBetweenSlices;
  }

  if (sliceThickness > EPSILON) {
    return sliceThickness;
  }

  return 1;
};

const expandMarkerBounds = (boundsIJK, dimensions, amount = 2) => {
  if (!boundsIJK || !dimensions) {
    return boundsIJK;
  }

  return boundsIJK.map(([min, max], axis) => [
    Math.max(0, Math.floor(min - amount)),
    Math.min(dimensions[axis] - 1, Math.ceil(max + amount)),
  ]);
};

const createEmptyMarkerBounds = () => [
  [Infinity, -Infinity],
  [Infinity, -Infinity],
  [Infinity, -Infinity],
];

const addPointToMarkerBounds = (boundsIJK, pointIJK) => {
  for (let axis = 0; axis < 3; axis++) {
    boundsIJK[axis][0] = Math.min(boundsIJK[axis][0], pointIJK[axis]);
    boundsIJK[axis][1] = Math.max(boundsIJK[axis][1], pointIJK[axis]);
  }
};

const hasValidMarkerBounds = boundsIJK =>
  boundsIJK?.every(([min, max]) => Number.isFinite(min) && Number.isFinite(max) && min <= max);

const applyMarkerMaskAsObliqueSlab = (preview, mask, canvasPosition, pCutoff) => {
  const sourceVoxelManager = preview?.segmentationVoxelManager;
  const targetVoxelManager = preview?.memo?.voxelManager;
  const segmentationImageData = preview?.segmentationImageData;
  const { origin, rightVector, downVector } = canvasPosition || {};

  if (
    !sourceVoxelManager ||
    !targetVoxelManager ||
    !segmentationImageData ||
    !mask?.data ||
    !origin ||
    !rightVector ||
    !downVector
  ) {
    return null;
  }

  const normal = crossMarker(rightVector, downVector);
  const rightLengthSquared = dotMarker(rightVector, rightVector);
  const downLengthSquared = dotMarker(downVector, downVector);

  if (!normal || rightLengthSquared < EPSILON || downLengthSquared < EPSILON) {
    return null;
  }

  const spacing = segmentationImageData.getSpacing?.() || [1, 1, 1];
  const minSpacing = Math.max(Math.min(...spacing), 0.25);
  const halfThicknessMm =
    Math.max(getMarkerSliceSpacingMm(preview.viewport) / 2, minSpacing / 2, 0.5) +
    MARKER_OBLIQUE_SLAB_PADDING_MM;
  const planeOrigin = [origin[0], origin[1], origin[2]];
  const boundsIJK = createEmptyMarkerBounds();
  const worldPointJ = [0, 0, 0];
  const worldPoint = [0, 0, 0];

  for (let j = 0; j < mask.height; j++) {
    worldPointJ[0] = origin[0] + downVector[0] * j;
    worldPointJ[1] = origin[1] + downVector[1] * j;
    worldPointJ[2] = origin[2] + downVector[2] * j;

    for (let i = 0; i < mask.width; i++) {
      const maskIndex = 4 * (i + j * mask.width);

      if (mask.data[maskIndex] <= pCutoff) {
        continue;
      }

      worldPoint[0] = worldPointJ[0] + rightVector[0] * i;
      worldPoint[1] = worldPointJ[1] + rightVector[1] * i;
      worldPoint[2] = worldPointJ[2] + rightVector[2] * i;

      const ijkPoint = segmentationImageData.worldToIndex(worldPoint).map(Math.round);

      if (ijkPoint.findIndex((value, axis) => value < 0 || value >= sourceVoxelManager.dimensions[axis]) !== -1) {
        continue;
      }

      addPointToMarkerBounds(boundsIJK, ijkPoint);
    }
  }

  if (!hasValidMarkerBounds(boundsIJK)) {
    return null;
  }

  const expandedBoundsIJK = expandMarkerBounds(
    boundsIJK,
    sourceVoxelManager.dimensions,
    Math.ceil(halfThicknessMm / minSpacing) + 2
  );
  const changedSlices = new Set();

  sourceVoxelManager.forEach(
    ({ index, pointIJK, pointLPS }) => {
      const world = pointLPS || transformIndexToWorld(segmentationImageData, pointIJK);
      const delta = subtractMarker(world, planeOrigin);
      const signedPlaneDistance = dotMarker(delta, normal);
      const existingValue = sourceVoxelManager.getAtIndex(index);

      if (existingValue === preview.previewSegmentIndex) {
        targetVoxelManager.setAtIJKPoint(pointIJK, null);
      }

      if (Math.abs(signedPlaneDistance) > halfThicknessMm + EPSILON) {
        return;
      }

      const projected = [
        world[0] - normal[0] * signedPlaneDistance,
        world[1] - normal[1] * signedPlaneDistance,
        world[2] - normal[2] * signedPlaneDistance,
      ];
      const projectedDelta = subtractMarker(projected, planeOrigin);
      const maskX = Math.round(dotMarker(projectedDelta, rightVector) / rightLengthSquared);
      const maskY = Math.round(dotMarker(projectedDelta, downVector) / downLengthSquared);

      if (maskX < 0 || maskX >= mask.width || maskY < 0 || maskY >= mask.height) {
        return;
      }

      const maskIndex = 4 * (maskX + maskY * mask.width);

      if (mask.data[maskIndex] <= pCutoff) {
        return;
      }

      targetVoxelManager.setAtIJKPoint(pointIJK, preview.previewSegmentIndex);
      changedSlices.add(pointIJK[2]);
    },
    {
      imageData: segmentationImageData,
      boundsIJK: expandedBoundsIJK,
    }
  );

  return {
    changedSlices: Array.from(changedSlices),
  };
};

const markMarkerLabelmapImageDataModified = (preview, modifiedSlices) => {
  preview?.segmentationImageData?.modified?.();

  const volumeId = preview?.volumeId;
  const segmentationVolume = volumeId ? cache.getVolume(volumeId) : null;

  if (!segmentationVolume) {
    return;
  }

  const dimensions = segmentationVolume.imageData?.getDimensions?.();
  const numberOfSlices = dimensions?.[2] || segmentationVolume.dimensions?.[2] || 0;

  if (segmentationVolume.invalidate) {
    segmentationVolume.invalidate();
  } else {
    for (let sliceIndex = 0; sliceIndex < numberOfSlices; sliceIndex++) {
      segmentationVolume.vtkOpenGLTexture?.setUpdatedFrame?.(sliceIndex);
    }

    segmentationVolume.imageData?.modified?.();
    segmentationVolume.vtkOpenGLTexture?.modified?.();
  }

  segmentationVolume.modified?.();
};

ONNXSegmentationController.prototype.getConfig = function patchedGetConfig(modelName) {
  const config = originalGetOnnxConfig.call(this, modelName);

  config.threads = 1;
  ort.env.wasm.wasmPaths = ortWasmBasePath;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = config.provider === 'wasm';

  return config;
};

ONNXSegmentationController.prototype.initViewport = function patchedInitViewport(viewport) {
  const isSameViewport = this.viewport === viewport;

  if (!isSameViewport || !this.tool) {
    originalOnnxInitViewport.call(this, viewport);
  }

  this.getPromptAnnotations = (annotationViewport = this.viewport) => {
    const { element } = annotationViewport;
    const annotations = [];

    for (const annotationName of this.promptAnnotationTypes) {
      annotations.push(...annotation.state.getAnnotations(annotationName, element));
    }

    return annotations;
  };
};

ONNXSegmentationController.prototype.createLabelmap = function patchedCreateLabelmap(...args) {
  const previousAutoSegmentMode = this._autoSegmentMode;
  const previousIslandFillOptions = this.islandFillOptions;
  const [mask] = args;

  this._autoSegmentMode = false;
  this.islandFillOptions = null;

  try {
    const result = originalCreateOnnxLabelmap.apply(this, args);
    const preview = this.tool?._previewData?.preview;
    const hasPreview = !!preview;
    const modifiedSlices = preview?.memo?.voxelManager?.getArrayOfModifiedSlices?.() || [];

    if (hasPreview) {
      const obliqueSlabResult = applyMarkerMaskAsObliqueSlab(preview, mask, args[1], this.pCutoff);
      modifiedSlices.splice(
        0,
        modifiedSlices.length,
        ...(obliqueSlabResult?.changedSlices || modifiedSlices)
      );
      this.tool.acceptPreview(this.viewport.element);
      markMarkerLabelmapImageDataModified(preview, modifiedSlices);
      forceMarkerVolumeLabelmapActorModified(preview);

      if (modifiedSlices?.length) {
        triggerSegmentationDataModified(preview.segmentationId, modifiedSlices, preview.segmentIndex);
      }

      this.viewport.render?.();
    }
    return result;
  } finally {
    this._autoSegmentMode = previousAutoSegmentMode;
    this.islandFillOptions = previousIslandFillOptions;
  }
};

export default function initCornerstoneTools(configuration = {}) {
  patchStackViewportSlabThicknessForCrosshairs();

  CrosshairsTool.isAnnotation = false;
  LabelmapSlicePropagationTool.isAnnotation = false;
  MarkerLabelmapTool.isAnnotation = false;
  ReferenceLinesTool.isAnnotation = false;
  AdvancedMagnifyTool.isAnnotation = false;
  PlanarFreehandContourSegmentationTool.isAnnotation = false;

  init({
    addons: {
      polySeg,
    },
    computeWorker: {
      autoTerminateOnIdle: {
        enabled: false,
      },
    },
  });
  addTool(PanTool);
  addTool(SegmentBidirectionalTool);
  addTool(WindowLevelTool);
  addTool(StackScrollTool);
  addTool(VolumeRotateTool);
  addTool(ZoomTool);
  addTool(ProbeTool);
  addTool(MIPJumpToClickTool);
  addTool(LengthTool);
  addTool(RectangleROITool);
  addTool(RectangleROIThresholdTool);
  addTool(EllipticalROITool);
  addTool(CircleROITool);
  addTool(BidirectionalTool);
  addTool(ArrowAnnotateTool);
  addTool(DragProbeTool);
  addTool(AngleTool);
  addTool(CobbAngleTool);
  addTool(MagnifyTool);
  addTool(CrosshairsTool);
  addTool(RectangleScissorsTool);
  addTool(SphereScissorsTool);
  addTool(CircleScissorsTool);
  addTool(BrushTool);
  addTool(PaintFillTool);
  addTool(ReferenceLinesTool);
  addTool(CalibrationLineTool);
  addTool(TrackballRotateTool);
  addTool(ImageOverlayViewerTool);
  addTool(AdvancedMagnifyTool);
  addTool(UltrasoundDirectionalTool);
  addTool(UltrasoundPleuraBLineTool);
  addTool(PlanarFreehandROITool);
  addTool(SplineROITool);
  addTool(LivewireContourTool);
  addTool(OrientationMarkerTool);
  addTool(WindowLevelRegionTool);
  addTool(PlanarFreehandContourSegmentationTool);
  addTool(SegmentSelectTool);
  addTool(SegmentLabelTool);
  addTool(LabelmapSlicePropagationTool);
  addTool(MarkerLabelmapTool);
  addTool(RegionSegmentPlusTool);
  addTool(LivewireContourSegmentationTool);
  addTool(SculptorTool);
  addTool(SplineContourSegmentationTool);
  addTool(LabelMapEditWithContourTool);
  // Modify annotation tools to use dashed lines on SR
  const annotationStyle = {
    textBoxFontSize: '15px',
    lineWidth: '1.5',
  };

  const defaultStyles = annotation.config.style.getDefaultToolStyles();
  annotation.config.style.setDefaultToolStyles({
    global: {
      ...defaultStyles.global,
      ...annotationStyle,
    },
  });
}

const toolNames = {
  Pan: PanTool.toolName,
  ArrowAnnotate: ArrowAnnotateTool.toolName,
  WindowLevel: WindowLevelTool.toolName,
  StackScroll: StackScrollTool.toolName,
  Zoom: ZoomTool.toolName,
  VolumeRotate: VolumeRotateTool.toolName,
  MipJumpToClick: MIPJumpToClickTool.toolName,
  Length: LengthTool.toolName,
  DragProbe: DragProbeTool.toolName,
  Probe: ProbeTool.toolName,
  RectangleROI: RectangleROITool.toolName,
  RectangleROIThreshold: RectangleROIThresholdTool.toolName,
  EllipticalROI: EllipticalROITool.toolName,
  CircleROI: CircleROITool.toolName,
  Bidirectional: BidirectionalTool.toolName,
  Angle: AngleTool.toolName,
  CobbAngle: CobbAngleTool.toolName,
  Magnify: MagnifyTool.toolName,
  Crosshairs: CrosshairsTool.toolName,
  Brush: BrushTool.toolName,
  PaintFill: PaintFillTool.toolName,
  ReferenceLines: ReferenceLinesTool.toolName,
  CalibrationLine: CalibrationLineTool.toolName,
  TrackballRotateTool: TrackballRotateTool.toolName,
  CircleScissors: CircleScissorsTool.toolName,
  RectangleScissors: RectangleScissorsTool.toolName,
  SphereScissors: SphereScissorsTool.toolName,
  ImageOverlayViewer: ImageOverlayViewerTool.toolName,
  AdvancedMagnify: AdvancedMagnifyTool.toolName,
  UltrasoundDirectional: UltrasoundDirectionalTool.toolName,
  UltrasoundAnnotation: UltrasoundPleuraBLineTool.toolName,
  SplineROI: SplineROITool.toolName,
  LivewireContour: LivewireContourTool.toolName,
  PlanarFreehandROI: PlanarFreehandROITool.toolName,
  OrientationMarker: OrientationMarkerTool.toolName,
  WindowLevelRegion: WindowLevelRegionTool.toolName,
  PlanarFreehandContourSegmentation: PlanarFreehandContourSegmentationTool.toolName,
  SegmentBidirectional: SegmentBidirectionalTool.toolName,
  SegmentSelect: SegmentSelectTool.toolName,
  SegmentLabel: SegmentLabelTool.toolName,
  LabelmapSlicePropagation: LabelmapSlicePropagationTool.toolName,
  MarkerLabelmap: MarkerLabelmapTool.toolName,
  RegionSegmentPlus: RegionSegmentPlusTool.toolName,
  LivewireContourSegmentation: LivewireContourSegmentationTool.toolName,
  SculptorTool: SculptorTool.toolName,
  SplineContourSegmentation: SplineContourSegmentationTool.toolName,
  LabelMapEditWithContourTool: LabelMapEditWithContourTool.toolName,
};

export { toolNames };
