// 配線図（graph.json v2）: docs/15 §3.5 の操作、分岐の表、切れている線、球と再生バー、Esc（Phase 8-0b）、
// 開いた直後の倍率と F キー（Phase 8-3a。docs/18 §3.2）
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { todayGraph } from '../../wiring/src/__tests__/fixture';
import { collectErrors, openWithGraph, waitReady } from './helpers';

const V2_URL = '?graph=samples/fixture-poly.today.v2.json';

function sampleV2(): { wires: { from: string; to: string }[] } {
  return JSON.parse(
    readFileSync(new URL('../../../examples/fixture-poly.today.v2.json', import.meta.url), 'utf8'),
  );
}

interface Lit {
  boxes: string[];
  items: string[];
  wires: string[];
  links: string[];
}
interface WiringDbg {
  selection: { kind: string } | null;
  lit: Lit | null;
  schedule: {
    cycle: number;
    balls: { key: string; kind: string; from: string; to: string; t0: number; dur: number }[];
  } | null;
  state: Record<string, boolean>;
  paused: boolean;
  size: { width: number; height: number };
  view: { k: number; tx: number; ty: number };
  time: number;
  select(sel: unknown): void;
  setPaused(p: boolean): void;
  seek(t: number): void;
  ballPositions(): { key: string; x: number; y: number; visible: boolean }[];
}
type Win = { __stackAtlas: { wiring: WiringDbg | null } };

const lit = (page: Page) =>
  page.evaluate(() => (window as unknown as Win).__stackAtlas.wiring!.lit);
const selection = (page: Page) =>
  page.evaluate(() => (window as unknown as Win).__stackAtlas.wiring!.selection);
const schedule = (page: Page) =>
  page.evaluate(() => (window as unknown as Win).__stackAtlas.wiring!.schedule);
const variantState = (page: Page) =>
  page.evaluate(() => (window as unknown as Win).__stackAtlas.wiring!.state);
const paused = (page: Page) =>
  page.evaluate(() => (window as unknown as Win).__stackAtlas.wiring!.paused);
const time = (page: Page) =>
  page.evaluate(() => (window as unknown as Win).__stackAtlas.wiring!.time);
const ballPositions = (page: Page) =>
  page.evaluate(() => (window as unknown as Win).__stackAtlas.wiring!.ballPositions());
const view = (page: Page) =>
  page.evaluate(() => (window as unknown as Win).__stackAtlas.wiring!.view);
const size = (page: Page) =>
  page.evaluate(() => (window as unknown as Win).__stackAtlas.wiring!.size);

/**
 * 開いて、検証の一覧（警告 1 件）を閉じる（画面の上の方の箱に重なるので）。
 * 2026-11-09 変更（8-3a）: 開いた直後は読める倍率で画面の箱のあたりだけを映すので、F キーで全体を映してから操作する
 * （以前は開いた直後が全体表示だった）
 */
async function openV2(page: Page) {
  await page.goto(V2_URL);
  await waitReady(page);
  await expect(page.locator('.wv')).toBeVisible();
  await expect(page.locator('.issues li.warning')).toHaveCount(1);
  await page.locator('.issues .x').click();
  await page.keyboard.press('f');
}

/** 箱の名前の帯（項目の行より上）を本物のマウスでクリックする */
async function clickBox(page: Page, id: string) {
  const b = (await page.locator(`[data-box="${id}"] .shape`).boundingBox())!;
  await page.mouse.click(b.x + b.width * 0.6, b.y + Math.min(3, b.height / 4));
}

/** 項目のピンをクリックする */
async function clickItem(page: Page, ref: string) {
  const b = (await page.locator(`[data-item="${ref}"] .pin`).boundingBox())!;
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
}

async function hoverBox(page: Page, id: string) {
  const b = (await page.locator(`[data-box="${id}"] .shape`).boundingBox())!;
  await page.mouse.move(b.x + b.width * 0.6, b.y + Math.min(3, b.height / 4));
}

