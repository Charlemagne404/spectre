import { useEffect, useState } from 'react';
import { Icon } from '../icons';
import { address, byteSize } from './model';
import type { Analysis, ByteRange } from './model';
import { isMatchingFile } from './investigations';
import type { BookmarkKind, Investigation, InvestigationBookmark, InvestigationFile } from './investigations';

export interface BookmarkDraft {
  range: ByteRange;
  kind: BookmarkKind;
  structureLabel?: string;
}

export function InvestigationPanel({ investigations, active, analysis, draft, error, status, onClose,
  onCreate, onSelect, onRename, onDelete, onNotes, onFileNotes, onAddBookmark, onNavigate,
  onRestore, onEditBookmark, onDeleteBookmark }: {
  investigations: Investigation[];
  active: Investigation | null;
  analysis: Analysis | null;
  draft: BookmarkDraft | null;
  error: string;
  status: string;
  onClose: () => void;
  onCreate: (name: string) => void;
  onSelect: (id: string) => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onNotes: (notes: string) => void;
  onFileNotes: (fileId: string, notes: string) => void;
  onAddBookmark: (draft: BookmarkDraft, label: string, note: string) => void;
  onNavigate: (file: InvestigationFile, bookmark: InvestigationBookmark) => void;
  onRestore: (file: InvestigationFile) => void;
  onEditBookmark: (fileId: string, bookmarkId: string, label: string, note: string) => void;
  onDeleteBookmark: (fileId: string, bookmarkId: string) => void;
}) {
  const [newName, setNewName] = useState('');
  const [rename, setRename] = useState(active?.name ?? '');
  const [notes, setNotes] = useState(active?.notes ?? '');
  const [bookmarkLabel, setBookmarkLabel] = useState('');
  const [bookmarkNote, setBookmarkNote] = useState('');
  const matchingFile = active?.files.find((file) => isMatchingFile(file, analysis));

  useEffect(() => {
    setRename(active?.name ?? '');
    setNotes(active?.notes ?? '');
  }, [active?.id, active?.name, active?.notes]);

  useEffect(() => {
    if (!draft) return;
    setBookmarkLabel(draft.structureLabel || (draft.range.length === 1 ? address(draft.range.offset) : `Range at ${address(draft.range.offset)}`));
    setBookmarkNote('');
  }, [draft?.range.offset, draft?.range.length, draft?.kind, draft?.structureLabel]);

  return <aside className="investigation-drawer" aria-label="Investigation workspace">
    <header className="investigation-drawer-heading">
      <div><span>LOCAL / OFFLINE</span><h2>Investigation</h2></div>
      <button type="button" className="icon-button" aria-label="Close investigation panel" onClick={onClose}><Icon name="close" /></button>
    </header>

    <label className="investigation-select-label" htmlFor="investigation-select">OPEN INVESTIGATION</label>
    <select id="investigation-select" aria-label="Open investigation" value={active?.id ?? ''} onChange={(event) => onSelect(event.target.value)}>
      <option value="">One-off session · no investigation</option>
      {investigations.map((item) => <option key={item.id} value={item.id}>{item.name || 'Untitled investigation'} · {item.files.length} file{item.files.length === 1 ? '' : 's'}</option>)}
    </select>

    <form className="investigation-create" onSubmit={(event) => {
      event.preventDefault(); onCreate(newName); setNewName('');
    }}>
      <input aria-label="New investigation name" placeholder="New investigation name (optional)" maxLength={100}
        value={newName} onChange={(event) => setNewName(event.target.value)} />
      <button type="submit" className="quiet-button">Create</button>
    </form>

    {active && <>
      <div className="investigation-record-head">
        <form onSubmit={(event) => { event.preventDefault(); onRename(rename); }}>
          <input aria-label="Investigation name" placeholder="Untitled investigation" maxLength={100}
            value={rename} onChange={(event) => setRename(event.target.value)} />
          <button type="submit" className="quiet-button">Rename</button>
        </form>
        <button type="button" className="quiet-button investigation-delete" onClick={onDelete}>Delete</button>
      </div>
      <div className="investigation-timestamps">Created {new Date(active.createdAt).toLocaleString()} · Modified {new Date(active.modifiedAt).toLocaleString()}</div>

      <section className="investigation-notes">
        <label htmlFor="investigation-notes">INVESTIGATION NOTES</label>
        <textarea id="investigation-notes" value={notes} maxLength={20_000} placeholder="Observations and working notes"
          onChange={(event) => setNotes(event.target.value)} onBlur={() => { if (notes !== active.notes) onNotes(notes); }} />
      </section>

      {draft && <form className="bookmark-create" onSubmit={(event) => {
        event.preventDefault(); if (matchingFile && draft) onAddBookmark(draft, bookmarkLabel, bookmarkNote);
      }}>
        <div className="investigation-section-title"><span>BOOKMARK SELECTION</span><span>{draft.kind.toUpperCase()}</span></div>
        <div className="bookmark-range">{address(draft.range.offset)} · {draft.range.length.toLocaleString('en')} byte{draft.range.length === 1 ? '' : 's'}
          {draft.structureLabel ? ` · ${draft.structureLabel}` : ''}</div>
        <input aria-label="Bookmark label" value={bookmarkLabel} maxLength={120} placeholder="Short label"
          onChange={(event) => setBookmarkLabel(event.target.value)} />
        <textarea aria-label="Bookmark note" value={bookmarkNote} maxLength={4_000} placeholder="Optional note"
          onChange={(event) => setBookmarkNote(event.target.value)} />
        <button type="submit" className="quiet-button" disabled={!matchingFile || !bookmarkLabel.trim()}>Save bookmark</button>
        {!matchingFile && <p className="investigation-unavailable">Complete an analysis in this investigation to attach bookmarks to its verified file identity.</p>}
      </form>}

      <section className="investigation-files">
        <div className="investigation-section-title"><span>EXAMINED FILES</span><span>{active.files.length}</span></div>
        {!active.files.length && <p className="investigation-muted">Completed files appear here. File bytes and original paths are not stored.</p>}
        {active.files.map((file) => <FileRecord key={file.id} file={file} available={isMatchingFile(file, analysis)}
          onNotes={onFileNotes} onRestore={onRestore} onNavigate={onNavigate} onEditBookmark={onEditBookmark} onDeleteBookmark={onDeleteBookmark} />)}
      </section>
      <section className="investigation-comparisons">
        <div className="investigation-section-title"><span>COMPARISONS</span><span>{active.comparisons?.length ?? 0}</span></div>
        {(active.comparisons ?? []).map((comparison) => {
          const first = active.files.find((file) => file.id === comparison.firstFileId);
          const second = active.files.find((file) => file.id === comparison.secondFileId);
          return <div className="investigation-comparison" key={comparison.id}>
            <strong>{first?.fileName ?? 'Unknown file'} ↔ {second?.fileName ?? 'Unknown file'}</strong>
            <span>{comparison.mode.toUpperCase()} · {comparison.identical ? 'BYTE IDENTICAL' : `${comparison.differingBytes.toLocaleString('en')} differing offsets`} · {comparison.differenceRangeCount.toLocaleString('en')} ranges</span>
            <code>{first?.sha256?.slice(0, 12) ?? 'NO SHA'} / {second?.sha256?.slice(0, 12) ?? 'NO SHA'}</code>
          </div>;
        })}
      </section>
    </>}

    <footer className="investigation-storage-status" role={error ? 'alert' : 'status'}>
      {error || status || 'Stored locally in this application profile · no file bytes or full paths'}
    </footer>
  </aside>;
}

