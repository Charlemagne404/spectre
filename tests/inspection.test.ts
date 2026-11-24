import { describe, expect, it } from 'vitest';
import { findBytePattern, findPattern, parseBytePattern, parseSearchPattern } from '../src/blackbox/byteSearch';
import { applyAnalysisEvent, createAnalysisRun } from '../src/blackbox/analysisEvents';
import { expandForPresentation, minimumPresentationDuration, presentationPhase, SMALL_FILE_PRESENTATION_LIMIT } from '../src/blackbox/analysisPresentation';
import { intersects } from '../src/blackbox/model';
import { interpretData, interpretUnsigned } from '../src/blackbox/numeric';
import { compareFiles } from '../src/blackbox/fileCompare';
import { scanEmbeddedSignatures } from '../src/blackbox/embeddedSignatures';
import type { AnalysisEvent } from '../src/blackbox/model';

function fileFromBytes(bytes: Uint8Array, name: string) {
  return new File([bytes.slice().buffer as ArrayBuffer], name);
}

describe('hexadecimal search', () => {
  it('parses formatted hexadecimal patterns and rejects incomplete input', () => {
    expect([...parseBytePattern('0x50 4B:03-04') ?? []]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(parseBytePattern('F')).toBeNull();
    expect(parseBytePattern('not hex')).toBeNull();
    expect(parseBytePattern('AA'.repeat(65))).toBeNull();
  });

  it('supports full-byte and nibble wildcards without weakening exact parsing', async () => {
    expect(parseBytePattern('DE ?? BE EF')).toBeNull();
    const wildcard = parseSearchPattern('DE A? ?E EF', 'hex');
    expect(wildcard).not.toBeNull();
    expect(await findPattern(fileFromBytes(Uint8Array.from([0xde, 0xaf, 0x3e, 0xef]), 'wild.bin'), wildcard!, 0)).toBe(0);
    expect(await findPattern(fileFromBytes(Uint8Array.from([0xde, 0xb0, 0x3f, 0xef]), 'miss.bin'), wildcard!, 0)).toBe(-1);
  });

  it('encodes ASCII, UTF-8 and UTF-16LE text patterns', () => {
    expect([...parseSearchPattern('ABC', 'ascii')!.bytes]).toEqual([0x41, 0x42, 0x43]);
    expect([...parseSearchPattern('é', 'utf8')!.bytes]).toEqual([0xc3, 0xa9]);
    expect([...parseSearchPattern('Aλ', 'utf16le')!.bytes]).toEqual([0x41, 0, 0xbb, 0x03]);
    expect(parseSearchPattern('é', 'ascii')).toBeNull();
  });

  it('searches bounded slices across read boundaries and wraps after the current offset', async () => {
    const bytes = new Uint8Array(1024 * 1024 + 8);
    bytes.set([0xde, 0xad, 0xbe, 0xef], 1024 * 1024 - 2);
    bytes.set([0xde, 0xad, 0xbe, 0xef], 12);
    const file = fileFromBytes(bytes, 'search.bin');
    const pattern = parseBytePattern('DE AD BE EF');
    if (!pattern) throw new Error('Pattern should parse');
    expect(await findBytePattern(file, pattern, 0)).toBe(12);
    expect(await findBytePattern(file, pattern, 1024 * 1024 - 1)).toBe(12);
    expect(await findBytePattern(file, pattern, 13)).toBe(1024 * 1024 - 2);
  });

  it('cancels a byte search between file slices', async () => {
    const file = fileFromBytes(new Uint8Array(1024 * 1024 * 3), 'large.bin');
    const controller = new AbortController();
    controller.abort();
    await expect(findBytePattern(file, new Uint8Array([0xff]), 0, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('searches backward and wraps over the file using bounded chunks', async () => {
    const bytes = new Uint8Array(1024 * 1024 + 20);
    bytes.set([0xca, 0xfe], 8);
    bytes.set([0xca, 0xfe], 1024 * 1024 + 10);
    const pattern = parseSearchPattern('CA FE', 'hex')!;
    const file = fileFromBytes(bytes, 'reverse.bin');
    expect(await findPattern(file, pattern, 1024 * 1024 + 12, 'backward')).toBe(1024 * 1024 + 10);
    expect(await findPattern(file, pattern, 7, 'backward')).toBe(1024 * 1024 + 10);
  });

  it('reports the actual number of candidate offsets scanned when no match exists', async () => {
    const file = fileFromBytes(new Uint8Array(1024 * 1024 + 32), 'progress.bin');
    const progress: Array<{ processed: number; total: number }> = [];
    const result = await findPattern(file, parseSearchPattern('FF FF', 'hex')!, 0, 'forward', undefined, (value) => progress.push(value));
    expect(result).toBe(-1);
    expect(progress.at(-1)).toEqual({ processed: file.size - 1, total: file.size - 1 });
    expect(progress.length).toBeGreaterThan(1);
  });
});

describe('hexadecimal integer interpretation', () => {
  it('decodes unsigned values with either byte order, including 64-bit values', () => {
    const riff = Uint8Array.from([0x52, 0x49, 0x46, 0x46]);
    expect(interpretUnsigned(riff, 4, 'little')).toEqual({ hexadecimal: '0x46464952', decimal: '1179011410' });
    expect(interpretUnsigned(riff, 4, 'big')?.hexadecimal).toBe('0x52494646');
    expect(interpretUnsigned(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]), 8, 'big')?.hexadecimal)
      .toBe('0x0102030405060708');
    expect(interpretUnsigned(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]), 8, 'little')?.decimal)
      .toBe('578437695752307201');
  });

  it('does not interpret a partial value past the available file bytes', () => {
    expect(interpretUnsigned(Uint8Array.from([0x34, 0x12]), 4, 'little')).toBeNull();
  });

  it('decodes signed integers, IEEE floats, textual values and raw representations', () => {
    expect(interpretData(Uint8Array.from([0xff]), 'I8', 'little')?.value).toBe('-1');
    expect(interpretData(Uint8Array.from([0xff, 0xff]), 'I16', 'big')?.value).toBe('-1');
    expect(interpretData(Uint8Array.from([0, 0, 0xc0, 0x3f]), 'F32', 'little')?.value).toBe('1.5');
    expect(interpretData(Uint8Array.from([0x41, 0, 0xbb, 3]), 'UTF16LE', 'little')?.value).toBe('Aλ');
    expect(interpretData(Uint8Array.from([0xc3, 0x28]), 'UTF8', 'little')?.value).toContain('INVALID');
    expect(interpretData(Uint8Array.from([0, 255]), 'BINARY', 'little')?.value).toBe('00000000 11111111');
    expect(interpretData(Uint8Array.from([0x41, 0]), 'HEX', 'little')?.value).toBe('41 00');
    expect(interpretData(Uint8Array.from([0x41]), 'U16', 'little')).toBeNull();
  });

  it('keeps 64-bit precision and renders Unix timestamps as UTC', () => {
    const bytes = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(interpretData(bytes, 'U64', 'little')?.value).toBe('578437695752307201');
    expect(interpretData(Uint8Array.from([0, 0, 0, 0]), 'UNIX32', 'big')?.value).toBe('1970-01-01T00:00:00.000Z');
  });
});

describe('offset-aligned binary comparison', () => {
  it('verifies identical bytes and independently fingerprints both files', async () => {
    const bytes = Uint8Array.from([49, 50, 51, 52, 53, 54, 55, 56, 57]);
    const result = await compareFiles(fileFromBytes(bytes, 'one.bin'), fileFromBytes(bytes, 'two.bin'));
    expect(result.mode).toBe('offset-aligned');
    expect(result.identical).toBe(true);
    expect(result.differingBytes).toBe(0);
    expect(result.files[0].sha256).toBe('15e2b0d3c33891ebb0f1ef609ec419420c20e320ce94c65fbc8c3312448eb225');
    expect(result.files[0].sha256).toBe(result.files[1].sha256);
  });

  it('groups changes across chunk edges and accounts for appended bytes', async () => {
    const first = new Uint8Array(1024 * 1024 + 8);
    const second = first.slice();
    second[1024 * 1024 - 1] = 1;
    second[1024 * 1024] = 2;
    second[second.length - 2] = 3;
    const result = await compareFiles(fileFromBytes(first, 'base.bin'), fileFromBytes(second, 'changed.bin'));
    expect(result.identical).toBe(false);
    expect(result.differingBytes).toBe(3);
    expect(result.differences).toEqual([
      { offset: 1024 * 1024 - 1, length: 2 },
      { offset: second.length - 2, length: 1 },
    ]);

    const appended = await compareFiles(fileFromBytes(first, 'short.bin'), fileFromBytes(new Uint8Array([...first, 9, 8]), 'long.bin'));
    expect(appended.differingBytes).toBe(2);
    expect(appended.differences.at(-1)).toEqual({ offset: first.length, length: 2 });
  });

  it('defines insertion alignment honestly and cancels before reading file slices', async () => {
    const base = fileFromBytes(Uint8Array.from([1, 2, 3, 4]), 'base.bin');
    const inserted = fileFromBytes(Uint8Array.from([1, 9, 2, 3, 4]), 'inserted.bin');
    const result = await compareFiles(base, inserted);
    expect(result.mode).toBe('offset-aligned');
    expect(result.differingBytes).toBe(4);
    const controller = new AbortController();
    controller.abort();
    await expect(compareFiles(base, inserted, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('embedded signature discovery', () => {
  it('finds and validates a complete PNG signature across a scan-slice boundary', async () => {
    const prefix = new Uint8Array(1024 * 1024 - 4).fill(0x41);
    const png = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...new Array(13).fill(0), 0, 0, 0, 0,
      0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0, 0, 0, 0,
    ]);
    const bytes = new Uint8Array(prefix.length + png.length);
    bytes.set(prefix);
    bytes.set(png, prefix.length);
    const file = fileFromBytes(bytes, 'wrapped.bin');
    const progress: number[] = [];
    const result = await scanEmbeddedSignatures(file, (value) => progress.push(value.processed));
    expect(result.totalCandidates).toBe(1);
    expect(result.findings[0]).toMatchObject({ offset: prefix.length, format: 'PNG', classification: 'complete', length: png.length });
    expect(result.findings[0].note).toContain('CRC values were not checked');
    expect(progress[0]).toBe(1024 * 1024);
  });

  it('keeps malformed signatures as candidates and cancels bounded scans', async () => {
    const malformed = fileFromBytes(Uint8Array.from([0x78, 0x50, 0x4b, 0x03, 0x04, 0, 0]), 'false-positive.bin');
    const result = await scanEmbeddedSignatures(malformed);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].classification).toBe('candidate');
    expect(result.findings[0].note).toContain('truncated');

    const controller = new AbortController();
    controller.abort();
    await expect(scanEmbeddedSignatures(fileFromBytes(new Uint8Array(1024 * 1024), 'large.bin'), undefined, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('shared analysis event state', () => {
  it('applies discoveries to one synchronized run and ignores events from replaced jobs', () => {
    const run = createAnalysisRun(5, fileFromBytes(new Uint8Array(8), 'bytes.bin'), false);
    const discovered: AnalysisEvent = { jobId: 5, type: 'STRUCTURE_REGION_DISCOVERED', index: 1, total: 1,
      region: { label: 'Header', offset: 0, length: 4, kind: 'header' } };
    const withRegion = applyAnalysisEvent(run, discovered);
    const withEntropy = applyAnalysisEvent(withRegion, { jobId: 5, type: 'ENTROPY_REGION_ANALYZED', regions: [{ offset: 0, length: 4, value: 2 }] });
    const withString = applyAnalysisEvent(withEntropy, { jobId: 5, type: 'STRING_BATCH_DISCOVERED', totalStrings: 1,
      strings: [{ offset: 1, length: 5, text: 'hello', encoding: 'ASCII' }] });
    const withStringCompletion = applyAnalysisEvent(withString, { jobId: 5, type: 'STRING_EXTRACTION_COMPLETED', totalStrings: 1, indexLimitReached: false });
    const withFrequencyCompletion = applyAnalysisEvent(withStringCompletion, { jobId: 5, type: 'BYTE_FREQUENCY_COMPLETED', totalBytes: 8 });
    const stale = applyAnalysisEvent(withFrequencyCompletion, { jobId: 4, type: 'STRUCTURE_PARSING_STARTED' });
    expect(stale.stage).toBe('received');
    expect(withFrequencyCompletion.regions[0].offset).toBe(withFrequencyCompletion.entropy[0].offset);
    expect(intersects(withFrequencyCompletion.regions[0], withFrequencyCompletion.strings[0])).toBe(true);
    expect(withFrequencyCompletion.strings[0].offset).toBe(1);
    expect(withFrequencyCompletion.stringsCompleted).toBe(true);
    expect(withFrequencyCompletion.histogramCompleted).toBe(true);
  });
});

describe('analysis result presentation', () => {
  it('sets a bounded reveal duration from the number of real stages', () => {
    expect(minimumPresentationDuration(4)).toBe(1_500);
    expect(minimumPresentationDuration(7)).toBeGreaterThanOrEqual(1_500);
    expect(minimumPresentationDuration(7)).toBeLessThanOrEqual(2_500);
    expect(minimumPresentationDuration(12)).toBe(2_500);
    expect(SMALL_FILE_PRESENTATION_LIMIT).toBe(4 * 1024 * 1024);
  });

  it('keeps entropy bins tied to their original offsets while revealing a batch in order', () => {
    const event: AnalysisEvent = { jobId: 9, type: 'ENTROPY_REGION_ANALYZED', regions: [
      { offset: 0, length: 4, value: 1.5 }, { offset: 4, length: 4, value: 2.25 },
    ] };
    expect(presentationPhase(event)).toBe('entropy');
    expect(expandForPresentation(event)).toEqual([
      { ...event, regions: [{ offset: 0, length: 4, value: 1.5 }] },
      { ...event, regions: [{ offset: 4, length: 4, value: 2.25 }] },
    ]);
  });
});
