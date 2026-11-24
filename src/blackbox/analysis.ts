import { createSHA256 } from 'hash-wasm';
import type { Analysis, AnalysisEvent, AnalysisEventPayload, EntropyBin, FileIdentity, FileString, ParserFinding, Region } from './model';
import { StringScanner, STRING_PREVIEW_LENGTH } from './stringScanner';
import { runParserRegistry } from './parserRegistry';
import type { FormatParser, ParserOutput } from './parserRegistry';

const configuredChunkSize = Number((import.meta as ImportMeta & { env?: Record<string, string> }).env?.VITE_ANALYSIS_CHUNK_SIZE);
export const CHUNK_SIZE = Number.isSafeInteger(configuredChunkSize) && configuredChunkSize >= 64 * 1024 && configuredChunkSize <= 4 * 1024 * 1024
  ? configuredChunkSize : 512 * 1024;
export const STRING_LIMIT = 50_000;
export const STRING_PREVIEW = STRING_PREVIEW_LENGTH;
export const ENTROPY_REGION_LIMIT = 512;
const MIN_ENTROPY_WINDOW = 4096;
const STRING_BATCH_SIZE = 256;
const ENTROPY_BATCH_SIZE = 16;

export class AnalysisCancelledError extends Error {
  constructor() {
    super('Analysis cancelled.');
    this.name = 'AbortError';
  }
}

export function shannon(counts: ArrayLike<number>, length: number) {
  if (!length) return 0;
  let value = 0;
  for (let index = 0; index < counts.length; index++) {
    const count = counts[index];
    if (count > 0) {
      const probability = count / length;
      value -= probability * Math.log2(probability);
    }
  }
  return value;
}

function ascii(bytes: Uint8Array, offset = 0, length = bytes.length - offset) {
  let value = '';
  const end = Math.min(bytes.length, offset + length);
  for (let index = offset; index < end; index++) value += String.fromCharCode(bytes[index]);
  return value;
}

function starts(bytes: Uint8Array, signature: number[]) {
  return signature.every((byte, index) => bytes[index] === byte);
}

function extensionOf(name: string) {
  const leaf = name.split(/[\\/]/).at(-1) ?? name;
  const dot = leaf.lastIndexOf('.');
  return dot <= 0 ? '' : leaf.slice(dot).toLowerCase();
}

function detectType(bytes: Uint8Array) {
  if (!bytes.length) return 'Empty file';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE') return 'RIFF / WAVE';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'WebP image';
  if (starts(bytes, [137, 80, 78, 71, 13, 10, 26, 10])) return 'PNG image';
  if (starts(bytes, [255, 216, 255])) return 'JPEG image';
  if (ascii(bytes, 0, 16) === 'SQLite format 3\0') return 'SQLite database';
  if (starts(bytes, [0x7f, 69, 76, 70])) return 'ELF binary';
  if (starts(bytes, [0x50, 0x4b, 3, 4]) || starts(bytes, [0x50, 0x4b, 5, 6]) || starts(bytes, [0x50, 0x4b, 7, 8])) return 'ZIP archive';
  if (starts(bytes, [0x1f, 0x8b, 8])) return 'GZIP data';
  if (ascii(bytes, 0, 5) === '%PDF-') return 'PDF document';
  if (ascii(bytes, 0, 4) === 'OggS') return 'Ogg container';
  if (ascii(bytes, 0, 4) === 'GIF8') return 'GIF image';
  if (ascii(bytes, 0, 2) === 'BM') return 'BMP image';
  if (ascii(bytes, 0, 4) === 'fLaC') return 'FLAC audio';
  if (ascii(bytes, 0, 4) === 'MThd') return 'MIDI file';
  if (ascii(bytes, 0, 4) === 'FORM' && ['AIFF', 'AIFC'].includes(ascii(bytes, 8, 4))) return 'AIFF audio';
  if (ascii(bytes, 4, 4) === 'ftyp') return 'ISO base media';
  if (starts(bytes, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return '7-Zip archive';
  if (ascii(bytes, 0, 4) === 'Rar!') return 'RAR archive';
  if (ascii(bytes, 0, 2) === 'MZ') return 'MZ executable';
  try {
    const preview = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, Math.min(bytes.length, 64 * 1024)), { stream: true });
    if (!/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(preview)) return 'Text / UTF-8';
  } catch {
    // A failed UTF-8 decode means the bytes should remain classified as binary.
  }
  return 'Binary data';
}

const extensionTypes: Record<string, string[]> = {
  'RIFF / WAVE': ['.wav', '.wave'],
  'WebP image': ['.webp'],
  'PNG image': ['.png'],
  'JPEG image': ['.jpg', '.jpeg', '.jpe'],
  'SQLite database': ['.sqlite', '.sqlite3', '.db', '.db3'],
  'ELF binary': ['.elf', '.so', '.o'],
  'ZIP archive': ['.zip', '.jar', '.apk', '.docx', '.xlsx', '.pptx', '.odt'],
  'GZIP data': ['.gz', '.gzip'],
  'PDF document': ['.pdf'],
  'Ogg container': ['.ogg', '.ogv', '.oga', '.opus'],
  'GIF image': ['.gif'],
  'BMP image': ['.bmp', '.dib'],
  'FLAC audio': ['.flac'],
  'MIDI file': ['.mid', '.midi'],
  'AIFF audio': ['.aif', '.aiff', '.aifc'],
  'ISO base media': ['.mp4', '.m4v', '.mov', '.m4a', '.3gp'],
  '7-Zip archive': ['.7z'],
  'RAR archive': ['.rar'],
  'MZ executable': ['.exe', '.dll', '.sys', '.scr', '.com'],
  'Text / UTF-8': ['.txt', '.text', '.md', '.markdown', '.csv', '.tsv', '.json', '.xml', '.html', '.htm', '.log', '.yaml', '.yml', '.toml', '.ini', '.css', '.js', '.ts', '.rs', '.py', '.sh'],
};

function identify(file: File, prefix: Uint8Array): FileIdentity {
  const type = detectType(prefix);
  const extension = extensionOf(file.name);
  const expected = extensionTypes[type];
  return {
    name: file.name || 'unnamed file',
    size: file.size,
    type,
    mime: ({
      'RIFF / WAVE': 'audio/wav', 'WebP image': 'image/webp', 'PNG image': 'image/png',
      'JPEG image': 'image/jpeg', 'SQLite database': 'application/vnd.sqlite3',
      'ELF binary': 'application/x-elf', 'ZIP archive': 'application/zip', 'GZIP data': 'application/gzip',
      'PDF document': 'application/pdf', 'Ogg container': 'application/ogg', 'GIF image': 'image/gif',
      'BMP image': 'image/bmp', 'FLAC audio': 'audio/flac', 'MIDI file': 'audio/midi',
      'AIFF audio': 'audio/aiff', 'ISO base media': 'video/mp4', '7-Zip archive': 'application/x-7z-compressed',
      'RAR archive': 'application/vnd.rar', 'MZ executable': 'application/vnd.microsoft.portable-executable',
      'Text / UTF-8': 'text/plain', 'Empty file': 'application/x-empty', 'Binary data': 'application/octet-stream',
    } as Record<string, string>)[type] ?? 'application/octet-stream',
    extension,
    extensionMatch: expected ? extension ? expected.includes(extension) : false : null,
    sourceMime: file.type,
    lastModified: file.lastModified,
  };
}

function checkCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new AnalysisCancelledError();
}

export async function analyzeFile(
  file: File,
  onEvent?: (event: AnalysisEvent) => void,
  jobId = 0,
  signal?: AbortSignal,
): Promise<Analysis> {
  const startedAt = new Date().toISOString();
  const analysisStart = performance.now();
  let eventCount = 0;
  const emit = (event: AnalysisEventPayload) => {
    eventCount++;
    onEvent?.({ ...event, jobId } as AnalysisEvent);
  };
  checkCancelled(signal);
  emit({ type: 'FILE_RECEIVED', name: file.name, size: file.size });
  emit({ type: 'FILE_IDENTIFICATION_STARTED' });
  const prefix = new Uint8Array(await file.slice(0, Math.min(file.size, 64 * 1024)).arrayBuffer());
  checkCancelled(signal);
  const identity = identify(file, prefix);
  emit({ type: 'FILE_IDENTIFIED', identity });
  const hexPreview = new Uint8Array(await file.slice(0, Math.min(file.size, 1024)).arrayBuffer());
  if (hexPreview.length) emit({ type: 'HEX_DATA_AVAILABLE', offset: 0, bytes: Array.from(hexPreview) });

  const sha = await createSHA256();
  const histogram = new Float64Array(256);
  const firstOffsets = new Array<number>(256).fill(-1);
  const binCounts = new Float64Array(256);
  const binSize = Math.max(MIN_ENTROPY_WINDOW, Math.ceil(file.size / ENTROPY_REGION_LIMIT));
  const entropy: EntropyBin[] = [];
  const strings: FileString[] = [];
  let totalStrings = 0;
  let stringIndexLimitReached = false;
  let entropyOffset = 0;
  let entropyLength = 0;
  let stringBatch: FileString[] = [];
  let entropyBatch: EntropyBin[] = [];
  let lastProgressUpdate = -Infinity;
  let lastStringUpdate = performance.now();
  let lastHistogramUpdate = -Infinity;

  function queueString(item: FileString) {
    if (strings.length >= STRING_LIMIT) return;
    strings.push(item);
    totalStrings = strings.length;
    stringBatch.push(item);
    if (strings.length >= STRING_LIMIT) stringIndexLimitReached = true;
    if (stringBatch.length >= STRING_BATCH_SIZE * 4 || performance.now() - lastStringUpdate >= 80) flushStringBatch(true);
  }

  function flushStringBatch(force = false) {
    if (!stringBatch.length || (!force && stringBatch.length < STRING_BATCH_SIZE)) return;
    emit({ type: 'STRING_BATCH_DISCOVERED', strings: stringBatch, totalStrings });
    stringBatch = [];
    lastStringUpdate = performance.now();
  }

  function flushEntropyBatch() {
    if (!entropyBatch.length) return;
    emit({ type: 'ENTROPY_REGION_ANALYZED', regions: entropyBatch });
    entropyBatch = [];
  }

  function finishEntropy(offset: number) {
    if (!entropyLength) return;
    const region = { offset: entropyOffset, length: entropyLength, value: shannon(binCounts, entropyLength) };
    entropy.push(region);
    entropyBatch.push(region);
    binCounts.fill(0);
    entropyOffset = offset;
    entropyLength = 0;
    if (entropyBatch.length >= ENTROPY_BATCH_SIZE) flushEntropyBatch();
  }

  const stringScanner = new StringScanner(({ value }) => queueString(value), '', STRING_LIMIT);

  emit({ type: 'HASHING_STARTED', total: file.size });
  emit({ type: 'ENTROPY_ANALYSIS_STARTED', windowSize: binSize });
  for (let start = 0; start < file.size; start += CHUNK_SIZE) {
    checkCancelled(signal);
    const bytes = new Uint8Array(await file.slice(start, Math.min(file.size, start + CHUNK_SIZE)).arrayBuffer());
    checkCancelled(signal);
    sha.update(bytes);

    for (let index = 0; index < bytes.length; index++) {
      const byte = bytes[index];
      const offset = start + index;
      histogram[byte]++;
      if (firstOffsets[byte] < 0) firstOffsets[byte] = offset;
      binCounts[byte]++;
      entropyLength++;

      if (!stringIndexLimitReached) stringScanner.consume(byte, offset);

      if (entropyLength === binSize || offset + 1 === file.size) finishEntropy(offset + 1);
    }

    const processed = start + bytes.length;
    totalStrings = strings.length;
    if (performance.now() - lastProgressUpdate >= 80 || processed === file.size) {
      emit({ type: 'HASHING_PROGRESS', processed, total: file.size });
      lastProgressUpdate = performance.now();
    }
    checkCancelled(signal);
    flushStringBatch(performance.now() - lastStringUpdate >= 80);
    if (performance.now() - lastHistogramUpdate >= 80 || processed === file.size) {
      emit({ type: 'BYTE_FREQUENCY_UPDATED', histogram: Array.from(histogram), firstOffsets: [...firstOffsets] });
      lastHistogramUpdate = performance.now();
    }
  }

  if (!stringIndexLimitReached) stringScanner.finish();
  totalStrings = strings.length;
  flushStringBatch(true);
  emit({ type: 'STRING_EXTRACTION_COMPLETED', totalStrings, indexLimitReached: stringIndexLimitReached });
  flushEntropyBatch();
  if (file.size === 0) emit({ type: 'BYTE_FREQUENCY_UPDATED', histogram: Array.from(histogram), firstOffsets: [...firstOffsets] });
  emit({ type: 'BYTE_FREQUENCY_COMPLETED', totalBytes: file.size });
  const sha256 = sha.digest('hex');
  emit({ type: 'HASHING_COMPLETED', sha256 });
  emit({ type: 'ENTROPY_ANALYSIS_COMPLETED', averageEntropy: shannon(histogram, file.size) });

  checkCancelled(signal);
  emit({ type: 'STRUCTURE_PARSING_STARTED' });
  const parsed = await parseStructure(file, identity, signal);
  checkCancelled(signal);
  const structureBatchSize = 32;
  for (let index = 0; index < parsed.regions.length; index += structureBatchSize) {
    const regions = parsed.regions.slice(index, index + structureBatchSize);
    emit({ type: 'STRUCTURE_REGION_BATCH_DISCOVERED', regions, index: index + regions.length, total: parsed.regions.length });
    if (index + regions.length < parsed.regions.length) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  emit({ type: 'STRUCTURE_PARSING_COMPLETED', structure: parsed.structure });

  const completedAt = new Date().toISOString();
  const analysis: Analysis = {
    ...identity,
    sha256,
    regions: parsed.regions,
    structure: parsed.structure,
    entropy,
    histogram: Array.from(histogram),
    firstOffsets: [...firstOffsets],
    strings,
    totalStrings,
    stringIndexLimitReached,
    averageEntropy: shannon(histogram, file.size),
    metrics: {
      durationMs: performance.now() - analysisStart,
      eventCount: eventCount + 1,
      eventsPerSecond: (eventCount + 1) / Math.max((performance.now() - analysisStart) / 1000, 0.001),
      chunkSize: CHUNK_SIZE,
    },
    startedAt,
    completedAt,
  };
  emit({ type: 'ANALYSIS_COMPLETED', analysis });
  return analysis;
}

function region(label: string, offset: number, length: number, kind: Region['kind']): Region {
  return { label, offset, length, kind };
}

function finishRegionMap(regions: Region[], size: number, gapLabel = 'Unparsed bytes') {
  const sorted = regions.filter((item) => item.length > 0 && item.offset >= 0 && item.offset < size)
    .map((item) => ({ ...item, length: Math.min(item.length, size - item.offset) }))
    .sort((a, b) => a.offset - b.offset || b.length - a.length);
  const result: Region[] = [];
  let cursor = 0;
  for (const item of sorted) {
    if (item.offset > cursor) result.push(region(gapLabel, cursor, item.offset - cursor, 'other'));
    if (item.offset < cursor) continue;
    result.push(item);
    cursor = item.offset + item.length;
  }
  if (cursor < size) result.push(region(gapLabel, cursor, size - cursor, 'other'));
  return result;
}

async function readAt(file: File, offset: number, length: number, signal?: AbortSignal) {
  checkCancelled(signal);
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) return new Uint8Array(0);
  const start = Math.min(file.size, offset);
  const requestedEnd = offset + length;
  const end = Number.isSafeInteger(requestedEnd) ? Math.max(start, Math.min(file.size, requestedEnd)) : file.size;
  const bytes = new Uint8Array(await file.slice(start, end).arrayBuffer());
  checkCancelled(signal);
  return bytes;
}

