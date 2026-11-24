import { open, mkdtemp, rm, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findPattern, parseSearchPattern } from '../src/blackbox/byteSearch';
import { compareFiles } from '../src/blackbox/fileCompare';

const enabled = process.env.SPECTRE_INSPECTION_PERF === '1';
const SIZE = Number(process.env.SPECTRE_INSPECTION_PERF_MIB ?? 128) * 1024 * 1024;
const CHUNK = 1024 * 1024;

interface DiskSlice {
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface DiskFile {
  name: string;
  size: number;
  slice(start?: number, end?: number): DiskSlice;
}

function fileView(handle: FileHandle, name: string, size: number): File {
  const view: DiskFile = {
    name,
    size,
    slice(start = 0, end = size) {
      const begin = Math.max(0, Math.min(size, Math.trunc(start)));
      const finish = Math.max(begin, Math.min(size, Math.trunc(end)));
      return {
        async arrayBuffer() {
          const bytes = new Uint8Array(finish - begin);
          let read = 0;
          while (read < bytes.length) {
            const result = await handle.read(bytes, read, bytes.length - read, begin + read);
            if (!result.bytesRead) break;
            read += result.bytesRead;
          }
          return bytes.slice(0, read).buffer;
        },
      };
    },
  };
  return view as unknown as File;
}

describe.skipIf(!enabled)('large-file inspection benchmarks', () => {
  let directory = '';
  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it(`benchmarks bounded search and offset-aligned comparison on ${SIZE / 1024 / 1024} MiB files`, async () => {
    directory = await mkdtemp(join(tmpdir(), 'spectre-inspection-perf-'));
    const firstPath = join(directory, 'comparison-a.bin');
    const secondPath = join(directory, 'comparison-b.bin');
    const firstHandle = await open(firstPath, 'w+');
    const secondHandle = await open(secondPath, 'w+');
    const block = new Uint8Array(CHUNK).fill(0x41);
    const changed = block.slice();
    changed[0] = 0x40;
    const changedOffset = Math.floor(SIZE / 2);

    try {
      for (let start = 0; start < SIZE; start += CHUNK) {
        await firstHandle.write(block, 0, Math.min(CHUNK, SIZE - start), start);
        await secondHandle.write(start === Math.floor(changedOffset / CHUNK) * CHUNK ? changed : block, 0, Math.min(CHUNK, SIZE - start), start);
      }

      const first = fileView(firstHandle, 'comparison-a.bin', SIZE);
      const second = fileView(secondHandle, 'comparison-b.bin', SIZE);
      const compareStart = performance.now();
      const comparison = await compareFiles(first, second);
      const compareMs = performance.now() - compareStart;
      expect(comparison.identical).toBe(false);
      expect(comparison.differingBytes).toBe(1);
      expect(comparison.differences).toEqual([{ offset: changedOffset, length: 1 }]);

      const searchStart = performance.now();
      const searchResult = await findPattern(first, parseSearchPattern('FF FF', 'hex')!, 0, 'forward');
      const searchMs = performance.now() - searchStart;
      expect(searchResult).toBe(-1);

      console.log(`${SIZE / 1024 / 1024} MiB offset-aligned compare: ${compareMs.toFixed(0)} ms; full-file no-match search: ${searchMs.toFixed(0)} ms`);
    } finally {
      await Promise.all([firstHandle.close(), secondHandle.close()]);
    }
  }, 5 * 60 * 1000);
});