const TODAY = [
  'route:/',
  'comp:TodayIsland',
  'fn:getToday',
  'endpoint:GET /today',
  'fn:internal/api.handleToday',
  'fn:internal/store.ListByDate',
  'schema:transactions',
];
const POST = [
  'endpoint:POST /transactions',
  'fn:createTransaction',
  'fn:internal/api.handleCreateTransaction',
  'fn:internal/store.InsertTransaction',
];

test('v2 を配線図で開く: 箱・枠・レーン、切れている線は選択なしで赤の破線', async ({ page }) => {
  const errors = collectErrors(page);
  await openV2(page);
  // host の枠になる箱（Lambda・Aurora）は箱ではなく枠
  await expect(page.locator('[data-box]')).toHaveCount(18);
  await expect(page.locator('[data-host]')).toHaveCount(2);
  await expect(page.locator('.lane-title')).toHaveText([
    '利用者・時刻',
    'ブラウザ',
    'エッジ・配信',
    'サーバー',
    'データ',
  ]);
  // 箱の種類は外側の左上
  await expect(page.locator('[data-box="route:/"] .kind')).toHaveText('screen');
  // 切れている線 3 件（2 本の線）。選択に関係なく描く。
  // 2026-11-09 変更（D46）: POST /transactions の amount（number → integer）は error から warn にしたので、
  // 赤（error）2 件・黄（warn）1 件
  const broken = page.locator('path[data-broken]');
  await expect(broken).toHaveCount(3);
  for (const el of await broken.all()) {
    await expect(el).toHaveClass(/\blit\b/);
    await expect(el).toHaveCSS('stroke-dasharray', /\d/);
  }
  const errorWires = page.locator('path[data-broken].error');
  const warnWires = page.locator('path[data-broken].warn');
  await expect(errorWires).toHaveCount(2);
  await expect(warnWires).toHaveCount(1);
  for (const el of await errorWires.all()) await expect(el).toHaveCSS('stroke', 'rgb(255, 59, 59)');
  await expect(warnWires).toHaveCSS('stroke', 'rgb(251, 191, 36)');
  await expect(page.locator('path.wire.broken.cut')).toHaveCount(3);
  // 選択前は球も再生バーも無い
  await expect(page.locator('.ball')).toHaveCount(0);
  await expect(page.locator('.wv-speed button.tl')).toBeHidden();
  expect(await selection(page)).toBeNull();
  expect(errors).toEqual([]);
});

test('画面をクリック: /today の経路が光り POST は光らない。球は画面から出る。Esc で解く', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await openV2(page);
  // hover は何も選んでいないときだけ
  await hoverBox(page, 'fn:getToday');
  await expect(page.locator('.box.hov')).toHaveCount(1);

  await clickBox(page, 'route:/');
  expect(await selection(page)).toEqual({ kind: 'box', id: 'route:/' });
  const l = (await lit(page))!;
  for (const id of [...TODAY, 'infra:static_site/this', 'infra:static_site/site'])
    expect(l.boxes, id).toContain(id);
  for (const id of POST) expect(l.boxes, id).not.toContain(id);
  await expect(page.locator('[data-box="route:/"]')).toHaveClass(/\bstart\b/);
  await expect(page.locator('[data-box="endpoint:POST /transactions"]')).toHaveClass(/\bdim\b/);
  // 光っている箱は手前の層
  await expect(page.locator('g.lit-boxes [data-box="fn:internal/api.handleToday"]')).toHaveCount(1);

  // 選択中は hover が効かない
  await hoverBox(page, 'comp:TotalCard');
  await expect(page.locator('.box.hov')).toHaveCount(0);

  // 球: 線ごとに 1 つ、最初の球は画面の出口から時刻 0 に出る
  await expect(page.locator('.ball').first()).toBeAttached();
  const sched = (await schedule(page))!;
  const first = sched.balls.filter((b) => b.kind === 'wire').sort((a, b) => a.t0 - b.t0)[0]!;
  expect(first.t0).toBe(0);
  expect(first.from).toBe('route:/#out/render_1');
  await page.evaluate(() => {
    const w = (window as unknown as Win).__stackAtlas.wiring!;
    w.setPaused(true);
    w.seek(0);
  });
  const pin = page.locator('[data-item="route:/#out/render_1"] .pin');
  const px = Number(await pin.getAttribute('cx'));
  const py = Number(await pin.getAttribute('cy'));
  const visible = (await ballPositions(page)).filter((b) => b.visible);
  expect(visible.length).toBeGreaterThan(0);
  expect(visible.some((b) => Math.abs(b.x - px) < 1 && Math.abs(b.y - py) < 1)).toBe(true);

  await page.keyboard.press('Escape');
  expect(await selection(page)).toBeNull();
  expect(await lit(page)).toBeNull();
  await expect(page.locator('.box.dim')).toHaveCount(0);
  await expect(page.locator('.ball')).toHaveCount(0);
  await expect(page.locator('.wv-speed button.tl')).toBeHidden();
  expect(errors).toEqual([]);
});

