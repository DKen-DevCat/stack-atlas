// 配線図の views・メモ・差分・警告のリンク（docs/18 §3.4・§4「views・memos・diff」、D64。Phase 8-3c）
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { PREV_EDITS as E, prevOfToday } from '../../wiring/src/__tests__/diff-fixture';
import { collectErrors, waitReady } from './helpers';

const SAMPLE = 'samples/fixture-poly.today.v2.json';
// 2026-11-10 変更（8-6）: v2 は WebGL があれば 2 面（左に 3D の地図、右に配線図）で開くので、配線図だけを確かめるテストは
// `&pane=wiring`（docs/20 §5.1 #17）で 1 面にする。2 面は split.spec.ts
const V2_URL = `?graph=${SAMPLE}&pane=wiring`;

function sampleV2() {
  return JSON.parse(
    readFileSync(new URL('../../../examples/fixture-poly.today.v2.json', import.meta.url), 'utf8'),
  );
}

interface WiringDbg {
  selection: unknown;
  lit: { boxes: string[] } | null;
  state: Record<string, boolean>;
  viewId: string | null;
  renders: number;
  memoBoxes: string[];
  diff: {
    ghost: { nodes: string[]; items: string[]; wires: string[] };
    added: { nodes: string[]; items: string[]; wires: string[] };
    changed: string[];
  } | null;
  view: { k: number; tx: number; ty: number };
}
type Win = { __stackAtlas: { wiring: WiringDbg | null } };
const dbg = <K extends keyof WiringDbg>(page: Page, key: K) =>
  page.evaluate((k) => (window as unknown as Win).__stackAtlas.wiring![k], key) as Promise<
    WiringDbg[K]
  >;

/** 箱の名前の帯（項目の行より上）を本物のマウスでクリックする */
async function clickBox(page: Page, id: string, attr = 'data-box') {
  const b = (await page.locator(`[${attr}="${id}"] .shape`).boundingBox())!;
  await page.mouse.click(b.x + b.width * 0.6, b.y + Math.min(3, b.height / 4));
}
/** 図の外の空白（全体表示の左の余白）をクリックする */
const clickBlank = (page: Page) => page.mouse.click(8, 300);

const HIT = 'infra:static_site/this#hit';

test('views のメニュー: 選ぶと始点と分岐が再現される。ほかを選ぶと空の選択に戻る。?view= で開ける', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto(V2_URL);
  await waitReady(page);
  await page.keyboard.press('f');
  const menu = page.locator('.wv-top select.wv-views');
  await expect(menu).toBeVisible();
  await expect(menu.locator('option')).toHaveText([
    'ビューを選ぶ…',
    '今日の合計を見る',
    '今日の合計を見る（CloudFront HIT）',
  ]);

  await menu.selectOption('today-cdn-hit');
  expect(await dbg(page, 'selection')).toEqual({ kind: 'box', id: 'actor:user' });
  expect((await dbg(page, 'state'))[HIT]).toBe(true);
  expect(await dbg(page, 'viewId')).toBe('today-cdn-hit');
  // HIT: CloudFront が折り返すので S3 は光らない
  let lit = (await dbg(page, 'lit'))!;
  expect(lit.boxes).toContain('infra:static_site/this');
  expect(lit.boxes).not.toContain('infra:static_site/site');
  expect(new URL(page.url()).searchParams.get('view')).toBe('today-cdn-hit');

  // 別の view: 分岐は既定に戻してから当てる
  await menu.selectOption('today');
  expect(await dbg(page, 'selection')).toEqual({ kind: 'box', id: 'route:/' });
  expect((await dbg(page, 'state'))[HIT]).toBe(false);
  lit = (await dbg(page, 'lit'))!;
  expect(lit.boxes).toContain('infra:static_site/site');
  await expect(menu).toHaveValue('today');

  // ほかをクリック: メニューは空の選択に戻り、URL の ?view= も消える
  await clickBox(page, 'comp:EntryList');
  await expect(menu).toHaveValue('');
  expect(await dbg(page, 'viewId')).toBeNull();
  expect(new URL(page.url()).searchParams.get('view')).toBeNull();
  await menu.selectOption('today');
  await clickBlank(page);
  await expect(menu).toHaveValue('');
  expect(await dbg(page, 'selection')).toBeNull();

  // 空の選択肢を選ぶ: 選択を解き、分岐も既定に戻す（前の view の分岐を残さない）
  await menu.selectOption('today-cdn-hit');
  expect((await dbg(page, 'state'))[HIT]).toBe(true);
  await menu.selectOption('');
  expect(await dbg(page, 'selection')).toBeNull();
  expect((await dbg(page, 'state'))[HIT]).toBe(false);
  expect(await dbg(page, 'viewId')).toBeNull();
  expect(new URL(page.url()).searchParams.get('view')).toBeNull();

  // ?view= で開く: 始点と分岐が当たり、開いた直後はその始点のあたりを映す。描くのは 1 回だけ（当ててから描く）
  await page.goto(`${V2_URL}&view=today-cdn-hit`);
  await waitReady(page);
  expect(await dbg(page, 'renders')).toBe(1);
  expect(await dbg(page, 'selection')).toEqual({ kind: 'box', id: 'actor:user' });
  expect((await dbg(page, 'state'))[HIT]).toBe(true);
  await expect(menu).toHaveValue('today-cdn-hit');
  const vp = page.viewportSize()!;
  const b = (await page.locator('[data-box="actor:user"] .shape').boundingBox())!;
  expect(b.x).toBeGreaterThanOrEqual(0);
  expect(b.x + b.width).toBeLessThanOrEqual(vp.width);
  expect(b.y).toBeGreaterThanOrEqual(0);
  expect(b.y + b.height).toBeLessThanOrEqual(vp.height);

  // graph に無い view は無視して普通に開き、警告の一覧に出す。URL の ?view= は外す（?graph= は残す）
  await page.goto(`${V2_URL}&view=nope`);
  await waitReady(page);
  expect(await dbg(page, 'selection')).toBeNull();
  await expect(page.locator('.wv-top [data-issues]')).toHaveText('警告 2 件');
  const url = new URL(page.url());
  expect(url.searchParams.get('view')).toBeNull();
  expect(url.searchParams.get('graph')).toBe(SAMPLE);
  expect(errors).toEqual([]);
});

