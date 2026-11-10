/**
 * Phase 5（共有）: 共有メモ（memos.json・/api/memos）、孤立メモ、差分表示（?prev=）。
 * memos.json・前回の graph.json・API は page.route で差し替える（CI でもファイル生成なしで動く）。
 */
import { expect, test, type Page } from '@playwright/test';
import { collectErrors, loadSample, SAMPLE_URL, waitReady } from './helpers';

const json = (body: unknown) => ({ contentType: 'application/json', body: JSON.stringify(body) });

async function serveMemos(page: Page, memos: Record<string, string>) {
  await page.route('**/samples/memos.json', (route) => route.fulfill(json(memos)));
}

test('graph.json の隣の memos.json を共有メモとして読み、編集するとローカル（未保存）になる', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await serveMemos(page, { 'infra:lambdaNext': 'メモリ1024MB / standalone' });
  await page.goto(SAMPLE_URL);
  await waitReady(page);

  const label = page.locator('.nl[data-id="infra:lambdaNext"]');
  await expect(label.locator('.memo')).toHaveText('📝');
  await label.click();
  const panel = page.locator('.panel');
  await expect(panel.locator('textarea')).toHaveValue('メモリ1024MB / standalone');
  await expect(panel.locator('.mchip')).toHaveText('共有');
  // vite preview には /api/memos が無いので「サーバーに保存」は出ない
  await expect(panel.locator('.btn', { hasText: 'サーバーに保存' })).toBeHidden();

  await panel.locator('textarea').fill('メモリ2048MB に変更');
  await expect(panel.locator('.mchip')).toHaveText('ローカル（未保存）');

  const download = page.waitForEvent('download');
  await panel.locator('.btn', { hasText: 'memos.json を書き出す' }).click();
  const d = await download;
  expect(d.suggestedFilename()).toBe('memos.json');
  const text = await (await d.createReadStream()).toArray();
  expect(JSON.parse(Buffer.concat(text).toString('utf8'))).toEqual({
    'infra:lambdaNext': 'メモリ2048MB に変更',
  });
  expect(errors).toEqual([]);
});

test('孤立メモの一覧から移す・削除する', async ({ page }) => {
  const errors = collectErrors(page);
  await serveMemos(page, {
    'comp:OldTable': '旧 ResultTable のメモ',
    'type:Gone': '消えた型',
    'type:Race': '既存',
  });
  await page.goto(SAMPLE_URL);
  await waitReady(page);

  const btn = page.locator('.orphanbtn');
  await expect(btn).toHaveText('孤立メモ (2)');
  await btn.click();
  const list = page.locator('.orphans');
  await expect(list).toBeVisible();
  await expect(list.locator('li')).toHaveCount(2);
  await expect(list.locator('li').first()).toContainText('comp:OldTable');
  await expect(list.locator('li').first()).toContainText('旧 ResultTable のメモ');

  // 移す
  const item = list.locator('li[data-id="comp:OldTable"]');
  await item.locator('.btn', { hasText: '移す…' }).click();
  await item.locator('input.mv').fill('comp:Nope');
  await item.locator('.btn', { hasText: /^移す$/ }).click();
  await expect(item.locator('.err')).toHaveText('graph.json に無い ID です');
  await item.locator('input.mv').fill('comp:ResultTable');
  await item.locator('.btn', { hasText: /^移す$/ }).click();
  await expect(btn).toHaveText('孤立メモ (1)');
  await expect(page.locator('.nl[data-id="comp:ResultTable"] .memo')).toHaveText('📝');

  // 削除 → 0 件で一覧もボタンも消える
  await list.locator('li[data-id="type:Gone"] .btn', { hasText: '削除' }).click();
  await expect(list).toBeHidden();
  await expect(btn).toBeHidden();

  await page.locator('.nl[data-id="comp:ResultTable"]').click();
  await expect(page.locator('.panel textarea')).toHaveValue('旧 ResultTable のメモ');
  await expect(page.locator('.panel .mchip')).toHaveText('ローカル（未保存）');
  expect(errors).toEqual([]);
});

test('serve の /api/memos があれば「サーバーに保存」で書き戻し、405 なら案内を出す', async ({
  page,
}) => {
  const errors = collectErrors(page);
  const posted: unknown[] = [];
  let allowWrite = true;
  await page.route('**/api/memos', (route) => {
    const req = route.request();
    if (req.method() === 'GET') return route.fulfill(json({ 'type:Race': 'API のメモ' }));
    posted.push({ type: req.headers()['content-type'], body: req.postDataJSON() });
    return allowWrite
      ? route.fulfill(json({ ok: true, count: 1 }))
      : route.fulfill({ status: 405, ...json({ error: 'x' }) });
  });
  await page.goto(SAMPLE_URL);
  await waitReady(page);
  await page.locator('.nl[data-id="type:Race"]').click();
  const panel = page.locator('.panel');
  await expect(panel.locator('textarea')).toHaveValue('API のメモ');
  await expect(panel.locator('.mchip')).toHaveText('共有');
  await panel.locator('textarea').fill('API のメモ（追記）');
  await expect(panel.locator('.mchip')).toHaveText('ローカル（未保存）');
  const save = panel.locator('.btn', { hasText: 'サーバーに保存' });
  await save.click();
  await expect(panel.locator('.msave')).toContainText('サーバーに保存しました');
  await expect(panel.locator('.mchip')).toHaveText('共有');
  expect(posted).toEqual([
    { type: 'application/json', body: { 'type:Race': 'API のメモ（追記）' } },
  ]);

  allowWrite = false;
  await panel.locator('textarea').fill('もう一度');
  await save.click();
  await expect(panel.locator('.msave')).toHaveText(
    'このサーバーは書き込みに対応していません（--repo なしで serve）',
  );
  await expect(save).toBeHidden();
  expect(errors).toEqual([]);
});

