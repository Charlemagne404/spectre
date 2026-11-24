import { useEffect, useRef, useState } from 'react';
import { address } from './model';
import type { ByteRange } from './model';
import { scanEmbeddedSignatures } from './embeddedSignatures';
import type { EmbeddedFinding, EmbeddedScanProgress } from './embeddedSignatures';

const PAGE_SIZE = 48;

export function EmbeddedSignaturesPane({ file, select }: {
  file: File;
  select: (range: ByteRange) => void;
}) {
  const [findings, setFindings] = useState<EmbeddedFinding[]>([]);
  const [progress, setProgress] = useState<EmbeddedScanProgress | null>(null);
  const [summary, setSummary] = useState('Scan on demand · source remains unchanged.');
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const [page, setPage] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const pageCount = Math.max(1, Math.ceil(findings.length / PAGE_SIZE));

  useEffect(() => () => controller.current?.abort(), [file]);

  async function scan() {
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    setRunning(true);
    setFindings([]);
    setProgress({ phase: 'scanning', processed: 0, total: Math.max(1, file.size) });
    setSummary('Searching file bytes for known signatures…');
    setError('');
    setPage(0);
    try {
      const result = await scanEmbeddedSignatures(file, setProgress, next.signal);
      setFindings(result.findings);
      setSummary(result.totalCandidates === 0 ? 'No supported embedded signatures found.'
        : `${result.totalCandidates.toLocaleString('en')} signature candidates · ${result.omittedCandidates.toLocaleString('en')} omitted · ${result.validationsSkipped.toLocaleString('en')} not validated`);
    } catch (cause) {
      if (!(cause instanceof Error && cause.name === 'AbortError')) setError(cause instanceof Error ? cause.message : 'Embedded-signature scan failed.');
      setSummary('Scan cancelled · partial candidates were discarded.');
    } finally {
      setProgress(null);
      if (controller.current === next) { controller.current = null; setRunning(false); }
    }
  }

  function cancel() { controller.current?.abort(); }

  const visible = findings.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  return <details className="embedded-signatures">
    <summary>Embedded signatures <span>bounded scan</span></summary>
    <div className="embedded-signature-content">
      <div className="embedded-signature-controls">
        <span role="status">{summary}</span>
        {running
          ? <button type="button" className="quiet-button" onClick={cancel}>Cancel</button>
          : <button type="button" className="quiet-button" onClick={() => void scan()}>{findings.length ? 'Scan again' : 'Scan file'}</button>}
      </div>
      {progress && <div className="embedded-signature-progress" role="status">
        <span>{progress.phase === 'scanning' ? 'Scanning signatures' : 'Validating candidates'}</span>
        <progress aria-label="Embedded signature scan progress" value={progress.processed} max={Math.max(1, progress.total)} />
        <span>{Math.floor(progress.processed / Math.max(1, progress.total) * 100)}%</span>
      </div>}
      {error && <p role="alert" className="embedded-signature-error">{error}</p>}
      {visible.length > 0 && <>
        <div className="embedded-signature-list" aria-label="Embedded signature findings">
          {visible.map((finding) => <button type="button" key={`${finding.offset}:${finding.signature}`}
            onClick={() => select({ offset: finding.offset, length: Math.max(1, Math.min(finding.length ?? 1, file.size - finding.offset)) })}
            title={finding.note}>
            <span className={'embedded-status embedded-' + finding.classification}>{finding.classification.toUpperCase()}</span>
            <strong>{finding.format} · {finding.signature}</strong>
            <code>{address(finding.offset)}</code>
            <small>{finding.note}</small>
          </button>)}
        </div>
        {pageCount > 1 && <div className="embedded-signature-pages">
          <button type="button" className="quiet-button" disabled={page === 0} onClick={() => setPage((value) => Math.max(0, value - 1))}>Previous</button>
          <span>{page + 1} / {pageCount} · {findings.length} shown of capped candidates</span>
          <button type="button" className="quiet-button" disabled={page + 1 >= pageCount} onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))}>Next</button>
        </div>}
      </>}
      <p className="embedded-signature-footnote">Candidates may be false positives. Validation is structural and does not extract or execute content.</p>
    </div>
  </details>;
}
