// build の出力（docs/16 §10）: graph.json（v2）は 2 面（3D の地図と配線図。Phase 8-6）、graph.v1.json（v1）は 3D の地図だけ。
// 配線図だけ（&pane=wiring）と 3D の地図だけのときは、隣にあれば左上の文字のリンクで行き来する
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { collectErrors, waitReady } from './helpers';

const read = (name: string) =>
  readFileSync(new URL(`../../../examples/${name}`, import.meta.url), 'utf8');
const V2 = read('fixture-poly.today.v2.json');
const V1 = read('race-site.graph.json');

/** built/ に graph.json（v2）と、あれば graph.v1.json（v1）を置いたことにする */
async function serveBuilt(page: Page, withV1: boolean) {
  const json = (body: string) => ({ contentType: 'application/json', body });
  await page.route('**/built/graph.json', (r) => r.fulfill(json(V2)));
  await page.route('**/built/graph.v1.json', (r) =>
    withV1 ? r.fulfill(json(V1)) : r.fulfill({ status: 404, body: 'not found' }),
  );
}

// 2026-11-10 変更（8-6）: graph.json（v2）は WebGL があれば 2 面（左に 3D の地図、右に配線図）で開き、2 面では
// 「3D の地図」のリンクを出さない（docs/20 §5.1 #14。地図も graph.json から描くので graph.v1.json は使わない。D74）。
// 以前は配線図だけで開き、graph.v1.json があれば「3D の地図」から開けた。その行き来は配線図だけ（&pane=wiring）で残る
test('graph.json（v2）は 2 面で開き、graph.v1.json があってもリンクを出さない。3D の地図（v1）の「配線図」からは 2 面へ', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await serveBuilt(page, true);
  await page.goto('?graph=built/graph.json');
  await waitReady(page);
  await expect(page.locator('.split .split-map .stage canvas')).toBeVisible();
  await expect(page.locator('.split .split-wiring .wv')).toBeVisible();
  // HEAD の応答を待つ（2 面では確かめもしない）
  await page.waitForTimeout(300);
  await expect(page.locator('.split-wiring .wv-top a.alt-link')).toBeHidden();
  await expect(page.locator('.split-map .top h1 a.alt-link')).toBeHidden();

  // v1 の graph.v1.json は今までどおり 3D の地図だけ。「配線図」で graph.json の 2 面へ
  await page.goto('?graph=built/graph.v1.json');
  await waitReady(page);
  await expect(page.locator('.split')).toHaveCount(0);
  await expect(page.locator('.top h1')).toBeVisible();
  const toWiring = page.locator('.top h1 a.alt-link');
  await expect(toWiring).toHaveText('配線図');
  await toWiring.click();
  await waitReady(page);
  expect(new URL(page.url()).searchParams.get('graph')).toBe('built/graph.json');
  await expect(page.locator('.split .split-wiring .wv')).toBeVisible();
  expect(errors).toEqual([]);
});

test('配線図だけ（&pane=wiring）: graph.v1.json があれば「3D の地図」から開ける。3D の地図から「配線図」で戻る', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await serveBuilt(page, true);
  await page.goto('?graph=built/graph.json&pane=wiring');
  await waitReady(page);
  await expect(page.locator('.wv')).toBeVisible();
  await expect(page.locator('.split')).toHaveCount(0);
  // 8-1 のレビューで変更: リンクは graph/altLink.ts の 1 つの部品になり、class は両方とも .alt-link（以前は .wv-alt と .alt）
  const toMap = page.locator('.wv-top a.alt-link');
  await expect(toMap).toBeVisible();
  await expect(toMap).toHaveText('3D の地図');
  expect(await toMap.getAttribute('href')).toContain('graph=built%2Fgraph.v1.json');

  await toMap.click();
  await waitReady(page);
  await expect(page.locator('.top h1')).toBeVisible();
  expect(new URL(page.url()).searchParams.get('graph')).toBe('built/graph.v1.json');
  const toWiring = page.locator('.top h1 a.alt-link');
  await expect(toWiring).toBeVisible();
  await expect(toWiring).toHaveText('配線図');

  await toWiring.click();
  await waitReady(page);
  await expect(page.locator('.wv')).toBeVisible();
  expect(new URL(page.url()).searchParams.get('graph')).toBe('built/graph.json');
  expect(errors).toEqual([]);
});

test('graph.v1.json が無ければ（手書きの v2・--v1 の build）リンクを出さない', async ({ page }) => {
  const errors = collectErrors(page);
  await serveBuilt(page, false);
  await page.goto('?graph=built/graph.json&pane=wiring');
  await waitReady(page);
  await expect(page.locator('.wv')).toBeVisible();
  // HEAD の応答を待つ
  await page.waitForTimeout(300);
  await expect(page.locator('.wv-top a.alt-link')).toBeHidden();
  expect(errors).toEqual([]);
});