/** サンプルから 1 ノード消し、1 ノード足し、1 ノードの名前を変えたもの（今の graph） */
function modifiedSample() {
  const prev = loadSample() as {
    nodes: {
      id: string;
      name: string;
      layer: string;
      kind: string;
      screen?: { regions?: { ref: string }[] };
    }[];
    edges: { from: string; to: string; kind: string }[];
  };
  const next = structuredClone(prev);
  next.nodes = next.nodes.filter((n) => n.id !== 'comp:RaceCard');
  next.edges = next.edges.filter((e) => e.from !== 'comp:RaceCard' && e.to !== 'comp:RaceCard');
  for (const n of next.nodes) {
    if (n.screen?.regions)
      n.screen.regions = n.screen.regions.filter((r) => r.ref !== 'comp:RaceCard');
  }
  next.nodes.push({ id: 'type:Entry', layer: 'types', kind: 'type', name: 'Entry' });
  next.edges.push({ from: 'comp:ResultTable', to: 'type:Entry', kind: 'uses' });
  next.nodes.find((n) => n.id === 'type:Race')!.name = 'RaceInfo';
  return { prev, next };
}

test('?prev= で差分を色分けし、ピルで切り替える', async ({ page }) => {
  const errors = collectErrors(page);
  const { prev, next } = modifiedSample();
  expect(prev.nodes.some((n) => n.id === 'comp:RaceCard')).toBe(true);
  await page.route('**/maps/now/graph.json', (r) => r.fulfill(json(next)));
  await page.route('**/maps/prev/graph.json', (r) => r.fulfill(json(prev)));
  await page.goto('?graph=maps/now/graph.json&prev=maps/prev/graph.json');
  await waitReady(page);

  await expect(page.locator('.issues')).toHaveCount(0);
  const pill = page.locator('.diffpill');
  await expect(pill).toHaveText('差分 +1 −1 ~1');
  await expect(pill).toHaveClass(/\bon\b/);
  const ghost = page.locator('.nl.ghost[data-ghost-id="comp:RaceCard"]');
  await expect(ghost).toBeVisible();
  await expect(ghost).toContainText('削除');
  const added = page.locator('.nl[data-id="type:Entry"]');
  await expect(added).toHaveClass(/diff-added/);
  await expect(added.locator('.db.added')).toBeVisible();
  await expect(page.locator('.nl[data-id="type:Race"]')).toHaveClass(/diff-changed/);
  const dbg = await page.evaluate(() => window.__stackAtlas?.viewer?.debugInfo);
  expect(dbg?.ghosts).toBe(1);
  expect(dbg?.removedEdges).toBeGreaterThan(0);

  // ハイライトが差分より優先。外せば戻る
  await added.hover();
  await expect(added).toHaveClass(/\bsel\b/);
  await expect(added).not.toHaveClass(/diff-added/);
  await page.mouse.move(700, 880);
  await expect(added).toHaveClass(/diff-added/);

  // パネルに変わったフィールド
  await page.locator('.nl[data-id="type:Race"]').click();
  await expect(page.locator('.panel .dinfo')).toHaveText('変更: 名前: Race → RaceInfo');
  await page.locator('.panel .x').click();

  // ピルで切り替え
  await pill.click();
  await expect(pill).not.toHaveClass(/\bon\b/);
  await expect(ghost).toBeHidden();
  await expect(added).not.toHaveClass(/diff-added/);
  await pill.click();
  await expect(ghost).toBeVisible();
  expect(errors).toEqual([]);
});

test('「開く ▾ → 前回と比較…」でファイルを比較元にする', async ({ page }) => {
  const errors = collectErrors(page);
  const { prev, next } = modifiedSample();
  await page.route('**/maps/now/graph.json', (r) => r.fulfill(json(next)));
  await page.goto('?graph=maps/now/graph.json');
  await waitReady(page);
  await expect(page.locator('.diffpill')).toHaveCount(0);
  await page.locator('.openmenu > .btn').click();
  await expect(page.locator('.openmenu .mi', { hasText: '前回と比較…' })).toBeVisible();
  await page
    .locator('.openmenu .mi', { hasText: '前回と比較…' })
    .locator('input')
    .setInputFiles({
      name: 'prev.graph.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(prev)),
    });
  await waitReady(page);
  await expect(page.locator('.diffpill')).toHaveText('差分 +1 −1 ~1');
  await expect(page.locator('.nl.ghost')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('?prev= が読めなくても描画を続け、警告を出す', async ({ page }) => {
  const errors = collectErrors(page);
  await page.route('**/maps/missing.json', (r) => r.fulfill({ status: 404, body: 'nope' }));
  await page.goto(`${SAMPLE_URL}&prev=maps/missing.json`);
  await waitReady(page);
  await expect(page.locator('.issues li.warning')).toContainText('前回の graph.json');
  await expect(page.locator('.diffpill')).toHaveCount(0);
  // 404 の fetch はブラウザが console に出すので除く
  expect(errors.filter((e) => !/404|Failed to load resource/.test(e))).toEqual([]);
});
