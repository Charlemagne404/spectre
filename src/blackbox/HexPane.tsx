import { useEffect, useRef, useState } from 'react';
import { Icon } from '../icons';
import { address, contains, hex } from './model';
import type { ByteRange } from './model';
import { Pane } from './Pane';
import { findBytePattern, parseBytePattern } from './byteSearch';

const ROW_BYTES = 16;
const PAGE_BYTES = 64 * ROW_BYTES;
const COPY_LIMIT = 4096;
const columns = Array.from({ length: ROW_BYTES }, (_, index) => index);
const EMPTY_PREVIEW: number[] = [];

export function HexPane({ file, selection, firstByte, select, prefetched = EMPTY_PREVIEW, enabled = true, emptyMessage = 'Byte window pending.' }: {
  file: File;
  selection: ByteRange | null;
  firstByte?: number;
  select: (range: ByteRange) => void;
  prefetched?: number[];
  enabled?: boolean;
  emptyMessage?: string;
}) {
  const offset = selection?.offset ?? 0;
  const page = Math.floor(offset / PAGE_BYTES);
  const start = page * PAGE_BYTES;
  const end = Math.min(start + PAGE_BYTES, file.size);
  const [data, setData] = useState<{ start: number; bytes: Uint8Array }>();
  const [readError, setReadError] = useState<number>();
  const [jump, setJump] = useState('');
  const [jumpError, setJumpError] = useState(false);
  const [search, setSearch] = useState('');
  const [searchStatus, setSearchStatus] = useState('');
  const [searchError, setSearchError] = useState('');
  const [lastFind, setLastFind] = useState<{ pattern: string; offset: number } | null>(null);
  const [copyStatus, setCopyStatus] = useState('');
  const searchAbort = useRef<AbortController | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const row = useRef<HTMLDivElement>(null);
  const bytes = data?.start === start ? data.bytes : undefined;
  const width = Math.max(8, hex(Math.max(0, file.size - 1), 1).length);

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

  useEffect(() => () => searchAbort.current?.abort(), []);

  useEffect(() => {
    const viewport = scroll.current;
    const selected = row.current;
    if (!viewport || !selected) return;
    const outer = viewport.getBoundingClientRect();
    const inner = selected.getBoundingClientRect();
    if (inner.top < outer.top || inner.bottom > outer.bottom) viewport.scrollTop += inner.top - outer.top - 10;
  }, [selection, bytes]);

  const move = (target: number, length = 1, preserveFind = false) => {
    if (!preserveFind) setLastFind(null);
    if (file.size) select({ offset: Math.min(file.size - 1, Math.max(target, 0)), length: Math.min(length, file.size - Math.max(target, 0)) });
  };

  async function find(event: React.FormEvent) {
    event.preventDefault();
    searchAbort.current?.abort();
    const controller = new AbortController();
    searchAbort.current = controller;
    const pattern = parseBytePattern(search);
    if (!pattern) {
      setSearchError('Enter up to 64 bytes as hexadecimal.');
      setSearchStatus('');
      return;
    }
    setSearchError('');
    setSearchStatus('Searching…');
    const patternKey = [...pattern].map((byte) => hex(byte)).join('');
    try {
      const searchFrom = lastFind?.pattern === patternKey ? lastFind.offset + 1 : offset;
      const found = await findBytePattern(file, pattern, searchFrom, controller.signal);
      if (controller.signal.aborted) return;
      if (found < 0) { setSearchStatus('Not found'); setLastFind(null); }
      else {
        setLastFind({ pattern: patternKey, offset: found });
        setSearchStatus('');
        move(found, pattern.length, true);
        scroll.current?.focus();
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setSearchError(error instanceof Error ? error.message : 'Byte search failed.');
        setSearchStatus('');
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
    <form className="hex-search-form" onSubmit={find}>
      <input aria-label="Search bytes (hexadecimal)" title="Search for bytes, for example: 50 4B 03 04"
        placeholder="Find bytes" value={search} onChange={(event) => { setSearch(event.target.value); setSearchError(''); setLastFind(null); }}
        disabled={!enabled || !file.size} spellCheck={false} />
      <button type="submit" className="icon-button" aria-label="Find byte sequence" title="Find byte sequence" disabled={!enabled || !file.size}><Icon name="search" /></button>
      {(searchError || searchStatus) && <span className={searchError ? 'hex-search-error' : 'hex-search-status'} role={searchError ? 'alert' : 'status'}>{searchError || searchStatus}</span>}
    </form>
    <form className="jump-form" onSubmit={(event) => {
      event.preventDefault();
      const value = /^(?:0x)?[\da-f]+$/i.test(jump.trim()) ? Number.parseInt(jump.trim(), 16) : NaN;
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
      aria-label="Hex bytes. Use arrow keys, Page Up, Page Down, Home or End to navigate."
      style={{ '--offset-width': (width * 7.2) + 'px' } as React.CSSProperties}
      onKeyDown={(event) => {
        const moves: Record<string, number> = {
          ArrowLeft: offset - 1, ArrowRight: offset + 1, ArrowUp: offset - ROW_BYTES, ArrowDown: offset + ROW_BYTES,
          PageUp: offset - PAGE_BYTES, PageDown: offset + PAGE_BYTES, Home: 0, End: file.size - 1,
        };
        if (!(event.key in moves)) return;
        event.preventDefault();
        move(moves[event.key]);
      }}>
      {!bytes?.length && <div className="empty-state">{!enabled ? emptyMessage : !file.size ? 'This file contains no bytes.' : readError === start ? 'These bytes could not be read.' : 'Reading bytes…'}</div>}
      {bytes && Array.from({ length: Math.ceil(bytes.length / ROW_BYTES) }, (_, index) => {
        const rowStart = start + index * ROW_BYTES;
        const rowData = bytes.subarray(index * ROW_BYTES, (index + 1) * ROW_BYTES);
        const activeRow = offset >= rowStart && offset < rowStart + ROW_BYTES;
        const isSelected = (column: number) => !!selection && contains(selection, rowStart + column);
        const render = (asAscii: boolean) => Array.from(rowData, (byte, column) => {
          const selected = isSelected(column);
          const text = asAscii ? byte >= 32 && byte < 127 ? String.fromCharCode(byte) : '·' : hex(byte);
          return <span key={column} className={(selected ? 'selected-byte' : '') + (byte === 0 ? ' null-byte' : '')}
            onClick={() => { move(rowStart + column); scroll.current?.focus({ preventScroll: true }); }}>{text}</span>;
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
      <span className="hex-selection" aria-live="polite">{selection ? <><strong>{address(offset, width)}</strong><span className="footer-separator">/</span>
        {selection.length.toLocaleString('en')} {selection.length === 1 ? 'byte' : 'bytes'}{firstByte === undefined ? '' : ' · ' + hex(firstByte)}</> : 'No selection'}</span>
      <button type="button" className="copy-bytes" onClick={copySelection} disabled={!selection || !file.size} title={`Copy up to ${COPY_LIMIT.toLocaleString('en')} selected bytes`}><Icon name="copy" /> {copyStatus || 'Copy'}</button>
    </footer>
  </Pane>;
}
