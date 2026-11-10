// 配線図の選択は作り直さず付け替える（docs/18 §11、D114〜D122。Phase 8-7）。確かめること:
// 選ぶ・解く・分岐・view で要素は同じもの（renders は変わらず paints が増える）、付け替えたあとの g.view の markup は
// 同じ状態で全体を作り直したものと同じ（等価。§11.8 の入力）、沈める表現の実際の値は §11.5 の表（DIM）、分岐の表の橋の位置、
// hover → クリックで hov が残らない、点滅が解除で止まる、場面を当て直しても（同じ配置・箱の幅を変えた配置・箱を抜いた配置）
// 選択・分岐・視点・球の割合が残り、クリックと hover が効く（根で受ける。docs/21 §2.9 の折りたたみへの継ぎ目）
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { DIM } from '../src/wiring/dim';
import { PREV_EDITS as E, prevOfToday } from '../../wiring/src/__tests__/diff-fixture';
import { todayGraph } from '../../wiring/src/__tests__/fixture';
import { collectErrors, openWithGraph, waitReady } from './helpers';

const SAMPLE = 'samples/fixture-poly.today.v2.json';
const V2_URL = `?graph=${SAMPLE}&pane=wiring`;

function sampleV2(): { wires: { from: string; to: string }[] } {
  return JSON.parse(
    readFileSync(new URL('../../../examples/fixture-poly.today.v2.json', import.meta.url), 'utf8'),
  );
}

interface WiringDbg {
  selection: unknown;
  lit: { boxes: string[]; items: string[]; wires: string[]; links: string[] } | null;
  schedule: { cycle: number } | null;
  state: Record<string, boolean>;
  paused: boolean;
  time: number;
  size: { width: number; height: number };
  view: { k: number; tx: number; ty: number };
  renders: number;
  paints: number;
  flashing: { timers: number; running: number };
  select(sel: unknown): void;
  setVariant(nodeId: string, variantId: string, value: boolean): void;
  setPaused(p: boolean): void;
  seek(t: number): void;
  viewHtml(): string;
  rebuild(opts?: { boxWidth?: number; omit?: string[] }): void;
}
type Win = { __stackAtlas: { wiring: WiringDbg | null }; __keep?: Element[] };

const dbg = <K extends keyof WiringDbg>(page: Page, key: K) =>
  page.evaluate((k) => (window as unknown as Win).__stackAtlas.wiring![k], key) as Promise<
    WiringDbg[K]
  >;
const counts = (page: Page) =>
  page.evaluate(() => {
    const w = (window as unknown as Win).__stackAtlas.wiring!;
    return { renders: w.renders, paints: w.paints };
  });

async function openV2(page: Page) {
  await page.goto(V2_URL);
  await waitReady(page);
  await page.keyboard.press('f');
}

/** 箱の名前の帯（項目の行より上）を本物のマウスでクリックする */
async function clickBox(page: Page, id: string) {
  const b = (await page.locator(`[data-box="${id}"] .shape`).boundingBox())!;
  await page.mouse.click(b.x + b.width * 0.6, b.y + Math.min(3, b.height / 4));
}
async function hoverBox(page: Page, id: string) {
  const b = (await page.locator(`[data-box="${id}"] .shape`).boundingBox())!;
  await page.mouse.move(b.x + b.width * 0.6, b.y + Math.min(3, b.height / 4));
}
async function clickItem(page: Page, ref: string) {
  const b = (await page.locator(`[data-item="${ref}"] .pin`).boundingBox())!;
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
}
/** ポインタを図の外の空白へ（hover と分岐の表を消す） */
async function leave(page: Page) {
  await page.mouse.move(8, 300);
  await expect(page.locator('.vtable-fo')).toHaveCount(0);
}

/** 2 つの文字列が違えば、最初に違う所の前後（等価が崩れたときに読める長さで出す） */
function firstDiff(a: string, b: string): string {
  if (a === b) return '';
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return `@${i}\n付け替え: …${a.slice(Math.max(0, i - 160), i + 160)}…\n作り直し: …${b.slice(Math.max(0, i - 160), i + 160)}…`;
}

