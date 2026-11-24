import { useEffect, useRef, useState } from 'react';
import { Icon } from '../icons';
import { address, contains, hex, intersects } from './model';
import type { ByteRange, Region } from './model';
import { Pane } from './Pane';
import { findPattern, parseSearchPattern } from './byteSearch';
import type { BytePattern, SearchDirection, SearchMode, SearchProgress } from './byteSearch';
import { interpretData } from './numeric';
import type { ByteOrder, DataFormat } from './numeric';

const ROW_BYTES = 16;
const PAGE_BYTES = 64 * ROW_BYTES;
const COPY_LIMIT = 4096;
const DATA_READ_LIMIT = 64;
const columns = Array.from({ length: ROW_BYTES }, (_, index) => index);
const EMPTY_PREVIEW: number[] = [];
const FORMATS: Array<[DataFormat, string]> = [
  ['U8', 'U8'], ['I8', 'I8'], ['U16', 'U16'], ['I16', 'I16'], ['U32', 'U32'], ['I32', 'I32'],
  ['U64', 'U64'], ['I64', 'I64'], ['F32', 'F32'], ['F64', 'F64'], ['ASCII', 'ASCII'],
  ['UTF8', 'UTF-8'], ['UTF16LE', 'UTF-16LE'], ['BINARY', 'Binary'], ['HEX', 'Hex'],
  ['UNIX32', 'Unix time · 32'], ['UNIX64', 'Unix time · 64'], ['FILETIME64', 'Windows FILETIME'],
];
const formatWidth: Partial<Record<DataFormat, number>> = {
  U8: 1, I8: 1, U16: 2, I16: 2, U32: 4, I32: 4, U64: 8, I64: 8,
  F32: 4, F64: 8, UNIX32: 4, UNIX64: 8, FILETIME64: 8,
};
const endianFormats = new Set<DataFormat>(['U16', 'I16', 'U32', 'I32', 'U64', 'I64', 'F32', 'F64', 'UNIX32', 'UNIX64', 'FILETIME64']);

function patternKey(pattern: BytePattern) {
  return Array.from(pattern.bytes, (byte, index) => `${byte.toString(16).padStart(2, '0')}/${pattern.masks[index].toString(16).padStart(2, '0')}`).join('');
}

function progressLabel(progress: SearchProgress) {
  const percent = progress.total ? Math.floor(progress.processed / progress.total * 100) : 100;
  return `Searching · ${percent}% · ${progress.processed.toLocaleString('en')} / ${progress.total.toLocaleString('en')} candidate bytes`;
}