test('項目をクリック: その項目の系譜だけ。型をクリック: 横断面（光る線 0 本、球なし）', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await openV2(page);
  await clickItem(page, 'comp:EntryList#in/entries');
  expect(await selection(page)).toEqual({ kind: 'item', ref: 'comp:EntryList#in/entries' });
  const l = (await lit(page))!;
  for (const id of [...TODAY, 'fn:toTodayView', 'comp:EntryList'])
    expect(l.boxes, id).toContain(id);
  // 系譜の外（TotalCard は TodayIsland の別の出口の先、POST は別の経路）
  for (const id of ['comp:TotalCard', ...POST]) expect(l.boxes, id).not.toContain(id);
  expect(l.items).toContain('comp:TodayIsland#out/render_2.entries');
  expect(l.items).not.toContain('comp:TodayIsland#out/render_1');
  await expect(page.locator('[data-item="comp:EntryList#in/entries"]')).toHaveClass(/\bstart\b/);

  // 型（Entry）をクリック
  const ty = page.locator('[data-item="comp:EntryList#in/entries"] [data-type="type:Entry"]');
  const b = (await ty.boundingBox())!;
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  expect(await selection(page)).toEqual({ kind: 'type', typeRef: 'type:Entry' });
  const t = (await lit(page))!;
  expect(t.wires).toEqual([]);
  expect(t.links).toEqual([]);
  expect(t.boxes.length).toBeGreaterThan(3);
  await expect(page.locator('g.lit-wires path.wire.lit:not(.broken)')).toHaveCount(0);
  await expect(page.locator('.ball')).toHaveCount(0);
  await expect(page.locator('.wv-speed button.tl')).toBeHidden();
  expect(errors).toEqual([]);
});

