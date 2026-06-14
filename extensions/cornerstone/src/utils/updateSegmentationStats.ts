import * as cornerstoneTools from '@cornerstonejs/tools';
import { cache } from '@cornerstonejs/core';
import cloneDeep from 'lodash.clonedeep';

interface BidirectionalAxis {
  length: number;
  // Add other axis properties as needed
}

interface BidirectionalData {
  majorAxis: BidirectionalAxis;
  minorAxis: BidirectionalAxis;
}

/**
 * Updates the statistics for a segmentation by calculating stats for each segment
 * and storing them in the segment's cachedStats property
 *
 * @param segmentation - The segmentation object containing segments to update stats for
 * @param segmentationId - The ID of the segmentation
 * @returns The updated segmentation object with new stats, or null if no updates were made
 */
export async function updateSegmentationStats({
  segmentation,
  segmentationId,
  readableText,
}: {
  segmentation: any;
  segmentationId: string;
  readableText: any;
}): Promise<any | null> {
  if (!segmentation) {
    console.debug('No segmentation found for id:', segmentationId);
    return null;
  }

  const segmentIndices = Object.keys(segmentation.segments)
    .map(index => parseInt(index))
    .filter(index => index > 0); // Filter out segment 0 which is typically background

  if (segmentIndices.length === 0) {
    console.debug('No segments found in segmentation:', segmentationId);
    return null;
  }

  if (segmentation.cachedStats?.isIsotropicLabelmap) {
    return updateIsotropicLabelmapStats({
      segmentation,
      segmentIndices,
      readableText,
    });
  }

  let stats;
  try {
    stats = await cornerstoneTools.utilities.segmentation.getStatistics({
      segmentationId,
      segmentIndices,
      mode: 'individual',
    });
  } catch (error) {
    console.warn('Unable to update segmentation statistics:', error);
    return null;
  }

  if (!stats) {
    return null;
  }

  const updatedSegmentation = cloneDeep(segmentation);
  let hasUpdates = false;

  // Loop through each segment's stats
  Object.entries(stats).forEach(([segmentIndex, segmentStats]) => {
    const index = parseInt(segmentIndex);

    if (!updatedSegmentation.segments[index]) {
      // This happens when a segment is being restored
      console.warn('Segment not found to update cached stats:', index);
      return;
    }

    if (!updatedSegmentation.segments[index].cachedStats) {
      updatedSegmentation.segments[index].cachedStats = {};
      hasUpdates = true;
    }

    // Get existing namedStats or initialize if not present
    const namedStats = updatedSegmentation.segments[index].cachedStats.namedStats || {};

    if (segmentStats.array) {
      segmentStats.array.forEach(stat => {
        // only gather stats that are in the readableText
        if (!readableText[stat.name]) {
          return;
        }

        if (stat && stat.name) {
          namedStats[stat.name] = {
            name: stat.name,
            label: readableText[stat.name],
            value: stat.value,
            unit: stat.unit,
            order: Object.keys(readableText).indexOf(stat.name),
          };
        }
      });

      if (readableText.volume) {
        // Add volume if it exists but isn't in the array
        if (segmentStats.volume && !namedStats.volume) {
          namedStats.volume = {
            name: 'volume',
            label: 'Volume',
            value: segmentStats.volume.value,
            unit: segmentStats.volume.unit,
            order: Object.keys(readableText).indexOf('volume'),
          };
        }
      }

      // Update the segment's cachedStats with namedStats
      updatedSegmentation.segments[index].cachedStats.namedStats = namedStats;
      hasUpdates = true;
    }
  });

  return hasUpdates ? updatedSegmentation : null;
}

function updateIsotropicLabelmapStats({
  segmentation,
  segmentIndices,
  readableText,
}: {
  segmentation: any;
  segmentIndices: number[];
  readableText: any;
}) {
  const volumeId = segmentation.representationData?.Labelmap?.volumeId;
  const volume = volumeId ? cache.getVolume(volumeId) : null;
  const scalarData =
    volume?.voxelManager?.getCompleteScalarDataArray?.() || volume?.voxelManager?.getScalarData?.();

  if (!volume || !scalarData) {
    return null;
  }

  const updatedSegmentation = cloneDeep(segmentation);
  const voxelVolume = volume.spacing.reduce((product, value) => product * value, 1);
  let hasUpdates = false;

  segmentIndices.forEach(segmentIndex => {
    const segment = updatedSegmentation.segments[segmentIndex];

    if (!segment) {
      return;
    }

    let count = 0;
    for (let voxelIndex = 0; voxelIndex < scalarData.length; voxelIndex++) {
      if (scalarData[voxelIndex] === segmentIndex) {
        count++;
      }
    }

    segment.cachedStats ||= {};
    const namedStats = segment.cachedStats.namedStats || {};

    if (readableText.count) {
      namedStats.count = {
        name: 'count',
        label: readableText.count,
        value: count,
        unit: null,
        order: Object.keys(readableText).indexOf('count'),
      };
    }

    if (readableText.volume) {
      namedStats.volume = {
        name: 'volume',
        label: readableText.volume,
        value: count * voxelVolume,
        unit: 'mm3',
        order: Object.keys(readableText).indexOf('volume'),
      };
    }

    segment.cachedStats.namedStats = namedStats;
    hasUpdates = true;
  });

  return hasUpdates ? updatedSegmentation : null;
}

/**
 * Updates a segment's statistics with bidirectional measurement data
 *
 * @param segmentationId - The ID of the segmentation
 * @param segmentIndex - The index of the segment to update
 * @param bidirectionalData - The bidirectional measurement data to add
 * @param segmentationService - The segmentation service to use for updating the segment
 * @returns Whether the update was successful
 */
export function updateSegmentBidirectionalStats({
  segmentationId,
  segmentIndex,
  bidirectionalData,
  segmentationService,
  annotation,
}: {
  segmentationId: string;
  segmentIndex: number;
  bidirectionalData: BidirectionalData;
  segmentationService: AppTypes.SegmentationService;
  annotation: any;
}) {
  if (!segmentationId || segmentIndex === undefined || !bidirectionalData) {
    console.debug('Missing required data for bidirectional stats update');
    return null;
  }

  const segmentation = segmentationService.getSegmentation(segmentationId);
  if (!segmentation || !segmentation.segments[segmentIndex]) {
    console.debug('Segment not found:', segmentIndex, 'in segmentation:', segmentationId);
    return null;
  }

  const updatedSegmentation = { ...segmentation };
  const segment = updatedSegmentation.segments[segmentIndex];

  if (!segment.cachedStats) {
    segment.cachedStats = { namedStats: {} };
  }

  if (!segment.cachedStats.namedStats) {
    segment.cachedStats.namedStats = {};
  }

  const { majorAxis, minorAxis, maxMajor, maxMinor } = bidirectionalData;
  if (!majorAxis || !minorAxis) {
    console.debug('Missing major or minor axis data');
    return null;
  }

  let hasUpdates = false;
  const namedStats = segment.cachedStats.namedStats;

  // Only calculate and update if we have valid measurements
  if (maxMajor > 0 && maxMinor > 0) {
    namedStats.bidirectional = {
      name: 'bidirectional',
      label: 'Bidirectional',
      annotationUID: annotation.annotationUID,
      value: {
        maxMajor,
        maxMinor,
        majorAxis,
        minorAxis,
      },
      unit: 'mm',
    };

    hasUpdates = true;
  }

  if (hasUpdates) {
    return updatedSegmentation;
  }

  return null;
}
