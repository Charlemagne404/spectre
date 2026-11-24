import { useCallback, useEffect, useRef, useState } from 'react';
import type { Ref } from 'react';
import { Icon } from '../icons';
import { HexPane } from './HexPane';
import { Pane } from './Pane';
import { StringsPane } from './StringsPane';
import { ByteHistogram, EntropyPlot, StructureMap } from './visualizations';
import { byteSize } from './model';
import type { Analysis, AnalysisRun, ByteRange, FileIdentity, StructureReport } from './model';
import type { Inspection } from './useInspection';
import { downloadReport } from './reports';
import type { ReportContext } from './reports';
import { InvestigationPanel } from './InvestigationPanel';
import type { BookmarkDraft } from './InvestigationPanel';
import { ComparisonOverlay } from './ComparisonOverlay';
import type { FileComparison } from './fileCompare';
import { EmbeddedSignaturesPane } from './EmbeddedSignaturesPane';
import { createBookmark, createInvestigation, deleteInvestigation, isMatchingFile, listInvestigations, recordAnalysis, recordComparison, updateInvestigation } from './investigations';
import type { BookmarkKind, Investigation, InvestigationBookmark, InvestigationFile } from './investigations';

export interface WorkspaceProps {
  inspection: Inspection | null;
  run: AnalysisRun | null;
  processingRun: AnalysisRun | null;
  pending: boolean;
  error: string;
  activating: boolean;
  shuttingDown: boolean;
  open: () => void;
  openSample: () => void;
  reanalyze: () => void;
  back: () => void;
  cancel: () => void;
  restoreFile: (file: InvestigationFile) => void;
  titleRef: Ref<HTMLHeadingElement>;
  searchRef: Ref<HTMLInputElement>;
}

type SelectionSource = 'structure' | 'entropy' | 'strings' | 'hex' | 'histogram' | 'search';
interface SharedSelection { range: ByteRange; source: SelectionSource }
const EMPTY_PREVIEW: number[] = [];
type DisplayAnalysis = Omit<Analysis, 'sha256' | 'structure'> & {
  sha256: string | null;
  structure: Analysis['structure'] | null;
};

function reportContextFor(investigation: Investigation | null, analysis: Analysis): ReportContext | undefined {
  if (!investigation) return undefined;
  const file = investigation.files.find((item) => isMatchingFile(item, analysis));
  const comparisons = (investigation.comparisons ?? []).filter((item) => !file || item.firstFileId === file.id || item.secondFileId === file.id)
    .map((item) => {
      const first = investigation.files.find((candidate) => candidate.id === item.firstFileId);
      const second = investigation.files.find((candidate) => candidate.id === item.secondFileId);
      return {
        comparedAt: item.comparedAt, mode: item.mode, firstFileName: first?.fileName ?? '(unavailable file record)',
        firstSha256: first?.sha256 ?? null, secondFileName: second?.fileName ?? '(unavailable file record)',
        secondSha256: second?.sha256 ?? null, identical: item.identical, comparedBytes: item.comparedBytes,
        differingBytes: item.differingBytes, differenceRangeCount: item.differenceRangeCount,
        omittedDifferenceRanges: item.omittedDifferenceRanges,
      };
    });
  return {
    id: investigation.id, name: investigation.name, createdAt: investigation.createdAt,
    modifiedAt: investigation.modifiedAt, notes: investigation.notes, fileNotes: file?.notes ?? '',
    bookmarks: file?.bookmarks ?? [], comparisons,
  };
}

