import dcmjs from 'dcmjs';
import { classes, Types, utils } from '@ohif/core';
import { cache, metaData, utilities as csUtilities } from '@cornerstonejs/core';
import { segmentation as cornerstoneToolsSegmentation } from '@cornerstonejs/tools';
import { adaptersRT, adaptersSEG } from '@cornerstonejs/adapters';
import { createReportDialogPrompt, useUIStateStore } from '@ohif/extension-default';

import PROMPT_RESPONSES from '../../default/src/utils/_shared/PROMPT_RESPONSES';

const getTargetViewport = ({ viewportId, viewportGridService }) => {
  const { viewports, activeViewportId } = viewportGridService.getState();
  const targetViewportId = viewportId || activeViewportId;

  const viewport = viewports.get(targetViewportId);

  return viewport;
};

const {
  Cornerstone3D: {
    Segmentation: { generateSegmentation },
  },
} = adaptersSEG;

const {
  Cornerstone3D: {
    RTSS: { generateRTSSFromRepresentation },
  },
} = adaptersRT;

const { genericMetadataProvider } = csUtilities;
const { DicomMetaDictionary } = dcmjs.data;

const MR_IMAGE_STORAGE_SOP_CLASS_UID = '1.2.840.10008.5.1.4.1.1.4';

function getSourceImageIdForSegmentation(segmentation) {
  const labelmapData = segmentation.representationData?.Labelmap;
  const volume = labelmapData?.volumeId ? cache.getVolume(labelmapData.volumeId) : null;

  return (
    labelmapData?.referencedImageIds?.[0] ||
    volume?.referencedImageIds?.[0] ||
    segmentation.predecessorImageId
  );
}

function addSyntheticReferenceMetadata({
  imageId,
  sourceImageId,
  studyInstanceUID,
  seriesInstanceUID,
  frameOfReferenceUID,
  sopInstanceUID,
  instanceNumber,
  rows,
  columns,
  origin,
  spacing,
}) {
  const sourceGeneralStudy = metaData.get('generalStudyModule', sourceImageId) || {};
  const sourcePatientStudy = metaData.get('patientStudyModule', sourceImageId) || {};
  const sourcePatient = metaData.get('patientModule', sourceImageId) || {};

  genericMetadataProvider.add(imageId, {
    type: 'generalStudyModule',
    metadata: {
      ...sourceGeneralStudy,
      studyInstanceUID,
    },
  });
  genericMetadataProvider.add(imageId, {
    type: 'patientStudyModule',
    metadata: sourcePatientStudy,
  });
  genericMetadataProvider.add(imageId, {
    type: 'patientModule',
    metadata: sourcePatient,
  });
  genericMetadataProvider.add(imageId, {
    type: 'generalSeriesModule',
    metadata: {
      modality: 'MR',
      seriesInstanceUID,
      studyInstanceUID,
      seriesNumber: 50000,
      seriesDescription: 'Isotropic segmentation reference',
    },
  });
  genericMetadataProvider.add(imageId, {
    type: 'generalImageModule',
    metadata: {
      instanceNumber,
      sopInstanceUID,
    },
  });
  genericMetadataProvider.add(imageId, {
    type: 'sopCommonModule',
    metadata: {
      sopClassUID: MR_IMAGE_STORAGE_SOP_CLASS_UID,
      sopInstanceUID,
    },
  });
  genericMetadataProvider.add(imageId, {
    type: 'imagePlaneModule',
    metadata: {
      frameOfReferenceUID,
      rows,
      columns,
      imageOrientationPatient: [1, 0, 0, 0, 1, 0],
      rowCosines: [1, 0, 0],
      columnCosines: [0, 1, 0],
      imagePositionPatient: origin,
      pixelSpacing: [spacing[1], spacing[0]],
      rowPixelSpacing: spacing[1],
      columnPixelSpacing: spacing[0],
      usingDefaultValues: false,
    },
  });
  genericMetadataProvider.add(imageId, {
    type: 'imagePixelModule',
    metadata: {
      rows,
      columns,
      samplesPerPixel: 1,
      photometricInterpretation: 'MONOCHROME2',
      bitsAllocated: 16,
      bitsStored: 16,
      highBit: 15,
      pixelRepresentation: 0,
    },
  });
}

