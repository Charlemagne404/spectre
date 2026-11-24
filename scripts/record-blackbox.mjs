import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const root = process.cwd();
const output = resolve(root, 'output/playwright');
const fileBytes = await readFile(resolve(root, 'README.md'));
const temporary = await mkdtemp(join(tmpdir(), 'spectre-recordings-'));
await mkdir(output, { recursive: true });

async function assertNewPath(path) {
  try {
    await access(path);
    throw new Error(`Refusing to replace existing recording: ${path}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Refusing')) throw error;
  }
}

async function dropSource(page) {
  await page.evaluate(async ({ encoded, name }) => {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    const file = new File([bytes], name, { type: 'text/plain' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const target = document.querySelector('.application');
    if (!target) throw new Error('BLACKBOX intake surface was not found.');
    window.__spectreDemoTransfer = transfer;
    target.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, { encoded: fileBytes.toString('base64'), name: 'README.md' });
  await page.waitForTimeout(280);
  await page.evaluate(() => {
    const target = document.querySelector('.application');
    const transfer = window.__spectreDemoTransfer;
    if (!target || !transfer) throw new Error('The incoming file was not retained for drop.');
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    delete window.__spectreDemoTransfer;
  });
}

async function enterBlackbox(page) {
  await page.goto('http://127.0.0.1:1420');
  await page.getByRole('button', { name: '[1] BLACKBOX' }).waitFor({ timeout: 20_000 });
  await page.getByRole('button', { name: '[1] BLACKBOX' }).click();
  await page.getByText('No file loaded.', { exact: true }).waitFor();
}

async function record(name, run) {
  const destination = join(output, name);
  const videoDirectory = join(temporary, name.replace(/\.webm$/, ''));
  await assertNewPath(destination);
  await mkdir(videoDirectory, { recursive: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: { dir: videoDirectory, size: { width: 1440, height: 900 } },
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const video = page.video();
  try {
    await enterBlackbox(page);
    await dropSource(page);
    await page.getByRole('heading', { name: 'README.md' }).waitFor();
    await page.getByText('ANALYSIS COMPLETE').waitFor({ timeout: 30_000 });
    const digest = createHash('sha256').update(fileBytes).digest('hex');
    await page.getByText(digest, { exact: true }).waitFor();
    await run(page);
    if (errors.length) throw new Error(errors.join('\n'));
  } finally {
    await context.close();
  }
  if (!video) throw new Error('The browser did not create a recording.');
  await copyFile(await video.path(), destination);
  await video.delete();
  return destination;
}

const browser = await chromium.launch({ headless: true });
try {
  const analysis = await record('blackbox-analysis.webm', async (page) => {
    await page.waitForSelector('.structure-map .region-fill');
    const screenshot = join(output, 'blackbox-analysis.png');
    await assertNewPath(screenshot);
    await page.screenshot({ path: screenshot });
  });
  const inspection = await record('blackbox-inspection.webm', async (page) => {
    const strings = page.getByRole('searchbox', { name: 'Filter strings' });
    await strings.fill('Spectre is a local-first desktop file inspection tool');
    await page.locator('.string-row').first().click();
    const selectedString = await page.locator('.hex-selection').innerText();
    if (!selectedString.includes('bytes')) throw new Error('Selecting a string did not update the hex range.');

    const bytes = page.getByRole('textbox', { name: 'Search bytes (hexadecimal)' });
    await bytes.fill('53 70 65 63 74 72 65');
    await page.getByRole('button', { name: 'Find byte sequence' }).click();
    await page.getByText('7 bytes', { exact: false }).waitFor();

    const graph = page.locator('.plot-hitbox');
    const bounds = await graph.boundingBox();
    if (!bounds) throw new Error('Entropy plot is unavailable.');
    await page.mouse.click(bounds.x + bounds.width * 0.72, bounds.y + bounds.height / 2);
    const plotted = await graph.getAttribute('aria-valuetext');
    const plotOffset = plotted?.match(/0x[\dA-F]+/)?.[0];
    if (!plotOffset) throw new Error('Entropy selection did not resolve to a file offset.');
    if (!(await page.locator('.hex-selection').innerText()).includes(plotOffset)) throw new Error('Entropy selection did not navigate the hex inspector.');

    await page.getByRole('button', { name: 'Unparsed bytes 01', exact: true }).click();
    await page.locator('.strings-footer').getByText('STRUCTURE REGION').waitFor();
    const screenshot = join(output, 'blackbox-inspection.png');
    await assertNewPath(screenshot);
    await page.screenshot({ path: screenshot });
  });
  console.log(`Recorded ${analysis}`);
  console.log(`Recorded ${inspection}`);
  console.log(`Source: README.md (${fileBytes.length.toLocaleString('en')} bytes, SHA-256 ${createHash('sha256').update(fileBytes).digest('hex')})`);
} finally {
  await browser.close();
  await rm(temporary, { recursive: true, force: true });
}
