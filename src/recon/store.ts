import { RECON_SCHEMA_VERSION } from './model';
import type { ReconInvestigation } from './model';

const DATABASE_NAME = 'spectre-recon';
const STORE_NAME = 'investigations';
const MAX_RECORD_BYTES = 12 * 1024 * 1024;
let databasePromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('Local RECON storage is unavailable in this browser context.'));
      return;
    }
    const request = indexedDB.open(DATABASE_NAME, RECON_SCHEMA_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => { database.close(); databasePromise = null; };
      resolve(database);
    };
    request.onerror = () => { databasePromise = null; reject(request.error ?? new Error('Could not open RECON storage.')); };
    request.onblocked = () => reject(new Error('RECON storage is busy in another Spectre window.'));
  });
  return databasePromise;
}

function request<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDatabase().then((database) => new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    let value: T;
    const pending = operation(transaction.objectStore(STORE_NAME));
    pending.onsuccess = () => { value = pending.result; };
    pending.onerror = () => reject(pending.error ?? new Error('RECON storage request failed.'));
    transaction.oncomplete = () => resolve(value!);
    transaction.onerror = () => reject(transaction.error ?? new Error('RECON storage transaction failed.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('RECON storage transaction was aborted.'));
  }));
}

function validate(record: ReconInvestigation): void {
  if (record.schemaVersion !== RECON_SCHEMA_VERSION || !Array.isArray(record.snapshots) || record.snapshots.length > 40) {
    throw new Error('This RECON investigation has an unsupported or invalid format.');
  }
  if (new TextEncoder().encode(JSON.stringify(record)).byteLength > MAX_RECORD_BYTES) {
    throw new Error('Investigation exceeds the 12 MiB local storage limit. Remove older snapshots or export it before continuing.');
  }
}

export async function listReconInvestigations(): Promise<ReconInvestigation[]> {
  const records = await request<ReconInvestigation[]>('readonly', (store) => store.getAll());
  return records.filter((record) => record?.schemaVersion === RECON_SCHEMA_VERSION && Array.isArray(record.snapshots))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function saveReconInvestigation(record: ReconInvestigation): Promise<void> {
  validate(record);
  await request<IDBValidKey>('readwrite', (store) => store.put(record));
}