/** 今の g.view（付け替えたあと）と、同じ状態で全体を作り直した g.view が同じ */
async function expectSameAsRebuilt(page: Page, label: string) {
  const [painted, rebuilt] = await page.evaluate(() => {
    const w = (window as unknown as Win).__stackAtlas.wiring!;
    const a = w.viewHtml();
    w.rebuild();
    return [a, w.viewHtml()];
  });
  expect(painted.length, label).toBeGreaterThan(1000);
  expect(firstDiff(painted, rebuilt), label).toBe('');
}

/** 付け替える要素（箱・項目・host・線）を覚える / 今も同じ要素か（順番ではなく集合で比べる。切れた線は層を移す） */
const SAME_SEL =
  '.wv-svg, .wv-svg g.view, g.view [data-box], g.view [data-item], g.view [data-host], g.view path.wire[data-key], g.view path[data-broken]';
const keep = (page: Page) =>
  page.evaluate((sel) => {
    (window as unknown as Win).__keep = [...document.querySelectorAll(sel)];
    return (window as unknown as Win).__keep!.length;
  }, SAME_SEL);
const sameElements = (page: Page) =>
  page.evaluate((sel) => {
    const kept = new Set((window as unknown as Win).__keep);
    const now = [...document.querySelectorAll(sel)];
    return { kept: kept.size, now: now.length, same: now.filter((el) => kept.has(el)).length };
  }, SAME_SEL);

test('選ぶ・解く・分岐・view は付け替えだけ: 要素は同じもの、renders は変わらず paints が 1 ずつ増える', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await openV2(page);
  expect(await counts(page)).toEqual({ renders: 1, paints: 0 });
  const n = await keep(page);
  expect(n).toBeGreaterThan(100);
  let p = 0;
  const step = async (label: string) => {
    p++;
    expect(await counts(page), label).toEqual({ renders: 1, paints: p });
    expect(await sameElements(page), label).toEqual({ kept: n, now: n, same: n });
  };

  await clickBox(page, 'route:/');
  await step('箱を選ぶ');
  await clickItem(page, 'comp:EntryList#in/entries');
  await step('項目を選ぶ');
  await page.evaluate(() =>
    (window as unknown as Win).__stackAtlas.wiring!.setVariant(
      'infra:static_site/this',
      'hit',
      true,
    ),
  );
  await step('分岐');
  await page.evaluate(() =>
    (window as unknown as Win).__stackAtlas.wiring!.select({ kind: 'type', typeRef: 'type:Entry' }),
  );
  await step('型を選ぶ');
  await page.evaluate(() =>
    (window as unknown as Win).__stackAtlas.wiring!.select({
      kind: 'host',
      id: 'infra:lambda_api/api',
    }),
  );
  await step('host を選ぶ');
  await page.keyboard.press('Escape');
  await step('解く');
  // view: 分岐を既定に戻して当て、始点から選ぶ（付け替えは 1 回）
  await page.locator('.wv-top select.wv-views').selectOption('today-cdn-hit');
  await step('view');
  await page.locator('.wv-top select.wv-views').selectOption('');
  await step('空の view（解く）');
  // 選んでいないときの Esc・空白のクリックは何も変わらないので付け替えない
  await page.keyboard.press('Escape');
  await page.mouse.click(8, 300);
  expect(await counts(page)).toEqual({ renders: 1, paints: p });
  expect(errors).toEqual([]);
});

