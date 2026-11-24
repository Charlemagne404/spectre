import { createSHA256 } from 'hash-wasm';

export const COMPARE_CHUNK_SIZE = 1024 * 1024;
export const MAX_STORED_DIFFERENCE_RANGES = 10_000;

export interface DifferenceRange {
  offset: number;
  length: number;
}

export interface ComparedFileStats {
  name: string;
  size: number;
  sha256: string;
  histogram: number[];
  entropy: number;
}

export interface FileComparison {
  mode: 'offset-aligned';
  identical: boolean;
  comparedBytes: number;
  differingBytes: number;
  differenceRangeCount: number;
  omittedDifferenceRanges: number;
  differences: DifferenceRange[];
  files: [ComparedFileStats, ComparedFileStats];
}

export interface ComparisonProgress {
  processed: number;
  total: number;
}

function abortError() {
  const error = new Error('Comparison cancelled.');
  error.name = 'AbortError';
  return error;
}

function entropy(histogram: Uint32Array | Float64Array, length: number) {
  if (!length) return 0;
  let result = 0;
  for (const count of histogram) {
    if (count) {
      const probability = count / length;
      result -= probability * Math.log2(probability);
    }
  }
  return result;
}

/** Offset-aligned comparison. Memory use is fixed except for the capped range summary. */
export async function compareFiles(
  first: File,
  second: File,
  signal?: AbortSignal,
  onProgress?: (progress: ComparisonProgress) => void,
): Promise<FileComparison> {
  const maxSize = Math.max(first.size, second.size);
  const total = Math.max(1, maxSize);
  const firstHash = await createSHA256();
  const secondHash = await createSHA256();
  const firstHistogram = first.size <= 0xffff_ffff ? new Uint32Array(256) : new Float64Array(256);
  const secondHistogram = second.size <= 0xffff_ffff ? new Uint32Array(256) : new Float64Array(256);
  const differences: DifferenceRange[] = [];
  let rangeStart = -1;
  let differenceRangeCount = 0;
  let differingBytes = 0;

  const closeDifference = (end: number) => {
    if (rangeStart < 0) return;
    differenceRangeCount++;
    if (differences.length < MAX_STORED_DIFFERENCE_RANGES) differences.push({ offset: rangeStart, length: end - rangeStart });
    rangeStart = -1;
  };

  for (let start = 0; start < maxSize; start += COMPARE_CHUNK_SIZE) {
    if (signal?.aborted) throw abortError();
    const end = Math.min(maxSize, start + COMPARE_CHUNK_SIZE);
    const [firstBuffer, secondBuffer] = await Promise.all([
      first.slice(start, Math.min(end, first.size)).arrayBuffer(),
      second.slice(start, Math.min(end, second.size)).arrayBuffer(),
    ]);
    if (signal?.aborted) throw abortError();
    const firstBytes = new Uint8Array(firstBuffer);
    const secondBytes = new Uint8Array(secondBuffer);
    if (firstBytes.length) firstHash.update(firstBytes);
    if (secondBytes.length) secondHash.update(secondBytes);

    for (let index = 0; index < firstBytes.length; index++) firstHistogram[firstBytes[index]]++;
    for (let index = 0; index < secondBytes.length; index++) secondHistogram[secondBytes[index]]++;
    for (let index = 0; index < end - start; index++) {
      const firstValue = index < firstBytes.length ? firstBytes[index] : -1;
      const secondValue = index < secondBytes.length ? secondBytes[index] : -1;
      const different = firstValue !== secondValue;
      const offset = start + index;
      if (different) {
        differingBytes++;
        if (rangeStart < 0) rangeStart = offset;
      } else closeDifference(offset);
    }
    onProgress?.({ processed: end, total });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  closeDifference(maxSize);

  const firstStats: ComparedFileStats = {
    name: first.name || 'unnamed file', size: first.size, sha256: firstHash.digest('hex'),
    histogram: Array.from(firstHistogram), entropy: entropy(firstHistogram, first.size),
  };
  const secondStats: ComparedFileStats = {
    name: second.name || 'unnamed file', size: second.size, sha256: secondHash.digest('hex'),
    histogram: Array.from(secondHistogram), entropy: entropy(secondHistogram, second.size),
  };
  return {
    mode: 'offset-aligned',
    identical: first.size === second.size && differingBytes === 0,
    comparedBytes: maxSize,
    differingBytes,
    differenceRangeCount,
    omittedDifferenceRanges: Math.max(0, differenceRangeCount - differences.length),
    differences,
    files: [firstStats, secondStats],
  };
}