function FileRecord({ file, available, onNotes, onRestore, onNavigate, onEditBookmark, onDeleteBookmark }: {
  file: InvestigationFile;
  available: boolean;
  onNotes: (fileId: string, notes: string) => void;
  onRestore: (file: InvestigationFile) => void;
  onNavigate: (file: InvestigationFile, bookmark: InvestigationBookmark) => void;
  onEditBookmark: (fileId: string, bookmarkId: string, label: string, note: string) => void;
  onDeleteBookmark: (fileId: string, bookmarkId: string) => void;
}) {
  const [notes, setNotes] = useState(file.notes);
  useEffect(() => setNotes(file.notes), [file.notes]);
  return <details className="investigation-file">
    <summary>
      <span className="investigation-file-name">{file.fileName}</span>
      <span className={available ? 'file-availability is-available' : 'file-availability'}>{available ? 'IN SESSION' : 'SOURCE NEEDED'}</span>
    </summary>
    <div className="investigation-file-facts">
      <span>{byteSize(file.size)} · {file.detectedFormat}</span>
      <code title={file.sha256 ?? 'No fingerprint available'}>{file.sha256 ? file.sha256.slice(0, 16) + '…' : 'NO FINGERPRINT'}</code>
      <span>Entropy {file.summary.averageEntropy.toFixed(2)} bits/B · {file.summary.parser}{file.summary.parserComplete ? ' · complete' : ' · partial'}</span>
    </div>
    <button type="button" className="quiet-button investigation-restore" onClick={() => onRestore(file)}>{available ? 'Choose another source' : 'Choose source file'}</button>
    <label className="investigation-small-label" htmlFor={`file-note-${file.id}`}>FILE NOTES</label>
    <textarea id={`file-note-${file.id}`} value={notes} maxLength={8_000} placeholder="Notes for this file"
      onChange={(event) => setNotes(event.target.value)} onBlur={() => { if (notes !== file.notes) onNotes(file.id, notes); }} />
    <div className="investigation-bookmarks">
      <div className="investigation-section-title"><span>BOOKMARKS</span><span>{file.bookmarks.length}</span></div>
      {!file.bookmarks.length && <p className="investigation-muted">No saved byte ranges.</p>}
      {file.bookmarks.slice(0, 100).map((bookmark) => <BookmarkRow key={bookmark.id} bookmark={bookmark} file={file} available={available}
        onNavigate={onNavigate} onEdit={onEditBookmark} onDelete={onDeleteBookmark} />)}
      {file.bookmarks.length > 100 && <p className="investigation-muted">{file.bookmarks.length - 100} additional bookmarks retained.</p>}
    </div>
  </details>;
}

