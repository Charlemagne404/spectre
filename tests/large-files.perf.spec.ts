import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { open, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const enabled = process.env.SPECTRE_PERF === '1';
const sizes = (process.env.SPECTRE_PERF_SIZES ?? '5KiB,10MiB,10MiB-PNG,128MiB,500MiB,1GiB').split(',').map((value) => value.trim());
const MiB = 1024 * 1024;

test.skip(!enabled, 'Set SPECTRE_PERF=1 to run disk-backed large-file performance cases.');
test.setTimeout(12 * 60 * 1000);

function parseSize(value: string) {
  const match = /^(\d+)(KiB|MiB|GiB)(?:-([A-Za-z0-9]+))?$/i.exec(value);
  if (!match) throw new Error(`Unsupported performance size: ${value}`);
  const unit = match[2].toLowerCase() === 'kib' ? 1024 : match[2].toLowerCase() === 'mib' ? MiB : MiB * 1024;
  return Number(match[1]) * unit;
}

function modeFor(size: string) {
  return ({
    '5KiB': 'repeated-text',
    '10MiB': 'many-strings',
    '10MiB-PNG': 'structured-png',
    '128MiB': 'high-entropy',
    '500MiB': 'repeated-binary',
    '1GiB': 'sparse-text',
  } as Record<string, string>)[size] ?? 'repeated-binary';
}

function descendantRssKiB() {
  try {
    const rows = execFileSync('ps', ['-Ao', 'pid=,ppid=,rss='], { encoding: 'utf8' }).trim().split('\n')
      .map((line) => line.trim().split(/\s+/).map(Number))
      .filter((row) => row.length === 3 && row.every(Number.isFinite));
    const processes = new Set([process.pid]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [pid, parent] of rows) {
        if (processes.has(parent) && !processes.has(pid)) { processes.add(pid); changed = true; }
      }
    }
    return rows.reduce((sum, [pid, , rss]) => sum + (processes.has(pid) ? rss : 0), 0);
  } catch {
    return 0;
  }
}

const pngCrcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});

function crc32Update(crc: number, bytes: Uint8Array) {
  for (const byte of bytes) crc = pngCrcTable[(crc ^ byte) & 0xff] ^ crc >>> 8;
  return crc;
}