function displayForRun(run: AnalysisRun): DisplayAnalysis {
  const fallback: FileIdentity = {
    name: run.file.name || 'unnamed file', size: run.file.size, type: 'Identifying…', mime: '—',
    extension: run.file.name.includes('.') ? '.' + run.file.name.split('.').at(-1)?.toLowerCase() : '',
    extensionMatch: null, sourceMime: run.file.type, lastModified: run.file.lastModified,
  };
  const identity = run.identity ?? fallback;
  return {
    ...identity,
    sha256: run.sha256,
    regions: run.regions,
    structure: run.structure,
    entropy: run.entropy,
    histogram: run.histogram,
    firstOffsets: run.firstOffsets,
    strings: run.strings,
    totalStrings: run.totalStrings,
    stringIndexLimitReached: run.stringIndexLimitReached,
    averageEntropy: run.averageEntropy ?? 0,
    metrics: { durationMs: 0, eventCount: 0, eventsPerSecond: 0, chunkSize: 1024 * 1024,
      phasesMs: { fileRanges: 0, sha256: 0, statisticsAndStrings: 0, structureParser: 0 } },
    startedAt: run.startedAt,
    completedAt: '',
  };
}

function FilePane({ file, data, sample, run, selection, select }: {
  file: File;
  data: DisplayAnalysis;
  sample: boolean;
  run: AnalysisRun | null;
  selection: ByteRange | null;
  select: (range: ByteRange, source: SelectionSource) => void;
}) {
  const [copyStatus, setCopyStatus] = useState('');
  const digest = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!copyStatus) return;
    const timer = window.setTimeout(() => setCopyStatus(''), 1700);
    return () => clearTimeout(timer);
  }, [copyStatus]);

  async function copyDigest() {
    if (!data.sha256) return;
    try {
      await navigator.clipboard.writeText(data.sha256);
      setCopyStatus('Copied');
    } catch {
      const range = document.createRange();
      if (!digest.current) return;
      range.selectNodeContents(digest.current);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      setCopyStatus('Selected');
    }
  }

  const hashState = data.sha256 ? 'RESOLVED'
    : run?.status === 'complete' ? 'HASH READY'
      : run?.stage === 'fingerprinting' ? 'HASHING' : 'AWAITING HASH';
  const structureState = data.structure
    ? data.structure.parser + (data.structure.complete ? ' · COMPLETE' : ' · PARTIAL')
    : run?.status === 'complete' ? 'STRUCTURE READY'
      : run?.stage === 'structure' ? 'PARSING' : 'AWAITING PARSER';

  return <Pane name="File / Structure" className="file-pane" actions={sample ? <span className="sample-label">Sample file</span> : undefined}>
    <div className="file-info">
      <h3 className="file-name" title={data.name}>{data.name}</h3>
      <dl className="file-details"><div><dt>Type</dt><dd>{data.type}</dd></div>
        <div><dt>Size</dt><dd title={data.size.toLocaleString('en') + ' bytes'}>{byteSize(data.size)}</dd></div>
        <div><dt>MIME</dt><dd title={data.sourceMime || undefined}>{data.mime}</dd></div></dl>
      {data.extensionMatch === false && <p className="identity-warning" role="note">
        Extension mismatch · {data.extension || '(none)'} / {data.type}
      </p>}
      <div className="digest">
        <div className="digest-heading"><span>SHA-256</span><span role="status">{copyStatus || hashState}</span></div>
        <div><code ref={digest} title={data.sha256 ?? undefined}>{data.sha256 ? <>{data.sha256.slice(0, 32)}<wbr />{data.sha256.slice(32)}</> : run?.status === 'complete' ? 'Fingerprint result pending reveal' : 'Fingerprint resolves after the scan'}</code>
          <button type="button" className="icon-button" aria-label="Copy SHA-256" title="Copy SHA-256" disabled={!data.sha256}
            onClick={copyDigest}><Icon name={copyStatus === 'Copied' ? 'check' : 'copy'} /></button>
        </div>
      </div>
    </div>
    <StructureMap regions={data.regions} size={data.size} selection={selection}
      select={(range) => select(range, 'structure')} parser={structureState + ' · ' + data.regions.length + ' regions'}
      limitation={data.structure?.limitation ?? undefined}
      emptyLabel={data.size === 0 ? 'Empty file' : run?.status === 'complete' ? 'Structure result pending reveal'
        : run?.stage === 'structure' ? 'Parsing file structure…' : 'Awaiting structure parser'} />
    {data.structure?.limitation && (data.structure.mode === 'generic' || !data.structure.complete)
      && <p className="structure-limitation" title={data.structure.limitation}>{data.structure.limitation}</p>}
    {!!data.structure?.findings?.length && <details className="parser-findings">
      <summary>Parser findings · {data.structure.findings.length}</summary>
      <div className="parser-findings-list">
        {data.structure.findings.slice(0, 128).map((finding, index) => {
          const label = finding.label;
          const value = finding.value;
          const range = finding.offset !== undefined && finding.length !== undefined && finding.length > 0
            ? { offset: finding.offset, length: finding.length } : null;
          return range
            ? <button type="button" key={label + ':' + finding.offset + ':' + index} onClick={() => select(range, 'structure')} title={`${label} · ${value}`}>
              <span>{label}</span><span>{value}</span>
            </button>
            : <div key={label + ':' + index} title={value}><span>{label}</span><span>{value}</span></div>;
        })}
      </div>
      {data.structure.findings.length > 128 && <p>{data.structure.findings.length - 128} additional findings are included in the report.</p>}
    </details>}
    {data.sha256 && <EmbeddedSignaturesPane file={file} select={(range) => select(range, 'structure')} />}
  </Pane>;
}

