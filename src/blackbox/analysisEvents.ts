import type { AnalysisEvent, AnalysisRun } from './model';

export function createAnalysisRun(jobId: number, file: File, sample: boolean): AnalysisRun {
  return {
    jobId,
    file,
    sample,
    status: 'running',
    stage: 'received',
    identity: null,
    sha256: null,
    processed: 0,
    regions: [],
    structure: null,
    entropy: [],
    histogram: Array(256).fill(0),
    firstOffsets: Array(256).fill(-1),
    strings: [],
    totalStrings: 0,
    stringIndexLimitReached: false,
    stringsCompleted: false,
    histogramCompleted: false,
    averageEntropy: null,
    statisticsStarted: false,
    statisticsCompleted: false,
    hexPreview: [],
    error: null,
    startedAt: new Date().toISOString(),
  };
}

export function applyAnalysisEvent(run: AnalysisRun, event: AnalysisEvent): AnalysisRun {
  if (event.jobId !== run.jobId || run.status !== 'running') return run;
  switch (event.type) {
    case 'FILE_RECEIVED':
      return { ...run, stage: 'received' };
    case 'FILE_IDENTIFICATION_STARTED':
      return { ...run, stage: 'identification' };
    case 'FILE_IDENTIFIED':
      return { ...run, stage: 'fingerprinting', identity: event.identity };
    case 'HASHING_STARTED':
      return { ...run, stage: 'fingerprinting' };
    case 'HASHING_PROGRESS':
      return { ...run, processed: event.processed };
    case 'HASHING_COMPLETED':
      return { ...run, processed: run.file.size, sha256: event.sha256 };
    case 'ENTROPY_ANALYSIS_STARTED':
      return { ...run, stage: 'statistics', statisticsStarted: true };
    case 'ENTROPY_REGION_ANALYZED':
      return { ...run, entropy: [...run.entropy, ...event.regions] };
    case 'ENTROPY_ANALYSIS_COMPLETED':
      return { ...run, statisticsCompleted: true, averageEntropy: event.averageEntropy };
    case 'STRING_BATCH_DISCOVERED':
      return { ...run, strings: [...run.strings, ...event.strings], totalStrings: event.totalStrings };
    case 'STRING_EXTRACTION_COMPLETED':
      return { ...run, stringsCompleted: true, totalStrings: event.totalStrings,
        stringIndexLimitReached: event.indexLimitReached };
    case 'BYTE_FREQUENCY_UPDATED':
      return { ...run, histogram: event.histogram, firstOffsets: event.firstOffsets };
    case 'BYTE_FREQUENCY_COMPLETED':
      return { ...run, histogramCompleted: true };
    case 'HEX_DATA_AVAILABLE':
      return event.offset === 0 ? { ...run, hexPreview: event.bytes } : run;
    case 'STRUCTURE_PARSING_STARTED':
      return { ...run, stage: 'structure' };
    case 'STRUCTURE_REGION_DISCOVERED':
      return { ...run, regions: [...run.regions, event.region] };
    case 'STRUCTURE_REGION_BATCH_DISCOVERED':
      return { ...run, regions: [...run.regions, ...event.regions] };
    case 'STRUCTURE_PARSING_COMPLETED':
      return { ...run, structure: event.structure };
    case 'ANALYSIS_COMPLETED':
      return { ...run, stage: 'complete', processed: run.file.size, sha256: event.analysis.sha256, status: 'complete' };
    case 'ANALYSIS_CANCELLED':
      return { ...run, status: 'cancelled', stage: 'cancelled' };
    case 'ANALYSIS_FAILED':
      return { ...run, status: 'failed', stage: 'failed', error: event.message };
  }
}

export function applyAnalysisEvents(run: AnalysisRun, events: AnalysisEvent[]): AnalysisRun {
  if (run.status !== 'running') return run;
  let next = run;
  const regions: AnalysisRun['regions'] = [];
  const entropy: AnalysisRun['entropy'] = [];
  const strings: AnalysisRun['strings'] = [];
  for (const event of events) {
    if (event.jobId !== run.jobId || next.status !== 'running') continue;
    if (event.type === 'STRUCTURE_REGION_DISCOVERED') regions.push(event.region);
    else if (event.type === 'STRUCTURE_REGION_BATCH_DISCOVERED') regions.push(...event.regions);
    else if (event.type === 'ENTROPY_REGION_ANALYZED') entropy.push(...event.regions);
    else if (event.type === 'STRING_BATCH_DISCOVERED') {
      strings.push(...event.strings);
      next = { ...next, totalStrings: event.totalStrings };
    } else next = applyAnalysisEvent(next, event);
  }
  if (!regions.length && !entropy.length && !strings.length) return next;
  return {
    ...next,
    regions: regions.length ? [...next.regions, ...regions] : next.regions,
    entropy: entropy.length ? [...next.entropy, ...entropy] : next.entropy,
    strings: strings.length ? [...next.strings, ...strings] : next.strings,
  };
}