test('views のメニュー: ファイルで開いた graph の view は URL に書かない（?graph= が無いので再読み込みで当たらない）', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('./');
  await page
    .locator('.empty input[type=file]')
    .setInputFiles(
      new URL('../../../examples/fixture-poly.today.v2.json', import.meta.url).pathname,
    );
  await waitReady(page);
  const menu = page.locator('.wv-top select.wv-views');
  await menu.selectOption('today-cdn-hit');
  expect(await dbg(page, 'viewId')).toBe('today-cdn-hit');
  expect((await dbg(page, 'state'))[HIT]).toBe(true);
  expect(new URL(page.url()).search).toBe('');
  expect(errors).toEqual([]);
});

const MEMOS = {
  'route:/': '画面のメモ',
  'type:Entry': '型のメモ',
  'web/src/feature/spend': 'spend のメモ',
  'gone:box': '消えた箱のメモ',
};

test('メモ: 角を折った箱、選ぶと左下の札、その場で書くと localStorage に残る。型・group のメモ、孤立メモのリンク', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.route('**/samples/memos.json', (r) =>
    r.fulfill({ contentType: 'application/json', body: JSON.stringify(MEMOS) }),
  );
  await page.goto(V2_URL);
  await waitReady(page);
  await page.keyboard.press('f');
  // 角を折るのは箱 id か group にメモがある箱（形だけ。文字の印は無い）
  expect(await dbg(page, 'memoBoxes')).toEqual([
    'fn:createTransaction',
    'fn:getToday',
    'fn:toTodayView',
    'route:/',
  ]);
  await expect(page.locator('[data-box="route:/"] .memo-fold')).toHaveCount(1);
  await expect(page.locator('[data-box="comp:TodayIsland"] .memo-fold')).toHaveCount(0);
  await expect(page.locator('.wv-top [data-orphans]')).toHaveText('孤立メモ 1 件');
  const card = page.locator('.wv-memo');
  await expect(card).toBeHidden();

  // 箱を選ぶ: 左下の札（不透明・光る層の上）。右下の再生バーに重ならない
  await clickBox(page, 'route:/');
  await expect(card).toBeVisible();
  const ta = card.locator('textarea[data-memo-id="route:/"]');
  await expect(ta).toHaveValue('画面のメモ');
  const vp = page.viewportSize()!;
  const cb = (await card.boundingBox())!;
  const sb = (await page.locator('.wv-speed').boundingBox())!;
  expect(cb.x).toBeLessThan(40);
  expect(cb.y + cb.height).toBeGreaterThan(vp.height - 40);
  expect(cb.x + cb.width).toBeLessThan(sb.x);
  expect(await card.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(21, 25, 34)');
  const top = await page.evaluate(
    ([x, y]) => document.elementFromPoint(x!, y!)?.closest('.wv-memo') !== null,
    [cb.x + cb.width / 2, cb.y + cb.height / 2],
  );
  expect(top).toBe(true);

  // その場で書く → このブラウザに保存（3D の地図と同じキー）
  await ta.fill('画面のメモ（追記）');
  await expect(card.locator('.wv-memo-st')).toHaveText('未保存');
  const stored = await page.evaluate(() =>
    Object.keys(localStorage)
      .filter((k) => k.startsWith('stack-atlas-memos:'))
      .map((k) => JSON.parse(localStorage.getItem(k)!)),
  );
  expect(stored).toEqual([{ 'route:/': '画面のメモ（追記）' }]);

  // group（v1 の箱の id）のメモも同じ札に並べる
  await clickBox(page, 'fn:getToday');
  await expect(card.locator('.wv-memo-entry')).toHaveCount(2);
  await expect(card.locator('textarea[data-memo-id="fn:getToday"]')).toHaveValue('');
  await expect(card.locator('textarea[data-memo-id="web/src/feature/spend"]')).toHaveValue(
    'spend のメモ',
  );

  // メモの無い箱に書くと角が折れ、消すと戻る
  await clickBox(page, 'comp:TotalCard');
  const totalTa = card.locator('textarea[data-memo-id="comp:TotalCard"]');
  await totalTa.fill('合計のカード');
  await expect(page.locator('[data-box="comp:TotalCard"] .memo-fold')).toHaveCount(1);
  await totalTa.fill('');
  await expect(page.locator('[data-box="comp:TotalCard"] .memo-fold')).toHaveCount(0);

  // 札の中の Esc は欄から焦点を外すだけ（選択は解かない）。もう一度押すと選択を解く
  // 2026-11-09 変更（8-3c のレビュー）: 以前は札で書いている途中の Esc でも選択が解けて札が閉じた
  await expect(totalTa).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(totalTa).not.toBeFocused();
  await expect(card).toBeVisible();
  // TotalCard は getToday を選んで光っていたので、クリックは下流だけ（downOnly）の選択
  expect(await dbg(page, 'selection')).toMatchObject({ kind: 'box', id: 'comp:TotalCard' });

  // 型をクリック（横断面）: 型の id のメモ（沈んだ箱は文字を消すので、選択を解いてから）
  await page.keyboard.press('Escape');
  await expect(card).toBeHidden();
  const ty = page.locator('[data-item="comp:EntryList#in/entries"] [data-type="type:Entry"]');
  const tb = (await ty.boundingBox())!;
  await page.mouse.click(tb.x + tb.width / 2, tb.y + tb.height / 2);
  await expect(card.locator('textarea[data-memo-id="type:Entry"]')).toHaveValue('型のメモ');

  // 孤立メモの一覧（箱・型・group のどれでもない id）
  await page.locator('.wv-top [data-orphans]').click();
  await expect(page.locator('.orphans li[data-id]')).toHaveCount(1);
  await expect(page.locator('.orphans li[data-id="gone:box"]')).toBeVisible();
  await page.locator('.orphans .x').click();

  // Esc で札を閉じる。再読み込みしても書いたメモは残る
  await page.keyboard.press('Escape');
  await expect(card).toBeHidden();
  await page.reload();
  await waitReady(page);
  await page.keyboard.press('f');
  await clickBox(page, 'route:/');
  await expect(card.locator('textarea[data-memo-id="route:/"]')).toHaveValue('画面のメモ（追記）');
  expect(errors).toEqual([]);
});

