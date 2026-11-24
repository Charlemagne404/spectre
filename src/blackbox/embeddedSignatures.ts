export const EMBEDDED_SCAN_CHUNK_SIZE = 1024 * 1024;
export const MAX_EMBEDDED_CANDIDATES = 1_000;
export const MAX_SIGNATURE_VALIDATIONS = 128;

export type EmbeddedClassification = 'candidate' | 'validated' | 'complete';
export type EmbeddedScanPhase = 'scanning' | 'validating';

export interface EmbeddedFinding {
  offset: number;
  format: string;
  signature: string;
  classification: EmbeddedClassification;
  length?: number;
  note: string;
}

export interface EmbeddedScanProgress {
  phase: EmbeddedScanPhase;
  processed: number;
  total: number;
}

export interface EmbeddedScanResult {
  findings: EmbeddedFinding[];
  totalCandidates: number;
  omittedCandidates: number;
  validationsSkipped: number;
}

interface SignatureDefinition { format: string; label: string; bytes: number[] }

const signatures: SignatureDefinition[] = [
  { format: 'PNG', label: 'PNG signature', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { format: 'ZIP', label: 'ZIP local file header', bytes: [0x50, 0x4b, 0x03, 0x04] },
  { format: 'ZIP', label: 'ZIP empty archive record', bytes: [0x50, 0x4b, 0x05, 0x06] },
  { format: 'PDF', label: 'PDF header', bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  { format: 'SQLite', label: 'SQLite 3 header', bytes: [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00] },
  { format: 'ELF', label: 'ELF header', bytes: [0x7f, 0x45, 0x4c, 0x46] },
  { format: 'Mach-O', label: 'Mach-O 32-bit big-endian', bytes: [0xfe, 0xed, 0xfa, 0xce] },
  { format: 'Mach-O', label: 'Mach-O 32-bit little-endian', bytes: [0xce, 0xfa, 0xed, 0xfe] },
  { format: 'Mach-O', label: 'Mach-O 64-bit big-endian', bytes: [0xfe, 0xed, 0xfa, 0xcf] },
  { format: 'Mach-O', label: 'Mach-O 64-bit little-endian', bytes: [0xcf, 0xfa, 0xed, 0xfe] },
  { format: 'Mach-O universal', label: 'Universal Mach-O header', bytes: [0xca, 0xfe, 0xba, 0xbe] },
  { format: 'Mach-O universal', label: 'Universal Mach-O 64-bit header', bytes: [0xca, 0xfe, 0xba, 0xbf] },
  { format: 'RIFF', label: 'RIFF container', bytes: [0x52, 0x49, 0x46, 0x46] },
  { format: 'JPEG', label: 'JPEG start-of-image marker', bytes: [0xff, 0xd8, 0xff] },
  { format: 'GZIP', label: 'GZIP header', bytes: [0x1f, 0x8b, 0x08] },
];

const byFirstByte = new Map<number, SignatureDefinition[]>();
for (const signature of signatures) {
  const entries = byFirstByte.get(signature.bytes[0]) ?? [];
  entries.push(signature);
  byFirstByte.set(signature.bytes[0], entries);
}
const maxSignatureLength = Math.max(...signatures.map((signature) => signature.bytes.length));

function abortError() {
  const error = new Error('Embedded-signature scan cancelled.');
  error.name = 'AbortError';
  return error;
}

function ascii(bytes: Uint8Array, offset: number, length: number) {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function containsAscii(bytes: Uint8Array, needle: string) {
  for (let offset = 0; offset <= bytes.length - needle.length; offset++) {
    let matches = true;
    for (let index = 0; index < needle.length; index++) {
      if (bytes[offset + index] !== needle.charCodeAt(index)) { matches = false; break; }
    }
    if (matches) return true;
  }
  return false;
}

function u16(bytes: Uint8Array, offset: number, littleEndian: boolean) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, littleEndian);
}

function u32(bytes: Uint8Array, offset: number, littleEndian: boolean) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, littleEndian);
}

function isRange(offset: number, length: number, limit: number) {
  return Number.isSafeInteger(offset) && Number.isSafeInteger(length) && offset >= 0 && length >= 0
    && offset <= limit && length <= limit - offset;
}

function candidate(offset: number, definition: SignatureDefinition, note: string): EmbeddedFinding {
  return { offset, format: definition.format, signature: definition.label, classification: 'candidate', note };
}