export function HexPane({ file, selection, firstByte, select, prefetched = EMPTY_PREVIEW, enabled = true,
  regions = [], emptyMessage = 'Byte window pending.' }: {
  file: File;
  selection: ByteRange | null;
  firstByte?: number;
  select: (range: ByteRange, source?: 'hex' | 'search') => void;
  prefetched?: number[];
  enabled?: boolean;
  regions?: Region[];
  emptyMessage?: string;
}) {
  const [focusOffset, setFocusOffset] = useState(selection?.offset ?? 0);
  const page = Math.floor(focusOffset / PAGE_BYTES);
  const start = page * PAGE_BYTES;
  const end = Math.min(start + PAGE_BYTES, file.size);
  const [data, setData] = useState<{ start: number; bytes: Uint8Array }>();
  const [dataBytes, setDataBytes] = useState<{ offset: number; length: number; bytes: Uint8Array | null }>();
  const [dataFormat, setDataFormat] = useState<DataFormat>('U8');
  const [byteOrder, setByteOrder] = useState<ByteOrder>('little');
  const [readError, setReadError] = useState<number>();
  const [jump, setJump] = useState('');
  const [jumpError, setJumpError] = useState(false);
  const [search, setSearch] = useState('');
  const [searchMode, setSearchMode] = useState<SearchMode>('hex');
  const [searchStatus, setSearchStatus] = useState('');
  const [searchError, setSearchError] = useState('');
  const [searching, setSearching] = useState(false);
  const [lastFind, setLastFind] = useState<{ key: string; offset: number; length: number } | null>(null);
  const [copyStatus, setCopyStatus] = useState('');
  const [canBack, setCanBack] = useState(false);
  const [canForward, setCanForward] = useState(false);
  const searchAbort = useRef<AbortController | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const row = useRef<HTMLDivElement>(null);
  const selectionAnchor = useRef(selection?.offset ?? 0);
  const selectionHead = useRef(selection?.offset ?? 0);
  const internalSelection = useRef<ByteRange | null>(null);
  const history = useRef<ByteRange[]>([]);
  const historyIndex = useRef(-1);
  const historyTraversal = useRef(false);
  const bytes = data?.start === start ? data.bytes : undefined;
  const width = Math.max(8, hex(Math.max(0, file.size - 1), 1).length);
  const selectedLength = selection ? Math.max(0, Math.min(selection.length, file.size - selection.offset)) : 0;
  const currentDataBytes = dataBytes?.offset === selection?.offset && dataBytes?.length === Math.min(selectedLength, DATA_READ_LIMIT)
    ? dataBytes?.bytes : undefined;
  const decoded = currentDataBytes instanceof Uint8Array ? interpretData(currentDataBytes, dataFormat, byteOrder) : null;
  const requiredLength = formatWidth[dataFormat] ?? 1;
  const dataLabel = !file.size ? 'NO BYTES'
    : !selection ? 'NO SELECTION'
      : currentDataBytes === undefined ? 'READING'
        : currentDataBytes === null ? 'UNAVAILABLE'
          : selectedLength < requiredLength ? `SELECT ${requiredLength} BYTE${requiredLength === 1 ? '' : 'S'}`
            : decoded?.value ?? 'UNAVAILABLE';
  const currentRegion = selection ? regions.find((region) => intersects(region, selection)) : undefined;

  useEffect(() => {
    let active = true;
    if (!enabled) {
      setData(undefined);
      setReadError(undefined);
      return () => { active = false; };
    }
    if (start === 0 && prefetched.length) {
      setData({ start: 0, bytes: new Uint8Array(prefetched) });
      return () => { active = false; };
    }
    file.slice(start, end).arrayBuffer().then((buffer) => {
      if (active) { setData({ start, bytes: new Uint8Array(buffer) }); setReadError(undefined); }
    }).catch(() => {
      if (active) setReadError(start);
    });
    return () => { active = false; };
  }, [file, start, end, prefetched, enabled]);

  useEffect(() => {
    let active = true;
    if (!enabled || !selection || !selectedLength) {
      setDataBytes(undefined);
      return () => { active = false; };
    }
    const length = Math.min(selectedLength, DATA_READ_LIMIT);
    file.slice(selection.offset, selection.offset + length).arrayBuffer().then((buffer) => {
      if (active) setDataBytes({ offset: selection.offset, length, bytes: new Uint8Array(buffer) });
    }).catch(() => {
      if (active) setDataBytes({ offset: selection.offset, length, bytes: null });
    });
    return () => { active = false; };
  }, [file, selection, selectedLength, enabled]);

  useEffect(() => () => searchAbort.current?.abort(), []);

  useEffect(() => {
    if (!selection) return;
    if (internalSelection.current === selection) {
      internalSelection.current = null;
      if (historyTraversal.current) historyTraversal.current = false;
      return;
    }
    selectionAnchor.current = selection.offset;
    selectionHead.current = selection.offset;
    setFocusOffset(selection.offset);
    setLastFind(null);
    recordHistory(selection);
    // External pane selections share this same range object through InspectionCanvas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection]);

  useEffect(() => {
    const viewport = scroll.current;
    const selected = row.current;
    if (!viewport || !selected) return;
    const outer = viewport.getBoundingClientRect();
    const inner = selected.getBoundingClientRect();
    if (inner.top < outer.top || inner.bottom > outer.bottom) viewport.scrollTop += inner.top - outer.top - 10;
  }, [focusOffset, bytes]);

  function recordHistory(range: ByteRange) {
    const current = history.current[historyIndex.current];
    if (current?.offset === range.offset && current.length === range.length) return;
    const next = history.current.slice(0, historyIndex.current + 1);
    next.push({ offset: range.offset, length: range.length });
    if (next.length > 128) next.shift();
    history.current = next;
    historyIndex.current = next.length - 1;
    setCanBack(historyIndex.current > 0);
    setCanForward(false);
  }

  function move(target: number, length = 1, options: { preserveFind?: boolean; extend?: boolean; source?: 'hex' | 'search' } = {}) {
    if (!file.size) return;
    if (!options.preserveFind) setLastFind(null);
    const bounded = Math.min(file.size - 1, Math.max(0, Math.trunc(target)));
    const anchor = options.extend ? selectionAnchor.current : bounded;
    const range = options.extend
      ? { offset: Math.min(anchor, bounded), length: Math.abs(anchor - bounded) + 1 }
      : { offset: bounded, length: Math.min(Math.max(1, length), file.size - bounded) };
    selectionAnchor.current = anchor;
    selectionHead.current = bounded;
    setFocusOffset(bounded);
    recordHistory(range);
    internalSelection.current = range;
    select(range, options.source ?? 'hex');
  }

  function traverseHistory(delta: -1 | 1) {
    const index = historyIndex.current + delta;
    const range = history.current[index];
    if (!range) return;
    historyIndex.current = index;
    historyTraversal.current = true;
    selectionAnchor.current = range.offset;
    selectionHead.current = range.offset;
    setFocusOffset(range.offset);
    setLastFind(null);
    internalSelection.current = range;
    select(range);
    setCanBack(index > 0);
    setCanForward(index < history.current.length - 1);
  }

  async function find(direction: SearchDirection) {
    searchAbort.current?.abort();
    const controller = new AbortController();
    searchAbort.current = controller;
    const pattern = parseSearchPattern(search, searchMode);
    if (!pattern) {
      setSearchError(searchMode === 'hex' ? 'Use byte pairs such as 50 4B ?? 04 (up to 64 bytes).' : 'Enter a valid, non-empty search string (up to 64 encoded bytes).');
      setSearchStatus('');
      return;
    }
    setSearchError('');
    setSearchStatus('Searching · 0%');
    setSearching(true);
    const key = searchMode + ':' + patternKey(pattern);
    try {
      const candidateCount = Math.max(0, file.size - pattern.bytes.length + 1);
      if (!candidateCount) {
        setSearchStatus('Pattern is longer than this file');
        setLastFind(null);
        return;
      }
      let from = Math.max(0, Math.min(candidateCount - 1, focusOffset));
      if (lastFind?.key === key) {
        from = direction === 'forward'
          ? (lastFind.offset + 1 >= candidateCount ? 0 : lastFind.offset + 1)
          : (lastFind.offset === 0 ? candidateCount - 1 : lastFind.offset - 1);
      }
      const found = await findPattern(file, pattern, from, direction, controller.signal, (progress) => {
        setSearchStatus(progressLabel(progress));
      });
      if (controller.signal.aborted) return;
      if (found < 0) {
        setSearchStatus('No match · scanned ' + file.size.toLocaleString('en') + ' bytes');
        setLastFind(null);
      } else {
        setLastFind({ key, offset: found, length: pattern.bytes.length });
        setSearchStatus(`Match ${address(found, width)} · ${pattern.bytes.length} bytes`);
        move(found, pattern.bytes.length, { preserveFind: true, source: 'search' });
        scroll.current?.focus();
      }
    } catch (error) {
      if (controller.signal.aborted) setSearchStatus('Search cancelled');
      else {
        setSearchError(error instanceof Error ? error.message : 'Byte search failed.');
        setSearchStatus('');
      }
    } finally {
      if (searchAbort.current === controller) {
        searchAbort.current = null;
        setSearching(false);
      }
    }
  }

  async function copySelection() {
    if (!selection) return;
    const length = Math.min(selection.length, COPY_LIMIT, file.size - selection.offset);
    try {
      const buffer = new Uint8Array(await file.slice(selection.offset, selection.offset + length).arrayBuffer());
      await navigator.clipboard.writeText(Array.from(buffer, (byte) => hex(byte)).join(' '));
      setCopyStatus(length < selection.length ? `Copied ${length.toLocaleString('en')} bytes` : 'Copied');
    } catch {
      setCopyStatus('Clipboard unavailable');
    }
    window.setTimeout(() => setCopyStatus(''), 1800);
  }

  const actions = <>
    <form className="hex-search-form" onSubmit={(event) => { event.preventDefault(); void find('forward'); }}>
      <select aria-label="Search encoding" value={searchMode} onChange={(event) => {
        setSearchMode(event.target.value as SearchMode); setSearchError(''); setSearchStatus(''); setLastFind(null);
      }} disabled={!enabled || !file.size}>
        <option value="hex">HEX</option><option value="ascii">ASCII</option><option value="utf8">UTF-8</option><option value="utf16le">UTF-16LE</option>
      </select>
      <input aria-label="Search bytes (hexadecimal)" title="Search bytes, text, or wildcard hex pairs"
        placeholder={searchMode === 'hex' ? 'Find bytes' : 'Find text'} value={search} onChange={(event) => {
          setSearch(event.target.value); setSearchError(''); setSearchStatus(''); setLastFind(null);
        }} disabled={!enabled || !file.size} spellCheck={false} />
      <button type="submit" className="icon-button" aria-label="Find next byte sequence" title="Find next byte sequence" disabled={!enabled || !file.size || searching}><Icon name="search" /></button>
      {(searchError || searchStatus) && <span className={searchError ? 'hex-search-error' : 'hex-search-status'} role={searchError ? 'alert' : 'status'}>{searchError || searchStatus}</span>}
    </form>
    <button type="button" className="icon-button" aria-label="Find previous match" title="Find previous match" disabled={!enabled || !file.size || searching} onClick={() => void find('backward')}><Icon name="left" /></button>
    {searching && <button type="button" className="icon-button" aria-label="Cancel byte search" title="Cancel search" onClick={() => searchAbort.current?.abort()}><Icon name="close" /></button>}
    <form className="jump-form" onSubmit={(event) => {
      event.preventDefault();
      const value = /^(?:0x)?[\da-f]+$/i.test(jump.trim()) ? Number.parseInt(jump.trim().replace(/^0x/i, ''), 16) : NaN;
      const invalid = !Number.isSafeInteger(value) || value >= file.size;
      setJumpError(invalid);
      if (!invalid) { move(value); setJump(''); scroll.current?.focus(); }
    }}>
      <input aria-label="Jump to hexadecimal offset" title="Enter a hexadecimal file offset" placeholder="Go to offset"
        value={jump} onChange={(event) => { setJumpError(false); setJump(event.target.value); }}
        aria-invalid={jumpError} aria-describedby={jumpError ? 'jump-error' : undefined} disabled={!enabled || !file.size} spellCheck={false} />
      <button className="icon-button" title="Jump to offset" aria-label="Jump to offset" disabled={!enabled || !file.size}><Icon name="jump" /></button>
      {jumpError && <span id="jump-error" role="alert">Enter a valid file offset</span>}
    </form>
    <div className="hex-history" aria-label="Byte navigation history">
      <button type="button" className="icon-button" title="Previous byte selection" aria-label="Previous byte selection" disabled={!canBack} onClick={() => traverseHistory(-1)}><Icon name="left" /></button>
      <button type="button" className="icon-button" title="Next byte selection" aria-label="Next byte selection" disabled={!canForward} onClick={() => traverseHistory(1)}><Icon name="right" /></button>
    </div>
    <div className="hex-pager">
      <button type="button" className="icon-button" title="Previous hex page" aria-label="Previous hex page" disabled={page === 0} onClick={() => move(start - PAGE_BYTES)}><Icon name="left" /></button>
      <button type="button" className="icon-button" title="Next hex page" aria-label="Next hex page" disabled={end >= file.size} onClick={() => move(end)}><Icon name="right" /></button>
    </div>
  </>;

  return <Pane name="Hex inspector" className="hex-pane" actions={actions}>
    <div className="hex-columns hex-layout" aria-hidden="true" style={{ '--offset-width': (width * 7.2) + 'px' } as React.CSSProperties}>
      <span>Offset</span>
      <span className="hex-bytes">{columns.map((column) => <span key={column}>{hex(column)}</span>)}</span>
      <span>ASCII</span>
    </div>
    <div ref={scroll} className="hex-scroll" tabIndex={0} role="region"
      aria-label="Hex bytes. Use arrows to select bytes, Shift+arrows to extend, Page Up or Page Down to navigate, Home or End for row boundaries, Ctrl+Home or Ctrl+End for file boundaries."
      style={{ '--offset-width': (width * 7.2) + 'px' } as React.CSSProperties}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c') {
          event.preventDefault(); void copySelection(); return;
        }
        const moves: Record<string, number> = {
          ArrowLeft: selectionHead.current - 1, ArrowRight: selectionHead.current + 1,
          ArrowUp: selectionHead.current - ROW_BYTES, ArrowDown: selectionHead.current + ROW_BYTES,
          PageUp: selectionHead.current - PAGE_BYTES, PageDown: selectionHead.current + PAGE_BYTES,
          Home: event.ctrlKey || event.metaKey ? 0 : selectionHead.current - (selectionHead.current % ROW_BYTES),
          End: event.ctrlKey || event.metaKey ? file.size - 1 : Math.min(file.size - 1, selectionHead.current + (ROW_BYTES - 1 - selectionHead.current % ROW_BYTES)),
        };
        if (!(event.key in moves)) return;
        event.preventDefault();
        move(moves[event.key], 1, { extend: event.shiftKey });
      }}>
      {!bytes?.length && <div className="empty-state">{!enabled ? emptyMessage : !file.size ? 'This file contains no bytes.' : readError === start ? 'These bytes could not be read.' : 'Reading bytes…'}</div>}
      {bytes && Array.from({ length: Math.ceil(bytes.length / ROW_BYTES) }, (_, index) => {
        const rowStart = start + index * ROW_BYTES;
        const rowData = bytes.subarray(index * ROW_BYTES, (index + 1) * ROW_BYTES);
        const activeRow = focusOffset >= rowStart && focusOffset < rowStart + ROW_BYTES;
        const isSelected = (column: number) => !!selection && contains(selection, rowStart + column);
        const isMatch = (column: number) => !!lastFind && rowStart + column >= lastFind.offset && rowStart + column < lastFind.offset + lastFind.length;
        const render = (asAscii: boolean) => Array.from(rowData, (byte, column) => {
          const selected = isSelected(column);
          const matched = isMatch(column);
          const text = asAscii ? byte >= 32 && byte < 127 ? String.fromCharCode(byte) : '·' : hex(byte);
          const className = [selected ? 'selected-byte' : '', matched ? 'search-match' : '', byte === 0 ? 'null-byte' : ''].filter(Boolean).join(' ');
          return <span key={column} className={className}
            onClick={(event) => { move(rowStart + column, 1, { extend: event.shiftKey }); scroll.current?.focus({ preventScroll: true }); }}>{text}</span>;
        });
        return <div key={rowStart} className={'hex-row hex-layout' + (activeRow ? ' active-row' : '')} ref={activeRow ? row : undefined}>
          <span className="hex-address">{hex(rowStart, width)}</span>
          <span className="hex-bytes">{render(false)}</span>
          <span className="hex-ascii">{render(true)}</span>
        </div>;
      })}
    </div>
    <footer className="hex-footer">
      <span>VIEW <strong>{file.size ? hex(start, width) + '–' + hex(end - 1, width) : '—'}</strong></span>
      <span className="hex-selection" aria-live="polite">{selection ? <><strong>{address(selection.offset, width)}</strong><span className="footer-separator">/</span>
        {selection.length.toLocaleString('en')} {selection.length === 1 ? 'byte' : 'bytes'}{firstByte === undefined ? '' : ' · ' + hex(firstByte)}</> : 'No selection'}</span>
      {currentRegion && <span className="hex-structure-context" title={`${currentRegion.label} · ${address(currentRegion.offset, width)} · ${currentRegion.length.toLocaleString('en')} bytes`}>
        REGION <strong>{currentRegion.label}</strong>
      </span>}
      <span className="hex-number">
        <select aria-label="Data interpretation" value={dataFormat} onChange={(event) => setDataFormat(event.target.value as DataFormat)}>
          {FORMATS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <button type="button" className="byte-order-button" disabled={!endianFormats.has(dataFormat)}
          aria-label={`Switch to ${byteOrder === 'little' ? 'big' : 'little'}-endian`}
          title={!endianFormats.has(dataFormat) ? 'Byte order does not apply to this interpretation' : `Switch to ${byteOrder === 'little' ? 'big' : 'little'}-endian`}
          onClick={() => setByteOrder((order) => order === 'little' ? 'big' : 'little')}>{byteOrder === 'little' ? 'LE' : 'BE'}</button>
        <output className="numeric-value" aria-label="Interpreted binary data"
          title={decoded ? [decoded.value, decoded.detail, dataBytes?.length === DATA_READ_LIMIT && selectedLength > DATA_READ_LIMIT ? `first ${DATA_READ_LIMIT} of ${selectedLength} selected bytes` : ''].filter(Boolean).join(' · ') : dataLabel}>
          {dataLabel}
        </output>
      </span>
      <button type="button" className="copy-bytes" onClick={copySelection} disabled={!selection || !file.size} title={`Copy up to ${COPY_LIMIT.toLocaleString('en')} selected bytes`}><Icon name="copy" /> {copyStatus || 'Copy'}</button>
    </footer>
  </Pane>;
}
