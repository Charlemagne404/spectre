import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function openWorkspace(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '[1] BLACKBOX' }).click();
  await expect(page.getByText('No file loaded.', { exact: true })).toBeVisible();
}

async function launch(page: Page) {
  await openWorkspace(page);
  await page.getByRole('button', { name: 'Sample', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'relay_07.wav' })).toBeVisible();
}

test('keyboard launcher and motion cancellation', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Escape');
  const module = page.getByRole('button', { name: '[1] BLACKBOX' });
  await expect(module).toBeFocused();
  await page.keyboard.press('1');
  await expect(page.locator('.workspace')).toHaveClass(/igniting/);
  await expect(page.locator('.workspace')).not.toHaveClass(/igniting/);
  await expect(page.getByText('No file loaded.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sample', exact: true }).click();
  await expect(page.getByText('Sample file')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(module).toBeFocused();
});

test('boot log records mounted readiness states instead of simulated work', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.boot-log-line').first()).toContainText('Spectre renderer mounted');
  await expect(page.locator('.boot-log-lines')).toContainText('Analysis worker: available on demand');
  await expect(page.locator('.boot-log-lines')).toContainText('First render frame delivered');
  await expect(page.locator('.boot-log-lines')).toContainText('SPECTRE surface ready');
  const lines = page.locator('.boot-log-line');
  await expect(lines).toHaveCount(8);
  await expect(page.locator('.boot-log-lines')).not.toContainText('Allocating byte-frequency bins');
});

test('file intake remains usable while the workspace activation runs', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '[1] BLACKBOX' }).click();
  await expect(page.locator('.workspace')).toHaveClass(/igniting/);
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open file', exact: true }).click();
  await (await chooser).setFiles({ name: 'activation.txt', mimeType: 'text/plain', buffer: Buffer.from('opened during activation') });
  await expect(page.getByRole('heading', { name: 'activation.txt' })).toBeVisible();
  await expect(page.getByText('ANALYSIS COMPLETE', { exact: true })).toBeVisible({ timeout: 5_000 });
});

