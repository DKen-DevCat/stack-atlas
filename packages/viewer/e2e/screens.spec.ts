// 画面の箱の中のビルド成果物の HTML（docs/18 §3.3・§4「画面」、D62・D63。Phase 8-3b）。
// fixture-poly と fixture-repo を `stack-atlas build` で一時ディレクトリに出し、ビューアと同じ origin の built-screens/ の下で
// 配る（screens/ の下は serve と同じ CSP の応答ヘッダ付き）。確かめること: 画面の箱に消毒した HTML の iframe が出る、
// 標準モード、自分以外の origin への通信 0、script の実行 0、[data-component] の領域（id と座標 ±4px）、選んだ経路の部品の枠、
// 沈んだ画面の不透明度、読み込みの規則（縮小すると外す）、読めないとき（ファイルで開いた・別 origin）はプレースホルダと graph の regions
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { collectErrors, waitReady } from './helpers';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
/** serve の応答ヘッダの CSP（packages/cli の SCREENS_CSP。e2e は CLI を import しないので文字列を読む） */
const SCREENS_CSP = /SCREENS_CSP =\s*"([^"]+)"/.exec(
  readFileSync(new URL('../../cli/src/commands/serve.ts', import.meta.url), 'utf8'),
)![1]!;
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
};

interface Region {
  ref: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
interface ScreensDbg {
  live: string[];
  state: Record<string, string>;
  measured: Record<string, Region[]>;
  regions: Record<string, Region[]>;
}
type Win = {
  __stackAtlas: {
    wiring: { screens: ScreensDbg; select(sel: unknown): void; view: { k: number } } | null;
  };
  __ran?: number;
};

let out = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  test.setTimeout(240_000);
  out = mkdtempSync(join(realpathSync(tmpdir()), 'sa-e2e-screens-'));
  for (const name of ['fixture-poly', 'fixture-repo'])
    execFileSync(
      'pnpm',
      ['atlas', 'build', `examples/${name}`, '-o', join(out, name), '--no-screenshots'],
      { cwd: ROOT, stdio: 'pipe' },
    );
});

test.afterAll(() => {
  if (out) rmSync(out, { recursive: true, force: true });
});

interface ServeOpts {
  /** screens/ の下に付ける応答ヘッダの CSP（null は付けない） */
  csp?: string | null;
  /** 差し替える中身（out からの相対パス → 本文） */
  override?: Record<string, string>;
}

/** built-screens/<name>/ の下で build の出力を配る（ビューアと同じ origin） */
async function serveBuilt(page: Page, name: string, opts: ServeOpts = {}) {
  const dir = join(out, name);
  await page.route(`**/built-screens/${name}/**`, (route) => {
    const url = new URL(route.request().url());
    const rel = decodeURIComponent(url.pathname.slice(`/built-screens/${name}/`.length));
    const file = normalize(join(dir, rel));
    const headers: Record<string, string> = {
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    };
    const csp = opts.csp === undefined ? SCREENS_CSP : opts.csp;
    if (rel.startsWith('screens/') && csp) {
      headers['Content-Security-Policy'] = csp;
      headers['X-Content-Type-Options'] = 'nosniff';
    }
    const body = opts.override?.[rel];
    if (body !== undefined) return route.fulfill({ status: 200, headers, body });
    if (!file.startsWith(dir + sep) || !existsSync(file) || !statSync(file).isFile())
      return route.fulfill({ status: 404, body: 'not found' });
    return route.fulfill({ status: 200, headers, body: readFileSync(file) });
  });
}

const screens = (page: Page) =>
  page.evaluate(() => (window as unknown as Win).__stackAtlas.wiring!.screens);
const select = (page: Page, sel: unknown) =>
  page.evaluate((s) => (window as unknown as Win).__stackAtlas.wiring!.select(s), sel);
