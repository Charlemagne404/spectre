export interface ByteRange {
  offset: number;
  length: number;
}

export interface Region extends ByteRange {
  label: string;
  kind: 'header' | 'format' | 'metadata' | 'data' | 'other';
}

export interface EntropyBin extends ByteRange {
  value: number;
}

export interface FileString extends ByteRange {
  text: string;
  encoding: 'ASCII' | 'UTF-16LE';
}

export interface FileIdentity {
  name: string;
  size: number;
  type: string;
  mime: string;
  extension: string;
  extensionMatch: boolean | null;
  sourceMime: string;
  lastModified: number;
}

export interface StructureReport {
  parser: string;
  mode: 'format-aware' | 'generic';
  complete: boolean;
  limitation: string | null;
  warnings: string[];
  findings?: ParserFinding[];
}

export interface ParserFinding {
  label: string;
  value: string;
  offset?: number;
  length?: number;
  kind?: 'property' | 'metadata' | 'entry' | 'section' | 'segment' | 'warning';
}

export interface Analysis {
  name: string;
  size: number;
  type: string;
  mime: string;
  extension: string;
  extensionMatch: boolean | null;
  sourceMime: string;
  lastModified: number;
  sha256: string;
  regions: Region[];
  structure: StructureReport;
  entropy: EntropyBin[];
  histogram: number[];
  firstOffsets: number[];
  strings: FileString[];
  totalStrings: number;
  stringIndexLimitReached: boolean;
  averageEntropy: number;
  metrics: { durationMs: number; eventCount: number; eventsPerSecond: number; chunkSize: number };
  startedAt: string;
  completedAt: string;
}

export type AnalysisStage =
  | 'received'
  | 'identification'
  | 'fingerprinting'
  | 'structure'
  | 'statistics'
  | 'complete'
  | 'cancelled'
  | 'failed';

export type AnalysisEvent =
  | { jobId: number; type: 'FILE_RECEIVED'; name: string; size: number }
  | { jobId: number; type: 'FILE_IDENTIFICATION_STARTED' }
  | { jobId: number; type: 'FILE_IDENTIFIED'; identity: FileIdentity }
  | { jobId: number; type: 'HASHING_STARTED'; total: number }
  | { jobId: number; type: 'HASHING_PROGRESS'; processed: number; total: number }
  | { jobId: number; type: 'HASHING_COMPLETED'; sha256: string }
  | { jobId: number; type: 'ENTROPY_ANALYSIS_STARTED'; windowSize: number }
  | { jobId: number; type: 'ENTROPY_REGION_ANALYZED'; regions: EntropyBin[] }
  | { jobId: number; type: 'ENTROPY_ANALYSIS_COMPLETED'; averageEntropy: number }
  | { jobId: number; type: 'STRING_BATCH_DISCOVERED'; strings: FileString[]; totalStrings: number }
  | { jobId: number; type: 'STRING_EXTRACTION_COMPLETED'; totalStrings: number; indexLimitReached: boolean }
  | { jobId: number; type: 'BYTE_FREQUENCY_UPDATED'; histogram: number[]; firstOffsets: number[] }
  | { jobId: number; type: 'BYTE_FREQUENCY_COMPLETED'; totalBytes: number }
  | { jobId: number; type: 'HEX_DATA_AVAILABLE'; offset: number; bytes: number[] }
  | { jobId: number; type: 'STRUCTURE_PARSING_STARTED' }
  | { jobId: number; type: 'STRUCTURE_REGION_DISCOVERED'; region: Region; index: number; total: number }
  | { jobId: number; type: 'STRUCTURE_REGION_BATCH_DISCOVERED'; regions: Region[]; index: number; total: number }
  | { jobId: number; type: 'STRUCTURE_PARSING_COMPLETED'; structure: StructureReport }
  | { jobId: number; type: 'ANALYSIS_COMPLETED'; analysis: Analysis }
  | { jobId: number; type: 'ANALYSIS_CANCELLED' }
  | { jobId: number; type: 'ANALYSIS_FAILED'; message: string };

export type AnalysisEventPayload = AnalysisEvent extends infer Event
  ? Event extends { jobId: number } ? Omit<Event, 'jobId'> : never
  : never;

export interface AnalysisRun {
  jobId: number;
  file: File;
  sample: boolean;
  status: 'running' | 'cancelled' | 'failed' | 'complete';
  stage: AnalysisStage;
  identity: FileIdentity | null;
  sha256: string | null;
  processed: number;
  regions: Region[];
  structure: StructureReport | null;
  entropy: EntropyBin[];
  histogram: number[];
  firstOffsets: number[];
  strings: FileString[];
  totalStrings: number;
  stringIndexLimitReached: boolean;
  stringsCompleted: boolean;
  histogramCompleted: boolean;
  averageEntropy: number | null;
  statisticsStarted: boolean;
  statisticsCompleted: boolean;
  hexPreview: number[];
  error: string | null;
  startedAt: string;
}

export function hex(value: number, width = 2) {
  return value.toString(16).toUpperCase().padStart(width, '0');
}

export function address(offset: number, width = 8) {
  return '0x' + hex(offset, width);
}

export function byteSize(size: number) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const unit = Math.min(units.length - 1, size > 0 ? Math.floor(Math.log(size) / Math.log(1024)) : 0);
  return (size / 1024 ** unit).toLocaleString('en', { maximumFractionDigits: unit ? 2 : 0 }) + ' ' + units[unit];
}

export function contains(range: ByteRange, offset: number) {
  return offset >= range.offset && offset - range.offset < range.length;
}

export function intersects(a: ByteRange, b: ByteRange) {
  return a.length > 0 && b.length > 0 && a.offset < b.offset + b.length && b.offset < a.offset + a.length;
}
