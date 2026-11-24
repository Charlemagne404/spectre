import type { Analysis, ByteRange, FileIdentity, StructureReport } from './model';
import type { FileComparison } from './fileCompare';

export const INVESTIGATION_SCHEMA_VERSION = 1;
const DATABASE_NAME = 'spectre-blackbox';
const STORE_NAME = 'investigations';

export type BookmarkKind = 'byte' | 'range' | 'structure' | 'string' | 'search' | 'difference';

export interface InvestigationBookmark extends ByteRange {
  id: string;
  fileId: string;
  sha256: string | null;
  kind: BookmarkKind;
  label: string;
  note: string;
  createdAt: string;
}

export interface InvestigationFile {
  id: string;
  fileName: string;
  size: number;
  sha256: string | null;
  detectedFormat: string;
  detectedMime: string;
  inspectedAt: string;
  summary: {
    averageEntropy: number;
    stringsFound: number | null;
    parser: string;
    parserComplete: boolean;
    warnings: string[];
    regionCount: number;
  };
  notes: string;
  bookmarks: InvestigationBookmark[];
  /** Persisted false: file contents and file handles are never stored in the investigation database. */
  unavailable: boolean;
}

export interface Investigation {
  schemaVersion: typeof INVESTIGATION_SCHEMA_VERSION;
  id: string;
  name: string;
  createdAt: string;
  modifiedAt: string;
  notes: string;
  files: InvestigationFile[];
  comparisons: InvestigationComparison[];
}

export interface InvestigationComparison {
  id: string;
  comparedAt: string;
  mode: 'offset-aligned';
  firstFileId: string;
  secondFileId: string;
  identical: boolean;
  comparedBytes: number;
  differingBytes: number;
  differenceRangeCount: number;
  omittedDifferenceRanges: number;
}

let databasePromise: Promise<IDBDatabase> | null = null;

function id() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

function openDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('Local investigation storage is unavailable in this browser context.'));
      return;
    }
    const request = indexedDB.open(DATABASE_NAME, INVESTIGATION_SCHEMA_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME, { keyPath: 'id' });
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        databasePromise = null;
      };
      resolve(database);
    };
    request.onerror = () => {
      databasePromise = null;
      reject(request.error ?? new Error('Could not open the local investigation database.'));
    };
    request.onblocked = () => reject(new Error('Local investigation storage is busy in another Spectre window. Close that window and try again.'));
  });
  return databasePromise;
}

function request<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDatabase().then((database) => new Promise<T>((resolve, reject) => {
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(STORE_NAME, mode);
    } catch (error) {
      reject(error);
      return;
    }
    let result: T;
    const pending = operation(transaction.objectStore(STORE_NAME));
    pending.onsuccess = () => { result = pending.result; };
    pending.onerror = () => reject(pending.error ?? new Error('Investigation storage request failed.'));
    transaction.oncomplete = () => resolve(result!);
    transaction.onerror = () => reject(transaction.error ?? new Error('Investigation storage transaction failed.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Investigation storage transaction was aborted.'));
  }));
}

function stored(record: Investigation): Investigation {
  return {
    ...record,
    schemaVersion: INVESTIGATION_SCHEMA_VERSION,
    modifiedAt: new Date().toISOString(),
    files: record.files.map((file) => ({ ...file, unavailable: true })),
    comparisons: record.comparisons ?? [],
  };
}

export async function listInvestigations(): Promise<Investigation[]> {
  const result = await request<Investigation[]>('readonly', (store) => store.getAll());
  return result.filter((item) => item && item.schemaVersion === INVESTIGATION_SCHEMA_VERSION && Array.isArray(item.files))
    .map((item) => ({ ...item, comparisons: item.comparisons ?? [] }))
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

export async function getInvestigation(investigationId: string): Promise<Investigation | null> {
  const result = await request<Investigation | undefined>('readonly', (store) => store.get(investigationId));
  if (!result || result.schemaVersion !== INVESTIGATION_SCHEMA_VERSION || !Array.isArray(result.files)) return null;
  return { ...result, comparisons: result.comparisons ?? [] };
}

export async function saveInvestigation(record: Investigation): Promise<Investigation> {
  const value = stored(record);
  await request<IDBValidKey>('readwrite', (store) => store.put(value));
  return value;
}

/** Apply a local edit in one read/write transaction so concurrent UI updates do not overwrite each other. */
export function updateInvestigation(investigationId: string, update: (current: Investigation) => Investigation): Promise<Investigation | null> {
  return openDatabase().then((database) => new Promise<Investigation | null>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const get = store.get(investigationId);
    let saved: Investigation | null = null;
    get.onsuccess = () => {
      const current = get.result as Investigation | undefined;
      if (!current || current.schemaVersion !== INVESTIGATION_SCHEMA_VERSION || !Array.isArray(current.files)) return;
      saved = stored(update(current));
      store.put(saved);
    };
    get.onerror = () => reject(get.error ?? new Error('Could not load the investigation for editing.'));
    transaction.oncomplete = () => resolve(saved);
    transaction.onerror = () => reject(transaction.error ?? new Error('Investigation update failed.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Investigation update was aborted.'));
  }));
}

