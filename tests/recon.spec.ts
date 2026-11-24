import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test.describe('RECON browser preview', () => {
  test.use({ reducedMotion: 'reduce' });

  test('opens the scoped module and keeps example observations explicit', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: '[2] RECON' }).click();
    await expect(page.getByRole('heading', { name: 'RECON' })).toBeVisible();
    await expect(page.locator('.recon-mode-note')).toContainText('Browser preview has no native network access.');
    await expect(page.getByRole('button', { name: /START INVESTIGATION/ })).toBeDisabled();

    await page.getByRole('button', { name: 'OPEN DETERMINISTIC FIXTURE' }).click();
    await expect(page.getByText('These deterministic example observations are not live network results.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'SAVE LOCAL' })).toBeDisabled();
    await page.getByText('ENTITY INDEX').click();
    await expect(page.getByRole('listbox', { name: 'Graph entities' }).getByRole('option', { name: /status\.example\.com/ })).toBeVisible();
    const edge = page.getByRole('listbox', { name: 'Graph relationships' }).getByRole('option').filter({ hasText: 'announced by' });
    await expect(edge).toBeVisible();
    await edge.click();
    await expect(page.getByRole('complementary', { name: 'Evidence inspector' })).toContainText('RELATIONSHIP');

    await page.getByRole('tab', { name: 'EVIDENCE' }).click();
    await expect(page.locator('.recon-evidence-table tbody tr')).toHaveCount(4);
    await page.getByRole('textbox', { name: 'Search evidence' }).fill('status.example.com');
    await expect(page.locator('.recon-evidence-table tbody tr')).toHaveCount(1);
    await page.getByRole('textbox', { name: 'Search evidence' }).fill('');
    await page.getByRole('combobox', { name: 'Filter evidence source' }).selectOption('ct');
    await expect(page.locator('.recon-evidence-table tbody tr')).toHaveCount(1);
    await page.getByRole('combobox', { name: 'Filter evidence source' }).selectOption('all');
    const certificate = page.locator('.recon-evidence-table tbody tr').filter({ hasText: 'status.example.com' });
    await certificate.focus();
    await certificate.press('Enter');
    await expect(page.getByRole('complementary', { name: 'Evidence inspector' })).toContainText(/historical/i);
    await page.getByRole('tab', { name: 'TIMELINE' }).click();
    await expect(page.locator('.recon-certificate-timeline')).toContainText('VALID FROM');
    await expect(page.locator('.recon-certificate-timeline')).toContainText('CT log submission time unavailable.');
    await expect(page.locator('.recon-certificate-timeline')).toContainText('status.example.com');

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'JSON', exact: true }).click();
    const report = await download;
    const path = await report.path();
    if (!path) throw new Error('The fixture export was not saved.');
    const contents = JSON.parse(await readFile(path, 'utf8')) as { fixture: boolean; snapshots: Array<{ evidence: unknown[] }> };
    expect(contents.fixture).toBe(true);
    expect(contents.snapshots[0].evidence).toHaveLength(4);
  });

  test('keeps the RECON workspace within the requested desktop and narrow widths', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: '[2] RECON' }).click();
    await page.getByRole('button', { name: 'OPEN DETERMINISTIC FIXTURE' }).click();
    for (const [width, height] of [[1920, 1080], [1440, 900], [1280, 800], [1024, 768], [740, 580]]) {
      await page.setViewportSize({ width, height });
      const documentWidth = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: window.innerWidth }));
      expect(documentWidth.scroll, `horizontal page overflow at ${width} × ${height}`).toBeLessThanOrEqual(documentWidth.viewport);
      await expect(page.locator('.recon-graph-region canvas')).toBeVisible();
      if (width === 740) {
        const history = await page.getByRole('combobox', { name: 'Open saved investigation' }).boundingBox();
        expect(history?.width ?? 0, 'local history selector remains usable at 740 px').toBeGreaterThanOrEqual(180);
      }
    }
  });
});