test('分岐の表: CloudFront の hit と GET /today の login を切り替えると光る範囲が変わる（選択中でも出る）', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await openV2(page);
  await clickBox(page, 'route:/');
  expect((await lit(page))!.boxes).toContain('infra:static_site/site');

  await hoverBox(page, 'infra:static_site/this');
  const table = page.locator('.vtable-fo');
  await expect(table).toHaveCount(1);
  // 箱から表へポインタを動かしても（箱と表の間の隙間を通っても）表は消えない（2026-11-09 のレビュー指摘。
  // 間は透明な橋で、さらに離れても少し待ってから消す）
  const shape = (await page.locator('[data-box="infra:static_site/this"] .shape').boundingBox())!;
  const fo = (await table.boundingBox())!;
  await page.mouse.move(shape.x + shape.width - 2, fo.y + 8);
  await page.mouse.move(fo.x + 20, fo.y + 8, { steps: 8 });
  await page.waitForTimeout(300);
  await expect(table).toHaveCount(1);
  await expect(page.getByRole('checkbox', { name: 'cache hit: ない' })).toBeChecked();
  await page.getByRole('checkbox', { name: 'cache hit: ある' }).click();
  expect((await variantState(page))['infra:static_site/this#hit']).toBe(true);
  // HIT: S3 は光らず、CloudFront が画面へ折り返して、画面と下流は光ったまま
  let l = (await lit(page))!;
  expect(l.boxes).not.toContain('infra:static_site/site');
  for (const id of [...TODAY, 'infra:static_site/this']) expect(l.boxes, id).toContain(id);
  await expect(page.locator('path.wire.inner')).toHaveCount(1);
  expect(await selection(page)).toEqual({ kind: 'box', id: 'route:/' });
  await expect(page.getByRole('checkbox', { name: 'cache hit: ある' })).toBeChecked();

  // login（認証の middleware）: 未ログインなら GET /today の先は光らない
  await hoverBox(page, 'endpoint:GET /today');
  await page.getByRole('checkbox', { name: 'ログイン済み: ない' }).click();
  l = (await lit(page))!;
  expect(l.boxes).toContain('endpoint:GET /today');
  for (const id of ['fn:internal/api.handleToday', 'schema:transactions'])
    expect(l.boxes, id).not.toContain(id);

  // 箱からも表からも離れたら表は消える
  await page.mouse.move(5, 300);
  await expect(table).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('分岐の表: date（項目の when）を切ると項目が薄く残り、経路から外れる（モックを縮めた合成グラフ）', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await openWithGraph(page, todayGraph(), 'mock-today.v2.json');
  // 2026-11-09 変更（8-3a）: 全体を映してから操作する（openV2 と同じ）
  await page.keyboard.press('f');
  await clickBox(page, 'screen:/today');
  expect((await lit(page))!.boxes).toContain('hook:useToday');
  await hoverBox(page, 'screen:/today');
  await page.getByRole('checkbox', { name: 'date あり: ない' }).click();
  await expect(page.locator('[data-item="screen:/today#in/query_date"]')).toHaveClass(
    /\binactive\b/,
  );
  let l = (await lit(page))!;
  expect(l.boxes).not.toContain('hook:useToday');
  expect(l.boxes).toContain('comp:TodayIsland');
  // 未ログインは LoginPrompt だけ
  await hoverBox(page, 'screen:/today');
  await page.getByRole('checkbox', { name: 'ログイン済み: ない' }).click();
  l = (await lit(page))!;
  expect(l.boxes).toContain('comp:LoginPrompt');
  expect(l.boxes).not.toContain('comp:TodayIsland');
  expect(errors).toEqual([]);
});

test('再生バー: 一時停止で球が止まり、シークで球の位置が変わる。速さを変えると周期が変わる', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await openV2(page);
  await clickBox(page, 'route:/');
  const play = page.locator('.wv-speed button.tl');
  const seek = page.locator('.wv-speed .seek');
  await expect(play).toBeVisible();
  await expect(play).toHaveText('❚❚');
  await page.waitForTimeout(300);
  await play.click();
  await expect(play).toHaveText('▶');
  expect(await paused(page)).toBe(true);
  const t1 = await time(page);
  const p1 = await ballPositions(page);
  await page.waitForTimeout(500);
  expect(await time(page)).toBe(t1);
  expect(await ballPositions(page)).toEqual(p1);

  await seek.fill('6');
  await expect.poll(() => time(page)).toBeCloseTo(6, 1);
  const p2 = await ballPositions(page);
  expect(p2).not.toEqual(p1);
  // DOM の球も動く
  const cx = await page.locator('.ball[visibility="visible"]').first().getAttribute('cx');
  expect(cx).not.toBeNull();

  const c1 = (await schedule(page))!.cycle;
  await page.locator('.wv-speed .speed-in').fill('2');
  await expect(page.locator('.wv-speed .speed-v')).toHaveText('×2.0');
  const c2 = (await schedule(page))!.cycle;
  expect(c2).toBeCloseTo(c1 / 2, 1);
  expect(errors).toEqual([]);
});