test('付け替えたあとの g.view は、同じ状態で全体を作り直したものと同じ（等価。§11.8 の入力）', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await openV2(page);
  const W = (fn: (w: WiringDbg) => void) =>
    page.evaluate(`(${fn.toString()})(window.__stackAtlas.wiring)`);

  await expectSameAsRebuilt(page, '開いた直後（選択なし）');
  await clickBox(page, 'route:/');
  await leave(page);
  await expectSameAsRebuilt(page, '箱');
  await clickItem(page, 'comp:EntryList#in/entries');
  await leave(page);
  await expectSameAsRebuilt(page, '項目');
  const ty = page.locator('[data-item="comp:EntryList#in/entries"] [data-type="type:Entry"]');
  const tb = (await ty.boundingBox())!;
  await page.mouse.click(tb.x + tb.width / 2, tb.y + tb.height / 2);
  await leave(page);
  await expectSameAsRebuilt(page, '型（光る線 0 本）');
  // 光っている線のクリック（その線から下流だけ。光る区間の sel）
  await clickBox(page, 'route:/');
  const i = sampleV2().wires.findIndex(
    (w) => w.from === 'endpoint:GET /today#req/path' && w.to === 'fn:internal/api.handleToday#in/r',
  );
  await page.locator(`path.wire.hitarea[data-wire="w${i}"]`).first().dispatchEvent('click');
  expect(((await dbg(page, 'selection')) as { kind: string }).kind).toBe('wire');
  await leave(page);
  await expectSameAsRebuilt(page, '光る線');
  // 光っている箱のクリック（下流だけ）
  await clickBox(page, 'fn:internal/api.handleToday');
  await leave(page);
  await expectSameAsRebuilt(page, '下流だけ');
  // 分岐（選択中）: CloudFront の hit、GET /today の login
  await clickBox(page, 'route:/');
  await W((w) => w.setVariant('infra:static_site/this', 'hit', true));
  await leave(page);
  await expectSameAsRebuilt(page, '分岐 hit');
  await W((w) => w.setVariant('endpoint:GET /today', 'login', false));
  await expectSameAsRebuilt(page, '分岐 login なし（選択中）');
  // 分岐の表を出したまま（表は付け替えのあとも作り直しのあとも出し直す）
  await hoverBox(page, 'infra:static_site/this');
  await expect(page.locator('.vtable-fo')).toHaveCount(1);
  await expectSameAsRebuilt(page, '分岐の表を出したまま');
  await leave(page);
  // 再生中に解除（球の層の中身は比べない）。分岐は今の値のまま（login なしで沈んだ線・項目）
  await W((w) => w.setPaused(false));
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await expectSameAsRebuilt(page, '再生中に解除（分岐 login なし）');
  // 実マウスの hover → クリック（hover の hov は選ぶと消える）
  await W((w) => w.setVariant('endpoint:GET /today', 'login', true));
  await hoverBox(page, 'fn:getToday');
  await expect(page.locator('[data-box="fn:getToday"]')).toHaveClass(/\bhov\b/);
  await expectSameAsRebuilt(page, 'hover（選択なし）');
  await clickBox(page, 'comp:TotalCard');
  await expect(page.locator('.hov')).toHaveCount(0);
  await expectSameAsRebuilt(page, 'hover → クリック');
  // view
  await page.locator('.wv-top select.wv-views').selectOption('today-cdn-hit');
  await leave(page);
  await expectSameAsRebuilt(page, 'view');
  await page.keyboard.press('Escape');
  await expectSameAsRebuilt(page, 'view を解く');
  expect(errors).toEqual([]);
});

test('等価: 差分（幽霊・今だけ・型の変わった項目）とメモの印があっても同じ', async ({ page }) => {
  const errors = collectErrors(page);
  await page.route('**/prev-today.v2.json', (r) =>
    r.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(prevOfToday(JSON.parse(JSON.stringify(sampleV2())))),
    }),
  );
  await page.route('**/samples/memos.json', (r) =>
    r.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ 'route:/': '画面のメモ', 'fn:getToday': 'メモ' }),
    }),
  );
  await page.goto(`${V2_URL}&prev=prev-today.v2.json`);
  await waitReady(page);
  await page.keyboard.press('f');
  await expect(page.locator(`[data-ghost="${E.ghostNode}"]`)).toHaveCount(1);
  await expect(page.locator('[data-box="route:/"] .memo-fold')).toHaveCount(1);
  await expectSameAsRebuilt(page, '差分・選択なし');
  await clickBox(page, 'fn:toTodayView');
  await leave(page);
  // 幽霊は lit にならず、根の has-sel で沈む（要素に class は付かない）
  await expect(page.locator('[data-ghost].lit')).toHaveCount(0);
  await expectSameAsRebuilt(page, '差分・選択中');
  await clickBox(page, E.addedNode);
  await leave(page);
  await expectSameAsRebuilt(page, '差分・今だけの箱を選ぶ');
  await page.keyboard.press('Escape');
  await expectSameAsRebuilt(page, '差分・解く');
  expect(errors).toEqual([]);
});