test('creates a local investigation, bookmarks a structure, and reopens it after reload', async ({ page }) => {
  await launch(page);
  const sourceDigest = await page.locator('.digest code').innerText();
  await page.getByRole('button', { name: 'Investigation' }).click();
  await page.getByRole('textbox', { name: 'New investigation name' }).fill('Acquisition A');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Acquisition A' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Investigation workspace' }).getByText('relay_07.wav', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Investigation name', exact: true }).fill('Acquisition A / intake');
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Acquisition A / intake' })).toBeVisible();
  await page.getByRole('button', { name: 'Close investigation panel' }).click();

  await page.getByRole('button', { name: 'LIST', exact: true }).click();
  await page.getByRole('button', { name: 'Bookmark', exact: true }).click();
  await page.getByRole('textbox', { name: 'Bookmark label' }).fill('LIST metadata block');
  await page.getByRole('textbox', { name: 'Bookmark note' }).fill('Review the embedded reference marker.');
  await page.getByRole('button', { name: 'Save bookmark' }).click();
  await page.locator('.investigation-file > summary').click();
  await page.locator('.investigation-bookmark > summary').filter({ hasText: 'LIST metadata block' }).click();
  await expect(page.getByText('LIST metadata block', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Navigate to bytes' }).click();
  await expect(page.locator('.hex-selection')).toContainText('0x00000024');

  await page.reload();
  await openWorkspace(page);
  await page.getByRole('button', { name: 'Investigation' }).click();
  await page.getByRole('combobox', { name: 'Open investigation' }).selectOption({ label: 'Acquisition A / intake · 1 file' });
  await page.locator('.investigation-file > summary').click();
  await page.locator('.investigation-bookmark > summary').filter({ hasText: 'LIST metadata block' }).click();
  await expect(page.locator('.investigation-file')).toContainText('SOURCE NEEDED');
  await expect(page.getByRole('button', { name: 'Choose matching source first' })).toBeDisabled();
  await page.getByRole('button', { name: 'Close investigation panel' }).click();

  await page.locator('input[aria-label="Choose a local file"]').setInputFiles({
    name: 'relay_07.wav', mimeType: 'audio/wav', buffer: Buffer.from('different file with the same filename'),
  });
  await expect(page.getByText('ANALYSIS COMPLETE', { exact: true })).toBeVisible({ timeout: 5_000 });
  await page.locator('.investigation-toggle').click();
  const originalRecord = page.locator('.investigation-file').filter({ hasText: 'SOURCE NEEDED' }).first();
  await originalRecord.locator('> summary').click();
  await originalRecord.locator('.investigation-bookmark > summary').filter({ hasText: 'LIST metadata block' }).click();
  await expect(originalRecord.getByRole('button', { name: 'Choose matching source first' })).toBeDisabled();

  await page.getByRole('button', { name: 'Sample', exact: true }).click();
  await expect(page.locator('.digest code')).toHaveText(sourceDigest, { timeout: 10_000 });
  const matchedRecord = page.locator('.investigation-file').filter({ hasText: 'IN SESSION' }).first();
  if (!(await matchedRecord.evaluate((element) => (element as HTMLDetailsElement).open))) await matchedRecord.locator('> summary').click();
  const matchedBookmark = matchedRecord.locator('.investigation-bookmark').filter({ hasText: 'LIST metadata block' }).first();
  if (!(await matchedBookmark.evaluate((element) => (element as HTMLDetailsElement).open))) await matchedBookmark.locator('> summary').click();
  await expect(page.getByText('LIST metadata block', { exact: true })).toBeVisible();
  await matchedRecord.getByRole('button', { name: 'Navigate to bytes' }).click();
  await expect(page.locator('.hex-selection')).toContainText('0x00000024');
});

test('deletes a local investigation without affecting the current file', async ({ page }) => {
  await launch(page);
  await page.getByRole('button', { name: 'Investigation' }).click();
  await page.getByRole('textbox', { name: 'New investigation name' }).fill('Temporary record');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Investigation', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Open investigation' })).not.toContainText('Temporary record');
  await expect(page.getByRole('heading', { name: 'relay_07.wav' })).toBeVisible();
});

test('compares files by actual offset-aligned bytes with navigable differences', async ({ page }) => {
  await openWorkspace(page);
  const firstBytes = Buffer.from([1, 2, 3, 4]);
  await page.locator('input[aria-label="Choose a local file"]').setInputFiles({ name: 'first.bin', mimeType: 'application/octet-stream', buffer: firstBytes });
  await expect(page.getByText('ANALYSIS COMPLETE', { exact: true })).toBeVisible({ timeout: 5_000 });
  await page.getByRole('button', { name: 'Investigation' }).click();
  await page.getByRole('textbox', { name: 'New investigation name' }).fill('Compare case');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByText('IN SESSION', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close investigation panel' }).click();
  await page.getByRole('button', { name: 'Compare', exact: true }).click();
  await page.locator('input[aria-label="Select comparison file"]').setInputFiles({ name: 'second.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([1, 9, 3, 4, 5]) });
  await expect(page.getByText('2 differing byte offsets found.', { exact: true })).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText('OFFSET-ALIGNED', { exact: true })).toBeVisible();
  await expect(page.getByText(/Insertions and deletions shift later offsets/)).toBeVisible();
  await expect(page.locator('.comparison-difference-rows button')).toHaveCount(2);
  await page.getByRole('button', { name: 'Next difference' }).click();
  await expect(page.getByText('2 / 2 retained ranges')).toBeVisible();
  await page.getByRole('button', { name: 'Bookmark difference on A' }).click();
  await page.getByRole('textbox', { name: 'Bookmark label' }).fill('Appended byte');
  await page.getByRole('button', { name: 'Save bookmark' }).click();
  await expect(page.locator('.investigation-comparisons')).toContainText('1');
  await page.getByRole('button', { name: 'Close investigation panel' }).click();
  const reportWait = page.waitForEvent('download');
  await page.getByRole('button', { name: 'JSON' }).click();
  const reportDownload = await reportWait;
  const reportPath = await reportDownload.path();
  if (!reportPath) throw new Error('Investigation report was not saved.');
  const report = JSON.parse(await readFile(reportPath, 'utf8')) as { investigation: { comparisons: unknown[]; bookmarks: Array<{ label: string; kind: string }> } };
  expect(report.investigation.comparisons).toHaveLength(1);
  expect(report.investigation.bookmarks).toContainEqual(expect.objectContaining({ label: 'Appended byte', kind: 'difference' }));
  await expect(page.getByRole('heading', { name: 'first.bin' })).toBeVisible();
});

test('scans for an embedded PNG, validates its chunk bounds, and links its bytes', async ({ page }) => {
  await openWorkspace(page);
  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...new Array(13).fill(0), 0, 0, 0, 0,
    0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0, 0, 0, 0,
  ]);
  const fixture = Buffer.concat([Buffer.from('container prefix'), png]);
  await page.locator('input[aria-label="Choose a local file"]').setInputFiles({ name: 'container.bin', mimeType: 'application/octet-stream', buffer: fixture });
  await expect(page.getByText('ANALYSIS COMPLETE', { exact: true })).toBeVisible({ timeout: 5_000 });
  await page.locator('.embedded-signatures > summary').click();
  await page.getByRole('button', { name: 'Scan file', exact: true }).click();
  const finding = page.locator('.embedded-signature-list button');
  await expect(finding).toContainText('PNG');
  await expect(finding).toContainText('COMPLETE');
  await finding.click();
  await expect(page.locator('.hex-selection')).toContainText('0x00000010');
  await expect(page.locator('.hex-selection')).toContainText(`${png.length} bytes`);
});

