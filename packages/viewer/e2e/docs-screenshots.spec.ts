/**
 * docs/images/phase1-*.png・phase5-*.png を撮り直す（通常の e2e では実行しない）。
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

test('docs 用スクリーンショット（Phase 5: 差分・孤立メモ）', async ({ page }) => {
  const errors = collectErrors(page);
  type G = {
    nodes: {
      id: string;
      name: string;
      layer: string;
      kind: string;
      screen?: { regions?: { ref: string }[] };
    }[];
    edges: { from: string; to: string; kind: string }[];
  };
  const prev = loadSample() as unknown as G;
  const next: G = structuredClone(prev);
  const removed = new Set(['comp:RaceCard', 'hook:useRaces']);
  next.nodes = next.nodes.filter((n) => !removed.has(n.id));
  next.edges = next.edges.filter((e) => !removed.has(e.from) && !removed.has(e.to));
  for (const n of next.nodes) {
    if (n.screen?.regions) n.screen.regions = n.screen.regions.filter((r) => !removed.has(r.ref));
  }
  next.nodes.push(
    { id: 'comp:EntryList', layer: 'components', kind: 'component', name: 'EntryList' },
    { id: 'type:Entry', layer: 'types', kind: 'type', name: 'Entry' },
  );
  next.edges.push(
    { from: 'comp:EntryList', to: 'type:Entry', kind: 'uses' },
    { from: 'route:/races', to: 'comp:EntryList', kind: 'uses' },
    { from: 'comp:ResultTable', to: 'type:Entry', kind: 'uses' },
  );
  next.nodes.find((n) => n.id === 'type:Race')!.name = 'RaceInfo';
  await page.route('**/maps/now/graph.json', (r) =>
    r.fulfill({ contentType: 'application/json', body: JSON.stringify(next) }),
  );
  await page.route('**/maps/prev/graph.json', (r) =>
    r.fulfill({ contentType: 'application/json', body: JSON.stringify(prev) }),
  );
  await page.goto('?graph=maps/now/graph.json&prev=maps/prev/graph.json');
  await waitReady(page);
  await page.waitForTimeout(1000);
  await expect(page.locator('.issues')).toHaveCount(0);
  await page.screenshot({ path: `${OUT}phase5-diff.png` });

  await page.route('**/samples/memos.json', (r) =>
    r.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        'infra:lambdaNext': 'メモリ1024MB / standalone。コールドスタート要観察',
        'comp:RaceTable': 'ResultTable にリネーム済み。メモを移す',
        'type:LegacyRace': '旧 API の型。削除予定',
      }),
    }),
  );
  await page.goto(SAMPLE_URL);
  await waitReady(page);
  await page.locator('.nl[data-id="infra:lambdaNext"]').click();
  await page.locator('.orphanbtn').click();
  const item = page.locator('.orphans li[data-id="comp:RaceTable"]');
  await item.locator('.btn', { hasText: '移す…' }).click();
  await item.locator('input.mv').fill('comp:ResultTable');
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${OUT}phase5-memos.png` });
  expect(errors).toEqual([]);
});
