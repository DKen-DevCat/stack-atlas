import { mkdirSync, readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { collectErrors, loadSample, openWithGraph, SAMPLE_URL, waitReady } from './helpers';

const SHOTS = new URL('./__screenshots__/', import.meta.url).pathname;

test('サンプルを描画できる（ラベル数 = ノード数、フロー表示）', async ({ page }) => {
  const errors = collectErrors(page);
  const sample = loadSample();
  await page.goto(SAMPLE_URL);
  await waitReady(page);

  await expect(page.locator('.labels .nl')).toHaveCount(sample.nodes.length);
  await expect(page.locator('.lchip')).toHaveCount(4);
  await expect(page.locator('.issues')).toHaveCount(0);

  await page.waitForTimeout(1200);
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}overview.png` });

  await page.locator('.seg button', { hasText: '閲覧 MISS' }).click();
  const pill = page.locator('.flowpill');
  await expect(pill).toBeVisible();
  await expect(pill).toContainText('/14');
  await expect(pill).toContainText('Browser');

  await page.locator('.seg button', { hasText: '閲覧 HIT' }).click();
  await expect(pill).toHaveClass(/hit/);
  await page.locator('.seg button', { hasText: 'フローなし' }).click();
  await expect(pill).toBeHidden();

  expect(errors).toEqual([]);
});

test('ホバーで依存先（赤）と影響範囲（橙）が光り、クリックでパネルが開く', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto(SAMPLE_URL);
  await waitReady(page);

  const label = (id: string) => page.locator(`.nl[data-id="${id}"]`);
  await label('comp:ResultTable').hover();
  await expect(label('comp:ResultTable')).toHaveClass(/\bsel\b/);
  await expect(label('type:RaceResult')).toHaveClass(/\bdown\b/);
  await expect(label('type:Race')).toHaveClass(/\bdown\b/);
  await expect(label('route:/races/[id]')).toHaveClass(/\bup\b/);
  await expect(label('infra:lambdaNext')).toHaveClass(/\bup\b/);
  await expect(label('infra:cloudfront')).toHaveClass(/\bdim\b/);

  await label('comp:ResultTable').click();
  const panel = page.locator('.panel');
  await expect(panel).toBeVisible();
  await expect(panel.locator('h2')).toHaveText('ResultTable');
  await expect(panel.locator('.chips').first()).toContainText('RaceResult');

  // キャッシュ表（CloudFront）
  await label('infra:cloudfront').click();
  await expect(panel.locator('h2')).toHaveText('CloudFront');
  await expect(panel.locator('table.ct')).toContainText('/_next/static/*');
  await expect(panel.locator('table.ct')).toContainText('⚠');
  await label('comp:ResultTable').click();

  // 関連チップでジャンプ（カメラが寄る）
  await panel.locator('.chip', { hasText: 'RaceResult' }).first().click();
  await expect(panel.locator('h2')).toHaveText('RaceResult');

  // メモ → ラベルに 📝
  await panel.locator('textarea').fill('rank を number に統一');
  await expect(label('type:RaceResult').locator('.memo')).toHaveText('📝');

  await panel.locator('.x').click();
  await expect(panel).toBeHidden();
  expect(errors).toEqual([]);
});

test('キャッシュモードと層チップ', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto(SAMPLE_URL);
  await waitReady(page);
  await page.locator('.btn', { hasText: 'キャッシュ' }).click();
  await expect(page.locator('.viewer')).toHaveClass(/cache-on/);
  await expect(page.locator('.nl[data-id="infra:cloudfront"] .cb')).toBeVisible();
  await expect(page.locator('.nl[data-id="type:Race"]')).toHaveClass(/\bsoft\b/);

  await page.locator('.lchip').first().click();
  await expect(page.locator('.lchip').first()).toHaveClass(/off/);
  await expect(page.locator('.nl[data-id="infra:cloudfront"]')).toBeHidden();
  await page.locator('.seg button', { hasText: '重ねる' }).click();
  await page.waitForTimeout(600);
  expect(errors).toEqual([]);
});

test('position をすべて消しても自動レイアウトで描画できる', async ({ page }) => {
  const errors = collectErrors(page);
  const g = loadSample();
  for (const n of g.nodes) delete n.position;
  await openWithGraph(page, g, 'nopos.graph.json');
  await expect(page.locator('.labels .nl')).toHaveCount(g.nodes.length);
  expect(errors).toEqual([]);
});

for (const layerCount of [2, 3, 5, 6]) {
  test(`${layerCount} 層の graph でも描画できる`, async ({ page }) => {
    const errors = collectErrors(page);
    const layers = Array.from({ length: layerCount }, (_, i) => ({
      id: `l${i}`,
      name: `層${i}`,
      color: ['#ff9f43', '#4f8cff', '#a78bfa', '#4ade80', '#f472b6', '#facc15'][i],
    }));
    const nodes = layers.flatMap((l, i) =>
      Array.from({ length: 3 }, (_, j) => ({
        id: `n:${i}-${j}`,
        layer: l.id,
        kind: i === 1 ? 'page' : j === 2 ? 'mystery' : 'component',
        name: `N${i}-${j}`,
      })),
    );
    const edges = nodes
      .filter((n) => !n.id.startsWith(`n:${layerCount - 1}-`))
      .map((n) => ({
        from: n.id,
        to: n.id.replace(/^n:(\d+)/, (_, d) => `n:${Number(d) + 1}`),
        kind: 'uses',
      }));
    await openWithGraph(page, { version: 1, layers, nodes, edges }, `l${layerCount}.graph.json`);
    await expect(page.locator('.lchip')).toHaveCount(layerCount);
    await expect(page.locator('.labels .nl')).toHaveCount(nodes.length);
    await expect(page.locator('.labels .pl')).toHaveCount(layerCount);
    // 未知の kind は警告として一覧に出るが、描画は続く
    await expect(page.locator('.issues li.warning').first()).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test('参照エラーがあっても一覧を出して描画を続ける', async ({ page }) => {
  const errors = collectErrors(page);
  const g = loadSample() as { edges: unknown[]; nodes: unknown[] };
  g.edges.push({ from: 'comp:Nope', to: 'type:Race', kind: 'uses' });
  await openWithGraph(page, g, 'broken.graph.json');
  await expect(page.locator('.issues li.error')).toContainText('comp:Nope');
  await expect(page.locator('.labels .nl')).toHaveCount(g.nodes.length);
  await page.locator('.issues .x').click();
  await expect(page.locator('.issues')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('graph の指定がなければ案内を出し、ファイル選択で開ける', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('./');
  await expect(page.locator('body')).toHaveAttribute('data-status', 'empty');
  await expect(page.locator('.empty')).toContainText('graph.json を選ぶ');
  // サンプルは v1（race-site）と v2（fixture-poly.today の配線図）の 2 つになった（Phase 8-0b）。リンクを名前で選ぶ
  await expect(page.locator('.empty .samples a', { hasText: 'race-site' })).toBeVisible();
  await expect(page.locator('.empty .samples a', { hasText: '配線図' })).toHaveAttribute(
    'href',
    '?graph=samples%2Ffixture-poly.today.v2.json',
  );
  await page
    .locator('.empty input[type=file]')
    .setInputFiles(new URL('../../../examples/race-site.graph.json', import.meta.url).pathname);
  await waitReady(page);
  await expect(page.locator('.labels .nl')).toHaveCount(loadSample().nodes.length);
  expect(errors).toEqual([]);
});

test.describe('スマホ幅', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test('凡例を隠し、パネルは下から出るシート', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto(SAMPLE_URL);
    await waitReady(page);
    await expect(page.locator('.legend')).toBeHidden();
    await page.locator('.nl[data-id="comp:ResultTable"]').click();
    const box = await page.locator('.panel').boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y + box!.height).toBeCloseTo(844, 0);
    expect(box!.height).toBeLessThanOrEqual(844 * 0.58 + 1);
    expect(box!.width).toBeCloseTo(390, 0);
    expect(errors).toEqual([]);
  });
});

test('screen.screenshot は graph.json からの相対パスで遅延読み込みする', async ({ page }) => {
  const errors = collectErrors(page);
  const g = loadSample() as { nodes: { id: string; screen?: Record<string, unknown> }[] };
  const races = g.nodes.find((n) => n.id === 'route:/races')!;
  races.screen = { ...races.screen, screenshot: 'shots/races.png' };
  const requested: string[] = [];
  const png = readFileSync(new URL('../../../docs/images/04-collapsed.png', import.meta.url));
  await page.route('**/maps/shots/races.png', (route) => {
    requested.push(route.request().url());
    return route.fulfill({ contentType: 'image/png', body: png });
  });
  await page.route('**/maps/site.graph.json', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(g) }),
  );
  await page.goto('?graph=maps/site.graph.json');
  await waitReady(page);
  await expect.poll(() => requested.length).toBeGreaterThan(0);
  expect(requested[0]).toMatch(/\/maps\/shots\/races\.png$/);
  await page.locator('.nl[data-id="route:/races"]').click();
  await expect(page.locator('.panel .src').first()).toContainText(
    'shots/races.png（読み込み済み）',
  );
  expect(errors).toEqual([]);
});
