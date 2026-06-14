import { CustomDropdownMenuContent } from './CustomDropdownMenuContent';
import { CustomSegmentStatisticsHeader } from './CustomSegmentStatisticsHeader';
import SegmentationToolConfig from '../components/SegmentationToolConfig';
import React from 'react';
import { SegmentationRepresentations } from '@cornerstonejs/tools/enums';

const DEFAULT_LABELMAP_SEGMENTS = {
  1: {
    label: 'Fistelgang vatska',
    active: true,
    color: [0, 255, 255, 255], // Cyan
  },
  2: {
    label: 'Fistelgang vagg',
    color: [255, 0, 0, 255], // Röd
  },
  3: {
    label: 'Inre sfinkter',
    color: [0, 120, 255, 255], // Blå
  },
  4: {
    label: 'Yttre sfinkter',
    color: [255, 215, 0, 255], // Gul
  },
  5: {
    label: 'Abscess',
    color: [255, 0, 255, 255], // Magenta
  },
  6: {
    label: 'Seton',
    color: [0, 255, 0, 255], // Grön
  },
  7: {
    label: 'Puborektalis',
    color: [255, 128, 0, 255], // Orange
  },
  8: {
    label: 'Levator ani',
    color: [128, 0, 255, 255], // Violett
  },
};

function applyDefaultLabelmapSegmentColors(segmentationService, segmentationId: string) {
  const viewportIds = segmentationService.getViewportIdsWithSegmentation(segmentationId) || [];

  viewportIds.forEach(viewportId => {
    Object.entries(DEFAULT_LABELMAP_SEGMENTS).forEach(([segmentIndex, segment]) => {
      if (segment.color) {
        segmentationService.setSegmentColor(
          viewportId,
          segmentationId,
          Number(segmentIndex),
          segment.color
        );
      }
    });
  });
}

export default function getSegmentationPanelCustomization({ commandsManager, servicesManager }) {
  const { segmentationService } = servicesManager.services;

  let contourRenderFillChangedGlobally = false;
  let isApplyingDefaultLabelmapSegmentColors = false;

  // Listen to when the global CONTOUR type renderFill style property is changed.
  const { unsubscribe } = segmentationService.subscribe(
    segmentationService.EVENTS.SEGMENTATION_STYLE_MODIFIED,
    ({ specifier, style }) => {
      if (
        specifier.type === SegmentationRepresentations.Contour &&
        specifier.segmentationId == null &&
        specifier.viewportId == null &&
        style.renderFill != null
      ) {
        unsubscribe();
        contourRenderFillChangedGlobally = true;
      }
    }
  );

  segmentationService.subscribe(
    segmentationService.EVENTS.SEGMENTATION_REPRESENTATION_MODIFIED,
    ({ segmentationId }) => {
      if (isApplyingDefaultLabelmapSegmentColors) {
        return;
      }

      isApplyingDefaultLabelmapSegmentColors = true;
      try {
        applyDefaultLabelmapSegmentColors(segmentationService, segmentationId);
      } finally {
        isApplyingDefaultLabelmapSegmentColors = false;
      }
    }
  );

  return {
    'panelSegmentation.customDropdownMenuContent': CustomDropdownMenuContent,
    'panelSegmentation.customSegmentStatisticsHeader': CustomSegmentStatisticsHeader,
    'panelSegmentation.disableEditing': false,
    'panelSegmentation.showAddSegment': true,
    'panelSegmentation.onSegmentationAdd': async ({
      segmentationRepresentationType = SegmentationRepresentations.Labelmap,
    }) => {
      const { viewportGridService } = servicesManager.services;
      const viewportId = viewportGridService.getState().activeViewportId;
      if (segmentationRepresentationType === SegmentationRepresentations.Labelmap) {
        const segmentationId = await commandsManager.run('createLabelmapForViewport', {
          viewportId,
          options: {
            segments: DEFAULT_LABELMAP_SEGMENTS,
            isotropic: {
              spacing: [1, 1, 1],
            },
          },
        });

        applyDefaultLabelmapSegmentColors(segmentationService, segmentationId);
      } else if (segmentationRepresentationType === SegmentationRepresentations.Contour) {
        const segmentationId = await commandsManager.run('createContourForViewport', {
          viewportId,
        });
        // Override the default (i.e. hydrated RTSTRUCT) style for contours if the global CONTOUR type
        // renderFill style property has not been changed.
        if (!contourRenderFillChangedGlobally) {
          segmentationService.setStyle(
            { segmentationId, type: SegmentationRepresentations.Contour },
            {
              renderFill: true,
              renderFillInactive: true,
            },
            // Do not merge so that these created contours inherit other type-specific style properties like the fill alpha.
            // Merging would otherwise permanently inherit the fill alpha and any inheritance from the type level would be lost.
            false
          );
        }

        // If the global CONTOUR type renderFill style property is already set, do not subscribe to the SEGMENTATION_STYLE_MODIFIED event.
        if (contourRenderFillChangedGlobally) {
          return;
        }

        // Subscribe to the SEGMENTATION_STYLE_MODIFIED event to listen for changes to the CONTOUR type renderFill style property.
        const { unsubscribe } = segmentationService.subscribe(
          segmentationService.EVENTS.SEGMENTATION_STYLE_MODIFIED,
          ({ specifier, style }) => {
            if (
              specifier.type === SegmentationRepresentations.Contour &&
              specifier.segmentationId == null &&
              specifier.viewportId == null &&
              style.renderFill != null
            ) {
              // We are here because the renderFill style property is globally being changed for ALL contours.
              // When this occurs, the desire is for ALL contours to inherit the property. To make this happen,
              // we have to clear the style property that was set for this specific segmentation
              // when it was created above.
              // We can now also unsubscribe because this change only needs to be made when the global CONTOUR type
              // renderFill style property is first changed.

              contourRenderFillChangedGlobally = true;
              unsubscribe();
              segmentationService.setStyle(
                { segmentationId, type: SegmentationRepresentations.Contour },
                {},
                false
              );
            }
          }
        );
      }
    },
    'panelSegmentation.tableMode': 'collapsed',
    'panelSegmentation.readableText': {
      // the values will appear in this order
      min: 'Min Value',
      minLPS: 'Min Coord',
      max: 'Max Value',
      maxLPS: 'Max Coord',
      mean: 'Mean Value',
      stdDev: 'Standard Deviation',
      count: 'Voxel Count',
      median: 'Median',
      skewness: 'Skewness',
      kurtosis: 'Kurtosis',
      peakValue: 'Peak Value',
      peakLPS: 'Peak Coord',
      volume: 'Volume',
      lesionGlycolysis: 'Lesion Glycolysis',
      center: 'Center',
    },
    'labelMapSegmentationToolbox.config': () => {
      return <SegmentationToolConfig />;
    },
    'contourSegmentationToolbox.config': () => {
      return <SegmentationToolConfig />;
    },
  };
}
