/**
 * docs/images/phase1-*.png を撮り直す（通常の e2e では実行しない）。
 *   DOCS_SCREENSHOTS=1 pnpm --filter @stack-atlas/viewer e2e docs-screenshots
 */
import { expect, test } from '@playwright/test';
import { collectErrors, loadSample, openWithGraph, SAMPLE_URL, waitReady } from './helpers';

const OUT = new URL('../../../docs/images/', import.meta.url).pathname;

test.skip(!process.env.DOCS_SCREENSHOTS, 'DOCS_SCREENSHOTS=1 のときだけ実行');

test('docs 用スクリーンショット', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto(SAMPLE_URL);
  await waitReady(page);
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${OUT}phase1-overview.png` });

  await page.locator('.nl[data-id="comp:ResultTable"]').hover();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}phase1-hover-component.png` });
  await page.mouse.move(5, 500);

  await page.locator('.btn', { hasText: 'キャッシュ' }).click();
  await page.locator('.seg button', { hasText: '閲覧 MISS' }).click();
  await page.waitForTimeout(4200);
  await page.screenshot({ path: `${OUT}phase1-cache-flow.png` });
  await page.locator('.btn', { hasText: 'キャッシュ' }).click();
  await page.locator('.seg button', { hasText: 'フローなし' }).click();

  await page.locator('.seg button', { hasText: '重ねる' }).click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}phase1-collapsed.png` });

  const g = loadSample();
  for (const n of g.nodes) delete n.position;
  await openWithGraph(page, g, 'nopos.graph.json');
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${OUT}phase1-autolayout.png` });
  expect(errors).toEqual([]);
});

test.describe('スマホ', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test('docs 用スクリーンショット（スマホ）', async ({ page }) => {
    await page.goto(SAMPLE_URL);
    await waitReady(page);
    await page.locator('.seg button', { hasText: '閲覧 MISS' }).click();
    await page.locator('.nl[data-id="route:/races/[id]"]').click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}phase1-mobile.png` });
  });
});