function little(bytes: Uint8Array, offset = 0) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function big(bytes: Uint8Array, offset = 0) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, false);
}

function parserFinding(label: string, value: string | number, offset?: number, length?: number,
  kind: ParserFinding['kind'] = 'property'): ParserFinding {
  return { label, value: String(value), ...(offset === undefined ? {} : { offset }), ...(length === undefined ? {} : { length }), kind };
}

async function parseWave(file: File, signal?: AbortSignal) {
  const bytes = await readAt(file, 0, 12, signal);
  const warnings: string[] = [];
  const findings: ParserFinding[] = [];
  const regions = [region('RIFF', 0, Math.min(12, file.size), 'header')];
  if (bytes.length < 12) return {
    regions: finishRegionMap(regions, file.size, 'Remaining bytes'),
    structure: { parser: 'RIFF / WAVE', mode: 'format-aware' as const, complete: false, limitation: 'The RIFF header is truncated.', warnings },
  };
  const riffEnd = Math.min(file.size, 8 + little(bytes, 4));
  if (8 + little(bytes, 4) > file.size) warnings.push('The RIFF length declares bytes beyond the end of the file.');
  let offset = 12;
  let complete = false;
  let byteRate = 0;
  let dataBytes = 0;
  let chunkCount = 0;
  while (offset + 8 <= riffEnd && chunkCount < 512) {
    const header = await readAt(file, offset, 8, signal);
    const name = ascii(header, 0, 4);
    if (!/^[\x20-\x7e]{4}$/.test(name)) {
      warnings.push('A chunk identifier contains non-printable bytes.');
      break;
    }
    const payload = little(header, 4);
    const length = 8 + payload + payload % 2;
    if (length < 8 || offset + length > riffEnd) {
      warnings.push('A chunk length extends beyond the declared RIFF boundary.');
      break;
    }
    const kind: Region['kind'] = name === 'fmt ' ? 'format' : name === 'data' ? 'data' : name === 'LIST' ? 'metadata' : 'other';
    regions.push(region(name.trim() || 'Chunk', offset, length, kind));
    if (name === 'fmt ') {
      const format = await readAt(file, offset + 8, Math.min(payload, 64), signal);
      if (format.length < 16) warnings.push('The WAVE fmt chunk is shorter than the required 16 bytes.');
      else {
        const view = new DataView(format.buffer, format.byteOffset, format.byteLength);
        const code = view.getUint16(0, true);
        const channels = view.getUint16(2, true);
        const sampleRate = view.getUint32(4, true);
        byteRate = view.getUint32(8, true);
        const blockAlign = view.getUint16(12, true);
        const bitsPerSample = view.getUint16(14, true);
        const formatNames: Record<number, string> = { 1: 'PCM', 3: 'IEEE float', 6: 'A-law', 7: 'μ-law', 0xfffe: 'WAVE_FORMAT_EXTENSIBLE' };
        findings.push(
          parserFinding('Audio format', formatNames[code] ?? `Format ${code}`),
          parserFinding('Channels', channels),
          parserFinding('Sample rate', `${sampleRate.toLocaleString('en')} Hz`),
          parserFinding('Average byte rate', `${byteRate.toLocaleString('en')} B/s`),
          parserFinding('Block alignment', `${blockAlign} bytes`),
          parserFinding('Bits per sample', bitsPerSample),
        );
        if (!channels || !sampleRate || !byteRate || !blockAlign) warnings.push('The WAVE fmt chunk contains zero-valued audio parameters.');
        if (code === 0xfffe && format.length >= 40) findings.push(parserFinding('Extensible subformat', little(format, 24) & 0xffff));
      }
    } else if (name === 'data') {
      dataBytes += payload;
      findings.push(parserFinding('Audio data', `${payload.toLocaleString('en')} bytes`, offset + 8, payload, 'segment'));
    } else if (name === 'LIST' && payload >= 4) {
      const list = await readAt(file, offset + 8, Math.min(payload, 64 * 1024), signal);
      if (ascii(list, 0, 4) === 'INFO') {
        let cursor = 4;
        let parsedInfo = 0;
        while (cursor + 8 <= list.length && parsedInfo < 64) {
          const tag = ascii(list, cursor, 4);
          const textLength = little(list, cursor + 4);
          if (textLength > list.length - cursor - 8) { warnings.push('A WAVE INFO metadata value exceeds its bounded metadata window.'); break; }
          const text = ascii(list, cursor + 8, textLength).replace(/\0+$/, '').trim();
          if (text) findings.push(parserFinding(`INFO ${tag}`, text, offset + 16 + cursor, textLength, 'metadata'));
          cursor += 8 + textLength + textLength % 2;
          parsedInfo++;
        }
        if (payload > list.length) warnings.push('WAVE INFO metadata was limited to 64 KiB.');
      }
    }
    offset += length;
    chunkCount++;
  }
  if (chunkCount === 512 && offset < riffEnd) warnings.push('The 512-chunk WAVE parser limit was reached.');
  complete = offset === riffEnd || riffEnd < 12;
  if (byteRate && dataBytes) findings.push(parserFinding('Estimated duration', `${(dataBytes / byteRate).toFixed(3)} s`));
  return {
    regions: finishRegionMap(regions, file.size, 'Remaining bytes'),
    structure: { parser: 'RIFF / WAVE chunks', mode: 'format-aware' as const, complete,
      limitation: complete ? null : 'Top-level chunk boundaries are decoded; malformed or incomplete chunk data remains unresolved.', warnings, findings },
  };
}

async function parsePng(file: File, signal?: AbortSignal) {
  const regions = [region('PNG signature', 0, 8, 'header')];
  const warnings: string[] = [];
  const findings: ParserFinding[] = [];
  const colorNames: Record<number, string> = { 0: 'Grayscale', 2: 'Truecolor', 3: 'Indexed color', 4: 'Grayscale + alpha', 6: 'Truecolor + alpha' };
  const depthByColor: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  let offset = 8;
  let foundEnd = false;
  let count = 0;
  let sawHeader = false;
  let sawData = false;
  let dataChunks = 0;
  let dataBytes = 0;
  let crcBudget = 16 * 1024 * 1024;
  let skippedCrc = false;
  let truncatedText = false;
  while (offset + 12 <= file.size && count < 512) {
    const header = await readAt(file, offset, 8, signal);
    const payloadSize = big(header, 0);
    const name = ascii(header, 4, 4);
    const length = payloadSize + 12;
    if (!/^[A-Za-z]{4}$/.test(name) || length < 12 || offset + length > file.size) {
      warnings.push('A PNG chunk header or declared chunk length is invalid.');
      break;
    }
    if (count === 0 && name !== 'IHDR') warnings.push('IHDR is not the first PNG chunk.');
    if (name === 'IHDR') {
      if (sawHeader || count !== 0) warnings.push('PNG contains a duplicate or misplaced IHDR chunk.');
      sawHeader = true;
      if (payloadSize !== 13) warnings.push('PNG IHDR must contain exactly 13 bytes.');
      const ihdr = await readAt(file, offset + 8, Math.min(payloadSize, 13), signal);
      if (ihdr.length === 13) {
        const width = big(ihdr, 0);
        const height = big(ihdr, 4);
        const bitDepth = ihdr[8];
        const colorType = ihdr[9];
        const compression = ihdr[10];
        const filter = ihdr[11];
        const interlace = ihdr[12];
        findings.push(
          parserFinding('Dimensions', `${width.toLocaleString('en')} × ${height.toLocaleString('en')}`),
          parserFinding('Bit depth', bitDepth),
          parserFinding('Color type', colorNames[colorType] ?? `Unknown (${colorType})`),
          parserFinding('Compression method', compression),
          parserFinding('Filter method', filter),
          parserFinding('Interlace method', interlace === 0 ? 'None' : interlace === 1 ? 'Adam7' : `Unknown (${interlace})`),
        );
        if (!width || !height) warnings.push('PNG image dimensions must be non-zero.');
        if (!depthByColor[colorType]?.includes(bitDepth)) warnings.push('PNG bit depth is invalid for the declared color type.');
        if (compression !== 0 || filter !== 0 || interlace > 1) warnings.push('PNG IHDR contains an unsupported method value.');
      }
    } else if (name === 'IDAT') {
      if (!sawHeader) warnings.push('IDAT appears before a valid IHDR chunk.');
      if (dataChunks && !sawData) warnings.push('PNG IDAT chunks are not contiguous.');
      sawData = true;
      dataChunks++;
      dataBytes += payloadSize;
    } else if (sawData && name !== 'IEND') {
      // A later IDAT after this ancillary chunk is not contiguous as required by PNG.
      sawData = false;
    }
    if (name === 'IEND' && payloadSize !== 0) warnings.push('PNG IEND must have an empty payload.');
    regions.push(region(name, offset, length, name === 'IHDR' ? 'format' : name === 'iTXt' || name === 'tEXt' || name === 'iCCP' ? 'metadata' : name === 'IDAT' ? 'data' : 'other'));

    if (name === 'tEXt' || name === 'zTXt' || name === 'iTXt') {
      const metadata = await readAt(file, offset + 8, Math.min(payloadSize, 64 * 1024), signal);
      const keywordEnd = metadata.subarray(0, 128).indexOf(0);
      if (keywordEnd > 0) {
        const keyword = new TextDecoder('windows-1252').decode(metadata.subarray(0, keywordEnd));
        if (name === 'tEXt') {
          const textBytes = metadata.subarray(keywordEnd + 1);
          const text = new TextDecoder('windows-1252').decode(textBytes.subarray(0, 1024)).replace(/\0+$/, '');
          truncatedText ||= textBytes.length > 1024;
          findings.push(parserFinding(`Text · ${keyword.slice(0, 128)}`, text + (textBytes.length > 1024 ? '…' : ''), offset + 8, payloadSize, 'metadata'));
        } else if (name === 'zTXt') {
          findings.push(parserFinding(`Compressed text · ${keyword.slice(0, 128)}`, 'Identified; not decompressed', offset + 8, payloadSize, 'metadata'));
        } else {
          let cursor = keywordEnd + 1;
          if (cursor + 2 <= metadata.length) {
            const compressed = metadata[cursor] !== 0;
            cursor += 2;
            const languageEnd = metadata.indexOf(0, cursor);
            if (languageEnd >= 0) {
              cursor = languageEnd + 1;
              const translatedEnd = metadata.indexOf(0, cursor);
              if (translatedEnd >= 0) {
                cursor = translatedEnd + 1;
                const textBytes = metadata.subarray(cursor);
                truncatedText ||= !compressed && textBytes.length > 1024;
                const text = compressed ? 'Identified; compressed text not decompressed'
                  : new TextDecoder('utf-8').decode(textBytes.subarray(0, 1024)).replace(/\0+$/, '') + (textBytes.length > 1024 ? '…' : '');
                findings.push(parserFinding(`International text · ${keyword.slice(0, 128)}`, text, offset + 8, payloadSize, 'metadata'));
              }
            }
          }
        }
      } else warnings.push(`PNG ${name} metadata has no keyword separator.`);
      if (payloadSize > metadata.length) warnings.push(`PNG ${name} metadata was limited to 64 KiB.`);
    }

    const crcLength = 4 + payloadSize;
    if (crcLength <= crcBudget) {
      const actualCrc = await crc32Range(file, offset + 4, crcLength, signal);
      const expected = await readAt(file, offset + 8 + payloadSize, 4, signal);
      if (expected.length === 4 && big(expected) !== actualCrc) warnings.push(`${name} chunk CRC does not match its contents.`);
      crcBudget -= crcLength;
    } else skippedCrc = true;
    offset += length;
    count++;
    if (name === 'IEND') { foundEnd = true; break; }
  }
  if (!sawHeader) warnings.push('PNG IHDR was not found.');
  if (!dataChunks) warnings.push('PNG IDAT image data was not found.');
  if (truncatedText) warnings.push('PNG textual metadata previews are capped at 1 KiB per value.');
  if (dataChunks) findings.push(parserFinding('IDAT chunks', dataChunks), parserFinding('IDAT payload', `${dataBytes.toLocaleString('en')} bytes`));
  if (skippedCrc) warnings.push('CRC checks were limited to the first 16 MiB of chunk data.');
  if (count === 512 && !foundEnd) warnings.push('The 512-region display limit was reached.');
  return {
    regions: finishRegionMap(regions, file.size, 'Trailing PNG bytes'),
    structure: { parser: 'PNG chunks', mode: 'format-aware' as const, complete: foundEnd && sawHeader,
      limitation: foundEnd ? 'Chunk boundaries and IHDR fields are decoded; image data is not decompressed. CRC checks cover up to 16 MiB.'
        : 'PNG chunks are decoded through IEND or the first malformed boundary; image data is not decompressed.', warnings, findings },
  };
}