/** 画面の箱の iframe */
const frameOf = (page: Page, id: string) => page.locator(`.wv-screen[data-screen="${id}"] iframe`);

/** ビューアの URL（playwright.config の baseURL） */
const baseURL = () => test.info().project.use.baseURL!;

/** 自分（ビューア）以外の origin への通信を集める（data: は通信ではない） */
function collectForeign(page: Page): string[] {
  const origin = new URL(baseURL()).origin;
  const foreign: string[] = [];
  page.on('request', (r) => {
    const u = r.url();
    if (u.startsWith('data:')) return;
    if (new URL(u).origin !== origin) foreign.push(u);
  });
  return foreign;
}

async function openBuilt(page: Page, name: string, opts: ServeOpts = {}) {
  await serveBuilt(page, name, opts);
  await page.goto(`?graph=built-screens/${name}/graph.json`);
  await waitReady(page);
  await expect(page.locator('.wv')).toBeVisible();
  // 検証の一覧（あれば）を閉じる
  const x = page.locator('.issues .x');
  if (await x.count()) await x.click();
}

/** 画面の HTML を 1280×800 で直接開いて [data-component] を測る（ビューアと独立の基準） */
async function measureDirect(browser: Browser, name: string, rel: string, component: string) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, bypassCSP: true });
  const p = await ctx.newPage();
  await serveBuilt(p, name, { csp: null });
  await p.goto(new URL(`built-screens/${name}/${rel}`, baseURL()).href);
  const box = (await p.locator(`[data-component="${component}"]`).first().boundingBox())!;
  await ctx.close();
  return box;
}

test('fixture-poly: / の画面の箱に消毒した HTML の iframe（標準モード・script 0・外への通信 0）、TodayIsland の領域', async ({
  page,
  browser,
}) => {
  const errors = collectErrors(page);
  const foreign = collectForeign(page);
  await openBuilt(page, 'fixture-poly');

  // 開いた直後（倍率 0.6。画面の箱は 360px 幅）に読み、[data-component] を測り終える
  await expect.poll(async () => (await screens(page)).measured['route:/']?.length ?? 0).toBe(1);
  const s = await screens(page);
  expect(s.live).toContain('route:/');
  expect(s.state['route:/']).toBe('ready');

  const frame = frameOf(page, 'route:/');
  await expect(frame).toHaveAttribute('sandbox', 'allow-same-origin');
  await expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
  expect(await frame.getAttribute('src')).toMatch(
    /\/built-screens\/fixture-poly\/screens\/index\/index\.html$/,
  );
  const doc = await frame.evaluate((f: HTMLIFrameElement) => {
    const d = f.contentDocument!;
    const head = [...d.head.children];
    const csp = head.findIndex((e) => e.getAttribute('http-equiv') === 'Content-Security-Policy');
    const firstRes = head.findIndex((e) => e.tagName === 'LINK' || e.tagName === 'STYLE');
    return {
      compat: d.compatMode,
      scripts: d.querySelectorAll('script').length,
      noscript: d.querySelectorAll('noscript, iframe, object, embed').length,
      csp,
      firstRes,
      h1: d.querySelector('h1')?.textContent,
      comps: [...d.querySelectorAll('[data-component]')].map((e) =>
        e.getAttribute('data-component'),
      ),
      w: f.offsetWidth,
      h: f.offsetHeight,
    };
  });
  expect(doc.compat).toBe('CSS1Compat');
  expect(doc.scripts).toBe(0);
  expect(doc.noscript).toBe(0);
  expect(doc.csp).toBe(0); // CSP の meta が head の最初の子（全部の link / style より前）
  expect(doc.firstRes).toBeGreaterThan(doc.csp);
  expect(doc.h1).toBe('支出トラッカー');
  expect(doc.comps).toEqual(['TodayIsland']);
  // iframe はビューポートの大きさ（1280×800）で、領域の幅に縮める
  expect([doc.w, doc.h]).toEqual([1280, 800]);

  // 領域: id と座標（直接 1280×800 で開いて測った値と ±4px）
  const direct = await measureDirect(
    browser,
    'fixture-poly',
    'screens/index/index.html',
    'TodayIsland',
  );
  const r = s.measured['route:/']![0]!;
  expect(r.ref).toBe('comp:TodayIsland');
  expect(Math.abs(r.x - direct.x)).toBeLessThanOrEqual(4);
  expect(Math.abs(r.y - direct.y)).toBeLessThanOrEqual(4);
  expect(Math.abs(r.w - direct.width)).toBeLessThanOrEqual(4);
  expect(Math.abs(r.h - direct.height)).toBeLessThanOrEqual(4);

  // 何も選んでいないときは枠を描かない
  await expect(page.locator('.wv g.regions rect.region')).toHaveCount(0);
  expect(foreign).toEqual([]);
  expect(errors).toEqual([]);
});