test('reveals small-file findings progressively after real analysis completes', async ({ page }) => {
  await openWorkspace(page);
  const payload = Buffer.from('small file, fully analyzed');
  const started = Date.now();
  await page.locator('input[type=file]').setInputFiles({ name: 'quick.txt', mimeType: 'text/plain', buffer: payload });
  await expect(page.getByText('REVEALING FINDINGS', { exact: true })).toBeVisible();
  await expect(page.getByRole('progressbar')).toHaveAttribute('value', String(payload.length));
  await expect(page.getByText('ANALYSIS COMPLETE', { exact: true })).toBeVisible({ timeout: 5_000 });
  const presentationTime = Date.now() - started;
  expect(presentationTime).toBeGreaterThanOrEqual(1_800);
  expect(presentationTime).toBeLessThan(3_000);
});

test.describe('inspection with reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('keeps all panes intentional and empty until the sample is requested', async ({ page }) => {
    await openWorkspace(page);
    await expect(page.locator('.workspace')).not.toHaveClass(/igniting/);
    await expect(page.getByText('No file loaded.', { exact: true })).toBeVisible();
    await expect(page.getByText('No measurements.', { exact: true })).toHaveCount(2);
    await expect(page.getByText('No extracted strings.', { exact: true })).toBeVisible();
    await expect(page.getByText('No file selected.', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'relay_07.wav' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Sample', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'relay_07.wav' })).toBeVisible();
    await expect(page.getByText('Sample file')).toBeVisible();
  });

  test('interprets bytes as unsigned integers with explicit byte order', async ({ page }) => {
    await launch(page);
    const value = page.getByLabel('Interpreted binary data');
    const hex = page.getByRole('combobox', { name: 'Data interpretation' });
    const bytes = page.getByRole('region', { name: /Hex bytes/ });
    await bytes.focus();
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Shift+ArrowRight');
    await hex.selectOption('U32');
    await expect(value).toHaveText('1179011410');
    await page.getByRole('button', { name: 'Switch to big-endian' }).click();
    await expect(value).toHaveText('1380533830');
    await bytes.focus();
    for (let index = 0; index < 4; index++) await page.keyboard.press('Shift+ArrowRight');
    await hex.selectOption('U64');
    await expect(value).toHaveText('5929347650879684864');
    await hex.selectOption('U8');
    await expect(page.getByRole('button', { name: 'Switch to little-endian' })).toBeDisabled();
  });

  test('extends byte ranges and traverses navigation history', async ({ page }) => {
    await launch(page);
    const bytes = page.getByRole('region', { name: /Hex bytes/ });
    await bytes.focus();
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Shift+ArrowRight');
    await expect(page.locator('.hex-selection')).toContainText('0x00000000');
    await expect(page.locator('.hex-selection')).toContainText('3 bytes');
    await page.getByRole('button', { name: 'Previous byte selection' }).click();
    await expect(page.locator('.hex-selection')).toContainText('2 bytes');
    await page.getByRole('button', { name: 'Next byte selection' }).click();
    await expect(page.locator('.hex-selection')).toContainText('3 bytes');
    await bytes.focus();
    await page.keyboard.press('Control+End');
    const endOffset = (await page.locator('.hex-selection').innerText()).match(/0x[\dA-F]+/)?.[0];
    expect(endOffset).toBeTruthy();
    await page.keyboard.press('Control+Home');
    await expect(page.locator('.hex-selection')).toContainText('0x00000000');
  });

  test('links structure, entropy, strings, and hex bytes', async ({ page }) => {
    await launch(page);
    await page.getByRole('button', { name: 'LIST', exact: true }).click();
    await expect(page.locator('.hex-selection')).toContainText('0x00000024');
    await expect(page.locator('.hex-bytes .selected-byte').first()).toHaveText('4C');
    await expect(page.locator('.strings-footer')).toContainText('STRUCTURE REGION');
    await expect(page.getByRole('button', { name: /RELAY 07 \/ reference capture/ })).toBeVisible();
    const graph = page.getByRole('slider', { name: 'Entropy region' });
    await graph.focus();
    await page.keyboard.press('End');
    await expect(page.locator('.hex-selection')).not.toContainText('0x00000024');
    await expect(graph).toHaveAttribute('aria-valuenow', await graph.getAttribute('aria-valuemax') ?? '');
    const box = await graph.boundingBox();
    if (!box) throw new Error('Missing entropy plot');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.locator('.plot-tooltip')).toHaveText(/0x[\dA-F]+ · \d\.\d{2} bits\/B/);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    const selectedPoint = await graph.getAttribute('aria-valuetext') ?? '';
    const selectedOffset = selectedPoint.match(/0x[\dA-F]+/)?.[0];
    expect(selectedOffset).toBeTruthy();
    await expect(page.locator('.hex-selection')).toContainText(selectedOffset ?? 'impossible');

    await page.keyboard.press('Control+f');
    const search = page.getByRole('searchbox', { name: 'Filter strings' });
    await expect(search).toBeFocused();
    await search.fill('reference capture');
    await page.getByRole('button', { name: /RELAY 07 \/ reference capture/ }).click();
    await expect(page.locator('.hex-ascii .selected-byte').first()).toHaveText('R');

    const byteSearch = page.getByRole('textbox', { name: 'Search bytes (hexadecimal)' });
    await byteSearch.fill('53 70 65 63 74 72 65');
    await page.getByRole('button', { name: 'Find next byte sequence' }).click();
    await expect(page.locator('.hex-selection')).toContainText('7 bytes');
    await expect(page.locator('.hex-selection')).toContainText('· 53');

    const jump = page.getByRole('textbox', { name: 'Jump to hexadecimal offset' });
    await jump.fill('FFFFFFFFFF');
    await jump.press('Enter');
    await expect(page.getByRole('alert')).toHaveText('Enter a valid file offset');
    await jump.fill('1');
    await jump.press('Enter');
    await expect(page.locator('.hex-selection')).toContainText('0x00000001');
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.hex-selection')).toContainText('0x00000002');
    await expect(page.locator('.histogram-head')).toContainText('0x46');
    const frequency = page.getByRole('slider', { name: /Byte frequency/ });
    await frequency.focus();
    await frequency.press('End');
    await expect(page.locator('.histogram-head')).toContainText('0xFF');
    await page.getByRole('button', { name: 'Next hex page' }).click();
    await expect(page.locator('.hex-selection')).toContainText('0x00000400');

    const graphFrequency = page.getByRole('slider', { name: /Byte frequency/ });
    const histogramBox = await graphFrequency.boundingBox();
    if (!histogramBox) throw new Error('Missing byte histogram');
    await page.mouse.click(histogramBox.x + histogramBox.width * 0.322, histogramBox.y + histogramBox.height / 2);
    await expect(page.locator('.hex-selection')).toContainText('· 52');
    await expect(page.locator('.histogram-head')).toContainText('0x52');
    await expect(page.getByRole('button', { name: 'JSON' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'HTML' })).toBeVisible();
  });

  test('replaces the sample using the system-picker entry point', async ({ page }) => {
    await launch(page);
    const payload = Buffer.from('hello Spectre\nhello file\n');
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Open file', exact: true }).click();
    await (await chooser).setFiles({ name: 'real.txt', mimeType: 'text/plain', buffer: payload });
    await expect(page.getByRole('heading', { name: 'real.txt' })).toBeVisible();
    await expect(page.getByText('Sample file')).toHaveCount(0);
    await expect(page.getByText(createHash('sha256').update(payload).digest('hex'))).toBeVisible();
    await expect(page.getByRole('button', { name: /hello Spectre/ })).toBeVisible();
  });

  test('exports JSON and HTML reports from completed analysis facts', async ({ page }) => {
    await launch(page);
    const payload = Buffer.from('actual report payload\nwith a printable string');
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Open file', exact: true }).click();
    await (await chooser).setFiles({ name: 'report.txt', mimeType: 'text/plain', buffer: payload });
    await page.getByRole('button', { name: 'JSON' }).waitFor();

    const jsonWait = page.waitForEvent('download');
    await page.getByRole('button', { name: 'JSON' }).click();
    const jsonDownload = await jsonWait;
    expect(jsonDownload.suggestedFilename()).toBe('spectre-report-analysis.json');
    const jsonPath = await jsonDownload.path();
    if (!jsonPath) throw new Error('The JSON report was not saved.');
    const report = JSON.parse(await readFile(jsonPath, 'utf8')) as { detectedFacts: { sha256: string; fileName: string; byteFrequency: { total: number } } };
    expect(report.detectedFacts.fileName).toBe('report.txt');
    expect(report.detectedFacts.sha256).toBe(createHash('sha256').update(payload).digest('hex'));
    expect(report.detectedFacts.byteFrequency.total).toBe(payload.length);

    const htmlWait = page.waitForEvent('download');
    await page.getByRole('button', { name: 'HTML' }).click();
    const htmlDownload = await htmlWait;
    const htmlPath = await htmlDownload.path();
    if (!htmlPath) throw new Error('The HTML report was not saved.');
    const html = await readFile(htmlPath, 'utf8');
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('actual report payload');
    expect(html).toContain(report.detectedFacts.sha256);
  });

  test('accepts dropped files from the launcher, including empty files', async ({ page }) => {
    await page.goto('/');
    const transfer = await page.evaluateHandle(() => {
      const data = new DataTransfer();
      data.items.add(new File([], 'zero.bin'));
      return data;
    });
    await page.locator('.application').dispatchEvent('drop', { dataTransfer: transfer });
    await expect(page.getByRole('heading', { name: 'zero.bin' })).toBeVisible();
    await expect(page.getByText('This file contains no bytes.')).toBeVisible();
    await expect(page.getByRole('slider', { name: 'Entropy region' })).toHaveCount(0);
  });

  test('cancels active work and safely replaces the file immediately', async ({ page }) => {
    await launch(page);
    const directory = await mkdtemp(join(tmpdir(), 'spectre-cancel-'));
    const large = join(directory, 'cancel.bin');
    try {
      const handle = await open(large, 'w');
      try { await handle.truncate(96 * 1024 * 1024); } finally { await handle.close(); }
      await page.locator('input[type=file]').setInputFiles(large);
      await expect(page.getByRole('progressbar')).toBeVisible();
      await page.getByRole('button', { name: 'Cancel analysis' }).click();
      await expect(page.locator('.analysis-status')).toHaveClass(/analysis-cancelled/);
      const cancelledAt = await page.getByRole('progressbar').getAttribute('value');
      await page.waitForTimeout(120);
      await expect(page.getByRole('progressbar')).toHaveAttribute('value', cancelledAt ?? '');
      const payload = Buffer.from('replacement remains responsive');
      await page.locator('input[type=file]').setInputFiles({ name: 'replacement.txt', mimeType: 'text/plain', buffer: payload });
      await expect(page.getByRole('heading', { name: 'replacement.txt' })).toBeVisible();
      await expect(page.getByText(createHash('sha256').update(payload).digest('hex'))).toBeVisible();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('keeps the workspace interactive while hashing a 128 MiB file', async ({ page }) => {
    await launch(page);
    const directory = await mkdtemp(join(tmpdir(), 'spectre-test-'));
    const path = join(directory, 'large.bin');
    try {
      const file = await open(path, 'w');
      try {
        await file.truncate(128 * 1024 * 1024);
      } finally {
        await file.close();
      }
      await page.locator('input[type=file]').setInputFiles(path);
      await expect(page.getByRole('progressbar')).toBeVisible();
      await expect(page.locator('.analysis-readout > span').first()).toHaveText('HASHING + BYTE STATISTICS');
      await expect(page.getByRole('heading', { name: 'large.bin' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Cancel analysis' })).toBeEnabled();
      await expect(page.getByRole('searchbox')).toBeDisabled();
      await expect(page.getByRole('heading', { name: 'large.bin' })).toBeVisible({ timeout: 15_000 });
      const hash = createHash('sha256');
      const chunk = Buffer.alloc(1024 * 1024);
      for (let index = 0; index < 128; index++) hash.update(chunk);
      await expect(page.getByText(hash.digest('hex'), { exact: true })).toBeVisible({ timeout: 60_000 });
      await expect(page.getByRole('searchbox')).toBeEnabled({ timeout: 60_000 });
      await page.keyboard.press('Control+f');
      await expect(page.getByRole('searchbox')).toBeFocused();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  for (const [width, height] of [[1280, 800], [1440, 900], [1920, 1080]]) {
    test('keeps all panes in view at ' + width + ' × ' + height, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await launch(page);
      for (const selector of ['.file-pane', '.entropy-pane', '.strings-pane', '.hex-pane', '.histogram']) {
        const rect = await page.locator(selector).boundingBox();
        expect(rect).not.toBeNull();
        if (!rect) throw new Error(selector + ' is missing');
        expect(rect.x).toBeGreaterThanOrEqual(0);
        expect(rect.y).toBeGreaterThanOrEqual(0);
        expect(rect.x + rect.width).toBeLessThanOrEqual(width);
        expect(rect.y + rect.height).toBeLessThanOrEqual(height);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      expect(await page.locator('.hex-scroll').evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    });
  }

  for (const [width, height] of [[1024, 768], [740, 580]]) {
    test('adapts without horizontal overflow at ' + width + ' × ' + height, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await launch(page);
      const documentMetrics = await page.evaluate(() => ({
        width: document.documentElement.scrollWidth,
        layoutWidth: document.documentElement.clientWidth,
        viewportWidth: window.innerWidth,
        height: document.documentElement.scrollHeight,
        viewportHeight: document.documentElement.clientHeight,
      }));
      expect(documentMetrics.width).toBe(documentMetrics.layoutWidth);
      expect(documentMetrics.layoutWidth).toBeLessThanOrEqual(documentMetrics.viewportWidth);
      for (const selector of ['.file-pane', '.entropy-pane', '.strings-pane', '.hex-pane', '.histogram']) {
        const rect = await page.locator(selector).boundingBox();
        expect(rect, `${selector} exists at ${width} × ${height}`).not.toBeNull();
        if (!rect) throw new Error(selector + ' is missing');
        expect(rect.x).toBeGreaterThanOrEqual(0);
        expect(rect.x + rect.width).toBeLessThanOrEqual(width);
        expect(rect.y + rect.height).toBeLessThanOrEqual(documentMetrics.height);
      }
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await expect(page.locator('.strings-pane')).toBeInViewport();
      await expect(page.getByRole('button', { name: 'Open file', exact: true })).toBeAttached();
      expect(documentMetrics.height).toBeGreaterThanOrEqual(documentMetrics.viewportHeight);
    });
  }
});
