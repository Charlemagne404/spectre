import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { analyzeFile, AnalysisCancelledError, CHUNK_SIZE, shannon, STRING_LIMIT } from '../src/blackbox/analysis';
import { demonstrationFile } from '../src/blackbox/fixture';
import { buildHtmlReport, buildReport } from '../src/blackbox/reports';
import type { AnalysisEvent } from '../src/blackbox/model';
import { runParserRegistry } from '../src/blackbox/parserRegistry';

function testFile(bytes: Uint8Array, name = 'fixture.bin') {
  return new File([bytes.slice().buffer as ArrayBuffer], name, { lastModified: 1_700_000_000_000 });
}

function pngChunk(name: string, payload: Uint8Array) {
  const chunk = new Uint8Array(12 + payload.length);
  new DataView(chunk.buffer).setUint32(0, payload.length, false);
  chunk.set(new TextEncoder().encode(name), 4);
  chunk.set(payload, 8);
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, 8 + payload.length)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1;
  }
  new DataView(chunk.buffer).setUint32(8 + payload.length, (crc ^ 0xffffffff) >>> 0, false);
  return chunk;
}

function zipFixture() {
  const name = new TextEncoder().encode('a.txt');
  const data = new TextEncoder().encode('hello');
  const local = new Uint8Array(30 + name.length + data.length);
  const localView = new DataView(local.buffer);
  localView.setUint32(0, 0x04034b50, true);
  localView.setUint16(4, 20, true);
  localView.setUint32(18, data.length, true);
  localView.setUint32(22, data.length, true);
  localView.setUint16(26, name.length, true);
  local.set(name, 30);
  local.set(data, 30 + name.length);

  const central = new Uint8Array(46 + name.length);
  const centralView = new DataView(central.buffer);
  centralView.setUint32(0, 0x02014b50, true);
  centralView.setUint16(4, 20, true);
  centralView.setUint16(6, 20, true);
  centralView.setUint32(20, data.length, true);
  centralView.setUint32(24, data.length, true);
  centralView.setUint16(28, name.length, true);
  central.set(name, 46);

  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, 1, true);
  endView.setUint16(10, 1, true);
  endView.setUint32(12, central.length, true);
  endView.setUint32(16, local.length, true);
  const joined = new Uint8Array(local.length + central.length + end.length);
  joined.set(local);
  joined.set(central, local.length);
  joined.set(end, local.length + central.length);
  return joined;
}

function zip64Fixture() {
  const name = new TextEncoder().encode('a.txt');
  const payload = new TextEncoder().encode('hello');
  const local = new Uint8Array(30 + name.length + payload.length);
  const localView = new DataView(local.buffer);
  localView.setUint32(0, 0x04034b50, true);
  localView.setUint16(4, 45, true);
  localView.setUint32(18, payload.length, true);
  localView.setUint32(22, payload.length, true);
  localView.setUint16(26, name.length, true);
  local.set(name, 30);
  local.set(payload, 30 + name.length);
  const extra = new Uint8Array(28);
  const extraView = new DataView(extra.buffer);
  extraView.setUint16(0, 1, true);
  extraView.setUint16(2, 24, true);
  extraView.setBigUint64(4, BigInt(payload.length), true);
  extraView.setBigUint64(12, BigInt(payload.length), true);
  extraView.setBigUint64(20, 0n, true);
  const central = new Uint8Array(46 + name.length + extra.length);
  const centralView = new DataView(central.buffer);
  centralView.setUint32(0, 0x02014b50, true);
  centralView.setUint16(4, 45, true);
  centralView.setUint16(6, 45, true);
  centralView.setUint32(20, 0xffffffff, true);
  centralView.setUint32(24, 0xffffffff, true);
  centralView.setUint16(28, name.length, true);
  centralView.setUint16(30, extra.length, true);
  centralView.setUint32(42, 0xffffffff, true);
  central.set(name, 46);
  central.set(extra, 46 + name.length);
  const recordOffset = local.length + central.length;
  const zip64End = new Uint8Array(56);
  const zip64View = new DataView(zip64End.buffer);
  zip64View.setUint32(0, 0x06064b50, true);
  zip64View.setBigUint64(4, 44n, true);
  zip64View.setBigUint64(24, 1n, true);
  zip64View.setBigUint64(32, 1n, true);
  zip64View.setBigUint64(40, BigInt(central.length), true);
  zip64View.setBigUint64(48, BigInt(local.length), true);
  const locator = new Uint8Array(20);
  const locatorView = new DataView(locator.buffer);
  locatorView.setUint32(0, 0x07064b50, true);
  locatorView.setBigUint64(8, BigInt(recordOffset), true);
  locatorView.setUint32(16, 1, true);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, 0xffff, true);
  eocdView.setUint16(10, 0xffff, true);
  eocdView.setUint32(12, 0xffffffff, true);
  eocdView.setUint32(16, 0xffffffff, true);
  const result = new Uint8Array(local.length + central.length + zip64End.length + locator.length + eocd.length);
  let cursor = 0;
  for (const part of [local, central, zip64End, locator, eocd]) { result.set(part, cursor); cursor += part.length; }
  return result;
}