function EmptyPaneState({ children }: { children: string }) {
  return <div className="pane-empty-state" role="status">{children}</div>;
}

function EmptyWorkspaceCanvas() {
  return <div className="workspace-grid empty-workspace-grid">
    <Pane name="File / Structure" className="file-pane"><EmptyPaneState>No file loaded.</EmptyPaneState></Pane>
    <Pane name="Entropy" className="entropy-pane"><EmptyPaneState>No measurements.</EmptyPaneState></Pane>
    <Pane name="Strings" className="strings-pane"><EmptyPaneState>No extracted strings.</EmptyPaneState></Pane>
    <Pane name="Hex inspector" className="hex-pane"><EmptyPaneState>No file selected.</EmptyPaneState></Pane>
    <section className="pane histogram" aria-labelledby="empty-histogram-title">
      <div className="histogram-head"><h3 id="empty-histogram-title">Byte frequency</h3></div>
      <div className="histogram-empty" role="status">No measurements.</div>
    </section>
  </div>;
}

const steps: Array<{ label: string; done: (run: AnalysisRun) => boolean; active: (run: AnalysisRun) => boolean }> = [
  { label: 'IDENTIFY', done: (run) => !!run.identity, active: (run) => run.stage === 'received' || run.stage === 'identification' },
  { label: 'FINGERPRINT', done: (run) => !!run.sha256, active: (run) => run.stage === 'fingerprinting' },
  { label: 'STRUCTURE', done: (run) => !!run.structure, active: (run) => run.stage === 'structure' },
  { label: 'STATISTICS', done: (run) => run.statisticsCompleted, active: (run) => run.statisticsStarted && !run.statisticsCompleted },
  { label: 'INSPECT', done: (run) => run.status === 'complete', active: () => false },
];

function AnalysisStatus({ run, processing, cancel }: { run: AnalysisRun; processing: AnalysisRun; cancel: () => void }) {
  const revealing = processing.status === 'complete' && run.status !== 'complete';
  const stage = revealing ? 'REVEALING FINDINGS'
    : processing.status === 'cancelled' ? 'ANALYSIS CANCELLED'
      : processing.status === 'failed' ? 'ANALYSIS FAILED'
        : processing.status === 'complete' ? 'ANALYSIS COMPLETE'
          : processing.stage === 'received' ? 'FILE RECEIVED'
            : processing.stage === 'identification' ? 'IDENTIFYING FILE'
              : processing.stage === 'fingerprinting' ? 'HASHING + BYTE STATISTICS'
                : processing.stage === 'statistics' ? processing.sha256 ? 'CALCULATING STATISTICS' : 'HASHING + BYTE STATISTICS'
                  : processing.stage === 'structure' ? 'PARSING STRUCTURE'
                    : 'ANALYZING';
  const progress = processing.processed;
  const progressMax = Math.max(1, processing.file.size);
  const statusClass = revealing ? ' analysis-revealing'
    : processing.status !== 'running' ? ' analysis-' + processing.status : '';
  return <section className={'analysis-status' + statusClass} role="status" aria-live="polite">
    <div className="analysis-readout"><span>{stage}</span><strong>{processing.identity?.name ?? processing.file.name}</strong>
      <span>{processing.file.size ? byteSize(processing.processed) + ' / ' + byteSize(processing.file.size) + ' scanned' : '0 bytes'}</span></div>
    <progress aria-label="Analysis byte scan progress" value={Math.min(progress, progressMax)} max={progressMax} />
    {processing.status === 'running' && <button type="button" className="icon-button" onClick={cancel} aria-label="Cancel analysis" title="Stop analysis"><Icon name="close" /></button>}
    <div className="analysis-steps" aria-label="Analysis stages">
      {steps.map((step) => <span key={step.label} className={(step.done(run) ? 'step-done' : step.active(run) ? 'step-active' : '')}>{step.label}</span>)}
      {processing.status === 'cancelled' || processing.status === 'failed' ? <span className="step-stopped">{processing.status.toUpperCase()}</span> : null}
    </div>
    {processing.error && <span className="analysis-error" role="alert">{processing.error}</span>}
  </section>;
}

