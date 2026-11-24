const SEARCH_CHUNK_SIZE = 1024 * 1024;

export function parseBytePattern(value: string) {
  const normalized = value.trim().replace(/0x/gi, '').replace(/[\s,:;_-]/g, '');
  if (!normalized || normalized.length % 2 || normalized.length > 128 || !/^[\da-f]+$/i.test(normalized)) return null;
  return Uint8Array.from({ length: normalized.length / 2 }, (_, index) => Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16));
}

export async function findBytePattern(file: File, pattern: Uint8Array, fromOffset: number, signal?: AbortSignal) {
  if (!pattern.length || !file.size) return -1;
  const origin = Math.max(0, Math.min(file.size, Math.trunc(fromOffset)));
  const ranges: Array<[number, number]> = [[origin, file.size], [0, origin]];
  for (const [start, end] of ranges) {
    let cursor = start;
    while (cursor < end) {
      if (signal?.aborted) {
        const error = new Error('Search cancelled.');
        error.name = 'AbortError';
        throw error;
      }
      const stepEnd = Math.min(end, cursor + SEARCH_CHUNK_SIZE);
      const readEnd = Math.min(end, stepEnd + pattern.length - 1);
      const bytes = new Uint8Array(await file.slice(cursor, readEnd).arrayBuffer());
      if (signal?.aborted) {
        const error = new Error('Search cancelled.');
        error.name = 'AbortError';
        throw error;
      }
      let index = bytes.indexOf(pattern[0]);
      while (index >= 0 && index + pattern.length <= bytes.length && cursor + index < stepEnd) {
        let match = true;
        for (let offset = 1; offset < pattern.length; offset++) {
          if (bytes[index + offset] !== pattern[offset]) { match = false; break; }
        }
        if (match) return cursor + index;
        index = bytes.indexOf(pattern[0], index + 1);
      }
      cursor = stepEnd;
    }
  }
  return -1;
}
