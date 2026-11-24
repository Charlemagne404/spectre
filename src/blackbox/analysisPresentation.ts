import type { AnalysisEvent } from './model';

export const SMALL_FILE_PRESENTATION_LIMIT = 4 * 1024 * 1024;

export const presentationPhases = [
  'identification',
  'fingerprint',
  'structure',
  'entropy',
  'strings',
  'frequency',
  'inspection',
] as const;

export type PresentationPhase = typeof presentationPhases[number];

export function minimumPresentationDuration(stageCount: number) {
  return Math.min(2500, Math.max(1500, 250 + Math.max(1, stageCount) * 280));
}

export function presentationPhase(event: AnalysisEvent): PresentationPhase | null {
  switch (event.type) {
    case 'FILE_RECEIVED':
    case 'FILE_IDENTIFICATION_STARTED':
    case 'FILE_IDENTIFIED':
      return 'identification';
    case 'HASHING_STARTED':
    case 'HASHING_PROGRESS':
    case 'HASHING_COMPLETED':
      return 'fingerprint';
    case 'STRUCTURE_PARSING_STARTED':
    case 'STRUCTURE_REGION_DISCOVERED':
    case 'STRUCTURE_REGION_BATCH_DISCOVERED':
    case 'STRUCTURE_PARSING_COMPLETED':
      return 'structure';
    case 'ENTROPY_ANALYSIS_STARTED':
    case 'ENTROPY_REGION_ANALYZED':
    case 'ENTROPY_ANALYSIS_COMPLETED':
      return 'entropy';
    case 'STRING_BATCH_DISCOVERED':
    case 'STRING_EXTRACTION_COMPLETED':
      return 'strings';
    case 'BYTE_FREQUENCY_UPDATED':
    case 'BYTE_FREQUENCY_COMPLETED':
      return 'frequency';
    case 'HEX_DATA_AVAILABLE':
    case 'ANALYSIS_COMPLETED':
      return 'inspection';
    case 'ANALYSIS_CANCELLED':
    case 'ANALYSIS_FAILED':
      return null;
  }
}

export function completesPresentationPhase(event: AnalysisEvent) {
  return event.type === 'FILE_IDENTIFIED'
    || event.type === 'HASHING_COMPLETED'
    || event.type === 'STRUCTURE_PARSING_COMPLETED'
    || event.type === 'ENTROPY_ANALYSIS_COMPLETED'
    || event.type === 'STRING_EXTRACTION_COMPLETED'
    || event.type === 'BYTE_FREQUENCY_COMPLETED'
    || event.type === 'ANALYSIS_COMPLETED';
}

export function expandForPresentation(event: AnalysisEvent): AnalysisEvent[] {
  if (event.type !== 'ENTROPY_REGION_ANALYZED' || event.regions.length < 2) return [event];
  return event.regions.map((region) => ({ ...event, regions: [region] }));
}