function createSyntheticReferenceImagesForIsotropicLabelmap(segmentation) {
  const labelmapData = segmentation.representationData?.Labelmap;
  const volume = labelmapData?.volumeId ? cache.getVolume(labelmapData.volumeId) : null;
  const sourceImageId = getSourceImageIdForSegmentation(segmentation);

  if (!volume || !sourceImageId) {
    throw new Error('Unable to export isotropic segmentation: missing volume or source image.');
  }

  const [columns, rows, slices] = volume.dimensions;
  const [columnSpacing, rowSpacing, sliceSpacing] = volume.spacing;
  const [originX, originY, originZ] = volume.origin;
  const sourceInstance = metaData.get('instance', sourceImageId) || {};
  const studyInstanceUID =
    sourceInstance.StudyInstanceUID ||
    metaData.get('generalStudyModule', sourceImageId)?.studyInstanceUID ||
    DicomMetaDictionary.uid();
  const frameOfReferenceUID =
    sourceInstance.FrameOfReferenceUID || volume.metadata?.FrameOfReferenceUID || DicomMetaDictionary.uid();
  const seriesInstanceUID = DicomMetaDictionary.uid();
  const sliceLength = rows * columns;

  return Array.from({ length: slices }, (_, sliceIndex) => {
    const imageId = `isotropic-seg-ref:${segmentation.segmentationId}:${sliceIndex}`;
    const sopInstanceUID = DicomMetaDictionary.uid();
    const imagePositionPatient = [
      originX,
      originY,
      originZ + sliceIndex * sliceSpacing,
    ];

    addSyntheticReferenceMetadata({
      imageId,
      sourceImageId,
      studyInstanceUID,
      seriesInstanceUID,
      frameOfReferenceUID,
      sopInstanceUID,
      instanceNumber: sliceIndex + 1,
      rows,
      columns,
      origin: imagePositionPatient,
      spacing: [columnSpacing, rowSpacing, sliceSpacing],
    });

    return {
      imageId,
      rows,
      columns,
      height: rows,
      width: columns,
      voxelManager: {
        getScalarData: () => new Uint16Array(sliceLength),
      },
    };
  });
}

function createLabelmap3DFromSegmentation({ segmentation, segmentationService }) {
  const { imageIds, volumeId } = segmentation.representationData.Labelmap;
  const volume = volumeId ? cache.getVolume(volumeId) : null;
  const segImages = volume ? null : imageIds.map(imageId => cache.getImage(imageId));
  const dimensions = volume?.dimensions;
  const scalarData = volume
    ? volume.voxelManager.getCompleteScalarDataArray?.() || volume.voxelManager.getScalarData()
    : null;
  const labelmaps2D = [];
  const allSegmentsOnLabelmap = [];

  if (volume && scalarData) {
    const [columns, rows, slices] = dimensions;
    const sliceLength = rows * columns;

    for (let z = 0; z < slices; z++) {
      const pixelData = scalarData.subarray(z * sliceLength, (z + 1) * sliceLength);
      const segmentsOnLabelmap = Array.from(new Set(pixelData.filter(segment => segment !== 0)));

      if (!segmentsOnLabelmap.length) {
        continue;
      }

      allSegmentsOnLabelmap.push(segmentsOnLabelmap);
      labelmaps2D[z] = {
        segmentsOnLabelmap,
        pixelData,
        rows,
        columns,
      };
    }
  } else {
    let z = 0;

    for (const segImage of segImages) {
      const segmentsOnLabelmap = new Set();
      const pixelData = segImage.getPixelData();
      const { rows, columns } = segImage;

      for (let i = 0; i < pixelData.length; i++) {
        const segment = pixelData[i];
        if (segment !== 0) {
          segmentsOnLabelmap.add(segment);
        }
      }

      allSegmentsOnLabelmap.push(Array.from(segmentsOnLabelmap));
      labelmaps2D[z++] = {
        segmentsOnLabelmap: Array.from(segmentsOnLabelmap),
        pixelData,
        rows,
        columns,
      };
    }
  }

  const labelmap3D = {
    segmentsOnLabelmap: Array.from(new Set(allSegmentsOnLabelmap.flat())),
    metadata: [],
    labelmaps2D,
  };

  const representations = segmentationService.getRepresentationsForSegmentation(
    segmentation.segmentationId
  );
  const firstRepresentation = representations[0];

  Object.entries(segmentation.segments).forEach(([segmentIndex, segment]) => {
    if (!segment) {
      return;
    }

    const color = firstRepresentation
      ? segmentationService.getSegmentColor(
          firstRepresentation.viewportId,
          segmentation.segmentationId,
          segment.segmentIndex
        )
      : [255, 0, 0, 255];

    const RecommendedDisplayCIELabValue = dcmjs.data.Colors.rgb2DICOMLAB(
      color.slice(0, 3).map(value => value / 255)
    ).map(value => Math.round(value));

    labelmap3D.metadata[segmentIndex] = {
      SegmentNumber: segmentIndex.toString(),
      SegmentLabel: segment.label,
      SegmentAlgorithmType: segment?.algorithmType || 'MANUAL',
      SegmentAlgorithmName: segment?.algorithmName || 'OHIF Brush',
      RecommendedDisplayCIELabValue,
      SegmentedPropertyCategoryCodeSequence: {
        CodeValue: 'T-D0050',
        CodingSchemeDesignator: 'SRT',
        CodeMeaning: 'Tissue',
      },
      SegmentedPropertyTypeCodeSequence: {
        CodeValue: 'T-D0050',
        CodingSchemeDesignator: 'SRT',
        CodeMeaning: 'Tissue',
      },
    };
  });

  return labelmap3D;
}