async function makeFixture(path: string, size: number, mode: string) {
  const handle = await open(path, 'w');
  const hash = createHash('sha256');
  const blockSize = MiB;
  const buffer = Buffer.alloc(blockSize);
  let state = 0x13579bdf;
  try {
    if (mode === 'structured-png') {
      const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
      const ihdrPayload = Buffer.alloc(13);
      ihdrPayload.writeUInt32BE(1024, 0);
      ihdrPayload.writeUInt32BE(1024, 4);
      ihdrPayload.set([8, 2, 0, 0, 0], 8);
      const makeChunk = (name: string, payload: Buffer) => {
        const type = Buffer.from(name, 'ascii');
        const result = Buffer.alloc(12 + payload.length);
        result.writeUInt32BE(payload.length, 0);
        type.copy(result, 4);
        payload.copy(result, 8);
        result.writeUInt32BE((crc32Update(crc32Update(0xffffffff, type), payload) ^ 0xffffffff) >>> 0, 8 + payload.length);
        return result;
      };
      const ihdr = makeChunk('IHDR', ihdrPayload);
      const payloadLength = size - signature.length - ihdr.length - 12 - 12;
      if (payloadLength < 0) throw new Error('PNG benchmark fixture is too small.');
      const idatHeader = Buffer.alloc(8);
      idatHeader.writeUInt32BE(payloadLength, 0);
      idatHeader.write('IDAT', 4, 'ascii');
      let offset = 0;
      const writePart = async (part: Buffer) => { hash.update(part); await handle.write(part, 0, part.length, offset); offset += part.length; };
      await writePart(signature);
      await writePart(ihdr);
      await writePart(idatHeader);
      let crc = crc32Update(0xffffffff, Buffer.from('IDAT'));
      buffer.fill(0);
      for (let remaining = payloadLength; remaining > 0;) {
        const length = Math.min(blockSize, remaining);
        const part = buffer.subarray(0, length);
        crc = crc32Update(crc, part);
        await writePart(part);
        remaining -= length;
      }
      const crcBuffer = Buffer.alloc(4);
      crcBuffer.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
      await writePart(crcBuffer);
      await writePart(makeChunk('IEND', Buffer.alloc(0)));
    } else for (let offset = 0; offset < size; offset += blockSize) {
      const length = Math.min(blockSize, size - offset);
      if (mode === 'repeated-text') {
        buffer.fill(0);
        const text = Buffer.from('SPECTRE large-file fixture with a repeatable text sequence\n');
        for (let cursor = 0; cursor < length; cursor += text.length) text.copy(buffer, cursor, 0, Math.min(text.length, length - cursor));
      } else if (mode === 'many-strings') {
        buffer.fill(0);
        for (let cursor = 0; cursor + 40 <= length; cursor += 40) {
          buffer.write(`STRING-INDEX-ENTRY-${String(offset + cursor).padStart(16, '0')}`, cursor, 39, 'ascii');
        }
      } else if (mode === 'high-entropy') {
        for (let cursor = 0; cursor < length; cursor++) {
          state ^= state << 13;
          state ^= state >>> 17;
          state ^= state << 5;
          buffer[cursor] = state & 0xff;
        }
      } else if (mode === 'sparse-text') {
        buffer.fill(0);
        for (let cursor = 0; cursor + 24 <= length; cursor += 64 * 1024) {
          buffer.write(`MARKER-${String(offset + cursor).padStart(16, '0')}`, cursor, 24, 'ascii');
        }
      } else {
        for (let cursor = 0; cursor < length; cursor++) buffer[cursor] = (offset + cursor) & 0xff;
      }
      const part = buffer.subarray(0, length);
      hash.update(part);
      await handle.write(part, 0, length, offset);
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

for (const sizeLabel of sizes) {
  test(`profiles ${sizeLabel} ${modeFor(sizeLabel)} fixture`, async ({ page }, testInfo) => {
    const size = parseSize(sizeLabel);
    const directory = await mkdtemp(join(tmpdir(), 'spectre-perf-'));
    const path = join(directory, `fixture-${sizeLabel}.bin`);
    let memorySampler: NodeJS.Timeout | undefined;
    let peakDescendantRss = 0;
    let baselineDescendantRss = 0;
    try {
      const expectedHash = await makeFixture(path, size, modeFor(sizeLabel));
      await page.goto('/');
      await page.getByRole('button', { name: '[1] BLACKBOX' }).click();
      await expect(page.getByText('No file loaded.', { exact: true })).toBeVisible();
      await page.evaluate(() => {
        const target = window as typeof window & { __spectrePerf?: { frames: number; maxFrameGap: number; previous: number; peakHeap: number } };
        const metrics = { frames: 0, maxFrameGap: 0, previous: performance.now(), peakHeap: 0 };
        target.__spectrePerf = metrics;
        const frame = (now: number) => {
          metrics.frames++;
          metrics.maxFrameGap = Math.max(metrics.maxFrameGap, now - metrics.previous);
          metrics.previous = now;
          const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
          if (memory) metrics.peakHeap = Math.max(metrics.peakHeap, memory.usedJSHeapSize);
          requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      });
      baselineDescendantRss = descendantRssKiB();
      peakDescendantRss = baselineDescendantRss;
      memorySampler = setInterval(() => { peakDescendantRss = Math.max(peakDescendantRss, descendantRssKiB()); }, 250);
      const startedAt = Date.now();
      let stringSearchMs: number | null = null;
      let hexNavigationMs: number | null = null;
      await page.locator('input[type=file]').setInputFiles(path);
      await expect(page.getByRole('heading', { name: `fixture-${sizeLabel}.bin` })).toBeVisible();
      await expect(page.getByText('ANALYSIS COMPLETE', { exact: true })).toBeVisible({ timeout: 10 * 60 * 1000 });
      await expect(page.getByText(expectedHash, { exact: true })).toBeVisible();
      const filePaneLayout = await page.locator('.file-pane').evaluate((pane) => {
        const digest = pane.querySelector('.digest')?.getBoundingClientRect();
        const structure = pane.querySelector('.structure')?.getBoundingClientRect();
        return digest && structure ? { digestBottom: digest.bottom, structureTop: structure.top } : null;
      });
      expect(filePaneLayout, 'file identity and structure sections are present').not.toBeNull();
      expect(filePaneLayout!.digestBottom).toBeLessThanOrEqual(filePaneLayout!.structureTop + 1);
      const elapsedMs = Date.now() - startedAt;
      const responsiveness = await page.evaluate(() => {
        const metrics = (window as typeof window & { __spectrePerf?: { frames: number; maxFrameGap: number; peakHeap: number } }).__spectrePerf;
        return metrics ?? { frames: 0, maxFrameGap: -1, peakHeap: 0 };
      });
      const downloadPromise = page.waitForEvent('download');
      await page.getByRole('button', { name: 'JSON', exact: true }).click();
      const download = await downloadPromise;
      const stream = await download.createReadStream();
      let reportText = '';
      for await (const part of stream) reportText += part.toString();
      const analysisMetrics = JSON.parse(reportText).detectedFacts.analysisMetrics as {
        durationMs: number; eventCount: number; eventsPerSecond: number; chunkSize: number;
      };
      if (sizeLabel === '10MiB') {
        const strings = page.getByRole('searchbox', { name: 'Filter strings' });
        const searchStartedAt = Date.now();
        await strings.fill('STRING-INDEX-ENTRY-0000000000400000');
        await expect(page.locator('.string-row').first()).toContainText('STRING-INDEX-ENTRY-0000000000400000', { timeout: 60_000 });
        stringSearchMs = Date.now() - searchStartedAt;
        expect(await page.locator('.string-row').count()).toBeLessThanOrEqual(100);
      }
      if (sizeLabel === '1GiB') {
        const navigationStartedAt = Date.now();
        await page.getByRole('textbox', { name: 'Jump to hexadecimal offset' }).fill('3FFFFFFF');
        await page.getByRole('button', { name: 'Jump to offset' }).click();
        await expect(page.locator('.hex-address').filter({ hasText: '3FFFFFF0' })).toBeVisible({ timeout: 10_000 });
        hexNavigationMs = Date.now() - navigationStartedAt;
      }
      if (memorySampler) clearInterval(memorySampler);
      memorySampler = undefined;
      const result = { sizeLabel, sizeBytes: size, mode: modeFor(sizeLabel), elapsedMs,
        baselineDescendantRssMiB: baselineDescendantRss / 1024,
        peakDescendantRssMiB: peakDescendantRss / 1024,
        rssGrowthMiB: Math.max(0, peakDescendantRss - baselineDescendantRss) / 1024,
        analysisMetrics, stringSearchMs, hexNavigationMs, ...responsiveness };
      console.info('SPECTRE_PERF_RESULT=' + JSON.stringify(result));
      await testInfo.attach('large-file-performance.json', {
        body: JSON.stringify(result, null, 2),
        contentType: 'application/json',
      });
      expect(responsiveness.frames).toBeGreaterThan(10);
      expect(responsiveness.maxFrameGap).toBeLessThan(2_000);
    } finally {
      if (memorySampler) clearInterval(memorySampler);
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test('profiles cancellation latency during a 128 MiB analysis', async ({ page }, testInfo) => {
  const size = 128 * MiB;
  const directory = await mkdtemp(join(tmpdir(), 'spectre-cancel-'));
  const path = join(directory, 'cancellation-128MiB.bin');
  try {
    await makeFixture(path, size, 'high-entropy');
    await page.goto('/');
    await page.getByRole('button', { name: '[1] BLACKBOX' }).click();
    await expect(page.getByText('No file loaded.', { exact: true })).toBeVisible();
    await page.locator('input[type=file]').setInputFiles(path);
    const cancel = page.getByRole('button', { name: 'Cancel analysis' });
    await expect(cancel).toBeEnabled();
    const startedAt = await cancel.evaluate((button) => {
      const now = performance.now();
      (button as HTMLButtonElement).click();
      return now;
    });
    await expect(page.getByText('ANALYSIS CANCELLED', { exact: true })).toBeVisible();
    const cancellationLatencyMs = await page.evaluate((start) => performance.now() - start, startedAt);
    console.info('SPECTRE_CANCEL_RESULT=' + JSON.stringify({ sizeBytes: size, cancellationLatencyMs }));
    await testInfo.attach('cancellation-performance.json', {
      body: JSON.stringify({ sizeBytes: size, cancellationLatencyMs }, null, 2), contentType: 'application/json',
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
