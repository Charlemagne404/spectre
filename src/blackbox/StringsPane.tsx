import { useEffect, useMemo, useRef, useState } from 'react';
import type { Ref } from 'react';
import { Icon } from '../icons';
import { hex } from './model';
import { intersects } from './model';
import type { ByteRange, FileString } from './model';
import { Pane } from './Pane';

const PAGE_SIZE = 100;
const REMOTE_PAGE_LIMIT = 500;

type SearchWorkerMessage =
  | { type: 'PROGRESS'; jobId: number; scannedBytes: number; totalBytes: number }
  | { type: 'PAGE'; jobId: number; matches: FileString[]; complete: boolean; limitReached: boolean; scannedBytes: number; totalBytes: number }
  | { type: 'ERROR'; jobId: number; message: string };

export function StringsPane({ file, jobId, strings, total, indexLimitReached, selection, contextRange, emptyMessage, searchReady, searchComplete, select, searchRef }: {
  file: File;
  jobId: number;
  strings: FileString[];
  total: number;
  indexLimitReached: boolean;
  selection: ByteRange | null;
  contextRange: ByteRange | null;
  emptyMessage: string;
  searchReady: boolean;
  searchComplete: boolean;
  select: (range: ByteRange, source: 'strings') => void;
  searchRef: Ref<HTMLInputElement>;
}) {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [remotePages, setRemotePages] = useState<FileString[][]>([]);
  const [remoteReady, setRemoteReady] = useState(false);
  const [remoteComplete, setRemoteComplete] = useState(true);
  const [remoteLimitReached, setRemoteLimitReached] = useState(false);
  const [remoteSearching, setRemoteSearching] = useState(false);
  const [remoteStatus, setRemoteStatus] = useState('');
  const [remoteError, setRemoteError] = useState('');
  const remoteWorker = useRef<Worker | null>(null);
  const searchSequence = useRef(0);
  const remotePageCount = useRef(0);
  const query = search.trim();
  const indexedMatches = useMemo(() => {
    const contextual = contextRange ? strings.filter((item) => intersects(item, contextRange)) : strings;
    const normalized = query.toLowerCase();
    return normalized ? contextual.filter(({ text }) => text.toLowerCase().includes(normalized)) : contextual;
  }, [contextRange, strings, query]);
  const needsRemoteSearch = !!query && searchComplete && (total > strings.length || indexLimitReached);

  useEffect(() => {
    const sequence = ++searchSequence.current;
    remoteWorker.current?.terminate();
    remoteWorker.current = null;
    remotePageCount.current = 0;
    setRemotePages([]);
    setRemoteReady(false);
    setRemoteComplete(!needsRemoteSearch);
    setRemoteLimitReached(false);
    setRemoteSearching(false);
    setRemoteStatus('');
    setRemoteError('');
    if (!needsRemoteSearch) return;

    setRemoteComplete(false);
    setRemoteSearching(true);
    setRemoteStatus('Searching the full file…');
    const timer = window.setTimeout(() => {
      if (searchSequence.current !== sequence) return;
      try {
        const worker = new Worker(new URL('./stringSearch.worker.ts', import.meta.url), { type: 'module' });
        remoteWorker.current = worker;
        worker.onmessage = ({ data }: MessageEvent<SearchWorkerMessage>) => {
          if (searchSequence.current !== sequence || data.jobId !== sequence) return;
          if (data.type === 'PROGRESS') {
            const percent = data.totalBytes ? Math.min(100, Math.floor(data.scannedBytes / data.totalBytes * 100)) : 100;
            setRemoteStatus(`Searching the full file… ${percent}%`);
          } else if (data.type === 'PAGE') {
            remotePageCount.current++;
            const pageNumber = remotePageCount.current;
            setRemotePages((current) => current.length >= REMOTE_PAGE_LIMIT ? current : [...current, data.matches]);
            setRemoteReady(true);
            setRemoteComplete(data.complete);
            setRemoteLimitReached(data.limitReached || pageNumber >= REMOTE_PAGE_LIMIT && !data.complete);
            setRemoteSearching(false);
            setRemoteStatus(data.complete ? 'Full-file search complete' : 'Full-file matches · more available');
            setPage(0);
            if (data.complete || data.limitReached || pageNumber >= REMOTE_PAGE_LIMIT) {
              worker.terminate();
              if (remoteWorker.current === worker) remoteWorker.current = null;
            }
          } else {
            setRemoteSearching(false);
            setRemoteError(data.message);
            setRemoteStatus('');
          }
        };
        worker.onerror = () => {
          if (searchSequence.current !== sequence) return;
          setRemoteSearching(false);
          setRemoteError('Full-file string search could not start.');
          setRemoteStatus('');
        };
        worker.postMessage({
          type: 'START', jobId: sequence, file, query, pageSize: PAGE_SIZE, maxMatches: PAGE_SIZE * REMOTE_PAGE_LIMIT,
          contextRange,
        });
      } catch {
        setRemoteSearching(false);
        setRemoteError('Full-file string search could not start.');
        setRemoteStatus('');
      }
    }, 180);

    return () => {
      window.clearTimeout(timer);
      if (remoteWorker.current) remoteWorker.current.terminate();
      remoteWorker.current = null;
    };
  }, [file, jobId, query, searchComplete, strings.length, total, contextRange?.offset, contextRange?.length, needsRemoteSearch]);

  const remoteActive = needsRemoteSearch && remoteReady && !remoteError;
  const pageCount = remoteActive ? remotePages.length : Math.ceil(indexedMatches.length / PAGE_SIZE);
  const visible = remoteActive ? remotePages[page] ?? [] : indexedMatches.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const canScanMore = needsRemoteSearch && !remoteComplete && !remoteLimitReached;
  const hasNext = page + 1 < pageCount || canScanMore && !remoteSearching;
  const togglePage = (next: number) => { setCursor(0); setPage(next); };

  function nextPage() {
    if (page + 1 < pageCount) {
      togglePage(page + 1);
      return;
    }
    if (canScanMore && !remoteSearching) {
      if (remotePages.length >= REMOTE_PAGE_LIMIT) {
        setRemoteLimitReached(true);
        setRemoteStatus('Search result limit reached · refine the filter to narrow results');
        remoteWorker.current?.terminate();
        remoteWorker.current = null;
        return;
      }
      setRemoteSearching(true);
      setRemoteStatus('Searching for the next page…');
      remoteWorker.current?.postMessage({ type: 'NEXT_PAGE', jobId: searchSequence.current });
    }
  }

  useEffect(() => {
    if (!selection || search) return;
    const index = indexedMatches.findIndex((item) => intersects(item, selection));
    if (index >= 0) setPage(Math.floor(index / PAGE_SIZE));
  }, [indexedMatches, search, selection?.length, selection?.offset]);

  const footer = indexLimitReached
    ? `${strings.length.toLocaleString('en')} entry index limit reached · filter scans the full file`
    : total > strings.length
    ? `${strings.length.toLocaleString('en')} indexed of ${total.toLocaleString('en')} · filter scans the full file`
    : 'ASCII + UTF-16LE · 5+ CHARS';
  const visibleCount = remoteActive ? remotePages.reduce((sum, batch) => sum + batch.length, 0) : indexedMatches.length;

  return <Pane name="Strings" className="strings-pane" actions={<span className="readout" title={remoteStatus || undefined}>{visibleCount.toLocaleString('en')}</span>}>
    <label className="strings-search">
      <Icon name="search" /><input ref={searchRef} type="search" placeholder="Filter strings" aria-label="Filter strings"
        spellCheck={false} maxLength={256} disabled={!searchReady} value={search} onChange={(event) => { setSearch(event.target.value); togglePage(0); }} />
    </label>
    <div className="string-columns" aria-hidden="true"><span>Offset</span><span>Text</span></div>
    <div className="strings-list" aria-label="Extracted strings"
      onKeyDown={(event) => {
        const direction = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
        if (!direction) return;
        const next = Math.max(0, Math.min(visible.length - 1, cursor + direction));
        event.preventDefault();
        event.currentTarget.querySelectorAll('button')[next]?.focus();
      }}>
      {visible.map((item, index) => <button key={item.offset + ':' + item.encoding} type="button" className={'string-row' + (selection && intersects(item, selection) ? ' string-active' : '')}
        tabIndex={index === cursor ? 0 : -1}
        aria-pressed={!!selection && intersects(item, selection)}
        title={item.encoding + ' · ' + item.text} onFocus={() => setCursor(index)} onClick={() => select(item, 'strings')}>
        <span>{hex(item.offset, 8)}</span><span>{item.text}{item.text.length < (item.encoding === 'UTF-16LE' ? item.length / 2 : item.length) ? '…' : ''}</span>
      </button>)}
      {!visible.length && <div className="empty-state">{remoteSearching ? remoteStatus || 'Searching the full file…'
        : remoteError ? remoteError
          : search ? searchComplete && remoteComplete ? 'No matching strings.' : 'No matching strings yet.' : emptyMessage}</div>}
    </div>
    <footer className="strings-footer">
      <span title={footer}>{contextRange ? 'STRUCTURE REGION · ' : ''}{total > strings.length && !query ? footer : remoteStatus || footer}</span>
      {(pageCount > 1 || needsRemoteSearch) && <div className="strings-pagination">
        <button type="button" className="icon-button" aria-label="Previous strings page" disabled={page === 0} onClick={() => togglePage(page - 1)}><Icon name="left" /></button>
        <span>{pageCount ? `${page + 1}/${pageCount}${canScanMore ? '+' : ''}` : remoteSearching ? 'SCAN' : '0'}</span>
        <button type="button" className="icon-button" aria-label="Next strings page" disabled={!hasNext} onClick={nextPage}><Icon name="right" /></button>
      </div>}
    </footer>
    {remoteLimitReached && <span className="visually-hidden" role="status">Search results are capped at 50,000 matches per query. Refine the filter to continue.</span>}
  </Pane>;
}
