import { expect, test } from '@playwright/test';

for (const size of [20, 100, 500, 2_000]) {
  test(`renders a ${size}-node synthetic graph`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/tests/graph-harness.html?nodes=${size}`);
    await page.waitForFunction(() => document.documentElement.dataset.graphReady === 'true', null, { timeout: 20_000 });
    const dimensions = await page.locator('canvas').evaluate((element) => {
      const canvas = element as HTMLCanvasElement;
      return { width: canvas.width, height: canvas.height };
    });
    expect(dimensions.width).toBeGreaterThan(0);
    expect(dimensions.height).toBeGreaterThan(0);
    const timing = await page.evaluate(() => window.__graphRenderMs);
    expect(timing).toBeGreaterThan(0);
    console.log(`RECON graph benchmark (${testInfo.project.name}): ${size} nodes, ${size - 1} edges, first canvas frame ${timing?.toFixed(1)} ms`);
  });
}