const crc32Table = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});

async function crc32Range(file: File, offset: number, length: number, signal?: AbortSignal) {
  let crc = 0xffffffff;
  for (let cursor = 0; cursor < length; cursor += CHUNK_SIZE) {
    const bytes = await readAt(file, offset + cursor, Math.min(CHUNK_SIZE, length - cursor), signal);
    for (const byte of bytes) crc = crc32Table[(crc ^ byte) & 0xff] ^ crc >>> 8;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const jpegMarkers: Record<number, string> = {
  0xc0: 'SOF0', 0xc1: 'SOF1', 0xc2: 'SOF2', 0xc3: 'SOF3', 0xc4: 'DHT', 0xc5: 'SOF5',
  0xc6: 'SOF6', 0xc7: 'SOF7', 0xc8: 'JPG', 0xc9: 'SOF9', 0xca: 'SOF10', 0xcb: 'SOF11',
  0xcc: 'DAC', 0xcd: 'SOF13', 0xce: 'SOF14', 0xcf: 'SOF15', 0xda: 'SOS', 0xdb: 'DQT',
  0xdc: 'DNL', 0xdd: 'DRI', 0xde: 'DHP', 0xdf: 'EXP', 0xfe: 'COM',
};

function parseExif(payload: Uint8Array, baseOffset: number) {
  const findings: ParserFinding[] = [];
  if (ascii(payload, 0, 6) !== 'Exif\0\0' || payload.length < 14) return findings;
  const tiff = 6;
  const littleEndian = payload[tiff] === 0x49 && payload[tiff + 1] === 0x49;
  if (!littleEndian && !(payload[tiff] === 0x4d && payload[tiff + 1] === 0x4d)) return findings;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  if (view.getUint16(tiff + 2, littleEndian) !== 42) return findings;
  const ifdOffset = view.getUint32(tiff + 4, littleEndian);
  const ifd = tiff + ifdOffset;
  if (ifd + 2 > payload.length) return findings;
  const count = Math.min(view.getUint16(ifd, littleEndian), 64);
  const tagNames: Record<number, string> = { 0x010f: 'Camera make', 0x0110: 'Camera model', 0x0112: 'Orientation', 0x0131: 'Software', 0x0132: 'Date/time' };
  for (let index = 0; index < count && ifd + 2 + (index + 1) * 12 <= payload.length; index++) {
    const entry = ifd + 2 + index * 12;
    const tag = view.getUint16(entry, littleEndian);
    const label = tagNames[tag];
    if (!label) continue;
    const type = view.getUint16(entry + 2, littleEndian);
    const values = view.getUint32(entry + 4, littleEndian);
    let value = '';
    if (tag === 0x0112 && type === 3 && values >= 1) {
      value = String(view.getUint16(entry + 8, littleEndian));
    } else if (type === 2 && values > 0 && values <= 4096) {
      const valueOffset = values <= 4 ? entry + 8 : tiff + view.getUint32(entry + 8, littleEndian);
      if (valueOffset >= 0 && valueOffset + values <= payload.length) {
        value = ascii(payload, valueOffset, Math.min(values, 512)).replace(/\0+$/, '').trim();
      }
    }
    if (value) findings.push(parserFinding(label, value, baseOffset + entry, 12, 'metadata'));
  }
  return findings;
}

async function findJpegEnd(file: File, start: number, signal?: AbortSignal) {
  let carry = -1;
  for (let cursor = start; cursor < file.size; cursor += CHUNK_SIZE) {
    const bytes = await readAt(file, cursor, Math.min(CHUNK_SIZE + 1, file.size - cursor), signal);
    for (let index = 0; index + 1 < bytes.length; index++) {
      if (bytes[index] === 0xff && bytes[index + 1] === 0xd9) return cursor + index;
    }
    if (carry === 0xff && bytes[0] === 0xd9) return cursor - 1;
    carry = bytes.at(-1) ?? -1;
  }
  return -1;
}

async function parseJpeg(file: File, signal?: AbortSignal) {
  const regions = [region('SOI', 0, 2, 'header')];
  const warnings: string[] = [];
  const findings: ParserFinding[] = [parserFinding('Start of image', 'SOI', 0, 2, 'segment')];
  const frameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  let scanStart = -1;
  let foundEnd = false;
  let count = 0;
  while (offset < file.size && count < 256) {
    const markerStart = offset;
    const markerWindow = await readAt(file, offset, Math.min(4096, file.size - offset), signal);
    if (markerWindow.length < 2 || markerWindow[0] !== 0xff) {
      warnings.push('Expected a JPEG marker at offset 0x' + offset.toString(16).toUpperCase() + '.');
      break;
    }
    let fillBytes = 1;
    while (fillBytes < markerWindow.length && markerWindow[fillBytes] === 0xff) fillBytes++;
    if (fillBytes >= markerWindow.length) { warnings.push('A JPEG marker fill run exceeds the 4 KiB marker window.'); break; }
    const markerIndex = offset + fillBytes;
    const marker = markerWindow[fillBytes];
    if (marker === undefined) break;
    const markerName = jpegMarkers[marker] ?? 'APP' + (marker >= 0xe0 && marker <= 0xef ? marker - 0xe0 : ' / 0x' + marker.toString(16).toUpperCase());
    if (marker === 0xd9) {
      regions.push(region('EOI', markerStart, markerIndex + 1 - markerStart, 'header'));
      findings.push(parserFinding('End of image', 'EOI', markerStart, markerIndex + 1 - markerStart, 'segment'));
      foundEnd = true;
      offset = markerIndex + 1;
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      regions.push(region(marker === 0x01 ? 'TEM' : 'RST' + (marker - 0xd0), markerStart, markerIndex + 1 - markerStart, 'other'));
      offset = markerIndex + 1;
      count++;
      continue;
    }
    const lengthBytes = await readAt(file, markerIndex + 1, 2, signal);
    if (lengthBytes.length < 2) { warnings.push('A JPEG segment length is truncated.'); break; }
    const segmentLength = lengthBytes[0] * 256 + lengthBytes[1];
    const segmentEnd = markerIndex + 1 + segmentLength;
    if (segmentLength < 2 || segmentEnd > file.size) { warnings.push('A JPEG segment extends beyond the end of the file.'); break; }
    const label = marker >= 0xe0 && marker <= 0xef ? 'APP' + (marker - 0xe0) : markerName;
    const kind = marker === 0xda ? 'data' : marker === 0xfe || marker >= 0xe0 && marker <= 0xef ? 'metadata' : 'format';
    regions.push(region(label, markerStart, segmentEnd - markerStart, kind));
    findings.push(parserFinding(label, `Segment · ${segmentLength.toLocaleString('en')} bytes`, markerStart, segmentEnd - markerStart, marker >= 0xe0 && marker <= 0xef || marker === 0xfe ? 'metadata' : 'segment'));
    const payloadOffset = markerIndex + 3;
    const payloadLength = segmentLength - 2;
    if (frameMarkers.has(marker)) {
      const frame = await readAt(file, payloadOffset, Math.min(payloadLength, 6 + 255 * 3), signal);
      if (frame.length < 6) warnings.push(`${label} frame header is truncated.`);
      else {
        const components = frame[5];
        const height = frame[1] * 256 + frame[2];
        const width = frame[3] * 256 + frame[4];
        findings.push(
          parserFinding('Image dimensions', `${width.toLocaleString('en')} × ${height.toLocaleString('en')}`),
          parserFinding('Sample precision', `${frame[0]} bits`),
          parserFinding('Components', components),
        );
        if (frame.length < 6 + components * 3 || segmentLength < 8 + components * 3) warnings.push(`${label} component table is truncated.`);
        for (let component = 0; component < components && 6 + component * 3 + 2 < frame.length; component++) {
          const at = 6 + component * 3;
          findings.push(parserFinding(`Component ${frame[at]}`, `Sampling ${frame[at + 1] >> 4}×${frame[at + 1] & 15} · quantization ${frame[at + 2]}`));
        }
      }
    }
    if (marker >= 0xe0 && marker <= 0xef) {
      const payload = await readAt(file, payloadOffset, Math.min(payloadLength, 1024 * 1024), signal);
      if (marker === 0xe0 && ascii(payload, 0, 5) === 'JFIF\0' && payload.length >= 14) {
        findings.push(parserFinding('JFIF version', `${payload[5]}.${payload[6]}`, payloadOffset, 14, 'metadata'));
        findings.push(parserFinding('JFIF density', `${payload[7] === 0 ? 'unitless' : payload[7] === 1 ? 'DPI' : 'DPCM'} · ${payload[8] * 256 + payload[9]}×${payload[10] * 256 + payload[11]}`, payloadOffset + 7, 5, 'metadata'));
      } else if (marker === 0xe1) {
        findings.push(...parseExif(payload, payloadOffset));
      } else if (marker === 0xe2 && ascii(payload, 0, 12) === 'ICC_PROFILE\0' && payload.length >= 14) {
        findings.push(parserFinding('ICC profile segment', `${payload[12]} of ${payload[13]}`, payloadOffset, payloadLength, 'metadata'));
      }
    } else if (marker === 0xfe && payloadLength) {
      const comment = await readAt(file, payloadOffset, Math.min(payloadLength, 16 * 1024), signal);
      findings.push(parserFinding('Comment', new TextDecoder('windows-1252').decode(comment).replace(/\0+$/, ''), payloadOffset, payloadLength, 'metadata'));
    }
    offset = segmentEnd;
    count++;
    if (marker === 0xda) { scanStart = offset; break; }
  }
  if (scanStart >= 0) {
    const end = await findJpegEnd(file, scanStart, signal);
    if (end >= 0) {
      if (end > scanStart) regions.push(region('Entropy-coded image data', scanStart, end - scanStart, 'data'));
      regions.push(region('EOI', end, 2, 'header'));
      findings.push(parserFinding('Entropy-coded data', `${(end - scanStart).toLocaleString('en')} bytes`, scanStart, end - scanStart, 'segment'));
      findings.push(parserFinding('End of image', 'EOI', end, 2, 'segment'));
      offset = end + 2;
      foundEnd = true;
    } else {
      if (scanStart < file.size) regions.push(region('Entropy-coded image data', scanStart, file.size - scanStart, 'data'));
      findings.push(parserFinding('Entropy-coded data', `${(file.size - scanStart).toLocaleString('en')} bytes · EOI unresolved`, scanStart, file.size - scanStart, 'segment'));
      offset = file.size;
      warnings.push('No JPEG EOI marker was found after the scan data.');
    }
  }
  if (count === 256) warnings.push('The 256-segment display limit was reached.');
  return {
    regions: finishRegionMap(regions, file.size, 'Trailing JPEG bytes'),
    structure: { parser: 'JPEG markers', mode: 'format-aware' as const, complete: foundEnd,
      limitation: 'Frame and bounded APP metadata are decoded; entropy-coded data is grouped and the image is not decoded.', warnings, findings },
  };
}

async function parseZip(file: File, signal?: AbortSignal) {
  const warnings: string[] = [];
  const regions: Region[] = [];
  const findings: ParserFinding[] = [];
  const tailStart = Math.max(0, file.size - 65_557);
  const tail = await readAt(file, tailStart, file.size - tailStart, signal);
  let eocd = -1;
  for (let index = tail.length - 22; index >= Math.max(0, tail.length - 65_557); index--) {
    if (little(tail, index) === 0x06054b50) { eocd = index; break; }
  }
  if (eocd < 0 || eocd + 22 > tail.length) {
    return {
      regions: genericRegions(file.size),
      structure: { parser: 'Generic ZIP byte regions', mode: 'generic' as const, complete: false, limitation: 'ZIP signature recognized, but a bounded end-of-central-directory record was not found.', warnings },
    };
  }
  const view = new DataView(tail.buffer, tail.byteOffset + eocd, tail.byteLength - eocd);
  const classicEntries = view.getUint16(10, true);
  const classicCentralSize = view.getUint32(12, true);
  const classicCentralOffset = view.getUint32(16, true);
  const commentLength = view.getUint16(20, true);
  const eocdOffset = tailStart + eocd;
  const usesZip64 = classicEntries === 0xffff || classicCentralSize === 0xffffffff || classicCentralOffset === 0xffffffff;
  let totalEntries = classicEntries;
  let centralSize = classicCentralSize;
  let centralOffset = classicCentralOffset;
  let zip64Resolved = !usesZip64;
  if (usesZip64) {
    const locatorOffset = eocdOffset - 20;
    const locator = await readAt(file, locatorOffset, 20, signal);
    if (locator.length === 20 && little(locator) === 0x07064b50) {
      const locatorView = new DataView(locator.buffer, locator.byteOffset, locator.byteLength);
      const recordOffset = safeNumber(locatorView.getBigUint64(8, true));
      const diskCount = locatorView.getUint32(16, true);
      const record = Number.isSafeInteger(recordOffset) ? await readAt(file, recordOffset, 56, signal) : new Uint8Array(0);
      if (record.length === 56 && little(record) === 0x06064b50) {
        const recordView = new DataView(record.buffer, record.byteOffset, record.byteLength);
        const recordSize = safeNumber(recordView.getBigUint64(4, true));
        const entriesOnDisk = safeNumber(recordView.getBigUint64(24, true));
        totalEntries = safeNumber(recordView.getBigUint64(32, true));
        centralSize = safeNumber(recordView.getBigUint64(40, true));
        centralOffset = safeNumber(recordView.getBigUint64(48, true));
        zip64Resolved = recordSize >= 44 && diskCount === 1 && recordView.getUint32(16, true) === 0
          && recordView.getUint32(20, true) === 0 && entriesOnDisk === totalEntries;
        if (!zip64Resolved) warnings.push('ZIP64 records are malformed or describe a multi-disk archive.');
      } else warnings.push('ZIP64 end-of-central-directory record is missing or truncated.');
    } else warnings.push('ZIP64 locator is missing; ZIP64 offsets cannot be resolved.');
  }
  if (!Number.isSafeInteger(totalEntries) || !Number.isSafeInteger(centralSize) || !Number.isSafeInteger(centralOffset)
    || totalEntries < 0 || centralSize < 0 || centralOffset < 0 || centralOffset > eocdOffset
    || centralSize > eocdOffset - centralOffset || eocd + 22 + commentLength > tail.length || !zip64Resolved) {
    warnings.push('The central directory or end record has inconsistent bounds.');
    return {
      regions: genericRegions(file.size),
      structure: { parser: 'Generic ZIP byte regions', mode: 'generic' as const, complete: false,
        limitation: 'ZIP directory bounds are malformed or ZIP64 values could not be safely resolved; ranges are generic.', warnings },
    };
  }
  const multiDisk = view.getUint16(4, true) !== 0 || view.getUint16(6, true) !== 0;
  if (multiDisk) warnings.push('Multi-disk ZIP archives are not fully inspected.');
  const central = await readAt(file, centralOffset, Math.min(centralSize, 16 * 1024 * 1024), signal);
  if (centralSize > central.length) warnings.push('The central directory exceeds the 16 MiB parser window.');
  let cursor = 0;
  let parsed = 0;
  let uncompressedTotal = 0;
  const methodNames: Record<number, string> = { 0: 'stored', 8: 'deflate', 9: 'deflate64', 12: 'bzip2', 14: 'LZMA', 93: 'Zstandard', 95: 'XZ' };
  while (cursor + 46 <= central.length && parsed < 512 && little(central, cursor) === 0x02014b50) {
    const data = new DataView(central.buffer, central.byteOffset + cursor, central.byteLength - cursor);
    const flags = data.getUint16(8, true);
    const method = data.getUint16(10, true);
    const crc = data.getUint32(16, true);
    const compressed32 = data.getUint32(20, true);
    const uncompressed32 = data.getUint32(24, true);
    const nameLength = data.getUint16(28, true);
    const extraLength = data.getUint16(30, true);
    const entryCommentLength = data.getUint16(32, true);
    const localOffset32 = data.getUint32(42, true);
    const recordLength = 46 + nameLength + extraLength + entryCommentLength;
    if (cursor + recordLength > central.length) { warnings.push('A central directory entry is truncated.'); break; }
    const nameBytes = central.subarray(cursor + 46, cursor + 46 + nameLength);
    let name = '';
    try { name = new TextDecoder(flags & 0x800 ? 'utf-8' : 'windows-1252').decode(nameBytes); } catch { name = 'entry ' + (parsed + 1); }
    if (name.length > 512) { name = name.slice(0, 512); warnings.push('A ZIP filename preview was capped at 512 characters.'); }
    let compressedSize = compressed32;
    let uncompressedSize = uncompressed32;
    let localOffset = localOffset32;
    const diskStart = data.getUint16(34, true);
    if (compressed32 === 0xffffffff || uncompressed32 === 0xffffffff || localOffset32 === 0xffffffff || diskStart === 0xffff) {
      const extraStart = cursor + 46 + nameLength;
      const extraEnd = extraStart + extraLength;
      let extra = extraStart;
      let zip64Extra: Uint8Array | null = null;
      while (extra + 4 <= extraEnd) {
        const tag = new DataView(central.buffer, central.byteOffset + extra, 4);
        const tagId = tag.getUint16(0, true);
        const tagLength = tag.getUint16(2, true);
        if (extra + 4 + tagLength > extraEnd) break;
        if (tagId === 0x0001) { zip64Extra = central.subarray(extra + 4, extra + 4 + tagLength); break; }
        extra += 4 + tagLength;
      }
      if (!zip64Extra) warnings.push(`ZIP64 size or offset values are missing for ${name || `entry ${parsed + 1}`}.`);
      else {
        const zipView = new DataView(zip64Extra.buffer, zip64Extra.byteOffset, zip64Extra.byteLength);
        let zipCursor = 0;
        const readZip64 = () => {
          if (zipCursor + 8 > zipView.byteLength) return Number.NaN;
          const value = safeNumber(zipView.getBigUint64(zipCursor, true));
          zipCursor += 8;
          return value;
        };
        if (uncompressed32 === 0xffffffff) uncompressedSize = readZip64();
        if (compressed32 === 0xffffffff) compressedSize = readZip64();
        if (localOffset32 === 0xffffffff) localOffset = readZip64();
        if (diskStart === 0xffff) {
          if (zipCursor + 4 > zipView.byteLength || zipView.getUint32(zipCursor, true) !== 0) warnings.push('ZIP64 entry uses an unsupported disk number.');
        }
      }
    }
    if (!Number.isSafeInteger(compressedSize) || !Number.isSafeInteger(uncompressedSize) || !Number.isSafeInteger(localOffset)
      || compressedSize < 0 || uncompressedSize < 0 || localOffset < 0 || localOffset >= centralOffset) {
      warnings.push(`Unsafe ZIP64 sizes or local offset for ${name || `entry ${parsed + 1}`}.`);
      cursor += recordLength;
      parsed++;
      continue;
    }
    uncompressedTotal = Math.min(Number.MAX_SAFE_INTEGER, uncompressedTotal + uncompressedSize);
    findings.push(
      parserFinding(`Entry · ${name || `entry ${parsed + 1}`}`, `${uncompressedSize.toLocaleString('en')} bytes`, localOffset, compressedSize, 'entry'),
      parserFinding(`Compression · ${name || `entry ${parsed + 1}`}`, methodNames[method] ?? `method ${method}`),
      parserFinding(`CRC32 · ${name || `entry ${parsed + 1}`}`, crc.toString(16).toUpperCase().padStart(8, '0')),
    );
    const localHeader = await readAt(file, localOffset, 30, signal);
    if (localHeader.length === 30 && little(localHeader) === 0x04034b50) {
      const localNameLength = new DataView(localHeader.buffer, localHeader.byteOffset, localHeader.byteLength).getUint16(26, true);
      const localExtraLength = new DataView(localHeader.buffer, localHeader.byteOffset, localHeader.byteLength).getUint16(28, true);
      const localHeaderLength = 30 + localNameLength + localExtraLength;
      const descriptorLength = flags & 0x08 ? (usesZip64 ? 24 : 16) : 0;
      const expectedEnd = localOffset + localHeaderLength + compressedSize + descriptorLength;
      if (!Number.isSafeInteger(expectedEnd) || localHeaderLength > centralOffset - localOffset) {
        warnings.push(`Local entry bounds for ${name || `entry ${parsed + 1}`} are invalid.`);
      } else {
        const end = Math.min(centralOffset, expectedEnd);
        regions.push(region(name || 'Archive entry', localOffset, end - localOffset, 'data'));
      }
    } else warnings.push('Local header for ' + (name || 'an archive entry') + ' is unavailable or malformed.');
    cursor += recordLength;
    parsed++;
  }
  if (totalEntries > parsed) warnings.push('Parsed ' + parsed.toLocaleString('en') + ' of ' + totalEntries.toLocaleString('en') + ' directory entries.');
  findings.unshift(parserFinding('Archive entries', `${parsed.toLocaleString('en')} parsed / ${totalEntries.toLocaleString('en')} declared`));
  findings.push(parserFinding('Total uncompressed size', `${uncompressedTotal.toLocaleString('en')} bytes`));
  if (centralSize > 0) regions.push(region('Central directory', centralOffset, centralSize, 'metadata'));
  regions.push(region('End of central directory', eocdOffset, Math.min(22 + commentLength, file.size - eocdOffset), 'metadata'));
  return {
    regions: finishRegionMap(regions, file.size, 'Archive gap / extra data'),
    structure: {
      parser: 'ZIP central directory', mode: 'format-aware' as const,
      complete: !multiDisk && totalEntries <= parsed && centralSize <= central.length,
      limitation: parsed >= 512 ? 'The display is capped at 512 archive entries.' : centralSize > central.length ? 'The central directory is capped at a 16 MiB parser window.' : null,
      warnings, findings,
    },
  };
}

async function readCString(file: File, offset: number, limit = 260, signal?: AbortSignal) {
  const bytes = await readAt(file, offset, limit, signal);
  const end = bytes.indexOf(0);
  return new TextDecoder('windows-1252').decode(bytes.subarray(0, end < 0 ? bytes.length : end));
}

async function parsePe(file: File, signal?: AbortSignal) {
  const dos = await readAt(file, 0, 64, signal);
  if (dos.length < 64) return null;
  const peOffset = little(dos, 0x3c);
  if (peOffset < 64 || peOffset + 24 > file.size || peOffset > 16 * 1024 * 1024) return null;
  const header = await readAt(file, peOffset, 24, signal);
  if (ascii(header, 0, 4) !== 'PE\0\0') return null;
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const machine = view.getUint16(4, true);
  const sections = view.getUint16(6, true);
  const timestamp = view.getUint32(8, true);
  const optionalSize = view.getUint16(20, true);
  const optionalOffset = peOffset + 24;
  const optional = await readAt(file, optionalOffset, Math.min(optionalSize, 4096), signal);
  const tableOffset = peOffset + 24 + optionalSize;
  const table = await readAt(file, tableOffset, Math.min(sections, 256) * 40, signal);
  const headerLength = Math.min(file.size - peOffset, 24 + optionalSize);
  const regions = [region('DOS header', 0, Math.min(64, file.size), 'header'),
    region('PE + COFF + optional header', peOffset, Math.max(0, headerLength), 'header')];
  if (table.length) regions.push(region('Section table', tableOffset, table.length, 'metadata'));
  const warnings: string[] = [];
  const findings: ParserFinding[] = [];
  const machineNames: Record<number, string> = {
    0x014c: 'x86', 0x8664: 'x86-64', 0x01c0: 'ARM', 0x01c4: 'ARMv7', 0xaa64: 'ARM64',
    0x0200: 'Intel Itanium', 0x5032: 'RISC-V 32', 0x5064: 'RISC-V 64', 0x5128: 'RISC-V 128',
  };
  const optionalView = optional.length ? new DataView(optional.buffer, optional.byteOffset, optional.byteLength) : null;
  const magic = optionalView && optionalView.byteLength >= 2 ? optionalView.getUint16(0, true) : 0;
  const is64 = magic === 0x20b;
  if (optionalSize && (magic !== 0x10b && magic !== 0x20b)) warnings.push('The PE optional header has an unknown magic value.');
  findings.push(
    parserFinding('Architecture', machineNames[machine] ?? `machine 0x${machine.toString(16).toUpperCase()}`),
    parserFinding('COFF sections', sections),
    parserFinding('Header timestamp', timestamp ? new Date(timestamp * 1000).toISOString() : 'Not set'),
    parserFinding('Optional header', magic === 0x10b ? 'PE32' : magic === 0x20b ? 'PE32+' : `Unknown magic 0x${magic.toString(16)}`),
  );
  const directories: Array<{ name: string; rva: number; size: number }> = [];
  if (optionalView && optionalView.byteLength >= 64 && (magic === 0x10b || magic === 0x20b)) {
    const entryPointRva = optionalView.getUint32(16, true);
    const imageBase = is64 && optionalView.byteLength >= 32
      ? safeNumber(optionalView.getBigUint64(24, true))
      : optionalView.getUint32(28, true);
    const sectionAlignment = optionalView.getUint32(32, true);
    const fileAlignment = optionalView.getUint32(36, true);
    const sizeOfImage = optionalView.getUint32(56, true);
    const countOffset = is64 ? 108 : 92;
    const directoryOffset = is64 ? 112 : 96;
    findings.push(
      parserFinding('Entry point RVA', `0x${entryPointRva.toString(16).toUpperCase()}`),
      parserFinding('Image base', Number.isSafeInteger(imageBase) ? `0x${imageBase.toString(16).toUpperCase()}` : 'Outside safe integer range'),
      parserFinding('Section alignment', sectionAlignment),
      parserFinding('File alignment', fileAlignment),
      parserFinding('Image size', `${sizeOfImage.toLocaleString('en')} bytes`),
    );
    if (optionalView.byteLength >= countOffset + 4) {
      const directoryCount = Math.min(optionalView.getUint32(countOffset, true), 16);
      const directoryNames = ['Export', 'Import', 'Resource', 'Exception', 'Security', 'Base relocation', 'Debug', 'Architecture', 'Global pointer', 'TLS', 'Load configuration', 'Bound import', 'IAT', 'Delay import', 'CLR', 'Reserved'];
      for (let index = 0; index < directoryCount && directoryOffset + index * 8 + 8 <= optionalView.byteLength; index++) {
        const rva = optionalView.getUint32(directoryOffset + index * 8, true);
        const size = optionalView.getUint32(directoryOffset + index * 8 + 4, true);
        if (!rva && !size) continue;
        directories[index] = { name: directoryNames[index], rva, size };
        findings.push(parserFinding(`${directoryNames[index]} directory`, `RVA 0x${rva.toString(16).toUpperCase()} · ${size.toLocaleString('en')} bytes`));
      }
    }
  } else if (optionalSize) warnings.push('The PE optional header is truncated before required fields.');

  const sectionRows: Array<{ name: string; virtualSize: number; virtualAddress: number; rawSize: number; rawOffset: number }> = [];
  const names = new TextDecoder('ascii');
  for (let index = 0; index < Math.min(sections, 256) && index * 40 + 40 <= table.length; index++) {
    const entry = table.subarray(index * 40, index * 40 + 40);
    const section = new DataView(entry.buffer, entry.byteOffset, entry.byteLength);
    const name = names.decode(entry.subarray(0, 8)).replace(/\0.*$/, '').trim() || 'Section ' + (index + 1);
    const virtualSize = section.getUint32(8, true);
    const virtualAddress = section.getUint32(12, true);
    const rawSize = section.getUint32(16, true);
    const rawOffset = section.getUint32(20, true);
    const characteristics = section.getUint32(36, true);
    const flags = [
      [0x00000020, 'CODE'], [0x00000040, 'INITIALIZED_DATA'], [0x00000080, 'UNINITIALIZED_DATA'],
      [0x02000000, 'DISCARDABLE'], [0x20000000, 'EXECUTE'], [0x40000000, 'READ'], [0x80000000, 'WRITE'],
    ] as const;
    const activeFlags = flags.filter(([mask]) => characteristics & mask).map(([, label]) => label).join(' · ') || 'No common flags';
    findings.push(parserFinding(`Section ${name}`, `RVA 0x${virtualAddress.toString(16).toUpperCase()} · virtual ${virtualSize.toLocaleString('en')} · raw ${rawSize.toLocaleString('en')} · ${activeFlags}`, rawOffset, rawSize, 'section'));
    sectionRows.push({ name, virtualSize, virtualAddress, rawSize, rawOffset });
    if (!rawSize) continue;
    if (rawOffset < tableOffset || rawOffset >= file.size) { warnings.push(`Section ${name} has an invalid raw-data offset.`); continue; }
    if (rawSize > file.size - rawOffset) warnings.push(`Section ${name} extends beyond the end of the file.`);
    regions.push(region(name, rawOffset, Math.min(rawSize, file.size - rawOffset), 'data'));
  }
  if (sections > 256) warnings.push('Only the first 256 PE sections are displayed.');
  if (table.length < Math.min(sections, 256) * 40) warnings.push('The PE section table is truncated.');
  const rvaToFileOffset = (rva: number) => {
    const section = sectionRows.find((item) => rva >= item.virtualAddress && rva - item.virtualAddress < Math.max(item.virtualSize, item.rawSize));
    if (!section) return -1;
    const delta = rva - section.virtualAddress;
    if (delta >= section.rawSize || section.rawOffset > file.size - delta) return -1;
    return section.rawOffset + delta;
  };

  const importDirectory = directories[1];
  let importSymbolCount = 0;
  if (importDirectory?.rva && importDirectory.size) {
    const importOffset = rvaToFileOffset(importDirectory.rva);
    const descriptors = importOffset >= 0 ? await readAt(file, importOffset, Math.min(importDirectory.size, 20 * 128), signal) : new Uint8Array(0);
    if (importOffset < 0) warnings.push('The import directory RVA does not map to file-backed section data.');
    else {
      let descriptorCount = 0;
      for (let at = 0; at + 20 <= descriptors.length && descriptorCount < 128 && importSymbolCount < 2048; at += 20) {
        const descriptor = new DataView(descriptors.buffer, descriptors.byteOffset + at, 20);
        const originalThunk = descriptor.getUint32(0, true);
        const nameRva = descriptor.getUint32(12, true);
        const firstThunk = descriptor.getUint32(16, true);
        if (!originalThunk && !nameRva && !firstThunk) break;
        const nameOffset = rvaToFileOffset(nameRva);
        if (nameOffset < 0) { warnings.push('An imported library name does not map to file-backed data.'); continue; }
        const library = await readCString(file, nameOffset, 260, signal);
        findings.push(parserFinding('Imported library', library || 'Unnamed library', nameOffset, Math.min(260, file.size - nameOffset), 'entry'));
        const thunkOffset = rvaToFileOffset(originalThunk || firstThunk);
        if (thunkOffset >= 0) {
          const width = is64 ? 8 : 4;
          const thunkBytes = await readAt(file, thunkOffset, width * 128, signal);
          for (let index = 0; index * width + width <= thunkBytes.length && importSymbolCount < 2048; index++) {
            const thunkView = new DataView(thunkBytes.buffer, thunkBytes.byteOffset + index * width, width);
            const value = is64 ? thunkView.getBigUint64(0, true) : BigInt(thunkView.getUint32(0, true));
            if (!value) break;
            importSymbolCount++;
            const ordinalMask = is64 ? 1n << 63n : 1n << 31n;
            const symbol = value & ordinalMask ? `ordinal ${Number(value & 0xffffn)}` : '';
            let imported = symbol;
            if (!symbol) {
              const symbolOffset = rvaToFileOffset(safeNumber(value));
              if (symbolOffset >= 0) imported = await readCString(file, symbolOffset + 2, 256, signal);
            }
            if (imported) findings.push(parserFinding('Imported symbol', `${library}!${imported}`, thunkOffset + index * width, width, 'entry'));
          }
        }
        descriptorCount++;
      }
      if (descriptorCount === 128) warnings.push('Import library listing is capped at 128 descriptors.');
      if (importSymbolCount === 2048) warnings.push('Imported symbol listing is capped at 2,048 entries.');
    }
  }

  const exportDirectory = directories[0];
  if (exportDirectory?.rva && exportDirectory.size) {
    const exportOffset = rvaToFileOffset(exportDirectory.rva);
    const directory = exportOffset >= 0 ? await readAt(file, exportOffset, 40, signal) : new Uint8Array(0);
    if (directory.length === 40) {
      const exports = new DataView(directory.buffer, directory.byteOffset, directory.byteLength);
      const nameCount = Math.min(exports.getUint32(24, true), 128);
      const namesOffset = rvaToFileOffset(exports.getUint32(32, true));
      const nameTable = namesOffset >= 0 ? await readAt(file, namesOffset, nameCount * 4, signal) : new Uint8Array(0);
      for (let index = 0; index * 4 + 4 <= nameTable.length; index++) {
        const nameRva = little(nameTable, index * 4);
        const nameOffset = rvaToFileOffset(nameRva);
        if (nameOffset >= 0) findings.push(parserFinding('Exported symbol', await readCString(file, nameOffset, 256, signal), nameOffset, undefined, 'entry'));
      }
      if (exports.getUint32(24, true) > nameCount) warnings.push('Export symbol listing is capped at 128 names.');
    } else warnings.push('The PE export directory is not mapped to a complete file-backed structure.');
  }
  return {
    regions: finishRegionMap(regions, file.size, 'Unmapped PE bytes'),
    structure: { parser: 'PE headers and sections', mode: 'format-aware' as const,
      complete: sections <= 256 && table.length >= Math.min(sections, 256) * 40,
      limitation: 'COFF, optional-header fields, sections, and bounded import/export names are decoded; resources are not expanded.', warnings, findings },
  };
}

function safeNumber(value: bigint) {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : Number.NaN;
}

async function parseElf(file: File, signal?: AbortSignal) {
  const header = await readAt(file, 0, 64, signal);
  if (header.length < 52) return null;
  const elfClass = header[4];
  const littleEndian = header[5] === 1;
  if (![1, 2].includes(elfClass) || ![1, 2].includes(header[5])) return null;
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const u16 = (offset: number) => view.getUint16(offset, littleEndian);
  const u32 = (offset: number) => view.getUint32(offset, littleEndian);
  const headerLength = elfClass === 1 ? 52 : 64;
  if (header.length < headerLength) return null;
  const elfType = u16(16);
  const machine = u16(18);
  const typeNames: Record<number, string> = { 1: 'Relocatable object', 2: 'Executable', 3: 'Shared object', 4: 'Core dump' };
  const machineNames: Record<number, string> = { 3: 'x86', 8: 'MIPS', 20: 'PowerPC', 21: 'PowerPC64', 40: 'ARM', 62: 'x86-64', 183: 'AArch64', 243: 'RISC-V' };
  const entryPoint = elfClass === 1 ? u32(24) : safeNumber(view.getBigUint64(24, littleEndian));
  let programOffset: number;
  let programEntrySize: number;
  let programCount: number;
  let sectionOffset: number;
  let entrySize: number;
  let sectionCount: number;
  let namesIndex: number;
  if (elfClass === 1) {
    programOffset = u32(28);
    programEntrySize = u16(42);
    programCount = u16(44);
    sectionOffset = u32(32);
    entrySize = u16(46);
    sectionCount = u16(48);
    namesIndex = u16(50);
  } else {
    programOffset = safeNumber(view.getBigUint64(32, littleEndian));
    programEntrySize = u16(54);
    programCount = u16(56);
    sectionOffset = safeNumber(view.getBigUint64(40, littleEndian));
    entrySize = u16(58);
    sectionCount = u16(60);
    namesIndex = u16(62);
  }
  const warnings: string[] = [];
  const findings: ParserFinding[] = [
    parserFinding('ELF class', elfClass === 1 ? '32-bit' : '64-bit'),
    parserFinding('Endianness', littleEndian ? 'Little-endian' : 'Big-endian'),
    parserFinding('ELF type', typeNames[elfType] ?? `type ${elfType}`),
    parserFinding('Architecture', machineNames[machine] ?? `machine ${machine}`),
    parserFinding('Entry point', Number.isSafeInteger(entryPoint) ? `0x${entryPoint.toString(16).toUpperCase()}` : 'Outside safe integer range'),
  ];
  if (header[6] !== 1) warnings.push('The ELF identification version is unsupported.');
  const minimumProgramEntry = elfClass === 1 ? 32 : 56;
  const programCap = programEntrySize >= minimumProgramEntry && Number.isSafeInteger(programOffset) && programOffset <= file.size
    ? Math.min(programCount, 256, Math.floor((4 * 1024 * 1024) / programEntrySize)) : 0;
  const programTableLength = programEntrySize * programCap;
  const programTable = programCap ? await readAt(file, programOffset, programTableLength, signal) : new Uint8Array(0);
  const programs: Array<{ type: number; offset: number; virtualAddress: number; fileSize: number; memorySize: number; flags: number }> = [];
  const programNames: Record<number, string> = { 0: 'NULL', 1: 'LOAD', 2: 'DYNAMIC', 3: 'INTERP', 4: 'NOTE', 5: 'SHLIB', 6: 'PHDR', 7: 'TLS', 0x6474e550: 'GNU_EH_FRAME', 0x6474e551: 'GNU_STACK', 0x6474e552: 'GNU_RELRO' };
  for (let index = 0; index < programCap && index * programEntrySize + minimumProgramEntry <= programTable.length; index++) {
    const start = index * programEntrySize;
    const data = new DataView(programTable.buffer, programTable.byteOffset + start, programEntrySize);
    const type = data.getUint32(0, littleEndian);
    const flags = elfClass === 1 ? data.getUint32(24, littleEndian) : data.getUint32(4, littleEndian);
    const offset = elfClass === 1 ? data.getUint32(4, littleEndian) : safeNumber(data.getBigUint64(8, littleEndian));
    const virtualAddress = elfClass === 1 ? data.getUint32(8, littleEndian) : safeNumber(data.getBigUint64(16, littleEndian));
    const fileSize = elfClass === 1 ? data.getUint32(16, littleEndian) : safeNumber(data.getBigUint64(32, littleEndian));
    const memorySize = elfClass === 1 ? data.getUint32(20, littleEndian) : safeNumber(data.getBigUint64(40, littleEndian));
    if (![offset, virtualAddress, fileSize, memorySize].every(Number.isSafeInteger) || offset < 0 || fileSize < 0) {
      warnings.push(`Program header ${index} contains values outside the supported numeric range.`);
      continue;
    }
    if (offset > file.size || fileSize > file.size - Math.min(offset, file.size)) {
      warnings.push(`Program segment ${index} extends beyond the file and cannot be navigated safely.`);
      continue;
    }
    programs.push({ type, offset, virtualAddress, fileSize, memorySize, flags });
    const access = `${flags & 4 ? 'R' : '-'}${flags & 2 ? 'W' : '-'}${flags & 1 ? 'X' : '-'}`;
    findings.push(parserFinding(`Program segment · ${programNames[type] ?? `type ${type}`}`,
      `VA 0x${virtualAddress.toString(16).toUpperCase()} · file ${fileSize.toLocaleString('en')} · memory ${memorySize.toLocaleString('en')} · ${access}`, offset, fileSize, 'segment'));
  }
  if (programCount > programCap) warnings.push('Program-header listing was capped by the 256-entry / 4 MiB parser limit.');
  if (programCount && programTable.length < programTableLength) warnings.push('The ELF program-header table is truncated.');
  const minimumSectionEntry = elfClass === 1 ? 40 : 64;
  const cap = entrySize >= minimumSectionEntry && Number.isSafeInteger(sectionOffset) && sectionOffset <= file.size
    ? Math.min(sectionCount, 512, Math.floor((4 * 1024 * 1024) / entrySize)) : 0;
  const tableLength = entrySize * cap;
  const table = cap ? await readAt(file, sectionOffset, tableLength, signal) : new Uint8Array(0);
  if (sectionCount && !cap) warnings.push('The ELF section-header table has an invalid offset or entry size.');
  const sectionEntries: Array<{ nameIndex: number; type: number; offset: number; size: number; address: number; link: number }> = [];
  const getEntry = (index: number) => {
    const start = index * entrySize;
    if (start + minimumSectionEntry > table.length) return null;
    const data = new DataView(table.buffer, table.byteOffset + start, table.byteLength - start);
    if (elfClass === 1) return {
      nameIndex: data.getUint32(0, littleEndian), type: data.getUint32(4, littleEndian),
      address: data.getUint32(12, littleEndian), offset: data.getUint32(16, littleEndian),
      size: data.getUint32(20, littleEndian), link: data.getUint32(24, littleEndian),
    };
    return {
      nameIndex: data.getUint32(0, littleEndian), type: data.getUint32(4, littleEndian),
      address: safeNumber(data.getBigUint64(16, littleEndian)), offset: safeNumber(data.getBigUint64(24, littleEndian)),
      size: safeNumber(data.getBigUint64(32, littleEndian)), link: data.getUint32(40, littleEndian),
    };
  };
  for (let index = 0; index < cap; index++) {
    const entry = getEntry(index);
    if (entry) sectionEntries.push(entry);
  }
  const names = sectionEntries[namesIndex];
  if (names && names.type !== 3) warnings.push('The ELF section-name table does not reference a string-table section.');
  const nameTable = names && Number.isSafeInteger(names.offset) && Number.isSafeInteger(names.size)
    ? await readAt(file, names.offset, Math.min(names.size, 1024 * 1024), signal) : new Uint8Array(0);
  if (names && names.size > nameTable.length) warnings.push('ELF section-name table was limited to 1 MiB.');
  const regions = [region('ELF header', 0, headerLength, 'header')];
  if (programTable.length) regions.push(region('Program-header table', programOffset, programTable.length, 'metadata'));
  if (table.length) regions.push(region('Section-header table', sectionOffset, table.length, 'metadata'));
  for (let index = 0; index < sectionEntries.length; index++) {
    const section = sectionEntries[index];
    const nameEnd = nameTable.indexOf(0, section.nameIndex);
    const nameLength = nameEnd < 0 ? nameTable.length - section.nameIndex : nameEnd - section.nameIndex;
    const name = section.nameIndex < nameTable.length
      ? new TextDecoder().decode(nameTable.subarray(section.nameIndex, section.nameIndex + Math.min(nameLength, 512))) + (nameLength > 512 ? '…' : '')
      : 'Section ' + index;
    const validSectionRange = Number.isSafeInteger(section.offset) && section.offset >= 0 && section.offset <= file.size
      && Number.isSafeInteger(section.size) && section.size >= 0;
    findings.push(parserFinding(`Section ${index} · ${name || 'unnamed'}`,
      `type ${section.type} · VA 0x${Number.isSafeInteger(section.address) ? section.address.toString(16).toUpperCase() : '?'} · ${Number.isSafeInteger(section.size) ? section.size.toLocaleString('en') : 'unknown'} bytes`,
      validSectionRange ? section.offset : undefined, validSectionRange ? section.size : undefined, 'section'));
    if (!validSectionRange) { warnings.push(`ELF section ${name} has an unsafe file range.`); continue; }
    if (section.type === 8 || !section.size || section.offset >= file.size) continue;
    if (section.size > file.size - section.offset) { warnings.push(`ELF section ${name} extends beyond the end of the file.`); continue; }
    regions.push(region(name || 'Section ' + index, section.offset, Math.min(section.size, file.size - section.offset), 'data'));
  }
  if (sectionCount > cap) warnings.push('Section-header listing was capped by the 512-entry / 4 MiB parser limit.');
  if (table.length < tableLength) warnings.push('The ELF section-header table is truncated.');

  const virtualToFileOffset = (address: number) => {
    const program = programs.find((item) => address >= item.virtualAddress && address - item.virtualAddress < item.fileSize);
    return program ? program.offset + (address - program.virtualAddress) : -1;
  };
  const entryPointFileOffset = virtualToFileOffset(entryPoint);
  if (entryPointFileOffset >= 0) findings.push(parserFinding('Entry point file offset', `0x${entryPointFileOffset.toString(16).toUpperCase()}`, entryPointFileOffset, 1, 'metadata'));
  const dynamicSection = sectionEntries.find((section) => section.type === 6);
  if (dynamicSection && Number.isSafeInteger(dynamicSection.offset) && Number.isSafeInteger(dynamicSection.size)) {
    const stringSection = sectionEntries[dynamicSection.link];
    const dynamicStrings = stringSection && Number.isSafeInteger(stringSection.offset) && Number.isSafeInteger(stringSection.size)
      ? await readAt(file, stringSection.offset, Math.min(stringSection.size, 1024 * 1024), signal) : new Uint8Array(0);
    const dynamic = await readAt(file, dynamicSection.offset, Math.min(dynamicSection.size, 1024 * 1024), signal);
    const entryWidth = elfClass === 1 ? 8 : 16;
    const dynamicNames: Record<number, string> = { 1: 'Needed library', 14: 'SONAME', 15: 'RPATH', 29: 'RUNPATH' };
    const maxEntries = Math.min(Math.floor(dynamic.length / entryWidth), 4096);
    let dynamicStringPreviewTruncated = false;
    for (let index = 0; index < maxEntries; index++) {
      const at = index * entryWidth;
      const tag = elfClass === 1 ? new DataView(dynamic.buffer, dynamic.byteOffset + at, entryWidth).getInt32(0, littleEndian)
        : safeNumber(new DataView(dynamic.buffer, dynamic.byteOffset + at, entryWidth).getBigInt64(0, littleEndian));
      const value = elfClass === 1 ? little(dynamic.subarray(at, at + entryWidth), 4)
        : safeNumber(new DataView(dynamic.buffer, dynamic.byteOffset + at, entryWidth).getBigUint64(8, littleEndian));
      if (tag === 0) break;
      const label = dynamicNames[tag];
      if (label && Number.isSafeInteger(value) && value >= 0 && value < dynamicStrings.length) {
        const end = dynamicStrings.indexOf(0, value);
        const valueEnd = end < 0 ? dynamicStrings.length : end;
        const previewEnd = Math.min(valueEnd, value + 512);
        dynamicStringPreviewTruncated ||= valueEnd - value > 512;
        findings.push(parserFinding(label, new TextDecoder().decode(dynamicStrings.subarray(value, previewEnd)) + (valueEnd - value > 512 ? '…' : ''), dynamicSection.offset + at, entryWidth, 'metadata'));
      }
    }
    if (dynamicSection.size > dynamic.length) warnings.push('ELF dynamic information was limited to 1 MiB.');
    if (stringSection && stringSection.size > dynamicStrings.length) warnings.push('ELF dynamic string table was limited to 1 MiB.');
    if (dynamicStringPreviewTruncated) warnings.push('ELF dynamic string previews are capped at 512 bytes per value.');
  }
  if (programCount === 0) warnings.push('This ELF file has no program-header table.');
  if (sectionCount === 0) warnings.push('This ELF file has no section-header table.');
  return {
    regions: finishRegionMap(regions, file.size, 'Unmapped ELF bytes'),
    structure: { parser: 'ELF program headers and sections', mode: 'format-aware' as const,
      complete: programCount <= programCap && programTable.length === programTableLength && sectionCount <= cap && table.length === tableLength,
      limitation: 'Program headers, section names, file-backed ranges, and bounded dynamic strings are decoded; relocations and symbol tables are not expanded.', warnings, findings },
  };
}

function readSqliteVarint(bytes: Uint8Array, offset: number) {
  let value = 0;
  for (let index = 0; index < 8; index++) {
    if (offset + index >= bytes.length) return null;
    const byte = bytes[offset + index];
    value = value * 128 + (byte & 0x7f);
    if (!Number.isSafeInteger(value)) return null;
    if (!(byte & 0x80)) return { value, length: index + 1 };
  }
  if (offset + 8 >= bytes.length) return null;
  value = value * 256 + bytes[offset + 8];
  return Number.isSafeInteger(value) ? { value, length: 9 } : null;
}

function decodeSqliteRecord(payload: Uint8Array, textDecoder: TextDecoder) {
  const headerLength = readSqliteVarint(payload, 0);
  if (!headerLength || headerLength.value < headerLength.length || headerLength.value > payload.length) return null;
  const serials: number[] = [];
  let headerCursor = headerLength.length;
  while (headerCursor < headerLength.value && serials.length < 64) {
    const serial = readSqliteVarint(payload, headerCursor);
    if (!serial || serial.value === 10 || serial.value === 11) return null;
    serials.push(serial.value);
    headerCursor += serial.length;
  }
  if (headerCursor !== headerLength.value) return null;
  let cursor = headerLength.value;
  const values: Array<string | number | null> = [];
  for (const serial of serials) {
    let length = serial === 0 || serial === 8 || serial === 9 ? 0
      : serial >= 1 && serial <= 4 ? serial
        : serial === 5 ? 6 : serial === 6 || serial === 7 ? 8
          : serial >= 12 ? Math.floor((serial - (serial % 2 ? 13 : 12)) / 2) : -1;
    if (length < 0 || cursor + length > payload.length) return null;
    if (serial === 0) values.push(null);
    else if (serial === 8) values.push(0);
    else if (serial === 9) values.push(1);
    else if (serial >= 1 && serial <= 6) {
      let integer = 0n;
      for (let index = 0; index < length; index++) integer = integer << 8n | BigInt(payload[cursor + index]);
      const bits = BigInt(length * 8);
      if (payload[cursor] & 0x80) integer -= 1n << bits;
      values.push(integer >= BigInt(Number.MIN_SAFE_INTEGER) && integer <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(integer) : integer.toString());
    } else if (serial === 7) {
      values.push(new DataView(payload.buffer, payload.byteOffset + cursor, 8).getFloat64(0, false));
    } else if (serial >= 12 && serial % 2 === 0) values.push(`blob · ${length} bytes`);
    else if (serial >= 13) values.push(textDecoder.decode(payload.subarray(cursor, cursor + length)));
    cursor += length;
  }
  return values;
}

async function parseSqlite(file: File, signal?: AbortSignal) {
  const header = await readAt(file, 0, 100, signal);
  if (header.length < 100) return null;
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  let pageSize = view.getUint16(16, false);
  if (pageSize === 1) pageSize = 65_536;
  const pageCount = view.getUint32(28, false);
  const validPageSize = pageSize >= 512 && pageSize <= 65_536 && (pageSize & (pageSize - 1)) === 0;
  const warnings: string[] = [];
  const findings: ParserFinding[] = [];
  if (!validPageSize) warnings.push('The SQLite page size is invalid.');
  if (validPageSize && file.size % pageSize) warnings.push('The file ends with a partial SQLite page.');
  const availablePages = validPageSize ? Math.ceil(file.size / pageSize) : 1;
  const pages = Math.min(availablePages, 512);
  const regions = [];
  const textEncoding = view.getUint32(56, false);
  const encodingNames: Record<number, string> = { 1: 'UTF-8', 2: 'UTF-16LE', 3: 'UTF-16BE' };
  const schemaFormat = view.getUint32(44, false);
  const schemaNames: Record<number, string> = { 1: 'legacy', 2: 'format 2', 3: 'format 3', 4: 'format 4' };
  const writeVersion = header[18];
  const readVersion = header[19];
  const schemaCookie = view.getUint32(40, false);
  const freeListTrunk = view.getUint32(32, false);
  const freeListPages = view.getUint32(36, false);
  const reservedBytes = header[20];
  const decoder = new TextDecoder(textEncoding === 2 ? 'utf-16le' : textEncoding === 3 ? 'utf-16be' : 'utf-8');
  findings.push(
    parserFinding('Page size', `${pageSize.toLocaleString('en')} bytes`),
    parserFinding('Declared pages', pageCount),
    parserFinding('Available pages', availablePages),
    parserFinding('Read / write format', `${readVersion} / ${writeVersion}`),
    parserFinding('Reserved bytes per page', reservedBytes),
    parserFinding('Schema format', schemaNames[schemaFormat] ?? `unknown (${schemaFormat})`),
    parserFinding('Text encoding', encodingNames[textEncoding] ?? `unknown (${textEncoding})`),
    parserFinding('Schema cookie', schemaCookie),
    parserFinding('Freelist', `${freeListPages} pages · first trunk ${freeListTrunk}`),
    parserFinding('Application ID', view.getUint32(68, false)),
    parserFinding('User version', view.getUint32(60, false)),
  );
  if (![1, 2].includes(writeVersion) || ![1, 2].includes(readVersion)) warnings.push('SQLite read/write format bytes are unsupported.');
  if (reservedBytes >= pageSize) warnings.push('SQLite reserved-byte count is not smaller than the page size.');
  if (schemaFormat < 1 || schemaFormat > 4) warnings.push('SQLite schema format is outside the supported range 1–4.');
  if (![1, 2, 3].includes(textEncoding)) warnings.push('SQLite text encoding is unsupported.');
  for (let index = 0; index < pages; index++) {
    const offset = index * pageSize;
    const length = Math.min(pageSize, file.size - offset);
    if (length > 0) regions.push(region('SQLite page ' + (index + 1), offset, length, index === 0 ? 'header' : 'data'));
  }
  if (availablePages > pages) regions.push(region('SQLite pages ' + (pages + 1) + '–' + availablePages, pages * pageSize, file.size - pages * pageSize, 'data'));
  if (pageCount && pageCount !== availablePages) warnings.push('The header declares ' + pageCount + ' pages; the file contains ' + availablePages + ' page-sized regions.');
  if (availablePages > pages) warnings.push('Only the first 512 SQLite page regions are individually displayed.');

  if (validPageSize && file.size >= pageSize) {
    const queue = [1];
    const visited = new Set<number>();
    let parsedSchemaRows = 0;
    let btreeValid = true;
    while (queue.length && visited.size < 64 && parsedSchemaRows < 128) {
      const pageNumber = queue.shift()!;
      if (visited.has(pageNumber) || pageNumber < 1 || pageNumber > availablePages) continue;
      visited.add(pageNumber);
      const pageOffset = (pageNumber - 1) * pageSize;
      const page = await readAt(file, pageOffset, pageSize, signal);
      const btree = pageNumber === 1 ? 100 : 0;
      const leafHeaderSize = 8;
      if (page.length < btree + leafHeaderSize) { warnings.push(`SQLite page ${pageNumber} has a truncated b-tree header.`); btreeValid = false; continue; }
      const pageType = page[btree];
      if (![0x02, 0x05, 0x0a, 0x0d].includes(pageType)) {
        warnings.push(`SQLite page ${pageNumber} has an invalid b-tree page type.`);
        btreeValid = false;
        continue;
      }
      const pageView = new DataView(page.buffer, page.byteOffset, page.byteLength);
      const interior = pageType === 0x02 || pageType === 0x05;
      const headerSize = interior ? 12 : 8;
      if (btree + headerSize > page.length) { warnings.push(`SQLite page ${pageNumber} b-tree header is truncated.`); btreeValid = false; continue; }
      const firstFreeblock = pageView.getUint16(btree + 1, false);
      const cellCount = pageView.getUint16(btree + 3, false);
      let cellContent = pageView.getUint16(btree + 5, false);
      if (!cellContent && pageSize === 65_536) cellContent = 65_536;
      const fragmentedBytes = page[btree + 7];
      findings.push(parserFinding(`Page ${pageNumber} structure`,
        `${pageType === 0x0d ? 'table leaf' : pageType === 0x05 ? 'table interior' : pageType === 0x0a ? 'index leaf' : 'index interior'} · ${cellCount} cells · content at ${cellContent} · fragmented ${fragmentedBytes} bytes`,
        pageOffset + btree, headerSize, 'segment'));
      if (firstFreeblock && firstFreeblock >= pageSize) warnings.push(`SQLite page ${pageNumber} freeblock offset is outside the page.`);
      const pointerStart = btree + headerSize;
      if (pointerStart + cellCount * 2 > page.length) { warnings.push(`SQLite page ${pageNumber} cell-pointer array is truncated.`); btreeValid = false; continue; }
      if (pageType === 0x05) {
        for (let cell = 0; cell < cellCount; cell++) {
          const pointer = pageView.getUint16(pointerStart + cell * 2, false);
          if (pointer < pointerStart + cellCount * 2 || pointer + 4 > page.length) { warnings.push(`SQLite page ${pageNumber} has an invalid child-page cell pointer.`); btreeValid = false; continue; }
          const child = pageView.getUint32(pointer, false);
          if (child >= 1 && child <= availablePages && !visited.has(child)) queue.push(child);
          else if (child < 1 || child > availablePages) { warnings.push(`SQLite page ${pageNumber} references a child page outside the file.`); btreeValid = false; }
        }
        const rightmost = pageView.getUint32(btree + 8, false);
          if (rightmost >= 1 && rightmost <= availablePages && !visited.has(rightmost)) queue.push(rightmost);
          else if (rightmost < 1 || rightmost > availablePages) { warnings.push(`SQLite page ${pageNumber} has an out-of-range rightmost child page.`); btreeValid = false; }
      } else if (pageType === 0x0d) {
        for (let cell = 0; cell < cellCount && parsedSchemaRows < 128; cell++) {
          const cellOffset = pageView.getUint16(pointerStart + cell * 2, false);
          const payloadVarint = readSqliteVarint(page, cellOffset);
          if (!payloadVarint) { warnings.push(`SQLite page ${pageNumber} has an invalid cell payload length.`); btreeValid = false; continue; }
          const rowId = readSqliteVarint(page, cellOffset + payloadVarint.length);
          if (!rowId) { warnings.push(`SQLite page ${pageNumber} has an invalid rowid varint.`); btreeValid = false; continue; }
          const payloadStart = cellOffset + payloadVarint.length + rowId.length;
          const payloadEnd = payloadStart + payloadVarint.value;
          if (!Number.isSafeInteger(payloadEnd) || payloadStart < 0 || payloadEnd > page.length) {
            warnings.push(`SQLite schema cell on page ${pageNumber} uses unresolved overflow content.`);
            btreeValid = false;
            continue;
          }
          const record = decodeSqliteRecord(page.subarray(payloadStart, payloadEnd), decoder);
          if (!record) { warnings.push(`SQLite schema record on page ${pageNumber} could not be decoded safely.`); btreeValid = false; continue; }
          const [type, name, tableName, rootPage, sql] = record;
          const description = `${String(type ?? 'object')} ${String(name ?? '(unnamed)')} · root page ${String(rootPage ?? 'unknown')}`;
          findings.push(parserFinding('Schema object', description, pageOffset + cellOffset, payloadEnd - cellOffset, 'entry'));
          if (typeof sql === 'string' && sql) findings.push(parserFinding(`Schema SQL · ${String(name ?? 'object')}`, sql.slice(0, 500), pageOffset + cellOffset, payloadEnd - cellOffset, 'metadata'));
          if (typeof tableName === 'string' && tableName !== name) findings.push(parserFinding('Schema table name', tableName));
          parsedSchemaRows++;
        }
      }
    }
    if (queue.length) { warnings.push('SQLite schema traversal was capped at 64 pages.'); btreeValid = false; }
    if (parsedSchemaRows === 128) { warnings.push('SQLite schema listing was capped at 128 records.'); btreeValid = false; }
    if (!btreeValid) warnings.push('The sampled SQLite b-tree validation is incomplete.');
    return {
      regions: finishRegionMap(regions, file.size, 'Unparsed SQLite bytes'),
      structure: { parser: 'SQLite pages and schema', mode: 'format-aware' as const,
        complete: validPageSize && file.size % pageSize === 0 && (!pageCount || pageCount === availablePages) && btreeValid,
        limitation: 'Page boundaries, sampled b-tree headers, and bounded sqlite_schema records are decoded; overflow chains and other tables are not traversed.', warnings, findings },
    };
  }
  return {
    regions: finishRegionMap(regions, file.size, 'Unparsed SQLite bytes'),
    structure: { parser: 'SQLite pages and schema', mode: 'format-aware' as const,
      complete: false,
      limitation: 'Page boundaries, sampled b-tree headers, and bounded sqlite_schema records are decoded; overflow chains and other tables are not traversed.', warnings, findings },
  };
}

async function parsePdf(file: File, signal?: AbortSignal) {
  if (file.size < 8) return null;
  const headerBytes = await readAt(file, 0, Math.min(1024, file.size), signal);
  const headerText = ascii(headerBytes);
  const version = /%PDF-(\d\.\d)/.exec(headerText)?.[1] ?? null;
  const versionOffset = version ? headerText.indexOf('%PDF-') : -1;
  const tailLength = Math.min(file.size, 1024 * 1024);
  const tailOffset = file.size - tailLength;
  const tail = ascii(await readAt(file, tailOffset, tailLength, signal));
  const startXrefMatches = [...tail.matchAll(/startxref\s+(\d+)/g)];
  const latestXref = startXrefMatches.at(-1);
  const xrefOffset = latestXref ? Number(latestXref[1]) : NaN;
  const validXrefOffset = Number.isSafeInteger(xrefOffset) && xrefOffset >= 0 && xrefOffset < file.size;
  const eofRelative = tail.lastIndexOf('%%EOF');
  const eofOffset = eofRelative >= 0 ? tailOffset + eofRelative : -1;
  const warnings: string[] = [];
  const findings: ParserFinding[] = [];
  const xrefEntries = new Map<number, number>();
  let xrefTableText = '';
  let xrefKind = 'unresolved';
  if (version) findings.push(parserFinding('PDF version', version, versionOffset, 8, 'property'));
  else warnings.push('A %PDF-x.y version header was not found in the first 1 KiB.');
  if (eofOffset >= 0) findings.push(parserFinding('End-of-file marker', '%%EOF', eofOffset, 5, 'segment'));
  else warnings.push('No %%EOF marker was found in the final 1 MiB.');
  if (validXrefOffset) {
    const xrefBytes = await readAt(file, xrefOffset, Math.min(1024 * 1024, file.size - xrefOffset), signal);
    xrefTableText = ascii(xrefBytes);
    if (/^xref(?:[\r\n\s])/.test(xrefTableText)) {
      xrefKind = 'classic table';
      findings.push(parserFinding('Cross-reference table', 'Classic xref table', xrefOffset, Math.min(xrefBytes.length, 1024), 'segment'));
      const trailerMatch = /(?:^|[\r\n])trailer\s*<<(.*?)>>/s.exec(xrefTableText);
      if (trailerMatch) {
        const trailerStart = trailerMatch.index + trailerMatch[0].indexOf('<<');
        const trailerOffset = xrefOffset + trailerStart;
        findings.push(parserFinding('Trailer dictionary', 'Parsed classic trailer', trailerOffset, trailerMatch[0].length, 'segment'));
        const dictionary = trailerMatch[1];
        const size = /\/Size\s+(\d+)/.exec(dictionary)?.[1];
        const root = /\/Root\s+(\d+)\s+(\d+)\s+R/.exec(dictionary);
        const info = /\/Info\s+(\d+)\s+(\d+)\s+R/.exec(dictionary);
        const previous = /\/Prev\s+(\d+)/.exec(dictionary)?.[1];
        if (size) findings.push(parserFinding('Xref object count', size));
        if (root) findings.push(parserFinding('Document catalog reference', `${root[1]} ${root[2]} R`));
        if (info) findings.push(parserFinding('Document info reference', `${info[1]} ${info[2]} R`));
        if (previous) findings.push(parserFinding('Previous xref offset', previous));
        const lines = xrefTableText.slice(0, trailerMatch.index).split(/\r?\n/);
        let lineIndex = lines[0]?.trim() === 'xref' ? 1 : 0;
        while (lineIndex < lines.length && xrefEntries.size < 20_000) {
          const subsection = /^(\d{1,10})\s+(\d{1,10})$/.exec(lines[lineIndex].trim());
          lineIndex++;
          if (!subsection) continue;
          const first = Number(subsection[1]);
          const count = Number(subsection[2]);
          if (!Number.isSafeInteger(first) || !Number.isSafeInteger(count) || count < 0) continue;
          const limit = Math.min(count, 20_000 - xrefEntries.size);
          for (let index = 0; index < limit && lineIndex < lines.length; index++, lineIndex++) {
            const entry = /^(\d{10})\s+(\d{5})\s+([nf])\s*$/.exec(lines[lineIndex].trim());
            if (!entry || entry[3] !== 'n') continue;
            const objectOffset = Number(entry[1]);
            if (Number.isSafeInteger(objectOffset) && objectOffset < file.size) xrefEntries.set(first + index, objectOffset);
          }
        }
        if (xrefEntries.size) findings.push(parserFinding('Decoded xref entries', `${xrefEntries.size.toLocaleString('en')} bounded entries`));
      } else {
        warnings.push('The xref offset points to a table, but a bounded trailer dictionary was not found.');
      }
    } else {
      xrefKind = 'xref stream';
      findings.push(parserFinding('Cross-reference stream', 'Xref stream object; entries are compressed and unresolved', xrefOffset,
        Math.min(xrefBytes.length, 1024), 'segment'));
      const dictionary = /<<(.*?)>>/s.exec(xrefTableText)?.[1] ?? '';
      const size = /\/Size\s+(\d+)/.exec(dictionary)?.[1];
      const width = /\/W\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(dictionary);
      if (size) findings.push(parserFinding('Xref stream object count', size));
      if (width) findings.push(parserFinding('Xref stream field widths', width.slice(1).join(' / ')));
      warnings.push('Xref stream entries were not decompressed.');
    }
  } else {
    warnings.push('A valid startxref offset was not found in the final 1 MiB.');
  }

  const regions: Region[] = [];
  const headerLength = versionOffset >= 0 ? versionOffset + 8 : Math.min(8, file.size);
  regions.push(region('PDF header', 0, headerLength, 'header'));
  const bodyEnd = validXrefOffset ? xrefOffset : eofOffset >= 0 ? eofOffset : file.size;
  if (xrefEntries.size) {
    const orderedObjects = [...xrefEntries.entries()].map(([number, offset]) => ({ number, offset }))
      .sort((a, b) => a.offset - b.offset).filter((item) => item.offset >= headerLength && item.offset < bodyEnd);
    const groupSize = Math.max(1, Math.ceil(orderedObjects.length / 128));
    for (let start = 0; start < orderedObjects.length; start += groupSize) {
      const group = orderedObjects.slice(start, start + groupSize);
      const nextOffset = orderedObjects[start + group.length]?.offset ?? bodyEnd;
      const firstOffset = group[0].offset;
      const lastOffset = group.at(-1)!.offset;
      const objectNumbers = group.map(({ number }) => number);
      const minNumber = Math.min(...objectNumbers);
      const maxNumber = Math.max(...objectNumbers);
      if (nextOffset > firstOffset) regions.push(region(group.length === 1 ? `PDF object ${minNumber}` : `PDF objects ${minNumber}–${maxNumber} · ${group.length} entries`, firstOffset, nextOffset - firstOffset, 'data'));
      if (group.length > 1 && lastOffset < nextOffset) findings.push(parserFinding('Object group range', `${group.length} xref entries · offsets ${lastOffset.toLocaleString('en')}–${nextOffset.toLocaleString('en')}`, firstOffset, nextOffset - firstOffset, 'section'));
    }
  } else if (bodyEnd > headerLength) {
    regions.push(region('PDF objects and streams (unresolved)', headerLength, bodyEnd - headerLength, 'other'));
  }
  if (validXrefOffset) {
    const xrefEnd = eofOffset > xrefOffset ? eofOffset : file.size;
    if (xrefEnd > xrefOffset) regions.push(region(xrefKind === 'classic table' ? 'Cross-reference and trailer' : 'Xref stream / trailer', xrefOffset, xrefEnd - xrefOffset, 'metadata'));
  }
  if (eofOffset >= 0) regions.push(region('%%EOF', eofOffset, Math.min(5, file.size - eofOffset), 'metadata'));
  if (eofOffset >= 0 && eofOffset + 5 < file.size) regions.push(region('Trailing bytes', eofOffset + 5, file.size - eofOffset - 5, 'other'));

  const referencedObjects = new Set<number>();
  const addRef = (number: string | undefined) => {
    const value = number ? Number(number) : NaN;
    if (Number.isSafeInteger(value) && value > 0 && valueRefsAvailable(value)) referencedObjects.add(value);
  };
  function valueRefsAvailable(value: number) {
    return xrefEntries.has(value);
  }
  const trailerDictionary = /(?:^|[\r\n])trailer\s*<<(.*?)>>/s.exec(xrefTableText)?.[1] ?? '';
  addRef(/\/Root\s+(\d+)\s+\d+\s+R/.exec(trailerDictionary)?.[1]);
  addRef(/\/Info\s+(\d+)\s+\d+\s+R/.exec(trailerDictionary)?.[1]);
  const inspectedObjects = new Set<number>();
  while (inspectedObjects.size < 8 && [...referencedObjects].some((number) => !inspectedObjects.has(number))) {
    const objectNumber = [...referencedObjects].find((number) => !inspectedObjects.has(number))!;
    inspectedObjects.add(objectNumber);
    const offset = xrefEntries.get(objectNumber);
    if (offset === undefined) continue;
    const length = Math.min(256 * 1024, file.size - offset);
    if (length <= 0) continue;
    const objectText = ascii(await readAt(file, offset, length, signal));
    const objectHeader = /^(\d+)\s+(\d+)\s+obj\b/.exec(objectText);
    if (!objectHeader || Number(objectHeader[1]) !== objectNumber) {
      warnings.push(`Referenced object ${objectNumber} does not match its xref offset.`);
      continue;
    }
    const objectBodyStart = objectText.indexOf('obj');
    const dictionaryStart = objectText.indexOf('<<', objectBodyStart + 3);
    const dictionaryEnd = dictionaryStart >= 0 ? objectText.indexOf('>>', dictionaryStart + 2) : -1;
    const dictionary = dictionaryEnd >= 0 ? objectText.slice(dictionaryStart + 2, dictionaryEnd) : '';
    const type = /\/Type\s*\/([A-Za-z0-9]+)/.exec(dictionary)?.[1];
    const offsetKind: Region['kind'] = type === 'Catalog' || type === 'Pages' || type === 'Page' ? 'format' : 'metadata';
    const label = type ? `Object ${objectNumber} · ${type}` : `Object ${objectNumber}`;
    regions.push(region(label, offset, Math.max(1, Math.min(length, objectText.indexOf('endobj') >= 0 ? objectText.indexOf('endobj') + 6 : length)), offsetKind));
    findings.push(parserFinding('Indirect object', `${objectNumber} ${objectHeader[2]} obj${type ? ` · /Type /${type}` : ''}`, offset,
      Math.min(length, objectText.indexOf('endobj') >= 0 ? objectText.indexOf('endobj') + 6 : length), 'entry'));
    if (type === 'Catalog') {
      const pages = /\/Pages\s+(\d+)\s+(\d+)\s+R/.exec(dictionary);
      const metadata = /\/Metadata\s+(\d+)\s+(\d+)\s+R/.exec(dictionary);
      if (pages) {
        const pagesNumber = Number(pages[1]);
        const pageOffset = xrefEntries.get(pagesNumber);
        findings.push(parserFinding('Page tree', `Object ${pagesNumber} ${pages[2]} R`, pageOffset, pageOffset === undefined ? undefined : 1, 'metadata'));
        addRef(pages[1]);
      }
      if (metadata) {
        const metadataNumber = Number(metadata[1]);
        const metadataOffset = xrefEntries.get(metadataNumber);
        findings.push(parserFinding('Embedded metadata stream', `Object ${metadataNumber} ${metadata[2]} R`, metadataOffset, metadataOffset === undefined ? undefined : 1, 'metadata'));
        addRef(metadata[1]);
      }
    }
    if (type === 'Pages') {
      const pageCount = /\/Count\s+(\d+)/.exec(dictionary)?.[1];
      if (pageCount) findings.push(parserFinding('Declared page count', pageCount));
    }
    if (type === 'Info') {
      for (const key of ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer', 'CreationDate', 'ModDate']) {
        const value = new RegExp(`/${key}\\s*(\\((?:\\\\.|[^\\)]){0,2048}\\)|<[^>]{0,2048}>)`).exec(dictionary)?.[1];
        if (value) findings.push(parserFinding(`Document ${key}`, value.slice(0, 512), offset, Math.min(512, value.length), 'metadata'));
      }
    }
  }
  let sampledStreamObjects = 0;
  const objectSamples = [...xrefEntries.entries()].slice(0, 128);
  for (const [objectNumber, offset] of objectSamples) {
    const sampleLength = Math.min(8 * 1024, file.size - offset);
    if (sampleLength <= 0) continue;
    const sample = ascii(await readAt(file, offset, sampleLength, signal));
    const header = /^(\d+)\s+(\d+)\s+obj\b/.exec(sample);
    if (!header || Number(header[1]) !== objectNumber) continue;
    const endObject = sample.indexOf('endobj', header[0].length);
    const objectText = sample.slice(0, endObject < 0 ? sample.length : endObject + 6);
    const dictionaryStart = objectText.indexOf('<<', header[0].length);
    const dictionaryEnd = dictionaryStart >= 0 ? objectText.indexOf('>>', dictionaryStart + 2) : -1;
    const dictionary = dictionaryEnd >= 0 ? objectText.slice(dictionaryStart + 2, dictionaryEnd) : '';
    if (/\/Type\s*\/ObjStm\b/.test(dictionary)) {
      findings.push(parserFinding('Compressed object container', `Object ${objectNumber} · object stream is not expanded`, offset, undefined, 'segment'));
    }
    const streamMarker = dictionaryEnd >= 0 ? /\bstream(?:\r\n|\n|\r)/.exec(objectText.slice(dictionaryEnd + 2)) : null;
    if (!streamMarker) continue;
    sampledStreamObjects++;
    const streamStart = offset + dictionaryEnd + 2 + streamMarker.index + streamMarker[0].length;
    const lengthToken = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dictionary)?.[1];
    const streamLength = lengthToken === undefined ? NaN : Number(lengthToken);
    const filter = /\/Filter\s*(?:\/([A-Za-z0-9]+)|\[\s*\/([A-Za-z0-9]+))/.exec(dictionary);
    const filterName = filter?.[1] ?? filter?.[2];
    if (Number.isSafeInteger(streamLength) && streamLength >= 0 && streamStart <= file.size && streamLength <= file.size - streamStart) {
      findings.push(parserFinding('PDF stream', `Object ${objectNumber} · ${streamLength.toLocaleString('en')} bytes${filterName ? ` · /${filterName}` : ''}`,
        streamStart, streamLength, 'segment'));
    } else {
      findings.push(parserFinding('PDF stream', `Object ${objectNumber} · byte length unresolved${filterName ? ` · /${filterName}` : ''}`,
        streamStart, undefined, 'segment'));
    }
  }
  if (sampledStreamObjects) findings.push(parserFinding('Sampled stream objects', `${sampledStreamObjects} of ${xrefEntries.size.toLocaleString('en')} xref entries`));
  if (xrefEntries.size > objectSamples.length) warnings.push('PDF stream and object type sampling is capped at the first 128 xref entries.');
  if (!xrefEntries.size && validXrefOffset && xrefKind === 'classic table') warnings.push('Object offsets were not decoded from the bounded xref table.');
  if (!xrefEntries.size && bodyEnd > headerLength) warnings.push('PDF object bodies were not enumerated from the available xref information.');
  if (startXrefMatches.length > 1) findings.push(parserFinding('Incremental revisions', `${startXrefMatches.length} startxref records in the final MiB`));
  return {
    regions: finishRegionMap(regions, file.size, 'Unresolved PDF bytes'),
    structure: {
      parser: 'PDF xref and object inspection', mode: 'format-aware' as const,
      complete: version !== null && eofOffset >= 0 && validXrefOffset && xrefKind === 'classic table' && xrefEntries.size > 0,
      limitation: 'The current xref revision and referenced catalog, page tree, and info objects are inspected with bounded reads. Xref streams, object streams, filters, and stream payloads remain unresolved.',
      warnings, findings,
    },
  };
}

function genericRegions(size: number) {
  if (!size) return [];
  const count = Math.min(128, Math.max(1, Math.ceil(size / (64 * 1024))));
  return Array.from({ length: count }, (_, index) => {
    const offset = Math.floor(index * size / count);
    const end = Math.floor((index + 1) * size / count);
    return region('Unparsed bytes ' + String(index + 1).padStart(2, '0'), offset, end - offset, 'other');
  });
}

const formatParserRegistry: FormatParser[] = [
  { id: 'RIFF / WAVE', supports: (identity) => identity.type === 'RIFF / WAVE', parse: parseWave },
  { id: 'PNG', supports: (identity) => identity.type === 'PNG image', parse: parsePng },
  { id: 'JPEG', supports: (identity) => identity.type === 'JPEG image', parse: parseJpeg },
  { id: 'ZIP', supports: (identity) => identity.type === 'ZIP archive', parse: parseZip },
  { id: 'PE', supports: (identity) => identity.type === 'MZ executable', parse: parsePe },
  { id: 'ELF', supports: (identity) => identity.type === 'ELF binary', parse: parseElf },
  { id: 'SQLite', supports: (identity) => identity.type === 'SQLite database', parse: parseSqlite },
  { id: 'PDF', supports: (identity) => identity.type === 'PDF document', parse: parsePdf },
];

export const registeredFormatParsers = formatParserRegistry.map(({ id }) => id);

async function parseStructure(file: File, identity: FileIdentity, signal?: AbortSignal): Promise<ParserOutput> {
  if (!file.size) return {
    regions: [],
    structure: { parser: 'Empty file', mode: 'format-aware', complete: true, limitation: null, warnings: [] },
  };
  const dispatch = await runParserRegistry(file, identity, formatParserRegistry, signal);
  if (dispatch.output) {
    const findings = dispatch.output.structure.findings;
    if (findings && findings.length > 4_096) {
      return {
        ...dispatch.output,
        structure: { ...dispatch.output.structure, findings: findings.slice(0, 4_096),
          warnings: [...dispatch.output.structure.warnings, 'Parser findings were capped at 4,096 entries.'] },
      };
    }
    return dispatch.output;
  }
  const warnings = dispatch.error ? [`${dispatch.parser} parser failed safely: ${dispatch.error}`]
    : dispatch.parser ? [`${dispatch.parser} signature was recognized, but its required structural fields did not validate.`] : [];
  if (identity.type === 'MZ executable') {
    return {
      regions: genericRegions(file.size),
      structure: { parser: 'Generic MZ byte regions', mode: 'generic', complete: false, limitation: 'An MZ header was identified, but a bounded, validated PE signature was not found.', warnings },
    };
  }
  const label = identity.type === 'Binary data' || identity.type === 'Text / UTF-8' ? 'Generic byte regions' : 'Generic ' + identity.type + ' byte regions';
  return {
    regions: genericRegions(file.size),
    structure: { parser: dispatch.parser ? `Generic ${dispatch.parser} fallback` : label, mode: 'generic', complete: false,
      limitation: dispatch.parser ? 'The recognized signature could not be parsed safely; ranges are display windows, not discovered sections.'
        : 'No format-aware structural parser is available; ranges are display windows, not discovered sections.', warnings },
  };
}
