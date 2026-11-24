import { describe, expect, it } from 'vitest';
import { findBytePattern, parseBytePattern } from '../src/blackbox/byteSearch';
import { applyAnalysisEvent, createAnalysisRun } from '../src/blackbox/analysisEvents';
import { expandForPresentation, minimumPresentationDuration, presentationPhase, SMALL_FILE_PRESENTATION_LIMIT } from '../src/blackbox/analysisPresentation';
import { intersects } from '../src/blackbox/model';
import { interpretUnsigned } from '../src/blackbox/numeric';
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