test('光っている線をクリックするとその線から下流だけ。光っている箱をクリックすると下流だけ', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await openV2(page);
  await clickBox(page, 'route:/');
  // 線のキーは wires[] の順番（w<index>）。endpoint → handleToday の線
  const i = sampleV2().wires.findIndex(
    (w) => w.from === 'endpoint:GET /today#req/path' && w.to === 'fn:internal/api.handleToday#in/r',
  );
  expect(i).toBeGreaterThanOrEqual(0);
  // 当たり判定は経路に沿った太い透明の線なので、要素に直接クリックを送る（外接矩形の中心は線の上とは限らない）
  await page.locator(`path.wire.hitarea[data-wire="w${i}"]`).first().dispatchEvent('click');
  expect(await selection(page)).toEqual({
    kind: 'wire',
    from: 'endpoint:GET /today#req/path',
    to: 'fn:internal/api.handleToday#in/r',
  });
  let l = (await lit(page))!;
  expect(l.boxes).toContain('fn:internal/store.ListByDate');
  expect(l.boxes).not.toContain('actor:user');
  await expect(page.locator('path.wire.lit.sel')).toHaveCount(1);

  await clickBox(page, 'fn:internal/api.handleToday');
  expect(await selection(page)).toEqual({
    kind: 'box',
    id: 'fn:internal/api.handleToday',
    downOnly: true,
  });
  l = (await lit(page))!;
  expect(l.boxes).toContain('schema:transactions');
  expect(l.boxes).not.toContain('route:/');
  expect(errors).toEqual([]);
});

test('開いた直後は項目の文字が 6px 以上の倍率で画面の箱のあたり。F で全体（文字は出さない）。選択しても箱は動かない', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto(V2_URL);
  await waitReady(page);
  await expect(page.locator('.wv')).toBeVisible();
  // 項目の文字（10px）× 倍率 ≥ 6px。/today の例は全体だと 0.6 未満なので、画面の箱（route:/）のあたりを 0.6 で映す
  const v0 = await view(page);
  expect(v0.k).toBeGreaterThanOrEqual(0.6 - 1e-9);
  const vp = page.viewportSize()!;
  const screen = (await page.locator('[data-box="route:/"] .shape').boundingBox())!;
  expect(screen.x).toBeGreaterThanOrEqual(0);
  expect(screen.y).toBeGreaterThanOrEqual(0);
  expect(screen.x).toBeLessThan(vp.width);
  expect(screen.y).toBeLessThan(vp.height);
  const fontPx = await page
    .locator('[data-box="route:/"] .item text')
    .first()
    .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(fontPx * v0.k).toBeGreaterThanOrEqual(6 - 1e-9);

  // F: 全体が収まる倍率（左右 20px・上の帯 44px・下 36px の内側）。画面に文字は増えない
  const text = await page.locator('.wv').innerText();
  await page.keyboard.press('f');
  const v1 = await view(page);
  const s = await size(page);
  expect(v1.k).toBeLessThan(0.6);
  expect(s.width * v1.k).toBeLessThanOrEqual(vp.width - 40 + 1);
  expect(s.height * v1.k).toBeLessThanOrEqual(vp.height - 44 - 36 + 1);
  for (const id of ['actor:user', 'route:/', 'schema:transactions']) {
    const b = (await page.locator(`[data-box="${id}"] .shape`).boundingBox())!;
    expect(b.x, id).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width, id).toBeLessThanOrEqual(vp.width);
    expect(b.y + b.height, id).toBeLessThanOrEqual(vp.height);
  }
  expect(await page.locator('.wv').innerText()).toBe(text);

  // 選択・分岐の切り替えで箱の座標は変わらない（配置は graph ごとに 1 回）
  const rect = (id: string) =>
    page
      .locator(`[data-box="${id}"] .shape`)
      .evaluate((el) => ['x', 'y', 'width', 'height'].map((a) => el.getAttribute(a)).join(','));
  const before = await rect('fn:internal/api.handleToday');
  await page.evaluate(() => {
    const w = (window as unknown as Win).__stackAtlas.wiring!;
    w.select({ kind: 'box', id: 'route:/' });
  });
  expect(await rect('fn:internal/api.handleToday')).toBe(before);
  await page.evaluate(() => {
    const w = (window as unknown as Win).__stackAtlas.wiring! as unknown as {
      setVariant(n: string, v: string, value: boolean): void;
    };
    w.setVariant('infra:static_site/this', 'hit', true);
  });
  expect(await rect('fn:internal/api.handleToday')).toBe(before);
  expect(errors).toEqual([]);
});