test('fixture-poly: route:/ を選ぶと TodayIsland の領域の枠（SVG）が画面の上の同じ所に出る。沈んだ画面は iframe も薄く', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await openBuilt(page, 'fixture-poly');
  await expect.poll(async () => (await screens(page)).measured['route:/']?.length ?? 0).toBe(1);

  await select(page, { kind: 'box', id: 'route:/' });
  const outline = page.locator(
    '.wv g.regions rect.region[data-region="comp:TodayIsland"][data-screen="route:/"]',
  );
  await expect(outline).toHaveCount(1);
  // 枠の位置 = iframe の中の要素の位置（ページの座標。縮小を掛けたもの）
  const want = await frameOf(page, 'route:/').evaluate((f: HTMLIFrameElement) => {
    const fr = f.getBoundingClientRect();
    const k = fr.width / f.offsetWidth;
    const el = f.contentDocument!.querySelector('[data-component="TodayIsland"]')!;
    const r = el.getBoundingClientRect();
    return { x: fr.x + r.x * k, y: fr.y + r.y * k, w: r.width * k, h: r.height * k };
  });
  const got = (await outline.boundingBox())!;
  // 枠の線の太さ（1.5 × 倍率）の分だけ外に広がる
  expect(Math.abs(got.x - want.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(got.y - want.y)).toBeLessThanOrEqual(2);
  expect(Math.abs(got.width - want.w)).toBeLessThanOrEqual(3);
  expect(Math.abs(got.height - want.h)).toBeLessThanOrEqual(3);
  // 選んだ画面は不透明、経路に入らない画面（/calendar）は箱と同じ 0.15。
  // 当てた値（style）で見る: 計算値は CSS の transition の途中の値で、ヘッドレスで並列に走らせるとフレームが進まず止まることがある
  const opacity = (id: string) =>
    page
      .locator(`.wv-screen[data-screen="${id}"]`)
      .evaluate((e) => (e as HTMLElement).style.opacity);
  await expect.poll(() => opacity('route:/')).toBe('1');
  await expect.poll(() => opacity('route:/calendar')).toBe('0.15');
  // 選んでも箱は動かない（画面の層も同じ）
  const s = await screens(page);
  expect(s.live).toContain('route:/calendar');

  // 選択を解くと枠は消え、不透明に戻る
  await page.keyboard.press('Escape');
  await expect(outline).toHaveCount(0);
  await expect.poll(() => opacity('route:/calendar')).toBe('1');
  expect(errors).toEqual([]);
});

