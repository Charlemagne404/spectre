import { spawn } from 'node:child_process';
import { mkdir, rename } from 'node:fs/promises';
import { once } from 'node:events';
import { chromium } from '@playwright/test';

const baseUrl = 'http://127.0.0.1:1420';
const output = 'output/recon-evidence';
const server = spawn('npm', ['run', 'dev'], { stdio: 'ignore' });
let browser;

try {
  await mkdir(output, { recursive: true });
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (server.exitCode !== null) throw new Error(`Vite exited with code ${server.exitCode}.`);
    try {
      const response = await fetch(baseUrl);
      if (response.ok) { ready = true; break; }
    } catch { /* The local server may still be starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error('Vite did not become available at 127.0.0.1:1420.');

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto(baseUrl);
  await page.screenshot({ path: `${output}/launcher-1920x1080.png` });
  await page.getByRole('button', { name: '[2] RECON' }).click();
  await page.screenshot({ path: `${output}/recon-empty-1920x1080.png` });
  await page.getByRole('button', { name: 'OPEN DETERMINISTIC FIXTURE' }).click();
  await page.locator('.recon-graph-region canvas').waitFor();
  await page.screenshot({ path: `${output}/recon-1920x1080-graph.png` });
  await page.getByText('ENTITY INDEX').click();
  await page.getByRole('listbox', { name: 'Graph entities' }).getByRole('option', { name: /status\.example\.com/ }).click();
  await page.screenshot({ path: `${output}/recon-selected-entity-1920x1080.png` });
  await page.getByRole('listbox', { name: 'Graph relationships' }).getByRole('option').filter({ hasText: 'announced by' }).click();
  await page.screenshot({ path: `${output}/recon-selected-relationship-1920x1080.png` });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('tab', { name: 'EVIDENCE' }).click();
  await page.screenshot({ path: `${output}/recon-1440x900-evidence.png`, animations: 'disabled' });
  await page.getByRole('tab', { name: 'TIMELINE' }).click();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({ path: `${output}/recon-1280x800-timeline.png`, animations: 'disabled' });

  await page.getByRole('tab', { name: 'GRAPH' }).click();
  for (const [width, height] of [[1024, 768], [740, 580]]) {
    await page.setViewportSize({ width, height });
    await page.getByRole('button', { name: 'REFIT' }).click();
    await page.screenshot({ path: `${output}/recon-${width}x${height}-graph.png`, animations: 'disabled' });
    if (width === 740) await page.screenshot({ path: `${output}/recon-${width}x${height}-full.png`, fullPage: true, animations: 'disabled' });
  }
  await context.close();

  const videoContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: 'reduce',
    recordVideo: { dir: output, size: { width: 1440, height: 900 } },
  });
  const videoPage = await videoContext.newPage();
  await videoPage.goto(baseUrl);
  await videoPage.getByRole('button', { name: '[2] RECON' }).click();
  await videoPage.getByRole('button', { name: 'OPEN DETERMINISTIC FIXTURE' }).click();
  await videoPage.waitForTimeout(450);
  await videoPage.getByRole('tab', { name: 'EVIDENCE' }).click();
  await videoPage.waitForTimeout(450);
  await videoPage.getByRole('tab', { name: 'TIMELINE' }).click();
  await videoPage.waitForTimeout(450);
  const video = videoPage.video();
  await videoContext.close();
  if (!video) throw new Error('Playwright did not create a RECON overview recording.');
  await rename(await video.path(), `${output}/recon-overview.webm`);
} finally {
  if (browser) await browser.close().catch(() => undefined);
  server.kill('SIGTERM');
  await Promise.race([once(server, 'exit'), new Promise((resolve) => setTimeout(resolve, 1_000))]);
}

console.log(`RECON screenshots and recording saved in ${output}/`);