export async function createInvestigation(name = ''): Promise<Investigation> {
  const now = new Date().toISOString();
  const record: Investigation = {
    schemaVersion: INVESTIGATION_SCHEMA_VERSION,
    id: id(),
    name: name.trim().slice(0, 100),
    createdAt: now,
    modifiedAt: now,
    notes: '',
    files: [],
    comparisons: [],
  };
  return saveInvestigation(record);
}

export async function deleteInvestigation(investigationId: string): Promise<void> {
  await request<undefined>('readwrite', (store) => store.delete(investigationId));
}

export function fileFromAnalysis(analysis: Analysis, existing?: InvestigationFile): InvestigationFile {
  return {
    id: existing?.id ?? id(),
    fileName: analysis.name,
    size: analysis.size,
    sha256: analysis.sha256,
    detectedFormat: analysis.type,
    detectedMime: analysis.mime,
    inspectedAt: new Date().toISOString(),
    summary: {
      averageEntropy: analysis.averageEntropy,
      stringsFound: analysis.stringIndexLimitReached ? null : analysis.totalStrings,
      parser: analysis.structure.parser,
      parserComplete: analysis.structure.complete,
      warnings: analysis.structure.warnings.slice(0, 64),
      regionCount: analysis.regions.length,
    },
    notes: existing?.notes ?? '',
    bookmarks: existing?.bookmarks ?? [],
    unavailable: false,
  };
}

export async function recordAnalysis(investigationId: string, analysis: Analysis): Promise<{ investigation: Investigation; file: InvestigationFile }> {
  let fileId = '';
  const saved = await updateInvestigation(investigationId, (investigation) => {
    const existing = investigation.files.find((file) => file.sha256 === analysis.sha256 && file.size === analysis.size);
    const file = fileFromAnalysis(analysis, existing);
    fileId = file.id;
    const files = existing
      ? investigation.files.map((item) => item.id === existing.id ? file : item)
      : [...investigation.files, file];
    return { ...investigation, files };
  });
  if (!saved) throw new Error('The investigation was deleted before this file could be recorded.');
  const file = saved.files.find((item) => item.id === fileId);
  if (!file) throw new Error('The file record was not retained by local storage.');
  return { investigation: saved, file };
}

export async function recordComparison(
  investigationId: string,
  firstAnalysis: Analysis,
  secondIdentity: FileIdentity,
  secondSha256: string,
  secondEntropy: number,
  secondStructure: StructureReport,
  secondRegionCount: number,
  result: FileComparison,
): Promise<Investigation> {
  const comparisonId = id();
  const comparedAt = new Date().toISOString();
  const saved = await updateInvestigation(investigationId, (investigation) => {
    const firstExisting = investigation.files.find((file) => file.sha256 === firstAnalysis.sha256 && file.size === firstAnalysis.size);
    const firstFile = firstExisting ?? fileFromAnalysis(firstAnalysis);
    const secondExisting = investigation.files.find((file) => file.sha256 === secondSha256 && file.size === secondIdentity.size);
    const secondFile: InvestigationFile = secondExisting ? {
      ...secondExisting, fileName: secondIdentity.name, detectedFormat: secondIdentity.type, detectedMime: secondIdentity.mime,
      inspectedAt: comparedAt, summary: { ...secondExisting.summary, averageEntropy: secondEntropy,
        parser: secondStructure.parser, parserComplete: secondStructure.complete,
        warnings: secondStructure.warnings.slice(0, 64), regionCount: secondRegionCount },
    } : {
      id: id(), fileName: secondIdentity.name, size: secondIdentity.size, sha256: secondSha256,
      detectedFormat: secondIdentity.type, detectedMime: secondIdentity.mime, inspectedAt: comparedAt,
      summary: { averageEntropy: secondEntropy, stringsFound: null, parser: secondStructure.parser,
        parserComplete: secondStructure.complete, warnings: secondStructure.warnings.slice(0, 64), regionCount: secondRegionCount },
      notes: '', bookmarks: [], unavailable: false,
    };
    const files = [...investigation.files];
    if (firstExisting) files[files.findIndex((file) => file.id === firstExisting.id)] = firstFile;
    else files.push(firstFile);
    if (secondExisting) files[files.findIndex((file) => file.id === secondExisting.id)] = secondFile;
    else files.push(secondFile);
    const comparison: InvestigationComparison = {
      id: comparisonId, comparedAt, mode: 'offset-aligned', firstFileId: firstFile.id, secondFileId: secondFile.id,
      identical: result.identical, comparedBytes: result.comparedBytes, differingBytes: result.differingBytes,
      differenceRangeCount: result.differenceRangeCount, omittedDifferenceRanges: result.omittedDifferenceRanges,
    };
    return { ...investigation, files, comparisons: [...(investigation.comparisons ?? []), comparison] };
  });
  if (!saved) throw new Error('The investigation was deleted before the comparison could be recorded.');
  return saved;
}

export function isMatchingFile(file: InvestigationFile, analysis: Analysis | null | undefined) {
  return !!analysis && file.sha256 !== null && file.sha256 === analysis.sha256 && file.size === analysis.size;
}

export function createBookmark(file: InvestigationFile, range: ByteRange, kind: BookmarkKind, label: string, note = ''): InvestigationBookmark {
  return {
    id: id(),
    fileId: file.id,
    sha256: file.sha256,
    kind,
    offset: range.offset,
    length: range.length,
    label: label.trim().slice(0, 120),
    note: note.slice(0, 4_000),
    createdAt: new Date().toISOString(),
  };
}