test('沈める表現の実際の値は §11.5 の表（DIM）: 箱 × 項目の積、線、host、切れた線、沈んだラベル', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await openV2(page);
  const op = (sel: string) =>
    page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return null;
      const cs = getComputedStyle(el);
      return {
        fill: Number(cs.fillOpacity),
        stroke: Number(cs.strokeOpacity),
        opacity: Number(cs.opacity),
        visibility: cs.visibility,
      };
    }, sel);
  const near = (v: number | undefined, want: number, label: string) =>
    expect(v, label).toBeCloseTo(want, 4);

  // 選択なし: 箱と項目は 1、線は wire
  near((await op('[data-box="route:/"] .shape'))?.fill, 1, '箱（選択なし）');
  near((await op('.box .item'))?.fill, 1, '項目（選択なし）');
  near((await op('path.wire.thin:not(.inactive):not(.ghost):not(.added)'))?.stroke, DIM.wire, '線');

  // 選択中
  await clickBox(page, 'route:/');
  await leave(page);
  const sunk = '[data-box="endpoint:POST /transactions"]';
  near((await op(`${sunk} .shape`))?.fill, DIM.box, '沈んだ箱の面');
  near((await op(`${sunk} .shape`))?.stroke, DIM.box, '沈んだ箱の縁');
  expect((await op(`${sunk} text`))?.visibility, '沈んだ箱のラベル').toBe('hidden');
  near((await op(`${sunk} .item`))?.fill, DIM.box * DIM.itemOff, '沈んだ箱の項目（積）');
  near((await op('[data-box="route:/"] .shape'))?.fill, 1, '光る箱');
  near((await op('.box.lit .item.on'))?.fill, 1, '光る項目');
  const offInLit = await op('.box.lit .item:not(.on):not(.inactive):not(.ghost)');
  expect(offInLit, '光る箱の中の光らない項目がある').not.toBeNull();
  near(offInLit!.fill, DIM.itemOff, '光る箱の中の光らない項目');
  near(
    (await op('path.wire.thin:not(.under):not(.inactive):not(.ghost):not(.added):not(.broken)'))
      ?.stroke,
    DIM.wireSel,
    '沈んだ線',
  );
  expect((await op('path.wire.thin.under'))?.visibility, '光る線の下の基の線').toBe('hidden');
  // 切れた線: 送り側の箱が光らないものは沈む（POST /transactions の amount）
  const brokenOff = await op('path.wire.broken:not(.lit)');
  expect(brokenOff, '光らない切れた線がある').not.toBeNull();
  near(brokenOff!.stroke, DIM.brokenOff, '光らない切れた線');
  // host: 下流だけの選択（TotalCard から下）ではサーバーとデータの枠は光らない
  await page.evaluate(() =>
    (window as unknown as Win).__stackAtlas.wiring!.select({
      kind: 'box',
      id: 'comp:TotalCard',
      downOnly: true,
    }),
  );
  near((await op('.host:not(.lit) .frame'))?.fill, DIM.box, '沈んだ host の枠');
  expect((await op('.host:not(.lit) text'))?.visibility, '沈んだ host のラベル').toBe('hidden');
  expect(errors).toEqual([]);
});

test('分岐で外れた項目と線（inactive）: 項目は選択に関係なく itemInactive、線は wireInactive / wireSelInactive', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await openWithGraph(page, todayGraph(), 'mock-today.v2.json', '&pane=wiring');
  await page.keyboard.press('f');
  await clickBox(page, 'screen:/today');
  await hoverBox(page, 'screen:/today');
  await page.getByRole('checkbox', { name: 'date あり: ない' }).click();
  const item = page.locator('[data-item="screen:/today#in/query_date"]');
  await expect(item).toHaveClass(/\binactive\b/);
  await expect(item).toHaveCSS('fill-opacity', String(DIM.itemInactive));
  const wire = page.locator('path.wire.thin.inactive').first();
  await expect(wire).toHaveCSS('stroke-opacity', String(DIM.wireSelInactive));
  await page.keyboard.press('Escape');
  await expect(item).toHaveCSS('fill-opacity', String(DIM.itemInactive));
  await expect(wire).toHaveCSS('stroke-opacity', String(DIM.wireInactive));
  expect(errors).toEqual([]);
});

