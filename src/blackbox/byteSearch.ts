export const SEARCH_CHUNK_SIZE = 1024 * 1024;
export type SearchMode = 'hex' | 'ascii' | 'utf8' | 'utf16le';
export type SearchDirection = 'forward' | 'backward';

export interface BytePattern {
  bytes: Uint8Array;
  masks: Uint8Array;
}

export interface SearchProgress {
  processed: number;
  total: number;
}

function patternFromPairs(value: string): BytePattern | null {
  const normalized = value.trim().replace(/0x/gi, '').replace(/[\s,:;_-]/g, '');
  if (!normalized || normalized.length % 2 || normalized.length > 128 || !/^[\da-f?]+$/i.test(normalized)) return null;
  const bytes = new Uint8Array(normalized.length / 2);
  const masks = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    const pair = normalized.slice(index * 2, index * 2 + 2);
    if (!/^[\da-f?]{2}$/i.test(pair)) return null;
    const high = pair[0] === '?' ? 0 : Number.parseInt(pair[0], 16);
    const low = pair[1] === '?' ? 0 : Number.parseInt(pair[1], 16);
    const highMask = pair[0] === '?' ? 0 : 0xf0;
    const lowMask = pair[1] === '?' ? 0 : 0x0f;
    bytes[index] = (high << 4) | low;
    masks[index] = highMask | lowMask;
  }
  return { bytes, masks };
}

/** Parse a hexadecimal byte sequence, including full-byte and nibble wildcards. */
export function parseBytePattern(value: string): Uint8Array | null {
  const parsed = patternFromPairs(value);
  return parsed && parsed.masks.every((mask) => mask === 0xff) ? parsed.bytes : null;
}

export function parseSearchPattern(value: string, mode: SearchMode): BytePattern | null {
  if (mode === 'hex') return patternFromPairs(value);
  if (!value.length) return null;
  let bytes: Uint8Array;
  if (mode === 'ascii') {
    if ([...value].some((character) => character.codePointAt(0)! > 0x7f)) return null;
    bytes = Uint8Array.from([...value], (character) => character.charCodeAt(0));
  } else if (mode === 'utf16le') {
    bytes = new Uint8Array(value.length * 2);
    for (let index = 0; index < value.length; index++) {
      const codeUnit = value.charCodeAt(index);
      bytes[index * 2] = codeUnit & 0xff;
      bytes[index * 2 + 1] = codeUnit >>> 8;
    }
  } else {
    bytes = new TextEncoder().encode(value);
  }
  if (!bytes.length || bytes.length > 64) return null;
  return { bytes, masks: new Uint8Array(bytes.length).fill(0xff) };
}

function abortError() {
  const error = new Error('Search cancelled.');
  error.name = 'AbortError';
  return error;
}

function matches(bytes: Uint8Array, localOffset: number, pattern: BytePattern) {
  for (let index = 0; index < pattern.bytes.length; index++) {
    if ((bytes[localOffset + index] & pattern.masks[index]) !== pattern.bytes[index]) return false;
  }
  return true;
}

/** Search file slices with fixed memory use, reporting bytes actually scanned. */
export async function findPattern(
  file: File,
  pattern: BytePattern,
  fromOffset: number,
  direction: SearchDirection = 'forward',
  signal?: AbortSignal,
  onProgress?: (progress: SearchProgress) => void,
): Promise<number> {
  const length = pattern.bytes.length;
  const candidateCount = file.size - length + 1;
  if (!length || !candidateCount) return -1;
  const origin = Math.max(0, Math.min(candidateCount - 1, Math.trunc(fromOffset)));
  const ranges: Array<[number, number]> = direction === 'forward'
    ? [[origin, candidateCount], [0, origin]]
    : [[0, origin + 1], [origin + 1, candidateCount]];
  const total = candidateCount;
  let processed = 0;

  for (const [rangeStart, rangeEnd] of ranges) {
    if (rangeStart >= rangeEnd) continue;
    if (direction === 'forward') {
      let cursor = rangeStart;
      while (cursor < rangeEnd) {
        if (signal?.aborted) throw abortError();
        const stepEnd = Math.min(rangeEnd, cursor + SEARCH_CHUNK_SIZE);
        const readEnd = Math.min(file.size, stepEnd + length - 1);
        const bytes = new Uint8Array(await file.slice(cursor, readEnd).arrayBuffer());
        if (signal?.aborted) throw abortError();
        for (let offset = 0; offset < stepEnd - cursor; offset++) {
          if (matches(bytes, offset, pattern)) return cursor + offset;
        }
        processed += stepEnd - cursor;
        onProgress?.({ processed, total });
        cursor = stepEnd;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    } else {
      let cursorEnd = rangeEnd;
      while (cursorEnd > rangeStart) {
        if (signal?.aborted) throw abortError();
        const cursorStart = Math.max(rangeStart, cursorEnd - SEARCH_CHUNK_SIZE);
        const readEnd = Math.min(file.size, cursorEnd + length - 1);
        const bytes = new Uint8Array(await file.slice(cursorStart, readEnd).arrayBuffer());
        if (signal?.aborted) throw abortError();
        for (let offset = cursorEnd - cursorStart - 1; offset >= 0; offset--) {
          if (matches(bytes, offset, pattern)) return cursorStart + offset;
        }
        processed += cursorEnd - cursorStart;
        onProgress?.({ processed, total });
        cursorEnd = cursorStart;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
  }
  return -1;
}

export async function findBytePattern(file: File, pattern: Uint8Array, fromOffset: number, signal?: AbortSignal) {
  return findPattern(file, { bytes: pattern, masks: new Uint8Array(pattern.length).fill(0xff) }, fromOffset, 'forward', signal);
}