function emptyMetricMessage(kind: 'entropy' | 'strings' | 'frequency', fileSize: number, visible: AnalysisRun | null,
  processing: AnalysisRun | null, totalStrings = visible?.totalStrings ?? 0) {
  if (processing?.status === 'failed') return 'Unavailable · analysis failed.';
  if (processing?.status === 'cancelled') return 'Analysis cancelled · partial results retained.';
  const stringsComplete = visible?.stringsCompleted ?? (processing?.status === 'complete' && !visible);
  const statisticsComplete = visible?.statisticsCompleted ?? (processing?.status === 'complete' && !visible);
  const frequencyComplete = visible?.histogramCompleted ?? (processing?.status === 'complete' && !visible);
  if (kind === 'strings' && stringsComplete && totalStrings === 0) return 'No printable strings found.';
  if (kind === 'entropy' && statisticsComplete && fileSize === 0) return 'No measurements for an empty file.';
  if (kind === 'frequency' && frequencyComplete && fileSize === 0) return 'No measurements for an empty file.';
  if (processing?.status === 'complete') return 'Results pending reveal.';
  if (kind === 'entropy') return processing?.statisticsStarted ? 'Measuring entropy…' : 'Waiting for entropy measurements…';
  if (kind === 'strings') return processing?.statisticsStarted ? 'Extracting strings…' : 'Waiting for string extraction…';
  return processing?.statisticsStarted ? 'Resolving byte frequencies…' : 'Waiting for byte counts…';
}

