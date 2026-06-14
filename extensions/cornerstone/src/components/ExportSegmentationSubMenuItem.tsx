import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuPortal,
  DropdownMenuSubContent,
  DropdownMenuItem,
  Icons,
} from '@ohif/ui-next';

import { SegmentationRepresentations } from '@cornerstonejs/tools/enums';

interface ExportSegmentationSubMenuItemProps {
  segmentationId: string;
  segmentationRepresentationType: string;
  allowExport: boolean;
  actions: {
    storeSegmentation: (segmentationId: string, modality?: string) => Promise<unknown>;
    downloadSegmentation: (segmentationId: string) => void;
    downloadRTSS: (segmentationId: string) => void;
    downloadCSVSegmentationReport: (segmentationId: string) => void;
  };
}

export const ExportSegmentationSubMenuItem: React.FC<ExportSegmentationSubMenuItemProps> = ({
  segmentationId,
  segmentationRepresentationType,
  allowExport,
  actions,
}) => {
  const { t } = useTranslation('SegmentationPanel');

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className="pl-1">
        <Icons.Export className="text-foreground" />
        <span className="pl-2">{t('Export')}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent>
          {segmentationRepresentationType === SegmentationRepresentations.Labelmap && (
            <DropdownMenuItem
              onClick={e => {
                e.preventDefault();
                actions.downloadCSVSegmentationReport(segmentationId);
              }}
              disabled={!allowExport}
            >
              {t('CSV Report')}
            </DropdownMenuItem>
          )}
          {segmentationRepresentationType === SegmentationRepresentations.Labelmap && (
            <DropdownMenuItem
              onClick={e => {
                e.preventDefault();
                actions.downloadSegmentation(segmentationId);
              }}
              disabled={!allowExport}
            >
              {t('Download DICOM SEG')}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            onClick={e => {
              e.preventDefault();
              actions.downloadRTSS(segmentationId);
            }}
            disabled={!allowExport}
          >
            {t('Download DICOM RTSS')}
          </DropdownMenuItem>
          {segmentationRepresentationType === SegmentationRepresentations.Labelmap && (
            <DropdownMenuItem
              onClick={e => {
                e.preventDefault();
                actions.storeSegmentation(segmentationId, 'SEG');
              }}
              disabled={!allowExport}
            >
              {t('Export DICOM SEG')}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            onClick={e => {
              e.preventDefault();
              actions.storeSegmentation(segmentationId, 'RTSTRUCT');
            }}
            disabled={!allowExport}
          >
            {t('Export DICOM RTSS')}
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  );
};
