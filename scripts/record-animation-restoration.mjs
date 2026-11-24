import { access, copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const root = process.cwd();
const output = resolve(root, 'output/animation-restoration');
const temporary = await mkdtemp(join(tmpdir(), 'spectre-animation-restoration-'));
await mkdir(output, { recursive: true });
let server;
let browser;

async function startServer() {
  server = spawn(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '1420', '--strictPort'], {
    cwd: root,
    stdio: 'inherit',
  });
  for (let attempt = 0; attempt < 120; attempt++) {
    if (server.exitCode !== null) throw new Error(`Vite exited before becoming ready (code ${server.exitCode}).`);
    try {
      const response = await fetch('http://127.0.0.1:1420/');
      if (response.ok) return;
    } catch { /* Vite is still binding its local test port. */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Vite did not become ready on 127.0.0.1:1420.');
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const stopped = new Promise((resolve) => server.once('exit', resolve));
  server.kill('SIGTERM');
  let timeout;
  await Promise.race([stopped, new Promise((resolve) => { timeout = setTimeout(resolve, 2_000); })]);
  if (timeout) clearTimeout(timeout);
}

async function ensureNew(path) {
  try {
    await access(path);
    throw new Error(`Refusing to replace existing recording: ${path}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Refusing')) throw error;
  }
}

async function attachBootCounter(page) {
  await page.addInitScript(() => {
    window.__bootLinePeak = 0;
    new MutationObserver(() => {
      window.__bootLinePeak = Math.max(window.__bootLinePeak, document.querySelectorAll('.boot-log-line').length);
    }).observe(document, { childList: true, subtree: true });
  });
}

async function enterLauncher(page) {
  await page.goto('http://127.0.0.1:1420');
  await page.getByRole('button', { name: '[1] BLACKBOX' }).waitFor({ timeout: 15_000 });
  await page.waitForFunction(() => {
    const button = document.querySelector('.launcher-module');
    return button instanceof HTMLButtonElement && !button.disabled;
  }, undefined, { timeout: 15_000 });
}

async function record(browser, name, action) {
  const destination = join(output, name);
  const videoDirectory = join(temporary, name.replace(/\.webm$/, ''));
  await ensureNew(destination);
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
    await action(page);
    if (errors.length) throw new Error(errors.join('\n'));
  } finally {
    await context.close();
  }
  if (!video) throw new Error('Chromium did not create a recording.');
  await copyFile(await video.path(), destination);
  await video.delete();
  return destination;
}

try {
  await startServer();
  browser = await chromium.launch({ headless: true });
  const boot = await record(browser, 'boot-sequence.webm', async (page) => {
    await attachBootCounter(page);
    await enterLauncher(page);
    const peak = await page.evaluate(() => window.__bootLinePeak);
    if (peak !== 70) throw new Error(`Expected 70 boot lines, observed ${peak}.`);
    await page.waitForTimeout(200);
  });

  const ignition = await record(browser, 'blackbox-ignition.webm', async (page) => {
    await enterLauncher(page);
    await page.getByRole('button', { name: '[1] BLACKBOX' }).click();
    await page.locator('.workspace.igniting').waitFor();
    await page.waitForFunction(() => !document.querySelector('.workspace')?.classList.contains('igniting'), undefined, { timeout: 5_000 });
    await page.waitForTimeout(200);
  });

  const analysis = await record(browser, 'progressive-analysis.webm', async (page) => {
    await enterLauncher(page);
    await page.getByRole('button', { name: '[1] BLACKBOX' }).click();
    await page.waitForFunction(() => !document.querySelector('.workspace')?.classList.contains('igniting'), undefined, { timeout: 5_000 });
    await page.getByRole('button', { name: 'Sample', exact: true }).click();
    await page.getByText('REVEALING FINDINGS', { exact: true }).waitFor({ timeout: 10_000 });
    const snapshots = await page.evaluate(async () => {
      const observed = [];
      const start = performance.now();
      while (performance.now() - start < 3_000) {
        observed.push({
          regions: document.querySelectorAll('.region-fill').length,
          strings: document.querySelectorAll('.string-row').length,
          hexRows: document.querySelectorAll('.hex-row').length,
          histogramBars: document.querySelectorAll('.histogram-bar').length,
        });
        if (document.querySelector('.analysis-readout')?.textContent?.includes('ANALYSIS COMPLETE')) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return observed;
    });
    const signatures = new Set(snapshots.map((item) => Object.values(item).join(':')));
    if (signatures.size < 2) throw new Error('Analysis findings did not change progressively during the recording.');
    await page.getByText('ANALYSIS COMPLETE', { exact: true }).waitFor({ timeout: 5_000 });
    await page.waitForTimeout(250);
  });

  console.log(`Recorded ${boot}`);
  console.log(`Recorded ${ignition}`);
  console.log(`Recorded ${analysis}`);
} finally {
  if (browser) await browser.close();
  await stopServer();
  await rm(temporary, { recursive: true, force: true });
}