const commandsModule = ({
  servicesManager,
  extensionManager,
  commandsManager,
}: Types.Extensions.ExtensionParams): Types.Extensions.CommandsModule => {
  const { segmentationService, displaySetService, viewportGridService } =
    servicesManager.services as AppTypes.Services;

  const actions = {
    /**
     * Loads segmentations for a specified viewport.
     * The function prepares the viewport for rendering, then loads the segmentation details.
     * Additionally, if the segmentation has scalar data, it is set for the corresponding label map volume.
     *
     * @param {Object} params - Parameters for the function.
     * @param params.segmentations - Array of segmentations to be loaded.
     * @param params.viewportId - the target viewport ID.
     *
     */
    loadSegmentationsForViewport: async ({ segmentations, viewportId }) => {
      // Todo: handle adding more than one segmentation
      const viewport = getTargetViewport({ viewportId, viewportGridService });
      const displaySetInstanceUID = viewport.displaySetInstanceUIDs[0];

      const segmentation = segmentations[0];
      const segmentationId = segmentation.segmentationId;
      const label = segmentation.config.label;
      const segments = segmentation.config.segments;

      const displaySet = displaySetService.getDisplaySetByUID(displaySetInstanceUID);

      await segmentationService.createLabelmapForDisplaySet(displaySet, {
        segmentationId,
        segments,
        label,
      });

      segmentationService.addOrUpdateSegmentation(segmentation);

      await segmentationService.addSegmentationRepresentation(viewport.viewportId, {
        segmentationId,
      });

      return segmentationId;
    },
    /**
     * Generates a segmentation from a given segmentation ID.
     * This function retrieves the associated segmentation and
     * its referenced volume, extracts label maps from the
     * segmentation volume, and produces segmentation data
     * alongside associated metadata.
     *
     * @param {Object} params - Parameters for the function.
     * @param params.segmentationId - ID of the segmentation to be generated.
     * @param params.options - Optional configuration for the generation process.
     *
     * @returns Returns the generated segmentation data.
     */
    generateSegmentation: ({ segmentationId, options = {} }) => {
      const segmentation = cornerstoneToolsSegmentation.state.getSegmentation(segmentationId);
      const predecessorImageId = options.predecessorImageId ?? segmentation.predecessorImageId;

      if (segmentation.cachedStats?.isIsotropicLabelmap) {
        const referencedImages = createSyntheticReferenceImagesForIsotropicLabelmap(segmentation);
        const labelmap3D = createLabelmap3DFromSegmentation({
          segmentation,
          segmentationService,
        });

        return generateSegmentation(referencedImages, labelmap3D, metaData, {
          predecessorImageId,
          ...options,
        });
      }

      const { imageIds } = segmentation.representationData.Labelmap;

      const segImages = imageIds.map(imageId => cache.getImage(imageId));
      const referencedImages = segImages.map(image => cache.getImage(image.referencedImageId));

      const labelmaps2D = [];

      let z = 0;

      for (const segImage of segImages) {
        const segmentsOnLabelmap = new Set();
        const pixelData = segImage.getPixelData();
        const { rows, columns } = segImage;

        // Use a single pass through the pixel data
        for (let i = 0; i < pixelData.length; i++) {
          const segment = pixelData[i];
          if (segment !== 0) {
            segmentsOnLabelmap.add(segment);
          }
        }

        labelmaps2D[z++] = {
          segmentsOnLabelmap: Array.from(segmentsOnLabelmap),
          pixelData,
          rows,
          columns,
        };
      }

      const allSegmentsOnLabelmap = labelmaps2D.map(labelmap => labelmap.segmentsOnLabelmap);

      const labelmap3D = {
        segmentsOnLabelmap: Array.from(new Set(allSegmentsOnLabelmap.flat())),
        metadata: [],
        labelmaps2D,
      };

      const segmentationInOHIF = segmentationService.getSegmentation(segmentationId);
      const representations = segmentationService.getRepresentationsForSegmentation(segmentationId);

      Object.entries(segmentationInOHIF.segments).forEach(([segmentIndex, segment]) => {
        // segmentation service already has a color for each segment
        if (!segment) {
          return;
        }

        const { label } = segment;

        const firstRepresentation = representations[0];
        const color = segmentationService.getSegmentColor(
          firstRepresentation.viewportId,
          segmentationId,
          segment.segmentIndex
        );

        const RecommendedDisplayCIELabValue = dcmjs.data.Colors.rgb2DICOMLAB(
          color.slice(0, 3).map(value => value / 255)
        ).map(value => Math.round(value));

        const segmentMetadata = {
          SegmentNumber: segmentIndex.toString(),
          SegmentLabel: label,
          SegmentAlgorithmType: segment?.algorithmType || 'MANUAL',
          SegmentAlgorithmName: segment?.algorithmName || 'OHIF Brush',
          RecommendedDisplayCIELabValue,
          SegmentedPropertyCategoryCodeSequence: {
            CodeValue: 'T-D0050',
            CodingSchemeDesignator: 'SRT',
            CodeMeaning: 'Tissue',
          },
          SegmentedPropertyTypeCodeSequence: {
            CodeValue: 'T-D0050',
            CodingSchemeDesignator: 'SRT',
            CodeMeaning: 'Tissue',
          },
        };
        labelmap3D.metadata[segmentIndex] = segmentMetadata;
      });

      const generatedSegmentation = generateSegmentation(referencedImages, labelmap3D, metaData, {
        predecessorImageId,
        ...options,
      });

      return generatedSegmentation;
    },
    /**
     * Downloads a segmentation based on the provided segmentation ID.
     * This function retrieves the associated segmentation and
     * uses it to generate the corresponding DICOM dataset, which
     * is then downloaded with an appropriate filename.
     *
     * @param {Object} params - Parameters for the function.
     * @param params.segmentationId - ID of the segmentation to be downloaded.
     *
     */
    downloadSegmentation: ({ segmentationId }) => {
      const segmentationInOHIF = segmentationService.getSegmentation(segmentationId);
      const generatedSegmentation = actions.generateSegmentation({
        segmentationId,
      });
      const storeFn = commandsManager.runCommand('createStoreFunction', {
        dataSource: 'download',
        defaultFileName: `${segmentationInOHIF.label}.dcm`,
      });
      storeFn(generatedSegmentation.dataset);
    },
    /**
     * Stores a segmentation based on the provided segmentationId into a specified data source.
     * The SeriesDescription is derived from user input or defaults to the segmentation label,
     * and in its absence, defaults to 'Research Derived Series'.
     *
     * @param {Object} params - Parameters for the function.
     * @param params.segmentationId - ID of the segmentation to be stored.
     * @param params.dataSource - Data source where the generated segmentation will be stored.
     *
     * @returns {Object|void} Returns the naturalized report if successfully stored,
     * otherwise throws an error.
     */
    storeSegmentation: async ({ segmentationId, dataSource, modality = 'SEG' }) => {
      const segmentation = segmentationService.getSegmentation(segmentationId);

      if (!segmentation) {
        throw new Error('No segmentation found');
      }

      const { label, predecessorImageId } = segmentation;

      const {
        value: reportName,
        dataSourceName,
        series,
        priorSeriesNumber,
        action,
      } = await createReportDialogPrompt({
        servicesManager,
        extensionManager,
        predecessorImageId,
        title: 'Store Segmentation',
        modality,
        enableDownload: true,
      });

      if (action !== PROMPT_RESPONSES.CREATE_REPORT) {
        return;
      }

      const defaultFileName =
        modality === 'RTSTRUCT'
          ? `rtss-${segmentationId}.dcm`
          : `${label || 'segmentation'}.dcm`;

      const storeFn = commandsManager.runCommand('createStoreFunction', {
        dataSource: dataSourceName,
        defaultFileName,
      });

      if (!storeFn) {
        throw new Error(`No valid store for dataSource: ${dataSourceName}`);
      }

      try {
        const args = {
          segmentationId,
          options: {
            SeriesDescription: series ? undefined : reportName || label || 'Contour Series',
            SeriesNumber: series ? undefined : 1 + priorSeriesNumber,
            predecessorImageId: series,
          },
        };
        const generatedDataAsync =
          (modality === 'SEG' && actions.generateSegmentation(args)) ||
          (modality === 'RTSTRUCT' && actions.generateContour(args));
        const generatedData = await generatedDataAsync;

        if (!generatedData?.dataset) {
          throw new Error('Error during segmentation generation');
        }

        const { dataset: naturalizedReport } = generatedData;

        // DCMJS assigns a dummy study id during creation, and this can cause problems, so clearing it out
        if (naturalizedReport.StudyID === 'No Study ID') {
          naturalizedReport.StudyID = '';
        }

        await storeFn(naturalizedReport, {});

        return naturalizedReport;
      } catch (error) {
        console.debug('Error storing segmentation:', error);
        throw error;
      }
    },

    generateContour: async args => {
      const { segmentationId, options } = args;
      const segmentations = segmentationService.getSegmentation(segmentationId);

      // inject colors to the segmentIndex
      const firstRepresentation =
        segmentationService.getRepresentationsForSegmentation(segmentationId)[0];
      Object.entries(segmentations.segments).forEach(([segmentIndex, segment]) => {
        segment.color = segmentationService.getSegmentColor(
          firstRepresentation.viewportId,
          segmentationId,
          Number(segmentIndex)
        );
      });
      const predecessorImageId = options?.predecessorImageId ?? segmentations.predecessorImageId;
      const dataset = await generateRTSSFromRepresentation(segmentations, {
        predecessorImageId,
        ...options,
      });
      return { dataset };
    },

    /**
     * Downloads an RTSS instance from a segmentation or contour
     * representation.
     */
    downloadRTSS: async args => {
      const { dataset } = await actions.generateContour(args);
      const { InstanceNumber: instanceNumber = 1, SeriesInstanceUID: seriesUID } = dataset;
      const storeFn = commandsManager.runCommand('createStoreFunction', {
        dataSource: 'download',
        defaultFileName: `rtss-${seriesUID}-${instanceNumber}.dcm`,
      });
      await storeFn(dataset);
    },

    toggleActiveSegmentationUtility: ({ itemId: buttonId }) => {
      const { uiState, setUIState } = useUIStateStore.getState();
      const isButtonActive = uiState['activeSegmentationUtility'] === buttonId;
      console.log('toggleActiveSegmentationUtility', isButtonActive, buttonId);
      // if the button is active, clear the active segmentation utility
      if (isButtonActive) {
        setUIState('activeSegmentationUtility', null);
      } else {
        setUIState('activeSegmentationUtility', buttonId);
      }
    },
  };

  const definitions = {
    loadSegmentationsForViewport: actions.loadSegmentationsForViewport,
    generateSegmentation: actions.generateSegmentation,
    downloadSegmentation: actions.downloadSegmentation,
    storeSegmentation: actions.storeSegmentation,
    downloadRTSS: actions.downloadRTSS,
    toggleActiveSegmentationUtility: actions.toggleActiveSegmentationUtility,
  };

  return {
    actions,
    definitions,
    defaultContext: 'SEGMENTATION',
  };
};

export default commandsModule;