test('hover は選ぶと消え、Esc のあとは効く。点滅は解除で 0。分岐の表の橋は光る線の層の直前', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await openV2(page);
  await hoverBox(page, 'fn:getToday');
  await expect(page.locator('[data-box="fn:getToday"]')).toHaveClass(/\bhov\b/);
  expect(await page.locator('path.wire.hov').count()).toBeGreaterThan(0);
  await clickBox(page, 'route:/');
  await expect(page.locator('.hov')).toHaveCount(0);
  // 選択中の hover は効かない
  await hoverBox(page, 'comp:TotalCard');
  await expect(page.locator('.hov')).toHaveCount(0);

  // 点滅: 再生中は球が出た・着いた項目が光る。解除・選び直しで 0
  await expect
    .poll(async () => {
      const f = await dbg(page, 'flashing');
      return f.timers + f.running;
    })
    .toBeGreaterThan(0);
  await clickBox(page, 'comp:TotalCard');
  await page.keyboard.press('Escape');
  expect(await dbg(page, 'flashing')).toEqual({ timers: 0, running: 0 });

  // Esc のあとは hover が効く（ポインタを動かしたら）
  await hoverBox(page, 'comp:TotalCard');
  await expect(page.locator('[data-box="comp:TotalCard"]')).toHaveClass(/\bhov\b/);
  await leave(page);
  await expect(page.locator('.hov')).toHaveCount(0);
  // 分岐の表（と箱との間の橋）の上へ動かしても、表の持ち主の箱の hover は残る（2026-11-10 追加。8-7 のレビュー指摘）
  await hoverBox(page, 'infra:static_site/this');
  const fo0 = page.locator('.vtable-fo');
  await expect(fo0).toHaveCount(1);
  const fb = (await fo0.boundingBox())!;
  const sb = (await page.locator('[data-box="infra:static_site/this"] .shape').boundingBox())!;
  await page.mouse.move(sb.x + sb.width - 2, fb.y + 8);
  await page.mouse.move(fb.x + 20, fb.y + 8, { steps: 8 });
  await expect(fo0).toHaveCount(1);
  await expect(page.locator('[data-box="infra:static_site/this"]')).toHaveClass(/\bhov\b/);
  await leave(page);

  // 分岐の表の橋: 光る線の層の直前（箱の下、host の上。表は箱の上に出るが、橋が光る線を塞がない）
  await clickBox(page, 'route:/');
  await hoverBox(page, 'infra:static_site/this');
  await expect(page.locator('.vtable-fo')).toHaveCount(1);
  const next = () =>
    page.evaluate(() => {
      const b = document.querySelector('.vtable-bridge');
      return b?.nextElementSibling?.getAttribute('class') ?? null;
    });
  expect(await next()).toBe('lit-wires');
  // 作り直したあとも同じ位置
  await page.evaluate(() => (window as unknown as Win).__stackAtlas.wiring!.rebuild());
  await expect(page.locator('.vtable-fo')).toHaveCount(1);
  expect(await next()).toBe('lit-wires');
  expect(errors).toEqual([]);
});

