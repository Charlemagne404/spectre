import { access, copyFile, mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from '@playwright/test';

const root = process.cwd();
const output = resolve(root, process.env.SPECTRE_EVIDENCE_DIR ?? 'output/development-mission-3');
const temporary = await mkdtemp(join(tmpdir(), 'spectre-mission-3-'));
const viewports = [
  { width: 1920, height: 1080 }, { width: 1440, height: 900 }, { width: 1280, height: 800 },
  { width: 1024, height: 768 }, { width: 740, height: 580 },
];
await mkdir(output, { recursive: true });

async function ensureNew(path) {
  try {
    await access(path);
    throw new Error(`Refusing to replace existing evidence: ${path}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Refusing')) throw error;
  }
}

async function screenshot(page, filename) {
  const destination = join(output, filename);
  await ensureNew(destination);
  await page.screenshot({ path: destination, fullPage: false });
  return destination;
}

async function enter(page) {
  await page.goto('http://127.0.0.1:1420');
  await page.getByRole('button', { name: '[1] BLACKBOX' }).waitFor({ timeout: 20_000 });
  await page.getByRole('button', { name: '[1] BLACKBOX' }).click();
  await page.getByText('No file loaded.', { exact: true }).waitFor();
}

async function loadSample(page) {
  await page.getByRole('button', { name: 'Sample', exact: true }).click();
  await page.getByRole('heading', { name: 'relay_07.wav' }).waitFor();
  await page.getByText('ANALYSIS COMPLETE', { exact: true }).waitFor({ timeout: 20_000 });
}

async function createCase(page, name) {
  await page.getByRole('button', { name: 'Investigation' }).click();
  await page.getByRole('textbox', { name: 'New investigation name' }).fill(name);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByText('IN SESSION', { exact: true }).waitFor();
  if (await page.getByRole('complementary', { name: 'Investigation workspace' }).count()) {
    await page.getByRole('complementary', { name: 'Investigation workspace' }).getByText('relay_07.wav', { exact: true }).waitFor();
  }
}

async function mutatedSample(page) {
  const bytes = await page.evaluate(async () => {
    const module = await import('/src/blackbox/fixture.ts');
    const file = module.demonstrationFile();
    return Array.from(new Uint8Array(await file.arrayBuffer()));
  });
  const fixture = Buffer.from(bytes);
  fixture[4096] ^= 0x01;
  return { name: 'relay_07-modified.wav', mimeType: 'audio/wav', buffer: fixture };
}

const browser = await chromium.launch({ headless: true });

async function video(filename, action) {
  const destination = join(output, filename);
  await ensureNew(destination);
  const videoDirectory = join(temporary, filename.replace(/\.webm$/, ''));
  await mkdir(videoDirectory, { recursive: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: { dir: videoDirectory, size: { width: 1440, height: 900 } },
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const recording = page.video();
  try {
    await enter(page);
    await action(page);
    if (errors.length) throw new Error(errors.join('\n'));
  } finally {
    await context.close();
  }
  if (!recording) throw new Error('Chromium did not create a video recording.');
  await copyFile(await recording.path(), destination);
  await recording.delete();
  return destination;
}

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (error) => { throw error; });
  await page.goto('http://127.0.0.1:1420');
  await page.getByRole('button', { name: '[1] BLACKBOX' }).waitFor({ timeout: 20_000 });
  await screenshot(page, 'launcher-1440x900.png');
  await page.getByRole('button', { name: '[1] BLACKBOX' }).click();
  await page.getByText('No file loaded.', { exact: true }).waitFor();
  await screenshot(page, 'empty-workspace-1440x900.png');

  const progressPath = join(temporary, 'analysis-progress.bin');
  const progressFile = await open(progressPath, 'w');
  const block = Buffer.alloc(1024 * 1024, 0x41);
  for (let index = 0; index < 64; index++) await progressFile.write(block);
  await progressFile.close();
  await page.locator('input[aria-label="Choose a local file"]').setInputFiles(progressPath);
  await page.waitForFunction(() => {
    const progress = document.querySelector('.analysis-status progress');
    return progress && progress.value > 0 && progress.value < progress.max;
  }, undefined, { timeout: 10_000 });
  await screenshot(page, 'analysis-progress-1440x900.png');
  await page.getByText('ANALYSIS COMPLETE', { exact: true }).waitFor({ timeout: 30_000 });

  await loadSample(page);
  await page.evaluate(() => document.fonts.ready);
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(100);
    await screenshot(page, `completed-${viewport.width}x${viewport.height}.png`);
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  const bytes = page.getByRole('region', { name: /Hex bytes/ });
  await bytes.focus();
  for (let index = 0; index < 3; index++) await page.keyboard.press('Shift+ArrowRight');
  await page.getByRole('combobox', { name: 'Data interpretation' }).selectOption('U32');
  await screenshot(page, 'data-inspector-1440x900.png');
  const parserFindings = page.locator('.parser-findings');
  if (await parserFindings.count()) {
    await parserFindings.locator('summary').click();
    await parserFindings.scrollIntoViewIfNeeded();
  }
  await screenshot(page, 'structure-analysis-1440x900.png');

  await createCase(page, 'Mission III visual evidence');
  await screenshot(page, 'investigation-navigation-1440x900.png');
  await page.getByRole('button', { name: 'Close investigation panel' }).click();
  await page.getByRole('button', { name: 'LIST', exact: true }).click();
  await page.getByRole('button', { name: 'Bookmark', exact: true }).click();
  await page.getByRole('textbox', { name: 'Bookmark label' }).fill('Reference metadata');
  await page.getByRole('textbox', { name: 'Bookmark note' }).fill('Review the reference capture metadata at the selected byte range.');
  await page.getByRole('button', { name: 'Save bookmark' }).click();
  await page.locator('.investigation-file > summary').click();
  await screenshot(page, 'bookmarks-1440x900.png');

  const videos = [];
  videos.push(await video('advanced-hex-inspection.webm', async (recordingPage) => {
    await loadSample(recordingPage);
    const search = recordingPage.getByRole('textbox', { name: 'Search bytes (hexadecimal)' });
    await search.fill('53 70 65 63 74 72 65');
    await recordingPage.getByRole('button', { name: 'Find next byte sequence' }).click();
    await recordingPage.getByText(/Match 0x[\dA-F]+ · 7 bytes/).waitFor();
    await recordingPage.getByRole('combobox', { name: 'Data interpretation' }).selectOption('U32');
    await recordingPage.getByRole('button', { name: 'Find previous match' }).click();
    await recordingPage.getByText(/Match 0x[\dA-F]+ · 7 bytes/).waitFor();
  }));
  videos.push(await video('investigation-bookmarks.webm', async (recordingPage) => {
    await loadSample(recordingPage);
    await createCase(recordingPage, 'Audio evidence / session 01');
    await recordingPage.getByRole('button', { name: 'Close investigation panel' }).click();
    await recordingPage.getByRole('button', { name: 'LIST', exact: true }).click();
    await recordingPage.getByRole('button', { name: 'Bookmark', exact: true }).click();
    await recordingPage.getByRole('textbox', { name: 'Bookmark label' }).fill('Metadata block');
    await recordingPage.getByRole('textbox', { name: 'Bookmark note' }).fill('Inspect the embedded INFO metadata.');
    await recordingPage.getByRole('button', { name: 'Save bookmark' }).click();
    await recordingPage.locator('.investigation-file > summary').click();
    await recordingPage.locator('.investigation-bookmark > summary').click();
    await recordingPage.getByRole('button', { name: 'Navigate to bytes' }).click();
    await recordingPage.locator('.hex-selection').waitFor();
  }));
  videos.push(await video('binary-comparison.webm', async (recordingPage) => {
    await loadSample(recordingPage);
    await createCase(recordingPage, 'Comparison / source revision');
    await recordingPage.getByRole('button', { name: 'Close investigation panel' }).click();
    const second = await mutatedSample(recordingPage);
    await recordingPage.getByRole('button', { name: 'Compare', exact: true }).click();
    await recordingPage.locator('input[aria-label="Select comparison file"]').setInputFiles(second);
    await recordingPage.getByText('1 differing byte offsets found.', { exact: true }).waitFor({ timeout: 20_000 });
    await recordingPage.getByRole('button', { name: 'Next difference' }).click();
    await recordingPage.getByRole('button', { name: 'Bookmark difference on A' }).click();
    await recordingPage.getByRole('textbox', { name: 'Bookmark label' }).fill('Changed sample byte');
    await recordingPage.getByRole('button', { name: 'Save bookmark' }).click();
  }));
  videos.push(await video('structural-file-analysis.webm', async (recordingPage) => {
    await loadSample(recordingPage);
    await recordingPage.locator('.parser-findings summary').click();
    await recordingPage.getByRole('button', { name: 'LIST', exact: true }).click();
    await recordingPage.locator('.hex-structure-context').waitFor();
  }));

  const comparePage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await enter(comparePage);
  await loadSample(comparePage);
  await createCase(comparePage, 'Comparison screen capture');
  await comparePage.getByRole('button', { name: 'Close investigation panel' }).click();
  const alternate = await mutatedSample(comparePage);
  await comparePage.getByRole('button', { name: 'Compare', exact: true }).click();
  await comparePage.locator('input[aria-label="Select comparison file"]').setInputFiles(alternate);
  await comparePage.getByText('1 differing byte offsets found.', { exact: true }).waitFor({ timeout: 20_000 });
  await screenshot(comparePage, 'binary-comparison-1440x900.png');

  await page.close();
  await comparePage.close();
  console.log(`Evidence saved under ${output}`);
  for (const filename of [
    'launcher-1440x900.png', 'empty-workspace-1440x900.png', 'analysis-progress-1440x900.png',
    ...viewports.map((viewport) => `completed-${viewport.width}x${viewport.height}.png`),
    'data-inspector-1440x900.png', 'structure-analysis-1440x900.png', 'investigation-navigation-1440x900.png',
    'bookmarks-1440x900.png', 'binary-comparison-1440x900.png',
  ]) console.log(join(output, filename));
  for (const path of videos) console.log(path);
} finally {
  await browser.close();
  await rm(temporary, { recursive: true, force: true });
}