function InspectionCanvas({ file, data, sample, run, processingRun, searchRef, onSelectionChange, navigateTo }: {
  file: File;
  data: DisplayAnalysis;
  sample: boolean;
  run: AnalysisRun | null;
  processingRun: AnalysisRun | null;
  searchRef: Ref<HTMLInputElement>;
  onSelectionChange?: (selection: SharedSelection | null) => void;
  navigateTo?: { range: ByteRange; source: SelectionSource; token: number } | null;
}) {
  const [shared, setShared] = useState<SharedSelection | null>(() => file.size ? { range: { offset: 0, length: 1 }, source: 'hex' } : null);
  const selection = shared?.range ?? null;
  const offset = selection?.offset;
  const [byte, setByte] = useState<{ offset: number; value: number }>();
  const lastNavigation = useRef(0);
  const firstByte = byte?.offset === offset ? byte?.value : undefined;
  const select = (range: ByteRange, source: SelectionSource) => setShared({ range, source });
  const hexVisible = !run || run.hexPreview.length > 0;

  useEffect(() => { onSelectionChange?.(shared); }, [shared, onSelectionChange]);

  useEffect(() => {
    if (!navigateTo || navigateTo.token === lastNavigation.current) return;
    lastNavigation.current = navigateTo.token;
    setShared({ range: navigateTo.range, source: navigateTo.source });
  }, [navigateTo]);

  useEffect(() => {
    if (!hexVisible || offset === undefined || offset >= file.size) return;
    let active = true;
    file.slice(offset, offset + 1).arrayBuffer().then((buffer) => {
      if (active) setByte({ offset, value: new Uint8Array(buffer)[0] });
    }).catch(() => { if (active) setByte(undefined); });
    return () => { active = false; };
  }, [file, hexVisible, offset]);

  const contextRange = shared?.source === 'structure' ? shared.range : null;
  const selectHistogramByte = (value: number) => {
    const byteOffset = data.firstOffsets[value];
    if (byteOffset !== undefined && byteOffset >= 0) select({ offset: byteOffset, length: 1 }, 'histogram');
  };

  return <div className="workspace-grid">
    <FilePane file={file} data={data} sample={sample} run={processingRun ?? run} selection={selection}
      select={(range, source) => select(range, source)} />
    <Pane name="Entropy" className="entropy-pane" actions={<span className="chart-summary">
      <span>Whole file</span><strong>{run && !run.statisticsCompleted ? '—' : data.averageEntropy.toFixed(2)}</strong> bits/B
    </span>}>
      <EntropyPlot bins={data.entropy} size={data.size} selection={selection}
        emptyMessage={emptyMetricMessage('entropy', data.size, run, processingRun, data.totalStrings)}
        select={(range) => select(range, 'entropy')} />
    </Pane>
    <StringsPane file={file} jobId={processingRun?.jobId ?? run?.jobId ?? 0}
      strings={data.strings} total={data.totalStrings} indexLimitReached={data.stringIndexLimitReached} selection={selection} contextRange={contextRange}
      emptyMessage={emptyMetricMessage('strings', data.size, run, processingRun, data.totalStrings)}
      searchReady={!run || run.strings.length > 0 || run.stringsCompleted} searchComplete={!run || run.stringsCompleted}
      select={(range) => select(range, 'strings')} searchRef={searchRef} />
    <HexPane file={file} selection={selection} firstByte={firstByte} regions={data.regions} select={(range, source = 'hex') => select(range, source)}
      prefetched={run?.hexPreview ?? EMPTY_PREVIEW} enabled={hexVisible}
      emptyMessage={processingRun?.status === 'failed' ? 'Bytes unavailable · analysis failed.'
        : processingRun?.status === 'cancelled' ? 'Analysis cancelled · partial bytes retained.'
          : processingRun?.status === 'complete' && run ? 'Byte window pending reveal.' : 'Preparing byte window…'} />
    <ByteHistogram histogram={data.histogram} firstOffsets={data.firstOffsets} firstByte={firstByte}
      selectByte={selectHistogramByte} emptyMessage={emptyMetricMessage('frequency', data.size, run, processingRun, data.totalStrings)} />
  </div>;
}