describe('event-driven file analysis', () => {
  it('reports actual WAVE regions, SHA-256, byte counts and progressive events', async () => {
    const file = demonstrationFile();
    const events: AnalysisEvent[] = [];
    const result = await analyzeFile(file, (event) => events.push(event), 7);
    const source = new Uint8Array(await file.arrayBuffer());

    expect(result.type).toBe('RIFF / WAVE');
    expect(result.mime).toBe('audio/wav');
    expect(result.extensionMatch).toBe(true);
    expect(result.sha256).toBe(createHash('sha256').update(source).digest('hex'));
    expect(result.regions.map(({ label }) => label)).toEqual(['RIFF', 'fmt', 'LIST', 'data', 'JUNK']);
    expect(result.regions.reduce((total, item) => total + item.length, 0)).toBe(file.size);
    expect(result.histogram.reduce((total, count) => total + count, 0)).toBe(file.size);
    expect(result.firstOffsets.every((offset, byte) => result.histogram[byte] ? offset >= 0 : offset === -1)).toBe(true);
    expect(result.entropy.reduce((total, bin) => total + bin.length, 0)).toBe(file.size);
    expect(Math.max(...result.entropy.map(({ value }) => value))).toBeGreaterThan(6);
    expect(result.strings.some(({ text }) => text.includes('reference capture'))).toBe(true);
    expect(events[0]).toMatchObject({ jobId: 7, type: 'FILE_RECEIVED', name: file.name, size: file.size });
    expect(events.map(({ type }) => type)).toContain('FILE_IDENTIFIED');
    expect(events.map(({ type }) => type)).toContain('HASHING_PROGRESS');
    expect(events.map(({ type }) => type)).toContain('STRING_EXTRACTION_COMPLETED');
    expect(events.map(({ type }) => type)).toContain('BYTE_FREQUENCY_COMPLETED');
    expect(events.filter(({ type }) => type === 'STRUCTURE_REGION_BATCH_DISCOVERED')
      .flatMap((event) => event.type === 'STRUCTURE_REGION_BATCH_DISCOVERED' ? event.regions : [])).toEqual(result.regions);
    expect(events.at(-1)).toMatchObject({ type: 'ANALYSIS_COMPLETED', jobId: 7 });
  });

  it('extracts ASCII and UTF-16LE strings with source byte offsets and bounded previews', async () => {
    const ascii = new TextEncoder().encode('\0hello Spectre\u0001');
    const utfText = 'FORENSIC';
    const utf = new Uint8Array(utfText.length * 2);
    for (let index = 0; index < utfText.length; index++) utf[index * 2] = utfText.charCodeAt(index);
    const long = new Uint8Array(12_000).fill(0x41);
    const bytes = new Uint8Array(ascii.length + utf.length + 1 + long.length);
    bytes.set(ascii);
    bytes.set(utf, ascii.length);
    bytes[ascii.length + utf.length] = 0;
    bytes.set(long, ascii.length + utf.length + 1);
    const result = await analyzeFile(testFile(bytes, 'strings.dat'));

    expect(result.strings).toContainEqual({ offset: 1, length: 13, text: 'hello Spectre', encoding: 'ASCII' });
    expect(result.strings).toContainEqual({ offset: ascii.length, length: 16, text: utfText, encoding: 'UTF-16LE' });
    const longString = result.strings.find(({ offset }) => offset === ascii.length + utf.length + 1);
    expect(longString?.length).toBe(12_000);
    expect(longString?.text).toHaveLength(240);
    expect(result.totalStrings).toBe(3);
  });

  it('keeps strings across chunk boundaries and stops the primary index at its exposed limit', async () => {
    const bytes = new Uint8Array(CHUNK_SIZE + 8 + (STRING_LIMIT + 2) * 6);
    bytes.set(new TextEncoder().encode('across-boundary'), CHUNK_SIZE - 7);
    for (let index = CHUNK_SIZE + 9; index + 5 < bytes.length; index += 6) bytes.set(new TextEncoder().encode('hello'), index);
    const events: AnalysisEvent[] = [];
    const result = await analyzeFile(testFile(bytes, 'boundaries.bin'), (event) => events.push(event));
    expect(result.strings[0]).toEqual({ offset: CHUNK_SIZE - 7, length: 15, text: 'across-boundary', encoding: 'ASCII' });
    expect(result.strings).toHaveLength(STRING_LIMIT);
    expect(result.totalStrings).toBe(STRING_LIMIT);
    expect(result.stringIndexLimitReached).toBe(true);
    expect(events.find(({ type }) => type === 'STRING_EXTRACTION_COMPLETED')).toMatchObject({ indexLimitReached: true });
    expect(events.filter(({ type }) => type === 'STRING_BATCH_DISCOVERED').length).toBeGreaterThan(1);
    expect(result.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('counts byte frequencies and computes entropy for a uniform byte distribution', async () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
    const result = await analyzeFile(testFile(bytes, 'uniform.bin'));
    expect(result.histogram).toEqual(Array(256).fill(1));
    expect(result.averageEntropy).toBe(8);
    expect(result.entropy).toEqual([{ offset: 0, length: 256, value: 8 }]);
    expect(shannon([3, 1], 4)).toBeCloseTo(0.811278);
    expect(shannon(Array(256).fill(1), 256)).toBe(8);
  });

  it('identifies misleading extensions without drawing a threat conclusion', async () => {
    const bytes = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF');
    const result = await analyzeFile(testFile(bytes, 'report.png'));
    const report = buildReport(result, '2026-11-23T12:00:00.000Z');
    expect(result.type).toBe('PDF document');
    expect(result.mime).toBe('application/pdf');
    expect(result.extensionMatch).toBe(false);
    expect(report.detectedFacts.sha256).toBe(result.sha256);
    expect(report.interpretations[0].note).toContain('not a maliciousness verdict');
    expect(report.detectedFacts.structure.mode).toBe('format-aware');
    expect(report.detectedFacts.structure.limitation).toContain('Xref streams');
    expect(buildHtmlReport(result)).toContain('does not match the detected type');
    expect(buildHtmlReport(result)).toContain('Confirmed parser findings');
    expect(report.detectedFacts.analysisMetrics.chunkSize).toBe(CHUNK_SIZE);
    const bounded = buildReport({ ...result, strings: Array.from({ length: 1_200 }, (_, offset) => ({
      offset, length: 5, text: 'entry', encoding: 'ASCII' as const,
    })) });
    expect(bounded.detectedFacts.strings).toMatchObject({ indexed: 1_200, included: 1_000, omitted: 200 });
    const capped = buildReport({ ...result, totalStrings: STRING_LIMIT, stringIndexLimitReached: true });
    expect(capped.detectedFacts.strings).toMatchObject({ totalFound: null, indexLimitReached: true });
    expect(capped.interpretations.some(({ subject }) => subject === 'String index limit')).toBe(true);
  });

  it('follows PDF xref entries to its catalog and page tree', async () => {
    const prefix = '%PDF-1.7\n';
    const object1 = '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n';
    const object2 = '2 0 obj\n<< /Type /Pages /Count 1 /Kids [] >>\nendobj\n';
    const body = prefix + object1 + object2;
    const object1Offset = Buffer.byteLength(prefix);
    const object2Offset = object1Offset + Buffer.byteLength(object1);
    const xrefOffset = Buffer.byteLength(body);
    const xref = `xref\n0 3\n0000000000 65535 f \n${String(object1Offset).padStart(10, '0')} 00000 n \n${String(object2Offset).padStart(10, '0')} 00000 n \ntrailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
    const result = await analyzeFile(testFile(new TextEncoder().encode(body + xref), 'catalog.pdf'));
    expect(result.structure.parser).toBe('PDF xref and object inspection');
    expect(result.structure.findings).toContainEqual(expect.objectContaining({ label: 'PDF version', value: '1.7' }));
    expect(result.structure.findings).toContainEqual(expect.objectContaining({ label: 'Declared page count', value: '1' }));
    expect(result.structure.complete).toBe(true);
    expect(result.regions.some(({ label }) => label.includes('Cross-reference'))).toBe(true);
  });

  it('identifies a bounded PDF stream without decompressing its payload', async () => {
    const prefix = '%PDF-1.7\n';
    const object1 = '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n';
    const object2 = '2 0 obj\n<< /Type /Pages /Count 1 /Kids [] >>\nendobj\n';
    const object3 = '3 0 obj\n<< /Length 4 /Filter /FlateDecode >>\nstream\nDATA\nendstream\nendobj\n';
    const body = prefix + object1 + object2 + object3;
    const offsets = [0, Buffer.byteLength(prefix), Buffer.byteLength(prefix + object1), Buffer.byteLength(prefix + object1 + object2)];
    const xrefOffset = Buffer.byteLength(body);
    const lines = ['xref', '0 4', '0000000000 65535 f ', ...offsets.slice(1).map((offset) => String(offset).padStart(10, '0') + ' 00000 n '),
      'trailer', '<< /Size 4 /Root 1 0 R >>', 'startxref', String(xrefOffset), '%%EOF'];
    const result = await analyzeFile(testFile(new TextEncoder().encode(body + lines.join('\n')), 'stream.pdf'));
    expect(result.structure.findings).toContainEqual(expect.objectContaining({ label: 'PDF stream', value: 'Object 3 · 4 bytes · /FlateDecode' }));
    const stream = result.structure.findings?.find(({ label }) => label === 'PDF stream');
    expect(stream?.offset).toBe(Buffer.byteLength(body.slice(0, body.indexOf('DATA'))));
    expect(stream?.length, JSON.stringify(stream)).toBe(4);
  });

  it('parses PNG chunks and reports its checksum limitation', async () => {
    const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const ihdrPayload = new Uint8Array(13);
    new DataView(ihdrPayload.buffer).setUint32(0, 640, false);
    new DataView(ihdrPayload.buffer).setUint32(4, 480, false);
    ihdrPayload.set([8, 2, 0, 0, 0], 8);
    const ihdr = pngChunk('IHDR', ihdrPayload);
    const iend = pngChunk('IEND', new Uint8Array());
    const bytes = new Uint8Array(signature.length + ihdr.length + iend.length);
    bytes.set(signature);
    bytes.set(ihdr, signature.length);
    bytes.set(iend, signature.length + ihdr.length);
    const result = await analyzeFile(testFile(bytes, 'image.png'));
    expect(result.regions.map(({ label }) => label)).toEqual(['PNG signature', 'IHDR', 'IEND']);
    expect(result.regions.map(({ offset, length }) => [offset, length])).toEqual([[0, 8], [8, 25], [33, 12]]);
    expect(result.structure.parser).toBe('PNG chunks');
    expect(result.structure.limitation).toContain('image data is not decompressed');
    expect(result.structure.findings).toContainEqual(expect.objectContaining({ label: 'Dimensions', value: '640 × 480' }));
    expect(result.structure.warnings.some((warning) => warning.includes('CRC'))).toBe(false);
  });

  it('parses bounded JPEG markers and image data offsets', async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xda, 0, 2, 1, 2, 3, 0xff, 0xd9]);
    const result = await analyzeFile(testFile(bytes, 'image.jpg'));
    expect(result.regions.map(({ label }) => label)).toEqual(['SOI', 'APP0', 'SOS', 'Entropy-coded image data', 'EOI']);
    expect(result.regions.map(({ offset, length }) => [offset, length])).toEqual([[0, 2], [2, 4], [6, 4], [10, 3], [13, 2]]);
    expect(result.structure.complete).toBe(true);
  });

  it('parses ZIP central-directory offsets and entry names', async () => {
    const result = await analyzeFile(testFile(zipFixture(), 'archive.zip'));
    expect(result.type).toBe('ZIP archive');
    expect(result.regions[0]).toMatchObject({ label: 'a.txt', offset: 0, length: 40, kind: 'data' });
    expect(result.regions.some(({ label }) => label === 'Central directory')).toBe(true);
    expect(result.regions.some(({ label }) => label === 'End of central directory')).toBe(true);
    expect(result.structure.parser).toBe('ZIP central directory');
  });

  it('resolves ZIP64 end records and per-entry sizes without extracting data', async () => {
    const result = await analyzeFile(testFile(zip64Fixture(), 'large.zip'));
    expect(result.structure.parser).toBe('ZIP central directory');
    expect(result.structure.complete).toBe(true);
    expect(result.structure.warnings).toEqual([]);
    expect(result.structure.findings).toContainEqual(expect.objectContaining({ label: 'Entry · a.txt', value: '5 bytes', offset: 0 }));
  });

  it('reports a damaged PNG chunk CRC while retaining bounded chunk parsing', async () => {
    const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const payload = new Uint8Array(13);
    new DataView(payload.buffer).setUint32(0, 1, false);
    new DataView(payload.buffer).setUint32(4, 1, false);
    payload.set([8, 2, 0, 0, 0], 8);
    const chunk = pngChunk('IHDR', payload);
    chunk[chunk.length - 1] ^= 0xff;
    const iend = pngChunk('IEND', new Uint8Array());
    const bytes = new Uint8Array(signature.length + chunk.length + iend.length);
    bytes.set(signature);
    bytes.set(chunk, signature.length);
    bytes.set(iend, signature.length + chunk.length);
    const result = await analyzeFile(testFile(bytes, 'damaged.png'));
    expect(result.regions.map(({ label }) => label)).toContain('IHDR');
    expect(result.structure.warnings).toContain('IHDR chunk CRC does not match its contents.');
  });

  it('isolates parser exceptions from the rest of file analysis', async () => {
    const file = testFile(new Uint8Array([1, 2, 3]), 'malformed.bin');
    const identity = { name: file.name, size: file.size, type: 'PNG image', mime: 'image/png', extension: '.png', extensionMatch: true,
      sourceMime: '', lastModified: file.lastModified };
    const dispatch = await runParserRegistry(file, identity, [{ id: 'PNG test parser', supports: () => true,
      parse: async () => { throw new RangeError('outside parser bounds'); } }]);
    expect(dispatch.parser).toBe('PNG test parser');
    expect(dispatch.output).toBeNull();
    expect(dispatch.error).toContain('outside parser bounds');
  });

  it('parses PE section raw ranges and SQLite database pages', async () => {
    const pe = new Uint8Array(132);
    pe.set([0x4d, 0x5a]);
    new DataView(pe.buffer).setUint32(0x3c, 64, true);
    pe.set([0x50, 0x45, 0, 0], 64);
    new DataView(pe.buffer).setUint16(64 + 4, 0x8664, true);
    new DataView(pe.buffer).setUint16(64 + 6, 1, true);
    new DataView(pe.buffer).setUint16(64 + 20, 0, true);
    pe.set(new TextEncoder().encode('.text'), 88);
    new DataView(pe.buffer).setUint32(88 + 16, 4, true);
    new DataView(pe.buffer).setUint32(88 + 20, 128, true);
    new DataView(pe.buffer).setUint32(88 + 36, 0x60000020, true);
    const peResult = await analyzeFile(testFile(pe, 'sample.exe'));
    expect(peResult.type).toBe('MZ executable');
    expect(peResult.regions).toContainEqual({ label: '.text', offset: 128, length: 4, kind: 'data' });
    expect(peResult.structure.parser).toBe('PE headers and sections');
    expect(peResult.structure.findings).toContainEqual(expect.objectContaining({ label: 'Architecture', value: 'x86-64' }));
    expect(peResult.structure.findings?.find(({ label }) => label === 'Section .text')?.value).toContain('EXECUTE');

    const sqlite = new Uint8Array(1024);
    sqlite.set(new TextEncoder().encode('SQLite format 3\0'));
    new DataView(sqlite.buffer).setUint16(16, 512, false);
    sqlite[18] = 1;
    sqlite[19] = 1;
    sqlite[20] = 0;
    new DataView(sqlite.buffer).setUint32(44, 4, false);
    new DataView(sqlite.buffer).setUint32(56, 1, false);
    new DataView(sqlite.buffer).setUint32(28, 2, false);
    sqlite[100] = 0x0d;
    new DataView(sqlite.buffer).setUint16(105, 512, false);
    const sqliteResult = await analyzeFile(testFile(sqlite, 'sample.sqlite'));
    expect(sqliteResult.type).toBe('SQLite database');
    expect(sqliteResult.regions.map(({ label, offset, length }) => [label, offset, length])).toEqual([
      ['SQLite page 1', 0, 512], ['SQLite page 2', 512, 512],
    ]);
  });

  it('handles ELF headers and generic unknown byte ranges honestly', async () => {
    const elf = new Uint8Array(64);
    elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
    new DataView(elf.buffer).setUint16(18, 62, true);
    new DataView(elf.buffer).setUint16(58, 64, true);
    const elfResult = await analyzeFile(testFile(elf, 'sample.elf'));
    expect(elfResult.type).toBe('ELF binary');
    expect(elfResult.regions[0]).toMatchObject({ label: 'ELF header', offset: 0, length: 64 });
    expect(elfResult.structure.parser).toBe('ELF program headers and sections');
    expect(elfResult.structure.findings).toContainEqual(expect.objectContaining({ label: 'Architecture', value: 'x86-64' }));

    const unknown = await analyzeFile(testFile(new Uint8Array([0, 255, 0, 255, 0, 255]), 'odd.bin'));
    expect(unknown.structure.mode).toBe('generic');
    expect(unknown.structure.limitation).toContain('not discovered sections');
    expect(unknown.regions.reduce((sum, part) => sum + part.length, 0)).toBe(6);
  });

  it('bounds malformed WAVE chunks and treats empty files as complete analyses', async () => {
    const malformed = new Uint8Array([82, 73, 70, 70, 255, 255, 255, 255, 87, 65, 86, 69, 100, 97, 116, 97, 255, 255, 255, 255]);
    const wave = await analyzeFile(testFile(malformed, 'short.wav'));
    expect(wave.regions).toEqual([
      { label: 'RIFF', kind: 'header', offset: 0, length: 12 },
      { label: 'Remaining bytes', kind: 'other', offset: 12, length: 8 },
    ]);
    expect(wave.structure.complete).toBe(false);

    const emptyFile = testFile(new Uint8Array(), 'empty');
    const empty = await analyzeFile(emptyFile);
    expect(empty.type).toBe('Empty file');
    expect(empty.entropy).toEqual([]);
    expect(empty.regions).toEqual([]);
    expect(empty.strings).toEqual([]);
    expect(empty.averageEntropy).toBe(0);
    expect(empty.sha256).toBe(createHash('sha256').digest('hex'));
    expect(empty.structure.complete).toBe(true);
  });

  it('stops between real file-read batches when its cancellation signal is aborted', async () => {
    const controller = new AbortController();
    const seen: string[] = [];
    const source = testFile(new Uint8Array(CHUNK_SIZE + 10).fill(0x41), 'cancel.bin');
    await expect(analyzeFile(source, (event) => {
      seen.push(event.type);
      if (event.type === 'HASHING_PROGRESS') controller.abort();
    }, 0, controller.signal)).rejects.toBeInstanceOf(AnalysisCancelledError);
    expect(seen).toContain('HASHING_PROGRESS');
    expect(seen).not.toContain('ANALYSIS_COMPLETED');
  });
});