test('場面を当て直す（同じ配置 2 回・箱の幅を変えた配置・箱を抜いた配置）: 選択・分岐・視点・球の割合が残り、クリックと hover が効く', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await openV2(page);
  await clickBox(page, 'route:/');
  await page.evaluate(() => {
    const w = (window as unknown as Win).__stackAtlas.wiring!;
    w.setVariant('infra:static_site/this', 'hit', true);
    w.setPaused(true);
    w.seek(1.2);
  });
  await leave(page);
  const before = await page.evaluate(() => {
    const w = (window as unknown as Win).__stackAtlas.wiring!;
    return {
      selection: w.selection,
      lit: w.lit,
      state: w.state,
      view: w.view,
      ratio: w.time / w.schedule!.cycle,
      renders: w.renders,
      size: w.size,
    };
  });
  const now = () =>
    page.evaluate(() => {
      const w = (window as unknown as Win).__stackAtlas.wiring!;
      return {
        selection: w.selection,
        lit: w.lit,
        state: w.state,
        view: w.view,
        ratio: w.time / w.schedule!.cycle,
        renders: w.renders,
        size: w.size,
        paused: w.paused,
      };
    });

  // 同じ配置を 2 回
  for (const k of [1, 2]) {
    await page.evaluate(() => (window as unknown as Win).__stackAtlas.wiring!.rebuild());
    const a = await now();
    expect(a.renders).toBe(before.renders + k);
    expect(a.selection).toEqual(before.selection);
    expect(a.lit).toEqual(before.lit);
    expect(a.state).toEqual(before.state);
    expect(a.view).toEqual(before.view);
    expect(a.paused).toBe(true);
    expect(a.ratio).toBeCloseTo(before.ratio, 3);
  }
  await expect(page.locator('[data-box="route:/"]')).toHaveClass(/\bstart\b/);
  await expect(page.locator('.wv')).toHaveClass(/\bhas-sel\b/);

  // 箱の幅を変えた配置: 図は広くなる。選択・分岐・視点・球の割合は残る
  await page.evaluate(() =>
    (window as unknown as Win).__stackAtlas.wiring!.rebuild({ boxWidth: 360 }),
  );
  const wide = await now();
  expect(wide.size.width).toBeGreaterThan(before.size.width);
  expect(wide.selection).toEqual(before.selection);
  expect(wide.lit).toEqual(before.lit);
  expect(wide.state).toEqual(before.state);
  expect(wide.view).toEqual(before.view);
  expect(wide.ratio).toBeCloseTo(before.ratio, 3);
  const shape = (await page.locator('[data-box="route:/"] .shape').boundingBox())!;
  expect(shape.width / before.view.k).toBeGreaterThan(300);

  // 当て直したあとも、クリック・hover・光る線のクリックは効く（svg の根で受けている）
  await page.keyboard.press('Escape');
  await hoverBox(page, 'comp:TotalCard');
  await expect(page.locator('[data-box="comp:TotalCard"]')).toHaveClass(/\bhov\b/);
  await clickBox(page, 'fn:getToday');
  expect(await dbg(page, 'selection')).toEqual({ kind: 'box', id: 'fn:getToday' });
  const i = sampleV2().wires.findIndex(
    (w) => w.from === 'endpoint:GET /today#req/path' && w.to === 'fn:internal/api.handleToday#in/r',
  );
  await page.locator(`path.wire.hitarea[data-wire="w${i}"]`).first().dispatchEvent('click');
  expect(((await dbg(page, 'selection')) as { kind: string }).kind).toBe('wire');
  await expectSameAsRebuilt(page, '幅を変えた配置で付け替え');

  // 箱を抜いた配置（折りたたみの練習）: 箱と両端の線が消え、omit: [] で戻る。選択はそのまま
  await page.keyboard.press('Escape');
  await clickBox(page, 'route:/');
  const sel = await dbg(page, 'selection');
  const wiresOf = () => page.locator('g.base-wires path[data-key]').count();
  const w0 = await wiresOf();
  await page.evaluate(() =>
    (window as unknown as Win).__stackAtlas.wiring!.rebuild({ omit: ['comp:TotalCard'] }),
  );
  await expect(page.locator('[data-box="comp:TotalCard"]')).toHaveCount(0);
  expect(await wiresOf()).toBeLessThan(w0);
  expect(await dbg(page, 'selection')).toEqual(sel);
  // 光っている箱のクリックは下流だけ（downOnly）
  await clickBox(page, 'fn:getToday');
  expect(await dbg(page, 'selection')).toEqual({ kind: 'box', id: 'fn:getToday', downOnly: true });
  await page.evaluate(() => (window as unknown as Win).__stackAtlas.wiring!.rebuild({ omit: [] }));
  await expect(page.locator('[data-box="comp:TotalCard"]')).toHaveCount(1);
  expect(await wiresOf()).toBe(w0);
  expect(errors).toEqual([]);
});
