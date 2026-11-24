import { createHash } from 'node:crypto';
import { open, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';

const MiB = 1024 * 1024;
const output = resolve(process.argv[2] ?? join(tmpdir(), 'spectre-performance-recording'));
await mkdir(output, { recursive: true });

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ crc >>> 8;
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(name, payload) {
  const chunk = Buffer.alloc(12 + payload.length);
  chunk.writeUInt32BE(payload.length, 0);
  chunk.write(name, 4, 4, 'ascii');
  payload.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + payload.length)), 8 + payload.length);
  return chunk;
}

function makePng() {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(96, 0);
  ihdr.writeUInt32BE(64, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const text = Buffer.from('Title\0BLACKBOX parser inspection fixture', 'latin1');
  const raw = Buffer.alloc((96 * 3 + 1) * 64);
  for (let y = 0; y < 64; y++) {
    raw[y * 289] = 0;
    for (let x = 0; x < 96; x++) {
      const pixel = y * 289 + 1 + x * 3;
      raw[pixel] = (x * 3) & 0xff;
      raw[pixel + 1] = (y * 5) & 0xff;
      raw[pixel + 2] = 0xc8;
    }
  }
  return Buffer.concat([signature, pngChunk('IHDR', ihdr), pngChunk('tEXt', text), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}

function makeZip() {
  const entries = [
    ['evidence/readme.txt', Buffer.from('Local archive inspection fixture. No files are extracted.\n')],
    ['logs/analysis.log', Buffer.from('2026-11-23T12:00:00Z parser=ZIP status=bounded\n')],
  ];
  let cursor = 0;
  const locals = [];
  const centrals = [];
  for (const [name, payload] of entries) {
    const nameBytes = Buffer.from(name);
    const crc = crc32(payload);
    const local = Buffer.alloc(30 + nameBytes.length + payload.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(payload.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    payload.copy(local, 30 + nameBytes.length);
    locals.push(local);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(payload.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(cursor, 42);
    nameBytes.copy(central, 46);
    centrals.push(central);
    cursor += local.length;
  }
  const centralOffset = cursor;
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

function makePdf() {
  const stream = 'BT /F1 18 Tf 72 720 Td (SPECTRE parser inspection fixture) Tj ET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Title (SPECTRE parser inspection fixture) /Creator (Local deterministic fixture generator) >>',
  ];
  let body = '%PDF-1.7\n%âãÏÓ\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

function makePe() {
  const bytes = Buffer.alloc(0x800);
  bytes.write('MZ', 0, 'ascii');
  bytes.write('This program cannot be run in DOS mode.\r\n$', 0x40, 'ascii');
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write('PE\0\0', 0x80, 'binary');
  bytes.writeUInt16LE(0x8664, 0x84);
  bytes.writeUInt16LE(3, 0x86);
  bytes.writeUInt16LE(0xf0, 0x94);
  bytes.writeUInt16LE(0x0022, 0x96);
  const optional = 0x98;
  bytes.writeUInt16LE(0x20b, optional);
  bytes.writeUInt32LE(0x1000, optional + 16);
  bytes.writeUInt32LE(0x1000, optional + 20);
  bytes.writeBigUInt64LE(0x140000000n, optional + 24);
  bytes.writeUInt32LE(0x1000, optional + 32);
  bytes.writeUInt32LE(0x200, optional + 36);
  bytes.writeUInt16LE(6, optional + 40);
  bytes.writeUInt16LE(0, optional + 42);
  bytes.writeUInt16LE(6, optional + 48);
  bytes.writeUInt16LE(0, optional + 50);
  bytes.writeUInt32LE(0x4000, optional + 56);
  bytes.writeUInt32LE(0x200, optional + 60);
  bytes.writeUInt16LE(3, optional + 68);
  bytes.writeUInt16LE(0x8160, optional + 70);
  bytes.writeBigUInt64LE(0x100000n, optional + 72);
  bytes.writeBigUInt64LE(0x1000n, optional + 80);
  bytes.writeBigUInt64LE(0x100000n, optional + 88);
  bytes.writeBigUInt64LE(0x1000n, optional + 96);
  bytes.writeUInt32LE(16, optional + 108);
  const sectionTable = optional + 0xf0;
  const sections = [
    { name: '.text', virtualSize: 0x80, rva: 0x1000, rawSize: 0x200, raw: 0x200, flags: 0x60000020 },
    { name: '.rdata', virtualSize: 0x100, rva: 0x2000, rawSize: 0x200, raw: 0x400, flags: 0x40000040 },
    { name: '.data', virtualSize: 0x40, rva: 0x3000, rawSize: 0x200, raw: 0x600, flags: 0xc0000040 },
  ];
  sections.forEach((section, index) => {
    const offset = sectionTable + index * 40;
    bytes.write(section.name, offset, 'ascii');
    bytes.writeUInt32LE(section.virtualSize, offset + 8);
    bytes.writeUInt32LE(section.rva, offset + 12);
    bytes.writeUInt32LE(section.rawSize, offset + 16);
    bytes.writeUInt32LE(section.raw, offset + 20);
    bytes.writeUInt32LE(section.flags, offset + 36);
  });
  bytes.set([0x48, 0x31, 0xc0, 0xc3], 0x200); // xor rax, rax; ret — inspected as bytes only
  bytes.write('Spectre PE section fixture\0', 0x400, 'ascii');
  bytes.set([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08], 0x600);
  return bytes;
}

const metadata = [];
async function writeFixture(name, bytes) {
  const path = join(output, name);
  await writeFile(path, bytes);
  metadata.push({ name, sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}

async function writeLargeFixture() {
  const name = 'spectre-500MiB-repeated-binary.bin';
  const path = join(output, name);
  const file = await open(path, 'w');
  const block = Buffer.alloc(MiB);
  for (let index = 0; index < block.length; index++) block[index] = index & 0xff;
  const hash = createHash('sha256');
  try {
    for (let offset = 0; offset < 500 * MiB; offset += block.length) {
      await file.write(block, 0, block.length, offset);
      hash.update(block);
    }
  } finally {
    await file.close();
  }
  metadata.push({ name, sizeBytes: 500 * MiB, sha256: hash.digest('hex') });
}

await writeFixture('spectre-inspection.png', makePng());
await writeFixture('spectre-inspection.zip', makeZip());
await writeFixture('spectre-inspection.pdf', makePdf());
await writeFixture('spectre-inspection.exe', makePe());
await writeLargeFixture();
await writeFile(join(output, 'fixtures.json'), `${JSON.stringify({ output, generatedAt: new Date().toISOString(), fixtures: metadata }, null, 2)}\n`);
console.log(JSON.stringify({ output, fixtures: metadata }, null, 2));