test('メモ: serve の /api/memos があれば札の「サーバーに保存」で書き戻す（3D の地図と同じ POST）', async ({
  page,
}) => {
  const errors = collectErrors(page);
  const posted: unknown[] = [];
  const json = (body: unknown) => ({ contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/memos', (route) => {
    const req = route.request();
    if (req.method() === 'GET') return route.fulfill(json({ 'route:/': 'API のメモ' }));
    posted.push(req.postDataJSON());
    return route.fulfill(json({ ok: true, count: 1 }));
  });
  await page.goto(V2_URL);
  await waitReady(page);
  await page.keyboard.press('f');
  await clickBox(page, 'route:/');
  const card = page.locator('.wv-memo');
  await expect(card.locator('textarea')).toHaveValue('API のメモ');
  await card.locator('textarea').fill('API のメモ（追記）');
  await expect(card.locator('.wv-memo-st')).toHaveText('未保存');
  await card.locator('.wv-memo-foot .wv-link', { hasText: 'サーバーに保存' }).click();
  await expect(card.locator('.wv-memo-msg')).toHaveText('サーバーに保存しました（1 件）');
  await expect(card.locator('.wv-memo-st')).toHaveText('');
  expect(posted).toEqual([{ 'route:/': 'API のメモ（追記）' }]);
  expect(errors).toEqual([]);
});