test('読み込みの規則: 全体表示（F）で画面の箱が 200px 未満になると iframe を外してプレースホルダ、拡大するとまた読む', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await openBuilt(page, 'fixture-poly');
  await expect.poll(async () => (await screens(page)).live.length).toBeGreaterThan(0);

  await page.keyboard.press('f');
  await expect.poll(async () => (await screens(page)).live).toEqual([]);
  await expect(page.locator('.wv-screen')).toHaveCount(0);
  const ph = page.locator('[data-screen-ph="route:/"]');
  await expect(ph).toHaveAttribute('data-state', 'idle');
  await expect(ph.locator('text')).toHaveText('拡大すると画面を表示');
  // 測った領域は残る（外しても枠は描ける）
  expect((await screens(page)).measured['route:/']).toHaveLength(1);

  // ctrl ＋ ホイールで拡大（ピンチと同じ）
  const box = (await page.locator('[data-box="route:/"] .shape').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -120);
  await page.keyboard.up('Control');
  await expect.poll(async () => (await screens(page)).live).toContain('route:/');
  await expect(ph).toHaveAttribute('data-state', 'ready');
  expect(errors).toEqual([]);
});

test('script は動かない: 消毒をすり抜けた script・on* 属性・javascript: と、document のメソッドを隠す名前付きの要素', async ({
  page,
}) => {
  const errors = collectErrors(page);
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  // 消毒していない HTML を CSP の応答ヘッダも無しで配る（iframe の sandbox だけで止まること）
  const evil =
    '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0">' +
    '<img name="querySelectorAll" alt=""><img name="fonts" alt=""><img name="images" alt="">' +
    "<script>parent.__ran = 1; fetch('/__ran?script');</script>" +
    '<img src="/__ran.png" onerror="parent.__ran = 2" alt="">' +
    '<a id="js" href="javascript:parent.__ran=3">x</a>' +
    // form の中の名前付きの input は form 自身のメソッド（getAttribute・getBoundingClientRect）を隠す
    '<form data-component="TodayIsland" style="position:absolute;left:100px;top:50px;width:300px;height:40px;margin:0">' +
    '<input type="hidden" name="getAttribute"><input type="hidden" name="getBoundingClientRect"></form>' +
    '</body></html>';
  await openBuilt(page, 'fixture-poly', {
    csp: null,
    override: { 'screens/index/index.html': evil },
  });
  await expect.poll(async () => (await screens(page)).measured['route:/']?.length ?? 0).toBe(1);
  expect((await screens(page)).measured['route:/']).toEqual([
    { ref: 'comp:TodayIsland', x: 100, y: 50, w: 300, h: 40 },
  ]);
  expect(await page.evaluate(() => (window as unknown as Win).__ran)).toBeUndefined();
  // script の fetch は出ない（img の /__ran.png は画像の読み込みで、script ではない）
  expect(requests.filter((u) => u.includes('/__ran?'))).toEqual([]);
  // 名前付きの要素が document と form のメソッドを隠している（ビューアは prototype から呼ぶので測れた）
  const shadowed = await frameOf(page, 'route:/').evaluate((f: HTMLIFrameElement) => {
    const d = f.contentDocument as unknown as Record<string, unknown>;
    const form = (f.contentDocument!.forms[0] ?? null) as unknown as Record<string, unknown> | null;
    return [typeof d.querySelectorAll, typeof form?.getAttribute];
  });
  expect(shadowed).toEqual(['object', 'object']);
  // ブラウザが sandbox で止めたことを console に出す（script と onerror）。画像の読み込み失敗（/__ran.png）も除く
  const blocked = errors.filter((e) => /Blocked script execution .*'allow-scripts'/.test(e));
  expect(blocked.length).toBeGreaterThan(0);
  expect(errors.filter((e) => !blocked.includes(e) && !/Failed to load resource/.test(e))).toEqual(
    [],
  );
});

