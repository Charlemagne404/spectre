import { describe, expect, it } from 'vitest';
import { StringScanner } from '../src/blackbox/stringScanner';
import type { StringFinding } from '../src/blackbox/stringScanner';

function scanInChunks(bytes: Uint8Array, chunkSize: number, query = '') {
  const findings: StringFinding[] = [];
  const scanner = new StringScanner((finding) => { findings.push(finding); }, query);
  for (let start = 0; start < bytes.length; start += chunkSize) {
    const end = Math.min(bytes.length, start + chunkSize);
    for (let offset = start; offset < end; offset++) scanner.consume(bytes[offset], offset);
  }
  scanner.finish();
  return findings;
}

describe('incremental printable string scanner', () => {
  it('preserves ASCII and UTF-16LE offsets across one-byte chunk boundaries', () => {
    const text = new TextEncoder().encode('prefix\0boundary text\0\0');
    const utf = new Uint8Array(12);
    for (let index = 0; index < 6; index++) utf[index * 2] = 'WIDGET'[index].charCodeAt(0);
    const bytes = new Uint8Array(text.length + utf.length + 1);
    bytes.set(text);
    bytes.set(utf, text.length);
    const findings = scanInChunks(bytes, 1);
    expect(findings.map(({ value }) => value)).toContainEqual({
      offset: 7, length: 13, text: 'boundary text', encoding: 'ASCII',
    });
    expect(findings.map(({ value }) => value)).toContainEqual({
      offset: text.length, length: 12, text: 'WIDGET', encoding: 'UTF-16LE',
    });
  });

  it('matches text beyond the bounded preview while retaining only 240 preview characters', () => {
    const prefix = 'A'.repeat(500);
    const bytes = new TextEncoder().encode(`\0${prefix}NeedleAtTheEnd\0`);
    const finding = scanInChunks(bytes, 17, 'needleattheend').find(({ value }) => value.offset === 1);
    expect(finding?.value.text).toHaveLength(240);
    expect(finding?.value.length).toBe(prefix.length + 'NeedleAtTheEnd'.length);
    expect(finding?.matchesQuery).toBe(true);
  });

  it('does not mistake isolated printable bytes for UTF-16LE strings', () => {
    const bytes = new TextEncoder().encode('alpha\0x\0bravo');
    const findings = scanInChunks(bytes, 2);
    expect(findings.some(({ value }) => value.encoding === 'UTF-16LE')).toBe(false);
  });

  it('skips long zero runs without losing strings on either side', () => {
    const asciiBefore = new TextEncoder().encode('BEFORE');
    const utfText = new Uint8Array(12);
    for (let index = 0; index < 6; index++) utfText[index * 2] = 'MIDDLE'[index].charCodeAt(0);
    const asciiAfter = new TextEncoder().encode('AFTER');
    const bytes = new Uint8Array(asciiBefore.length + 4_096 + utfText.length + 4_096 + asciiAfter.length);
    bytes.set(asciiBefore);
    bytes.set(utfText, asciiBefore.length + 4_096);
    bytes.set(asciiAfter, asciiBefore.length + 4_096 + utfText.length + 4_096);

    expect(scanInChunks(bytes, 257).map(({ value }) => value)).toEqual([
      { offset: 0, length: 6, text: 'BEFORE', encoding: 'ASCII' },
      { offset: asciiBefore.length + 4_096, length: 12, text: 'MIDDLE', encoding: 'UTF-16LE' },
      { offset: asciiBefore.length + 4_096 + utfText.length + 4_096, length: 5, text: 'AFTER', encoding: 'ASCII' },
    ]);
  });

  it('continues counting strings after the retained finding limit without emitting more entries', () => {
    const findings: StringFinding[] = [];
    const scanner = new StringScanner((finding) => { findings.push(finding); }, '', 2);
    const bytes = new TextEncoder().encode('first string\0second string\0third string\0');
    for (let offset = 0; offset < bytes.length; offset++) scanner.consume(bytes[offset], offset);
    scanner.finish();

    expect(findings.map(({ value }) => value.text)).toEqual(['first string', 'second string']);
    expect(scanner.totalFindings).toBe(3);
  });
});