test('差分（?prev= が v2）: 前にしか無い箱・項目・線は灰の点線、今だけの箱・線と型の変わった項目は緑の縁。幽霊は光らない', async ({
  page,
}) => {
  const errors = collectErrors(page);
  // 前の graph はテストのたびに例を写して作る（diff-fixture の prevOfToday）
  await page.route('**/prev-today.v2.json', (r) =>
    r.fulfill({ contentType: 'application/json', body: JSON.stringify(prevOfToday(sampleV2())) }),
  );
  await page.goto(`${V2_URL}&prev=prev-today.v2.json`);
  await waitReady(page);
  await page.keyboard.press('f');
  const d = (await dbg(page, 'diff'))!;
  expect(d.ghost.nodes).toEqual([E.ghostNode, E.ghostInHost, E.ghostBadHost, E.ghostScreen].sort());
  expect(d.added.nodes).toEqual([E.addedNode]);
  expect(d.changed).toEqual([E.changedItem]);

  const GRAY = 'rgb(107, 114, 128)';
  const GREEN = 'rgb(74, 222, 128)';
  const ghost = page.locator(`[data-ghost="${E.ghostNode}"] .shape`);
  await expect(ghost).toHaveCSS('stroke', GRAY);
  await expect(ghost).toHaveCSS('stroke-dasharray', /\d/);
  await expect(page.locator(`[data-box="${E.ghostNode}"]`)).toHaveCount(0);
  await expect(page.locator(`[data-box="${E.addedNode}"] .dmark`)).toHaveCSS('stroke', GREEN);
  const removed = page.locator(`[data-ghost-item="${E.removedItem}"]`);
  await expect(removed).toHaveCount(1);
  await expect(removed.locator('.hit')).toHaveCSS('stroke-dasharray', /\d/);
  await expect(page.locator(`[data-item="${E.changedItem}"] .hit`)).toHaveCSS('stroke', GREEN);
  await expect(page.locator('path[data-ghost-wire]')).toHaveCount(4);
  await expect(page.locator('path[data-ghost-wire]').first()).toHaveCSS('stroke', GRAY);
  await expect(page.locator('path.wire.thin.added')).toHaveCount(2);
  await expect(page.locator('path.wire.thin.added').first()).toHaveCSS('stroke', GREEN);

  // 選択は今の graph でたどる: 幽霊は光らず、クリックしても選べない（選択が解ける）
  await clickBox(page, 'fn:toTodayView');
  const lit = (await dbg(page, 'lit'))!;
  for (const id of d.ghost.nodes) expect(lit.boxes, id).not.toContain(id);
  await expect(page.locator(`[data-ghost="${E.ghostNode}"]`)).toHaveClass(/\bdim\b/);
  await expect(page.locator('g.lit-boxes [data-ghost]')).toHaveCount(0);
  await expect(page.locator('g.lit-wires [data-ghost-wire]')).toHaveCount(0);
  await clickBox(page, E.ghostNode, 'data-ghost');
  expect(await dbg(page, 'selection')).toBeNull();
  expect(errors).toEqual([]);
});

test('差分: 前の graph が v1 なら差分は出さず、題名の横に「前の graph が v1 です」', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto(`${V2_URL}&prev=samples/race-site.graph.json`);
  await waitReady(page);
  await expect(page.locator('.wv-top .wv-note')).toHaveText('前の graph が v1 です');
  expect(await dbg(page, 'diff')).toBeNull();
  await expect(page.locator('[data-ghost]')).toHaveCount(0);
  await expect(page.locator('.dmark')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('警告のリンク: 図の上の枠は出さず、題名の横の「警告 1 件」で一覧を開く。Esc（選択はそのまま）と外のクリックで閉じる', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto(V2_URL);
  await waitReady(page);
  await expect(page.locator('.issues')).toHaveCount(0);
  const link = page.locator('.wv-top [data-issues]');
  // 3D の地図へのリンク（.alt-link）と同じ並び・見た目
  await expect(link).toHaveText('警告 1 件');
  await expect(link).toHaveCSS('font-size', '11px');
  await expect(link).toHaveCSS('text-decoration-line', 'underline');
  const panel = page.locator('.wv-issues');
  await expect(panel).toBeHidden();
  await link.click();
  await expect(panel).toBeVisible();
  await expect(panel.locator('li.warning')).toHaveCount(1);

  await page.keyboard.press('f');
  await clickBox(page, 'route:/');
  await expect(panel).toBeHidden(); // 外のクリック
  await link.click();
  await expect(panel).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  // Esc は一覧だけを閉じる（選択は解けない）
  expect(await dbg(page, 'selection')).toEqual({ kind: 'box', id: 'route:/' });
  expect(errors).toEqual([]);
});