async function validate(file: File, finding: EmbeddedFinding, signal: AbortSignal): Promise<EmbeddedFinding> {
  const at = finding.offset;
  const remaining = file.size - at;
  const read = async (offset: number, length: number) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
  if (signal.aborted) throw abortError();

  if (finding.format === 'RIFF') {
    const head = await read(at, 12);
    if (head.length < 12 || ascii(head, 8, 4) !== 'WAVE' && ascii(head, 8, 4) !== 'WEBP') return candidate(at, { format: 'RIFF', label: finding.signature, bytes: [] }, 'RIFF marker found, but the supported WAVE/WEBP form did not validate.');
    const end = at + 8 + u32(head, 4, true);
    if (!Number.isSafeInteger(end) || end < at + 12 || end > file.size) return candidate(at, { format: 'RIFF', label: finding.signature, bytes: [] }, 'Declared RIFF container bounds exceed the source file.');
    let cursor = at + 12;
    let chunks = 0;
    while (cursor < end && chunks < 10_000) {
      if (signal.aborted) throw abortError();
      if (!isRange(cursor, 8, end)) return candidate(at, { format: 'RIFF', label: finding.signature, bytes: [] }, 'A RIFF child header is truncated.');
      const chunkHead = await read(cursor, 8);
      const length = u32(chunkHead, 4, true);
      const next = cursor + 8 + length + (length & 1);
      if (!Number.isSafeInteger(next) || next > end) return candidate(at, { format: 'RIFF', label: finding.signature, bytes: [] }, 'A RIFF child length extends beyond its declared container.');
      cursor = next;
      chunks++;
    }
    if (cursor !== end || chunks >= 10_000) return candidate(at, { format: 'RIFF', label: finding.signature, bytes: [] }, 'RIFF child boundaries were not completely resolved within parser limits.');
    return { ...finding, classification: 'complete', length: end - at, note: `${chunks} bounded child chunks; declared container ends within the file.` };
  }

  if (finding.format === 'PNG') {
    const head = await read(at, 33);
    if (head.length < 33 || u32(head, 8, false) !== 13 || ascii(head, 12, 4) !== 'IHDR') return candidate(at, { format: 'PNG', label: finding.signature, bytes: [] }, 'The required 13-byte IHDR chunk did not validate.');
    let cursor = at + 8;
    let chunks = 0;
    while (cursor + 12 <= file.size && chunks < 10_000) {
      if (signal.aborted) throw abortError();
      const chunkHead = await read(cursor, 8);
      if (chunkHead.length < 8) break;
      const length = u32(chunkHead, 0, false);
      const name = ascii(chunkHead, 4, 4);
      if (!/^[A-Za-z]{4}$/.test(name) || !isRange(cursor + 8, length + 4, file.size)) return candidate(at, { format: 'PNG', label: finding.signature, bytes: [] }, 'A PNG chunk type or declared length is invalid.');
      cursor += 12 + length;
      chunks++;
      if (name === 'IEND') return { ...finding, classification: 'complete', length: cursor - at, note: `${chunks} chunk boundaries through IEND; CRC values were not checked.` };
    }
    return candidate(at, { format: 'PNG', label: finding.signature, bytes: [] }, chunks >= 10_000 ? 'PNG chunk scan reached the 10,000-chunk limit.' : 'No bounded IEND chunk was found.');
  }

  if (finding.format === 'ZIP' && finding.signature === 'ZIP local file header') {
    const head = await read(at, 30);
    if (head.length < 30) return candidate(at, { format: 'ZIP', label: finding.signature, bytes: [] }, 'ZIP local-file header is truncated.');
    const version = u16(head, 4, true);
    const method = u16(head, 8, true);
    const compressedSize = u32(head, 18, true);
    const nameLength = u16(head, 26, true);
    const extraLength = u16(head, 28, true);
    const dataStart = at + 30 + nameLength + extraLength;
    if (version < 10 || version > 63 || nameLength > 4_096 || extraLength > 65_535 || dataStart > file.size) return candidate(at, { format: 'ZIP', label: finding.signature, bytes: [] }, 'ZIP local-file fields or name/extra bounds are implausible.');
    if (compressedSize !== 0xffff_ffff && compressedSize !== 0 && !isRange(dataStart, compressedSize, file.size)) return candidate(at, { format: 'ZIP', label: finding.signature, bytes: [] }, 'ZIP entry payload bounds extend beyond the source file.');
    return { ...finding, classification: 'validated', length: compressedSize > 0 && compressedSize !== 0xffff_ffff ? dataStart + compressedSize - at : dataStart - at,
      note: `Local entry header validated · method ${method} · payload CRC and archive directory not checked.` };
  }

  if (finding.format === 'ZIP') return candidate(at, { format: finding.format, label: finding.signature, bytes: [] }, 'ZIP end records require archive-level context and were not interpreted as embedded objects.');

  if (finding.format === 'PDF') {
    const head = await read(at, 8);
    if (head.length < 8 || !/^%PDF-\d\.\d/.test(ascii(head, 0, 8))) return candidate(at, { format: 'PDF', label: finding.signature, bytes: [] }, 'PDF version header did not validate.');
    const sampleEnd = Math.min(file.size, at + 16 * 1024 * 1024);
    for (let cursor = at + head.length; cursor < sampleEnd; cursor += EMBEDDED_SCAN_CHUNK_SIZE) {
      if (signal.aborted) throw abortError();
      const chunk = await read(cursor, Math.min(EMBEDDED_SCAN_CHUNK_SIZE + 5, sampleEnd - cursor));
      if (containsAscii(chunk, '%%EOF')) return { ...finding, classification: 'validated', length: cursor + chunk.length - at,
        note: 'Version header and a bounded %%EOF marker were found; xref tables and objects were not resolved.' };
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    return { ...finding, classification: 'validated', note: 'PDF version header validated; no %%EOF marker was found within the 16 MiB validation window.' };
  }

  if (finding.format === 'ELF') {
    const head = await read(at, 64);
    const elfClass = head[4];
    const data = head[5];
    if (head.length < 16 || ![1, 2].includes(elfClass) || ![1, 2].includes(data) || head[6] !== 1) return candidate(at, { format: 'ELF', label: finding.signature, bytes: [] }, 'ELF class, byte order, or identification version is invalid.');
    const requiredHeader = elfClass === 1 ? 52 : 64;
    if (head.length < requiredHeader) return candidate(at, { format: 'ELF', label: finding.signature, bytes: [] }, 'ELF header is truncated.');
    const headerSize = u16(head, elfClass === 1 ? 40 : 52, data === 1);
    if (headerSize !== requiredHeader || remaining < headerSize) return candidate(at, { format: 'ELF', label: finding.signature, bytes: [] }, 'ELF header size does not match its class.');
    return { ...finding, classification: 'validated', length: headerSize, note: `${elfClass === 1 ? '32-bit' : '64-bit'} ELF header bounds validated; program data was not traversed.` };
  }

  if (finding.format === 'SQLite') {
    const head = await read(at, 100);
    if (head.length < 100) return candidate(at, { format: 'SQLite', label: finding.signature, bytes: [] }, 'SQLite database header is truncated.');
    let pageSize = u16(head, 16, false);
    if (pageSize === 1) pageSize = 65_536;
    if (pageSize < 512 || pageSize > 65_536 || (pageSize & (pageSize - 1)) !== 0) return candidate(at, { format: 'SQLite', label: finding.signature, bytes: [] }, 'SQLite page size is invalid.');
    const pageCount = u32(head, 28, false);
    if (pageCount && pageCount <= Math.floor(remaining / pageSize)) return { ...finding, classification: 'validated', length: pageCount * pageSize,
      note: `${pageCount.toLocaleString('en')} declared pages fit in the source; page trees and freelist were not traversed.` };
    return { ...finding, classification: 'validated', length: pageSize, note: 'SQLite header and page size validated; declared page count is unavailable or incomplete.' };
  }

  if (finding.format.startsWith('Mach-O')) {
    const signature = await read(at, 4);
    const magic = ascii(signature, 0, 4);
    const littleEndian = magic === '\xce\xfa\xed\xfe' || magic === '\xcf\xfa\xed\xfe';
    const is64 = magic === '\xfe\xed\xfa\xcf' || magic === '\xcf\xfa\xed\xfe';
    const fat = magic === '\xca\xfe\xba\xbe' || magic === '\xbe\xba\xfe\xca' || magic === '\xca\xfe\xba\xbf' || magic === '\xbf\xba\xfe\xca';
    const headSize = fat ? 8 : is64 ? 32 : 28;
    const head = await read(at, headSize);
    if (head.length < headSize) return candidate(at, { format: finding.format, label: finding.signature, bytes: [] }, 'Mach-O header is truncated.');
    if (fat) {
      const fatLittle = magic === '\xbe\xba\xfe\xca' || magic === '\xbf\xba\xfe\xca';
      const count = u32(head, 4, fatLittle);
      const entrySize = magic === '\xca\xfe\xba\xbf' || magic === '\xbf\xba\xfe\xca' ? 32 : 20;
      if (!count || count > 64 || !isRange(at + 8, count * entrySize, file.size)) return candidate(at, { format: finding.format, label: finding.signature, bytes: [] }, 'Universal Mach-O architecture table is outside bounded limits.');
      return { ...finding, classification: 'validated', note: `${count} universal architecture records fit the source; slice headers were not traversed.` };
    }
    const ncmds = u32(head, 16, littleEndian);
    const sizeofcmds = u32(head, 20, littleEndian);
    if (ncmds > 4_096 || sizeofcmds > 16 * 1024 * 1024 || !isRange(at + headSize, sizeofcmds, file.size)) return candidate(at, { format: finding.format, label: finding.signature, bytes: [] }, 'Mach-O load-command bounds are invalid or exceed parser limits.');
    const commands = await read(at + headSize, sizeofcmds);
    const commandsView = new DataView(commands.buffer, commands.byteOffset, commands.byteLength);
    let cursor = 0;
    for (let index = 0; index < ncmds; index++) {
      if (cursor + 8 > commands.length) return candidate(at, { format: finding.format, label: finding.signature, bytes: [] }, 'Mach-O load-command table is truncated.');
      const size = commandsView.getUint32(cursor + 4, littleEndian);
      if (size < 8 || size > commands.length - cursor) return candidate(at, { format: finding.format, label: finding.signature, bytes: [] }, 'Mach-O load-command size is invalid.');
      cursor += size;
    }
    if (cursor !== sizeofcmds) return candidate(at, { format: finding.format, label: finding.signature, bytes: [] }, 'Mach-O load-command byte count does not match the header.');
    return { ...finding, classification: 'validated', note: `${is64 ? '64-bit' : '32-bit'} header and ${ncmds} bounded load commands validate; segments are not recursively inspected.` };
  }

  if (finding.format === 'JPEG') {
    const marker = await read(at, 4);
    return marker.length >= 3 && marker[0] === 0xff && marker[1] === 0xd8 && marker[2] === 0xff
      ? { ...finding, classification: 'validated', length: 3, note: 'JPEG start-of-image marker sequence validated; marker stream and end-of-image were not traversed.' }
      : finding;
  }

  if (finding.format === 'GZIP') {
    const head = await read(at, 10);
    if (head.length < 10 || head[3] & 0xe0) return candidate(at, { format: 'GZIP', label: finding.signature, bytes: [] }, 'GZIP header is truncated or uses reserved flag bits.');
    return { ...finding, classification: 'validated', length: remaining, note: 'GZIP header validated; deflate stream and trailer checksum were not verified.' };
  }
  return { ...finding, note: 'Signature candidate only; no bounded structural validator is available.' };
}

/** Scan in fixed-size slices and validate only a bounded prefix of discovered signatures. */
export async function scanEmbeddedSignatures(
  file: File,
  onProgress?: (progress: EmbeddedScanProgress) => void,
  signal = new AbortController().signal,
): Promise<EmbeddedScanResult> {
  const findings: EmbeddedFinding[] = [];
  let totalCandidates = 0;
  const rangeEnd = file.size;
  for (let start = 0; start < rangeEnd; start += EMBEDDED_SCAN_CHUNK_SIZE) {
    if (signal.aborted) throw abortError();
    const stepEnd = Math.min(rangeEnd, start + EMBEDDED_SCAN_CHUNK_SIZE);
    const readEnd = Math.min(rangeEnd, stepEnd + maxSignatureLength - 1);
    const bytes = new Uint8Array(await file.slice(start, readEnd).arrayBuffer());
    if (signal.aborted) throw abortError();
    for (let localOffset = 0; localOffset < stepEnd - start; localOffset++) {
      const definitions = byFirstByte.get(bytes[localOffset]);
      if (!definitions) continue;
      const offset = start + localOffset;
      if (offset === 0) continue;
      for (const definition of definitions) {
        let matches = true;
        for (let index = 1; index < definition.bytes.length; index++) {
          if (bytes[localOffset + index] !== definition.bytes[index]) { matches = false; break; }
        }
        if (!matches) continue;
        totalCandidates++;
        if (findings.length < MAX_EMBEDDED_CANDIDATES) findings.push(candidate(offset, definition, 'Signature bytes found; structural validation is pending.'));
      }
    }
    onProgress?.({ phase: 'scanning', processed: stepEnd, total: Math.max(1, file.size) });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  const validationCount = Math.min(findings.length, MAX_SIGNATURE_VALIDATIONS);
  for (let index = 0; index < validationCount; index++) {
    if (signal.aborted) throw abortError();
    try { findings[index] = await validate(file, findings[index], signal); }
    catch (error) { if (signal.aborted) throw abortError(); throw error; }
    onProgress?.({ phase: 'validating', processed: index + 1, total: Math.max(1, validationCount) });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  for (let index = validationCount; index < findings.length; index++) findings[index] = {
    ...findings[index], note: 'Validation limit reached; signature candidate retained without structural validation.',
  };
  return {
    findings, totalCandidates,
    omittedCandidates: Math.max(0, totalCandidates - findings.length),
    validationsSkipped: Math.max(0, findings.length - validationCount),
  };
}