export function Workspace({ inspection, run, pending, error, activating, shuttingDown, open, openSample, reanalyze,
  back, cancel, titleRef, searchRef, processingRun, restoreFile }: WorkspaceProps & { processingRun: AnalysisRun | null }) {
  const [investigations, setInvestigations] = useState<Investigation[]>([]);
  const [activeInvestigation, setActiveInvestigation] = useState<Investigation | null>(null);
  const [investigationOpen, setInvestigationOpen] = useState(false);
  const [comparisonOpen, setComparisonOpen] = useState(false);
  const [bookmarkSelection, setBookmarkSelection] = useState<SharedSelection | null>(null);
  const [bookmarkDraft, setBookmarkDraft] = useState<BookmarkDraft | null>(null);
  const [navigationRequest, setNavigationRequest] = useState<{ range: ByteRange; source: SelectionSource; token: number } | null>(null);
  const [storageError, setStorageError] = useState('');
  const [storageStatus, setStorageStatus] = useState('');
  const [reportFeedback, setReportFeedback] = useState<{ label: string; detail: string; error: boolean } | null>(null);
  const navigationSequence = useRef(0);
  const analysis = inspection?.data ?? null;

  const replaceInvestigation = useCallback((updated: Investigation) => {
    setInvestigations((current) => [updated, ...current.filter((item) => item.id !== updated.id)].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)));
    setActiveInvestigation((current) => current?.id === updated.id ? updated : current);
  }, []);

  useEffect(() => {
    let active = true;
    listInvestigations().then((items) => { if (active) setInvestigations(items); })
      .catch((cause: unknown) => { if (active) setStorageError(cause instanceof Error ? cause.message : 'Local investigations could not be loaded.'); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!activeInvestigation || !analysis) return;
    let current = true;
    const investigationId = activeInvestigation.id;
    setStorageStatus('Recording file identity and analysis summary locally…');
    recordAnalysis(investigationId, analysis).then(({ investigation }) => {
      if (!current) return;
      replaceInvestigation(investigation);
      setStorageError('');
      setStorageStatus('Analysis metadata saved locally. The source file was not copied.');
    }).catch((cause: unknown) => {
      if (current) setStorageError(cause instanceof Error ? cause.message : 'Analysis metadata could not be saved.');
    });
    return () => { current = false; };
  }, [activeInvestigation?.id, analysis?.sha256, inspection?.id, replaceInvestigation]);

  const updateActive = useCallback(async (update: (record: Investigation) => Investigation) => {
    if (!activeInvestigation) return;
    try {
      const updated = await updateInvestigation(activeInvestigation.id, update);
      if (!updated) throw new Error('This investigation is no longer available in local storage.');
      replaceInvestigation(updated);
      setStorageError('');
      setStorageStatus('Saved locally.');
    } catch (cause) {
      setStorageError(cause instanceof Error ? cause.message : 'Investigation changes could not be saved.');
    }
  }, [activeInvestigation, replaceInvestigation]);

  async function createNewInvestigation(name: string) {
    try {
      const created = await createInvestigation(name);
      replaceInvestigation(created);
      setActiveInvestigation(created);
      setStorageError('');
      setStorageStatus('Investigation created locally.');
    } catch (cause) {
      setStorageError(cause instanceof Error ? cause.message : 'Investigation could not be created.');
    }
  }

  function chooseInvestigation(id: string) {
    if (!id) { setActiveInvestigation(null); setStorageStatus('One-off session · nothing is persisted until an investigation is opened.'); return; }
    const selected = investigations.find((item) => item.id === id);
    if (selected) { setActiveInvestigation(selected); setStorageError(''); setStorageStatus('Investigation opened.'); }
  }

  async function removeActiveInvestigation() {
    if (!activeInvestigation) return;
    const removedId = activeInvestigation.id;
    try {
      await deleteInvestigation(removedId);
      setInvestigations((items) => items.filter((item) => item.id !== removedId));
      setActiveInvestigation(null);
      setBookmarkDraft(null);
      setStorageStatus('Investigation deleted.');
      setStorageError('');
    } catch (cause) {
      setStorageError(cause instanceof Error ? cause.message : 'Investigation could not be deleted.');
    }
  }

  async function addBookmark(draft: BookmarkDraft, label: string, note: string) {
    if (!activeInvestigation || !analysis || !label.trim()) return;
    const file = activeInvestigation.files.find((item) => isMatchingFile(item, analysis));
    if (!file) { setStorageError('The current file fingerprint is not part of this investigation.'); return; }
    const bookmark = createBookmark(file, draft.range, draft.kind, label, note);
    await updateActive((record) => ({ ...record, files: record.files.map((item) => item.id === file.id
      ? { ...item, bookmarks: [...item.bookmarks, bookmark] } : item) }));
    setBookmarkDraft(null);
  }

  async function editBookmark(fileId: string, bookmarkId: string, label: string, note: string) {
    await updateActive((record) => ({ ...record, files: record.files.map((file) => file.id !== fileId ? file : {
      ...file, bookmarks: file.bookmarks.map((bookmark) => bookmark.id === bookmarkId ? { ...bookmark, label: label.trim().slice(0, 120), note: note.slice(0, 4_000) } : bookmark),
    }) }));
  }

  async function removeBookmark(fileId: string, bookmarkId: string) {
    await updateActive((record) => ({ ...record, files: record.files.map((file) => file.id === fileId ? {
      ...file, bookmarks: file.bookmarks.filter((bookmark) => bookmark.id !== bookmarkId),
    } : file) }));
  }

  async function saveComparison(secondIdentity: FileIdentity, structure: StructureReport, secondRegionCount: number, result: FileComparison) {
    if (!activeInvestigation || !analysis) return;
    try {
      const saved = await recordComparison(activeInvestigation.id, analysis, secondIdentity,
        result.files[1].sha256, result.files[1].entropy, structure, secondRegionCount, result);
      replaceInvestigation(saved);
      setStorageError('');
      setStorageStatus('Comparison summary and both file fingerprints saved in this investigation.');
    } catch (cause) {
      setStorageError(cause instanceof Error ? cause.message : 'Comparison metadata could not be saved.');
    }
  }

  function navigateBookmark(file: InvestigationFile, bookmark: InvestigationBookmark) {
    if (!analysis || !isMatchingFile(file, analysis) || bookmark.sha256 !== analysis.sha256 || bookmark.fileId !== file.id
      || !Number.isSafeInteger(bookmark.offset) || !Number.isSafeInteger(bookmark.length) || bookmark.offset < 0
      || bookmark.length < 1 || bookmark.offset > analysis.size || bookmark.length > analysis.size - bookmark.offset) {
      setStorageStatus('Choose and analyze the source whose SHA-256 matches this bookmark before navigating.');
      return;
    }
    const source: SelectionSource = bookmark.kind === 'structure' ? 'structure'
      : bookmark.kind === 'string' ? 'strings'
        : bookmark.kind === 'search' ? 'search' : 'hex';
    setNavigationRequest({ range: { offset: bookmark.offset, length: bookmark.length }, source, token: ++navigationSequence.current });
    setInvestigationOpen(false);
  }

  const reportSelection = useCallback((selection: SharedSelection | null) => setBookmarkSelection(selection), []);
  async function exportReport(format: 'json' | 'html') {
    setReportFeedback(null);
    try {
      const path = await downloadReport(inspection!.data, format, reportContextFor(activeInvestigation, inspection!.data));
      setReportFeedback({ label: path ? 'Saved to Downloads' : 'Download started', detail: path ?? '', error: false });
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message
        : typeof cause === 'string' ? cause
          : cause && typeof cause === 'object' && 'message' in cause ? String(cause.message)
            : String(cause);
      setReportFeedback({ label: `Export failed: ${detail}`, detail, error: true });
    }
  }
  const requestBookmark = () => {
    const selected = bookmarkSelection;
    if (!selected || !analysis) { setStorageStatus('Select a byte range in a completed file first.'); setInvestigationOpen(true); return; }
    const region = analysis.regions.find((item) => selected.range.offset >= item.offset && selected.range.offset - item.offset < item.length);
    const kind: BookmarkKind = selected.source === 'structure' ? 'structure'
      : selected.source === 'strings' ? 'string'
        : selected.source === 'search' ? 'search'
          : selected.range.length === 1 ? 'byte' : 'range';
    setBookmarkDraft({ range: selected.range, kind, structureLabel: kind === 'structure' ? region?.label : undefined });
    setInvestigationOpen(true);
  };

  const liveRun = run && run.status !== 'complete' ? run : null;
  const display = liveRun ? displayForRun(liveRun) : inspection?.data;
  const activeFile = processingRun?.file ?? run?.file ?? inspection?.file;
  const sample = run?.sample ?? inspection?.sample ?? false;
  const key = run?.jobId ?? inspection?.id;
  const canBookmark = !!activeInvestigation && !!analysis && !!bookmarkSelection;
  return <main className={'workspace' + (activating ? ' igniting' : '') + (shuttingDown ? ' powering-down' : '')}>
    <header className="workspace-header">
      <div className="workspace-identity">
        <button type="button" className="workspace-back" onClick={back} aria-label="Return to Spectre launcher" title="Return to launcher (Esc)"><Icon name="back" /> <span>SPECTRE</span></button>
        <span className="identity-divider" aria-hidden="true">/</span>
        <h1 tabIndex={-1} ref={titleRef}><span className="module-mark" aria-hidden="true" />BLACKBOX</h1>
      </div>
      <div className="workspace-controls">
        {inspection && <button type="button" className="quiet-button" onClick={() => { setInvestigationOpen(false); setComparisonOpen(true); }} title="Compare this file with another">Compare</button>}
        <button type="button" className="quiet-button investigation-toggle" aria-expanded={investigationOpen}
          onClick={() => setInvestigationOpen((value) => !value)} title="Open local investigations">
          <span className="investigation-indicator" aria-hidden="true" />{activeInvestigation ? activeInvestigation.name || 'Untitled investigation' : 'Investigation'}
        </button>
        {activeInvestigation && <button type="button" className="quiet-button" onClick={requestBookmark} disabled={!canBookmark} title="Bookmark the current byte selection">Bookmark</button>}
        <button type="button" className="quiet-button" onClick={openSample} title="Load the bundled RIFF/WAVE sample">Sample</button>
        {activeFile && <button type="button" className="quiet-button" onClick={reanalyze} disabled={pending}>Reanalyze</button>}
        {inspection && processingRun?.status === 'complete' && <div className="report-controls" aria-label="Export analysis report">
          <button type="button" className="quiet-button" onClick={() => void exportReport('json')}>JSON</button>
          <button type="button" className="quiet-button" onClick={() => void exportReport('html')}>HTML</button>
          {reportFeedback && <span className={'report-feedback' + (reportFeedback.error ? ' is-error' : '')}
            role={reportFeedback.error ? 'alert' : 'status'} aria-label={reportFeedback.detail || reportFeedback.label}
            title={reportFeedback.detail || reportFeedback.label}>{reportFeedback.label}</span>}
        </div>}
        <button type="button" className="open-button" onClick={open}><Icon name="open" /> Open file</button>
      </div>
    </header>
    {investigationOpen && <InvestigationPanel investigations={investigations} active={activeInvestigation} analysis={analysis}
      draft={bookmarkDraft} error={storageError} status={storageStatus} onClose={() => setInvestigationOpen(false)}
      onCreate={(name) => void createNewInvestigation(name)} onSelect={chooseInvestigation}
      onRename={(name) => void updateActive((record) => ({ ...record, name: name.trim().slice(0, 100) }))}
      onDelete={() => void removeActiveInvestigation()}
      onNotes={(notes) => void updateActive((record) => ({ ...record, notes: notes.slice(0, 20_000) }))}
      onFileNotes={(fileId, notes) => void updateActive((record) => ({ ...record, files: record.files.map((file) => file.id === fileId ? { ...file, notes: notes.slice(0, 8_000) } : file) }))}
      onAddBookmark={(draft, label, note) => void addBookmark(draft, label, note)}
      onNavigate={navigateBookmark} onRestore={(file) => restoreFile(file)}
      onEditBookmark={(fileId, bookmarkId, label, note) => void editBookmark(fileId, bookmarkId, label, note)}
      onDeleteBookmark={(fileId, bookmarkId) => void removeBookmark(fileId, bookmarkId)} />}
    {run && <AnalysisStatus run={run} processing={processingRun ?? run} cancel={cancel} />}
    {!run && error && <div className="workspace-error" role="alert">{error}</div>}
    {display && activeFile ? <InspectionCanvas key={key} file={activeFile} data={display} sample={sample} run={liveRun}
      processingRun={processingRun} searchRef={searchRef} onSelectionChange={reportSelection} navigateTo={navigationRequest} /> : !pending && <EmptyWorkspaceCanvas />}
    {comparisonOpen && inspection && <ComparisonOverlay firstFile={inspection.file} firstAnalysis={inspection.data}
      canAnnotate={!!activeInvestigation} onClose={() => setComparisonOpen(false)}
      onBookmark={(range) => {
        setBookmarkDraft({ range, kind: 'difference' });
        setComparisonOpen(false);
        setInvestigationOpen(true);
      }} onComplete={saveComparison} />}
  </main>;
}