function BookmarkRow({ bookmark, file, available, onNavigate, onEdit, onDelete }: {
  bookmark: InvestigationBookmark;
  file: InvestigationFile;
  available: boolean;
  onNavigate: (file: InvestigationFile, bookmark: InvestigationBookmark) => void;
  onEdit: (fileId: string, bookmarkId: string, label: string, note: string) => void;
  onDelete: (fileId: string, bookmarkId: string) => void;
}) {
  const [label, setLabel] = useState(bookmark.label);
  const [note, setNote] = useState(bookmark.note);
  useEffect(() => { setLabel(bookmark.label); setNote(bookmark.note); }, [bookmark.label, bookmark.note]);
  const validAnchor = bookmark.sha256 !== null && bookmark.sha256 === file.sha256 && bookmark.fileId === file.id;
  return <details className="investigation-bookmark">
    <summary><span>{bookmark.label}</span><span>{address(bookmark.offset)} · {bookmark.length} B</span></summary>
    <div className="bookmark-kind">{bookmark.kind.toUpperCase()} · {validAnchor ? 'FINGERPRINT LINKED' : 'IDENTITY UNVERIFIED'}</div>
    {available && validAnchor
      ? <button type="button" className="quiet-button" onClick={() => onNavigate(file, bookmark)}>Navigate to bytes</button>
      : <button type="button" className="quiet-button" disabled>Choose matching source first</button>}
    <input aria-label="Edit bookmark label" maxLength={120} value={label} onChange={(event) => setLabel(event.target.value)} />
    <textarea aria-label="Edit bookmark note" maxLength={4_000} value={note} onChange={(event) => setNote(event.target.value)} />
    <div className="bookmark-actions">
      <button type="button" className="quiet-button" onClick={() => onEdit(file.id, bookmark.id, label, note)} disabled={!label.trim()}>Save edit</button>
      <button type="button" className="quiet-button investigation-delete" onClick={() => onDelete(file.id, bookmark.id)}>Delete</button>
    </div>
  </details>;
}
