import { useEffect, useRef, useState } from 'react';
import { Icon } from '../icons';
import { byteSize, hex } from './model';
import type { Analysis, ByteRange, FileIdentity, Region, StructureReport } from './model';
import { compareFiles } from './fileCompare';
import type { FileComparison } from './fileCompare';
import { identifyFile, inspectFileStructure } from './analysis';

const DISPLAY_BYTES = 256;
const DIFFERENCE_PAGE = 64;

export function ComparisonOverlay({ firstFile, firstAnalysis, canAnnotate, onClose, onBookmark, onComplete }: {
  firstFile: File;
  firstAnalysis: Analysis;
  canAnnotate: boolean;
  onClose: () => void;
  onBookmark: (range: ByteRange) => void;
  onComplete: (secondIdentity: FileIdentity, secondStructure: StructureReport, secondRegionCount: number, result: FileComparison) => Promise<void> | void;
}) {
  const [secondFile, setSecondFile] = useState<File | null>(null);
  const [secondIdentity, setSecondIdentity] = useState<FileIdentity | null>(null);
  const [secondRegions, setSecondRegions] = useState<Region[]>([]);
  const [result, setResult] = useState<FileComparison | null>(null);
  const [status, setStatus] = useState('Select a second local file to begin an offset-aligned comparison.');
  const [error, setError] = useState('');
  const [progress, setProgress] = useState({ processed: 0, total: 1 });
  const [working, setWorking] = useState(false);
  const [differenceIndex, setDifferenceIndex] = useState(0);
  const [differencePage, setDifferencePage] = useState(0);
  const [viewOffset, setViewOffset] = useState(0);
  const [windowBytes, setWindowBytes] = useState<{ offset: number; first: Uint8Array; second: Uint8Array }>();
  const input = useRef<HTMLInputElement>(null);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const selectedDifference = result?.differences[differenceIndex] ?? null;
  const maxSize = Math.max(firstFile.size, secondFile?.size ?? 0);
  const viewStart = Math.floor(viewOffset / DISPLAY_BYTES) * DISPLAY_BYTES;

  useEffect(() => {
    if (!secondFile) { setWindowBytes(undefined); return; }
    let active = true;
    const end = Math.min(maxSize, viewStart + DISPLAY_BYTES);
    Promise.all([
      firstFile.slice(viewStart, Math.min(firstFile.size, end)).arrayBuffer(),
      secondFile.slice(viewStart, Math.min(secondFile.size, end)).arrayBuffer(),
    ]).then(([first, second]) => {
      if (active) setWindowBytes({ offset: viewStart, first: new Uint8Array(first), second: new Uint8Array(second) });
    }).catch(() => { if (active) setWindowBytes(undefined); });
    return () => { active = false; };
  }, [firstFile, secondFile, viewStart, maxSize]);

  async function startComparison(file: File) {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setSecondFile(file);
    setSecondIdentity(null);
    setSecondRegions([]);
    setResult(null);
    setError('');
    setDifferenceIndex(0);
    setDifferencePage(0);
    setViewOffset(0);
    setProgress({ processed: 0, total: Math.max(1, firstFile.size, file.size) });
    setWorking(true);
    try {
      setStatus('Identifying second file from its bounded signature prefix…');
      const identity = await identifyFile(file);
      if (controller.signal.aborted) return;
      setSecondIdentity(identity);
      setStatus('Comparing actual bytes at matching offsets…');
      const comparison = await compareFiles(firstFile, file, controller.signal, (next) => setProgress(next));
      if (controller.signal.aborted) return;
      setStatus('Reading second file structure…');
      const parsed = await inspectFileStructure(file, identity, controller.signal);
      if (controller.signal.aborted) return;
      setSecondRegions(parsed.regions);
      setResult(comparison);
      setStatus(comparison.identical ? 'All bytes match at every offset.' : `${comparison.differingBytes.toLocaleString('en')} differing byte offsets found.`);
      await onComplete(identity, parsed.structure, parsed.regions.length, comparison);
    } catch (cause) {
      if (controller.signal.aborted) setStatus('Comparison cancelled.');
      else setError(cause instanceof Error ? cause.message : 'The files could not be compared.');
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        setWorking(false);
      }
    }
  }

  function selectDifference(index: number) {
    if (!result?.differences.length) return;
    const normalized = (index + result.differences.length) % result.differences.length;
    setDifferenceIndex(normalized);
    const range = result.differences[normalized];
    setViewOffset(range.offset);
    setDifferencePage(Math.floor(normalized / DIFFERENCE_PAGE));
  }

  const currentOffset = selectedDifference?.offset ?? viewOffset;
  const firstRegion = firstAnalysis.regions.find((region) => region.offset <= currentOffset && currentOffset - region.offset < region.length);
  const secondRegion = secondRegions.find((region) => region.offset <= currentOffset && currentOffset - region.offset < region.length);
  const differencePageCount = result ? Math.ceil(result.differences.length / DIFFERENCE_PAGE) : 0;
  const pageDifferences = result?.differences.slice(differencePage * DIFFERENCE_PAGE, (differencePage + 1) * DIFFERENCE_PAGE) ?? [];

  return <div className="comparison-scrim">
    <section className="comparison-overlay" role="dialog" aria-modal="true" aria-label="Binary comparison">
      <header className="comparison-heading">
        <div><span>BLACKBOX / TWO FILES</span><h2>Binary comparison</h2></div>
        <div className="comparison-heading-actions">
          <button type="button" className="quiet-button" onClick={() => input.current?.click()} disabled={working}>{secondFile ? 'Choose another file' : 'Select second file'}</button>
          <button type="button" className="icon-button" aria-label="Close comparison" onClick={() => { controllerRef.current?.abort(); onClose(); }}><Icon name="close" /></button>
        </div>
      </header>
      <input ref={input} type="file" hidden aria-label="Select comparison file" onChange={(event) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (file) void startComparison(file);
      }} />
      <div className="comparison-identity-grid">
        <FileIdentityBlock label="A · CURRENT FILE" name={firstAnalysis.name} size={firstAnalysis.size} type={firstAnalysis.type}
          sha256={firstAnalysis.sha256} entropy={firstAnalysis.averageEntropy} />
        <FileIdentityBlock label="B · COMPARISON FILE" name={secondIdentity?.name ?? secondFile?.name ?? 'Awaiting file'}
          size={secondIdentity?.size ?? secondFile?.size ?? 0} type={secondIdentity?.type ?? '—'}
          sha256={result?.files[1].sha256 ?? '—'} entropy={result?.files[1].entropy ?? 0} />
      </div>
      <div className="comparison-operation" role={error ? 'alert' : 'status'}>
        <span>{error || status}</span>
        {working && <>
          <progress aria-label="Binary comparison progress" value={progress.processed} max={progress.total} />
          <span>{byteSize(progress.processed)} / {byteSize(progress.total)}</span>
          <button type="button" className="quiet-button" onClick={() => controllerRef.current?.abort()}>Cancel</button>
        </>}
      </div>

      {result && <>
        <div className="comparison-summary">
          <span><small>MODE</small><strong>OFFSET-ALIGNED</strong></span>
          <span><small>RESULT</small><strong className={result.identical ? 'comparison-equal' : 'comparison-different'}>{result.identical ? 'BYTE IDENTICAL' : 'DIFFERENT'}</strong></span>
          <span><small>DIFFERENT OFFSETS</small><strong>{result.differingBytes.toLocaleString('en')}</strong></span>
          <span><small>CONTIGUOUS RANGES</small><strong>{result.differenceRangeCount.toLocaleString('en')}{result.omittedDifferenceRanges ? ` · ${result.omittedDifferenceRanges.toLocaleString('en')} ranges omitted from navigation` : ''}</strong></span>
        </div>
        {!result.identical && <p className="comparison-limitation">Offset-aligned comparison treats bytes at the same offset as counterparts. Insertions and deletions shift later offsets; this view does not perform insertion-aware alignment.</p>}
        <div className="comparison-navigation">
          <div><button type="button" className="quiet-button" disabled={!result.differences.length} onClick={() => selectDifference(differenceIndex - 1)}>Previous difference</button>
            <button type="button" className="quiet-button" disabled={!result.differences.length} onClick={() => selectDifference(differenceIndex + 1)}>Next difference</button></div>
          <span>{result.differences.length ? `${differenceIndex + 1} / ${result.differences.length} retained ranges` : 'No differing ranges'}</span>
          <button type="button" className="quiet-button" disabled={!selectedDifference || !canAnnotate}
            onClick={() => selectedDifference && onBookmark(selectedDifference)} title="Bookmark this differing range on file A">Bookmark difference on A</button>
        </div>
        <div className="comparison-context">
          <span>A REGION · {firstRegion?.label ?? 'No decoded region'}</span>
          <span>B REGION · {secondRegion?.label ?? 'No decoded region'}</span>
        </div>
        <div className="comparison-hex-grid">
          <HexComparisonColumn label="A · CURRENT FILE" fileName={firstAnalysis.name} start={viewStart} maxSize={maxSize}
            bytes={windowBytes?.offset === viewStart ? windowBytes.first : undefined}
            otherBytes={windowBytes?.offset === viewStart ? windowBytes.second : undefined} />
          <HexComparisonColumn label="B · COMPARISON FILE" fileName={secondFile?.name ?? ''} start={viewStart} maxSize={maxSize}
            bytes={windowBytes?.offset === viewStart ? windowBytes.second : undefined}
            otherBytes={windowBytes?.offset === viewStart ? windowBytes.first : undefined} />
        </div>
        <div className="comparison-hex-controls">
          <button type="button" className="quiet-button" disabled={viewStart === 0} onClick={() => setViewOffset(Math.max(0, viewStart - DISPLAY_BYTES))}>Previous byte window</button>
          <span>VIEW {hex(viewStart, Math.max(8, (Math.max(maxSize - 1, 0)).toString(16).length))} · {byteSize(Math.min(DISPLAY_BYTES, Math.max(0, maxSize - viewStart)))}</span>
          <button type="button" className="quiet-button" disabled={viewStart + DISPLAY_BYTES >= maxSize} onClick={() => setViewOffset(viewStart + DISPLAY_BYTES)}>Next byte window</button>
        </div>
        {result.differences.length > 0 && <div className="comparison-difference-list">
          <div className="investigation-section-title"><span>DIFFERENCE RANGES · FIRST 10,000 RETAINED</span><span>{differencePage + 1} / {differencePageCount}</span></div>
          <div className="comparison-difference-rows">
            {pageDifferences.map((range, index) => {
              const actualIndex = differencePage * DIFFERENCE_PAGE + index;
              return <button type="button" key={range.offset} aria-pressed={actualIndex === differenceIndex}
                onClick={() => selectDifference(actualIndex)}>
                <span>{hex(range.offset, Math.max(8, (Math.max(maxSize - 1, 0)).toString(16).length))}</span>
                <span>{range.length.toLocaleString('en')} byte{range.length === 1 ? '' : 's'}</span>
              </button>;
            })}
          </div>
          <div className="comparison-page-controls">
            <button type="button" className="quiet-button" disabled={differencePage === 0} onClick={() => setDifferencePage((page) => page - 1)}>Previous range page</button>
            <button type="button" className="quiet-button" disabled={differencePage + 1 >= differencePageCount} onClick={() => setDifferencePage((page) => page + 1)}>Next range page</button>
          </div>
        </div>}
      </>}
    </section>
  </div>;
}

