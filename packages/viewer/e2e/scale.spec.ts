/**
 * Phase 7: 250 ノードの合成 graph（src/graph/synthetic.ts）で、板の広がり・ラベルの LOD・検索・kind チップ・
 * ホバーの速さを確かめる。DOCS_SCREENSHOTS=1 のときは docs/images/phase7-*.png も撮る。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { makeSyntheticGraph } from '../src/graph/synthetic';
import { collectErrors, openWithGraph } from './helpers';

const SHOTS = new URL('./__screenshots__/', import.meta.url).pathname;
const DOCS = new URL('../../../docs/images/', import.meta.url).pathname;
const docsShot = (name: string) =>
  process.env.DOCS_SCREENSHOTS ? [`${SHOTS}${name}`, `${DOCS}${name}`] : [`${SHOTS}${name}`];

interface Debug {
  nodes: number;
  plate: { width: number; depth: number };
  layerGap: number;
  sceneScale: number;
  labelMode: string;
  searchMatches: number | null;
}
interface Win {
  __stackAtlas: { viewer: { debugInfo: Debug; hover(id: string | null): void } };
}
const debug = (page: Page) =>
  page.evaluate(() => (window as unknown as Win).__stackAtlas.viewer.debugInfo);

test('250 ノード: 板が広がり、ラベルは「関連のみ」、検索と kind チップが効く', async ({ page }) => {
  const errors = collectErrors(page);
  const g = makeSyntheticGraph();
  expect(g.nodes.length).toBe(250);
  await openWithGraph(page, g, 'synthetic-250.graph.json');
  await expect(page.locator('.labels .nl')).toHaveCount(250);

  const d = await debug(page);
  expect(d.plate.width).toBeGreaterThan(100);
  expect(d.plate.depth).toBeGreaterThan(20);
  expect(d.layerGap).toBeGreaterThan(7.5);
  expect(d.sceneScale).toBeGreaterThan(2);
  expect(d.labelMode).toBe('related');
  // 「関連のみ」: インフラ・画面の層のラベルは出て、コンポーネント・型のラベルは隠れる
  await expect(page.locator('.nl[data-id="infra:0"]')).toBeVisible();
  await expect(page.locator('.nl[data-id^="component:"]').first()).toBeHidden();
  expect(await page.locator('.labels .nl.lod-hide').count()).toBeGreaterThan(150);

  await page.waitForTimeout(800);
  mkdirSync(SHOTS, { recursive: true });
  for (const p of docsShot('phase7-scale.png')) await page.screenshot({ path: p });

  // 「すべて」: 遠いラベルは点になる
  await page.locator('#labelSeg button', { hasText: 'すべて' }).click();
  await page.waitForTimeout(300);
  expect(await page.locator('.labels .nl.lod-hide').count()).toBe(0);
  expect(await page.locator('.labels .nl.lod-dot').count()).toBeGreaterThan(100);
  await page.locator('#labelSeg button', { hasText: '関連のみ' }).click();

  // 検索: `/` でフォーカス、部分一致の件数、一致は sel・ほかは dim、Enter で寄る、Esc でクリア
  await page.keyboard.press('/');
  const input = page.locator('input.search');
  await expect(input).toBeFocused();
  await input.fill('budget');
  const expected = g.nodes.filter((n) =>
    [n.name, n.id, n.file ?? ''].some((s) => s.toLowerCase().includes('budget')),
  );
  expect(expected.length).toBeGreaterThan(3);
  await expect(page.locator('.searchbox .count')).toHaveText(`${expected.length} 件`);
  expect((await debug(page)).searchMatches).toBe(expected.length);
  await expect(page.locator('.labels .nl.sel')).toHaveCount(expected.length);
  // 一致したラベルは「関連のみ」でも出る
  await expect(page.locator(`.nl[data-id="${expected[0]!.id}"]`)).toBeVisible();
  expect(await page.locator('.labels .nl.dim').count()).toBe(250 - expected.length);
  await input.press('Enter');
  await expect(page.locator('.searchbox .count')).toHaveText(`1 / ${expected.length} 件`);
  await expect(page.locator('.panel')).toBeVisible();
  await expect(page.locator('.panel h2')).toHaveText(expected[0]!.name);
  await page.waitForTimeout(900);
  for (const p of docsShot('phase7-search.png')) await page.screenshot({ path: p });
  await input.press('Escape');
  await expect(page.locator('.searchbox .count')).toBeEmpty();
  expect((await debug(page)).searchMatches).toBeNull();
  await expect(page.locator('.labels .nl.sel')).toHaveCount(1); // 選択中のノードだけ

  // kind チップ: type を隠すと type のラベルが消え、戻すと出る
  const typeChip = page.locator('.kchip[data-kind="type"]');
  await expect(typeChip).toContainText('type');
  await typeChip.click();
  await expect(typeChip).toHaveClass(/off/);
  await page.locator('#labelSeg button', { hasText: 'すべて' }).click();
  await expect(page.locator('.nl[data-id^="type:"]').first()).toBeHidden();
  await expect(page.locator('.nl[data-id^="schema:"]').first()).toBeVisible();
  await typeChip.click();
  await expect(page.locator('.nl[data-id^="type:"]').first()).toBeVisible();

  expect(errors).toEqual([]);
});

test('250 ノード: ホバー 20 回の時間', async ({ page }) => {
  const errors = collectErrors(page);
  await openWithGraph(page, makeSyntheticGraph(), 'synthetic-250.graph.json');
  const ids = ['component:', 'type:', 'infra:', 'route:', 'hook:', 'lib:', 'handler:'];
  const r = await page.evaluate(async (prefixes) => {
    const v = (window as unknown as Win).__stackAtlas.viewer;
    const all: string[] = Array.from(document.querySelectorAll('.labels .nl')).map(
      (e) => (e as HTMLElement).dataset.id!,
    );
    const pick = all.filter((id) => prefixes.some((p) => id.startsWith(p)));
    const targets = Array.from({ length: 20 }, (_, i) => pick[(i * 37) % pick.length]!);
    // applyState だけの時間（同期）
    const t0 = performance.now();
    for (const id of targets) v.hover(id);
    const sync = performance.now() - t0;
    v.hover(null);
    // 1 フレームずつ描画を挟んだ時間
    const frame = () => new Promise<void>((res) => requestAnimationFrame(() => res()));
    await frame();
    const t1 = performance.now();
    for (const id of targets) {
      v.hover(id);
      await frame();
    }
    const withFrames = performance.now() - t1;
    v.hover(null);
    // 比較用: ホバーなしで 20 フレーム
    const t2 = performance.now();
    for (let i = 0; i < 20; i++) await frame();
    const idle = performance.now() - t2;
    return { sync, withFrames, idle };
  }, ids);
  console.log(
    `hover x20: applyState ${r.sync.toFixed(1)}ms (${(r.sync / 20).toFixed(2)}ms each), with frames ${r.withFrames.toFixed(1)}ms (${(r.withFrames / 20).toFixed(1)}ms each), idle 20 frames ${r.idle.toFixed(1)}ms`,
  );
  expect(r.sync / 20).toBeLessThan(50);
  expect(errors).toEqual([]);
});

/** fixture-poly の graph.json（`pnpm atlas build examples/fixture-poly -o <dir> --no-screenshots`）があれば撮る */
const POLY = process.env.POLY_GRAPH ?? '';
test('fixture-poly のスクリーンショット', async ({ page }) => {
  test.skip(!POLY || !existsSync(POLY), 'POLY_GRAPH=<fixture-poly の graph.json> のときだけ');
  const errors = collectErrors(page);
  const g = JSON.parse(readFileSync(POLY, 'utf8'));
  await openWithGraph(page, g, 'poly.graph.json');
  await expect(page.locator('.labels .nl')).toHaveCount(g.nodes.length);
  await page.waitForTimeout(1200);
  mkdirSync(SHOTS, { recursive: true });
  for (const p of docsShot('phase7-poly.png')) await page.screenshot({ path: p });
  expect(errors).toEqual([]);
});