test('読めないとき: 応答ヘッダの sandbox に allow-same-origin が無い（別 origin）→ プレースホルダと graph の regions', async ({
  page,
}) => {
  const errors = collectErrors(page);
  // graph.json の route:/ に regions を足す（graph の regions は計測より優先し、読めないときも描ける）
  const g = JSON.parse(readFileSync(join(out, 'fixture-poly', 'graph.json'), 'utf8')) as {
    nodes: { id: string; screen?: { regions?: Region[] } }[];
  };
  g.nodes.find((n) => n.id === 'route:/')!.screen!.regions = [
    { ref: 'comp:TodayIsland', x: 10, y: 20, w: 300, h: 50 },
  ];
  await openBuilt(page, 'fixture-poly', {
    csp: 'sandbox',
    override: { 'graph.json': JSON.stringify(g) },
  });
  await expect.poll(async () => (await screens(page)).state['route:/']).toBe('blocked');
  await expect(page.locator('.wv-screen[data-screen="route:/"]')).toHaveCount(0);
  const ph = page.locator('[data-screen-ph="route:/"]');
  await expect(ph).toBeVisible();
  await expect(ph.locator('text')).toHaveText('画面の HTML を読めません（別の origin）');
  expect((await screens(page)).regions['route:/']).toEqual([
    { ref: 'comp:TodayIsland', x: 10, y: 20, w: 300, h: 50 },
  ]);
  await select(page, { kind: 'box', id: 'route:/' });
  await expect(
    page.locator('.wv g.regions rect.region[data-region="comp:TodayIsland"]'),
  ).toHaveCount(1);
  // 不透明な origin の文書では CSP の 'self' が合わず、資産の読み込みが拒まれることがある（画面は出さないので関係ない）
  expect(errors.filter((e) => !/Content Security Policy|Refused to/.test(e))).toEqual([]);
});

test('ファイルで開いたとき（相対パスを解けない）は iframe を出さず、プレースホルダ', async ({
  page,
}) => {
  const errors = collectErrors(page);
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  await page.goto('./');
  await page
    .locator('.empty input[type=file]')
    .setInputFiles(join(out, 'fixture-poly', 'graph.json'));
  await waitReady(page);
  await expect(page.locator('.wv')).toBeVisible();
  const s = await screens(page);
  expect(s.live).toEqual([]);
  expect(s.state['route:/']).toBe('nobase');
  await expect(page.locator('[data-screen-ph="route:/"] text')).toHaveText(
    'graph.json を URL で開くと画面を表示',
  );
  expect(requests.filter((u) => u.includes('/screens/'))).toEqual([]);
  expect(errors).toEqual([]);
});

test('fixture-repo: 画面の箱に iframe が出て、[data-component] を箱 id に解く（Header・RaceCard）', async ({
  page,
}) => {
  const errors = collectErrors(page);
  const foreign = collectForeign(page);
  await openBuilt(page, 'fixture-repo');
  // 2026-11-09（8-3b のレビュー）: 8-2b・8-3a を取り込んだ後の配置では、開いた直後の表示で `/` の画面の箱が下端に掛かるだけで
  // 画面の領域が表示の枠の外にあり、読み込みの規則（枠に掛かる箱だけ読む）どおり読まれない（measured が 0 のまま）。
  // 箱を表示の上の方まで動かしてから測る（wheel は縦の移動。ctrl 無し）
  const box = (await page.locator('.box[data-box="route:/"]').boundingBox())!;
  await page.mouse.move(700, 450);
  await page.mouse.wheel(0, box.y - 120);
  await expect
    .poll(async () => (await screens(page)).measured['route:/']?.length ?? 0)
    .toBeGreaterThan(0);
  const s = await screens(page);
  expect(s.live.length).toBeGreaterThan(0);
  expect(s.live.length).toBeLessThanOrEqual(6);
  const refs = new Set(s.measured['route:/']!.map((r) => r.ref));
  expect(refs.has('comp:Header')).toBe(true);
  expect(refs.has('comp:RaceCard')).toBe(true);
  const compat = await frameOf(page, 'route:/').evaluate(
    (f: HTMLIFrameElement) => f.contentDocument!.compatMode,
  );
  expect(compat).toBe('CSS1Compat');
  expect(foreign).toEqual([]);
  expect(errors).toEqual([]);
});