function FileIdentityBlock({ label, name, size, type, sha256, entropy }: {
  label: string; name: string; size: number; type: string; sha256: string; entropy: number;
}) {
  return <div className="comparison-file-identity">
    <span>{label}</span><strong title={name}>{name}</strong>
    <div><span>{byteSize(size)}</span><span>{type}</span><span>{entropy.toFixed(2)} bits/B</span></div>
    <code title={sha256}>{sha256}</code>
  </div>;
}

function HexComparisonColumn({ label, fileName, start, maxSize, bytes, otherBytes }: {
  label: string; fileName: string; start: number; maxSize: number; bytes?: Uint8Array; otherBytes?: Uint8Array;
}) {
  const rows = bytes ? Math.ceil(Math.max(bytes.length, otherBytes?.length ?? 0) / 16) : 0;
  return <section className="comparison-hex-column" aria-label={`${label} hexadecimal view`}>
    <header><span>{label}</span><span title={fileName}>{fileName}</span></header>
    {bytes && otherBytes ? <div className="comparison-hex-lines">
      {Array.from({ length: rows }, (_, rowIndex) => {
        const rowStart = rowIndex * 16;
        const rowBytes = bytes.subarray(rowStart, rowStart + 16);
        const rowOther = otherBytes.subarray(rowStart, rowStart + 16);
        const offset = start + rowStart;
        return <div className="comparison-hex-row" key={offset}>
          <span className="comparison-hex-offset">{hex(offset, Math.max(8, (Math.max(maxSize - 1, 0)).toString(16).length))}</span>
          <span className="comparison-hex-byte-grid">
            {Array.from({ length: 16 }, (_, column) => {
              const value = rowBytes[column];
              const other = rowOther[column];
              const present = value !== undefined && start + rowStart + column < maxSize;
              const different = value !== other;
              return <span key={column} className={different ? 'comparison-byte-different' : ''}>{present ? hex(value) : '··'}</span>;
            })}
          </span>
          <span className="comparison-hex-ascii">{Array.from(rowBytes, (value, column) => {
            const other = rowOther[column];
            return <span key={column} className={value !== other ? 'comparison-byte-different' : ''}>{value >= 32 && value < 127 ? String.fromCharCode(value) : '·'}</span>;
          })}</span>
        </div>;
      })}
    </div> : <div className="comparison-hex-loading">Reading the selected byte window…</div>}
  </section>;
}
