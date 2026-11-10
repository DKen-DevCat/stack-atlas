// 2 面（3D の地図 ⇄ 配線図。Phase 8-6、docs/20 §3・§5.1・§6）。fixture-poly を `stack-atlas build` で一時ディレクトリに出し
// （トップの groups が入った v2）、ビューアと同じ origin の built-split/ の下で配る。確かめること:
// 2 面で開く、地図のクリック → 配線図の選択と両方の面の球（同じ時刻。D106）、配線図のクリック → 地図の group が光る、
// Esc で両方を解く、選択中は地図の hover が効かない、?sel=、狭い画面の切り替え、メモの共有、差分、v1 は 3D だけ、止まっている間は描かない
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { collectErrors, SAMPLE_URL, waitReady } from './helpers';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
/** serve の応答ヘッダの CSP（screens.spec.ts と同じく CLI の文字列を読む） */
const SCREENS_CSP = /SCREENS_CSP =\s*"([^"]+)"/.exec(
  readFileSync(new URL('../../cli/src/commands/serve.ts', import.meta.url), 'utf8'),
)![1]!;
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

const REQUEST = 'lib:web/src/feature/spend/request.ts';
const URL0 = '?graph=built-split/graph.json';

let out = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  test.setTimeout(240_000);
  out = mkdtempSync(join(realpathSync(tmpdir()), 'sa-e2e-split-'));
  execFileSync('pnpm', ['atlas', 'build', 'examples/fixture-poly', '-o', out, '--no-screenshots'], {
    cwd: ROOT,
    stdio: 'pipe',
  });
});

test.afterAll(() => {
  if (out) rmSync(out, { recursive: true, force: true });
});

/** built-split/ の下で build の出力を配る（override は out からの相対パス → 本文） */
async function serve(page: Page, override: Record<string, string> = {}) {
  await page.route('**/built-split/**', (route) => {
    const url = new URL(route.request().url());
    const rel = decodeURIComponent(url.pathname.slice('/built-split/'.length));
    const file = normalize(join(out, rel));
    const headers: Record<string, string> = {
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    };
    if (rel.startsWith('screens/')) {
      headers['Content-Security-Policy'] = SCREENS_CSP;
      headers['X-Content-Type-Options'] = 'nosniff';
    }
    const body = override[rel];
    if (body !== undefined) return route.fulfill({ status: 200, headers, body });
    if (!file.startsWith(out + sep) || !existsSync(file) || !statSync(file).isFile())
      return route.fulfill({ status: 404, body: 'not found' });
    return route.fulfill({ status: 200, headers, body: readFileSync(file) });
  });
}

interface SplitWin {
  __stackAtlas: {
    split: {
      pane: string;
      narrow: boolean;
      active: string;
      ratio: number;
      mapLit: { nodes: string[]; edges: number; starts: string[] } | null;
      mapFlow: { balls: number; pulses: number; cycle: number } | null;
      flowAt(tau?: number): {
        tau: number;
        balls: { edge: string; from: string; to: string; progress: number; wires: string[] }[];
      };
    } | null;
    wiring: {
      selection: { kind: string; id?: string } | null;
      schedule: { cycle: number; balls: { key: string; t0: number; dur: number }[] } | null;
      time: number;
      paused: boolean;
      select(sel: unknown): void;
      setPaused(p: boolean): void;
      seek(t: number): void;
      ballPositions(): { key: string; visible: boolean }[];
    } | null;
    viewer: {
      hover(id: string | null): void;
      debugInfo: {
        frames: number;
        linked: boolean;
        narrow: boolean;
        nodes: number;
        highlight: string | null;
        ghosts: number;
        mapFlow: { balls: number; pulses: number; edges: string[] } | null;
      };
    } | null;
  };
}
const split = (page: Page) =>
  page.evaluate(() => {
    const s = (window as unknown as SplitWin).__stackAtlas.split!;
    return {
      pane: s.pane,
      narrow: s.narrow,
      active: s.active,
      ratio: s.ratio,
      mapLit: s.mapLit,
      mapFlow: s.mapFlow,
    };
  });
const wsel = (page: Page) =>
  page.evaluate(() => (window as unknown as SplitWin).__stackAtlas.wiring!.selection);
const mapInfo = (page: Page) =>
  page.evaluate(() => (window as unknown as SplitWin).__stackAtlas.viewer!.debugInfo);

/**
 * ページで n フレーム待つ（requestAnimationFrame）。ヘッドレスの WebGL は 1 フレームが遅い（手元では 1 秒に 1〜2 フレーム）ので、
 * 時間ではなくフレームの数で「描いた・描かない」を確かめる
 */
const frames = (page: Page, n: number) =>
  page.evaluate(
    (k) =>
      new Promise<void>((res) => {
        let i = 0;
        const step = () => (++i >= k ? res() : requestAnimationFrame(step));
        requestAnimationFrame(step);
      }),
    n,
  );

/** 地図のノードのラベルをクリックする（ポインタを押してから。キーは最後に触った面へ） */
async function clickMapNode(page: Page, id: string) {
  const l = page.locator(`.split-map .nl[data-id="${id}"]`);
  await l.dispatchEvent('pointerdown');
  await l.dispatchEvent('click');
}

async function open(page: Page, query = '') {
  await serve(page);
  await page.goto(`${URL0}${query}`);
  await waitReady(page);
}

test('fixture-poly の v2 は 2 面で開く: 左に 3D の地図（group で畳んだ 50 ノード）、右に配線図。リンク・凡例・旧フローは出さない', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await open(page);
  // .viewer 自体は大きさを持たない（部品は面を基準にした fixed）ので、描く面と題名で確かめる
  await expect(page.locator('.split .split-map .viewer.linked')).toHaveCount(1);
  await expect(page.locator('.split-map .stage canvas')).toBeVisible();
  await expect(page.locator('.split-map .top h1')).toBeVisible();
  await expect(page.locator('.split .split-wiring .wv')).toBeVisible();
  const sep = page.locator('.split-divider[role="separator"]');
  await expect(sep).toHaveAttribute('aria-valuenow', '50');
  const info = await mapInfo(page);
  expect(info.linked).toBe(true);
  expect(info.nodes).toBe(50);
  // 地図の面は窓の半分（狭い画面の並べ方は面の幅で決まる。§5.1 #11）
  expect(info.narrow).toBe(true);
  await expect(page.locator('.split-map .legend')).toHaveCount(0);
  await expect(page.locator('.split-map #flowSeg')).toBeHidden();
  await page.waitForTimeout(300);
  await expect(page.locator('.split-map .top h1 a.alt-link')).toBeHidden();
  await expect(page.locator('.split-wiring .wv-top a.alt-link')).toBeHidden();
  expect(await split(page)).toMatchObject({ pane: 'wiring', narrow: false, mapLit: null });
  // 止まっている間は描かない（§5.1 #10）
  await frames(page, 2);
  const f0 = (await mapInfo(page)).frames;
  await frames(page, 3);
  expect((await mapInfo(page)).frames).toBe(f0);
  // 境目は矢印キーで 5% ずつ（25〜75%）
  await sep.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(sep).toHaveAttribute('aria-valuenow', '45');
  await page.keyboard.press('ArrowRight');
  await expect(sep).toHaveAttribute('aria-valuenow', '50');
  expect(errors).toEqual([]);
});

test('地図で route:/ をクリック → 配線図で route:/ が選ばれ、球が両方の面で同じ時刻に流れる（D106）', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await open(page);
  await clickMapNode(page, 'route:/');
  expect(await wsel(page)).toEqual({ kind: 'box', id: 'route:/' });
  const s = await split(page);
  expect(s.active).toBe('map');
  expect(s.mapLit!.starts).toEqual(['route:/']);
  expect(s.mapFlow!.balls).toBeGreaterThan(0);
  expect(new URL(page.url()).searchParams.get('sel')).toBe('route:/');
  // 地図の始点は白い輪とラベルの白い枠。光らないノードのラベルは消える
  await expect(page.locator('.split-map .nl[data-id="route:/"]')).toHaveClass(/\bstart\b/);
  await expect(page.locator('.split-map .nl[data-id="route:/push"]')).toHaveClass(/\bdim\b/);
  await expect(page.locator('.split-map .nl[data-id="route:/push"]')).toHaveCSS(
    'visibility',
    'hidden',
  );

  // 再生中は地図も毎フレーム描く
  const f0 = (await mapInfo(page)).frames;
  await frames(page, 3);
  expect((await mapInfo(page)).frames).toBeGreaterThanOrEqual(f0 + 2);

  // 球が 2 つ以上ある時刻で止めて、両方の面の球を比べる（配線図の再生バーで止める・シークすると地図も追う）
  const t = await page.evaluate(() => {
    const w = window as unknown as SplitWin;
    const sch = w.__stackAtlas.wiring!.schedule!;
    for (let x = 0; x < sch.cycle; x += 0.25)
      if (w.__stackAtlas.split!.flowAt(x).balls.length >= 2) return x;
    return -1;
  });
  expect(t).toBeGreaterThan(0);
  await page.evaluate((x) => {
    const w = (window as unknown as SplitWin).__stackAtlas.wiring!;
    w.setPaused(true);
    w.seek(x);
  }, t);
  await frames(page, 2);
  const r = await page.evaluate(() => {
    const st = (window as unknown as SplitWin).__stackAtlas;
    const tau = st.wiring!.time;
    return {
      tau,
      map: st.viewer!.debugInfo.mapFlow!,
      at: st.split!.flowAt(tau),
      wiring: st
        .wiring!.ballPositions()
        .filter((b) => b.visible)
        .map((b) => b.key.slice(0, b.key.indexOf('|'))),
    };
  });
  expect(r.tau).toBeCloseTo(t);
  expect(r.map.balls).toBeGreaterThanOrEqual(2);
  expect(r.map.balls).toBe(r.at.balls.length);
  expect(r.map.edges.sort()).toEqual(r.at.balls.map((b) => b.edge).sort());
  // 地図の球はどれも、その時刻に配線図で走っている線の球
  for (const b of r.at.balls) expect(b.wires.some((w) => r.wiring.includes(w))).toBe(true);
  // 止めている間は描かない
  const f1 = (await mapInfo(page)).frames;
  await frames(page, 3);
  expect((await mapInfo(page)).frames).toBe(f1);
  expect(errors).toEqual([]);
});

test('配線図で fn:getToday をクリック → 地図でその group のノードが始点として光る。選択中は地図の hover が効かない', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await open(page);
  // 配線図の面で全体を映し（F）、fn:getToday の所で拡大してから本物のマウスでクリックする
  await page.locator('.split-wiring .wv-stage').hover();
  await page.keyboard.press('f');
  const shape = page.locator('.split-wiring [data-box="fn:getToday"] .shape');
  let b = (await shape.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.keyboard.down('Control');
  for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -150);
  await page.keyboard.up('Control');
  b = (await shape.boundingBox())!;
  await page.mouse.click(b.x + b.width * 0.6, b.y + Math.min(3, b.height / 4));
  expect(await wsel(page)).toEqual({ kind: 'box', id: 'fn:getToday' });
  const s = await split(page);
  expect(s.active).toBe('wiring');
  expect(s.mapLit!.starts).toEqual([REQUEST]);
  expect(s.mapLit!.nodes).toContain('endpoint:GET /today');
  expect(s.mapLit!.nodes).not.toContain('endpoint:POST /transactions');
  await expect(page.locator(`.split-map .nl[data-id="${REQUEST}"]`)).toHaveClass(/\bstart\b/);

  // 選択中は地図の hover で何も変わらない（docs/15 §3.6 の規則 1）
  const before = await page.locator('.split-map .nl[data-id="route:/push"]').getAttribute('class');
  await page.locator('.split-map .nl[data-id="route:/push"]').dispatchEvent('mouseenter');
  await page.evaluate(() =>
    (window as unknown as SplitWin).__stackAtlas.viewer!.hover('route:/push'),
  );
  expect((await mapInfo(page)).highlight).toBeNull();
  expect(await page.locator('.split-map .nl[data-id="route:/push"]').getAttribute('class')).toBe(
    before,
  );
  expect(errors).toEqual([]);
});

test('Esc は最後に触った面が受けて両方を 1 回で解く。空白のクリックも', async ({ page }) => {
  const errors = collectErrors(page);
  await open(page, '&sel=route%3A%2F');
  expect(await wsel(page)).toEqual({ kind: 'box', id: 'route:/' });
  // 地図を触ってから Esc
  await clickMapNode(page, REQUEST);
  expect((await wsel(page))?.kind).toBe('group');
  await page.keyboard.press('Escape');
  expect(await wsel(page)).toBeNull();
  expect((await split(page)).mapLit).toBeNull();
  expect(new URL(page.url()).searchParams.has('sel')).toBe(false);
  // 地図の球も消える（次に描いたフレームで）
  await frames(page, 2);
  expect((await mapInfo(page)).mapFlow!.balls).toBe(0);
  // 配線図を選んで（配線図を触った）Esc
  await page.locator('.split-wiring .wv-stage').dispatchEvent('pointerdown');
  await page.evaluate(() =>
    (window as unknown as SplitWin).__stackAtlas.wiring!.select({ kind: 'box', id: 'route:/' }),
  );
  expect((await split(page)).active).toBe('wiring');
  expect((await split(page)).mapLit).not.toBeNull();
  await page.keyboard.press('Escape');
  expect(await wsel(page)).toBeNull();
  expect((await split(page)).mapLit).toBeNull();
  // 地図の空白のクリックも両方を解く（左下の何も無い所）
  await clickMapNode(page, 'route:/');
  expect(await wsel(page)).not.toBeNull();
  await page.mouse.click(24, 880);
  expect(await wsel(page)).toBeNull();
  expect((await split(page)).mapLit).toBeNull();
  // 選択が無いときの地図の hover は効く（つながる線を明るくするだけ）
  await page.evaluate(() => (window as unknown as SplitWin).__stackAtlas.viewer!.hover('route:/'));
  expect((await mapInfo(page)).highlight).toBe('route:/');
  expect(errors).toEqual([]);
});

test('?sel= で開くと選ばれている（地図の group・箱・host）。解けない値は警告して外す。?view= が勝つ', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await open(page, `&sel=${encodeURIComponent(REQUEST)}`);
  expect(await wsel(page)).toMatchObject({ kind: 'group', id: REQUEST });
  expect((await split(page)).mapLit!.starts).toEqual([REQUEST]);
  await page.goto(`${URL0}&sel=${encodeURIComponent('infra:lambda_api/api')}`);
  await waitReady(page);
  expect(await wsel(page)).toEqual({ kind: 'host', id: 'infra:lambda_api/api' });
  // 解けない値: 警告の一覧に出して URL から外す
  await page.goto(`${URL0}&sel=fn%3Anope`);
  await waitReady(page);
  expect(await wsel(page)).toBeNull();
  expect(new URL(page.url()).searchParams.has('sel')).toBe(false);
  await page.locator('.split-wiring .wv-top [data-issues]').click();
  await expect(page.locator('.split-wiring .wv-issues')).toContainText('fn:nope');
  // ?view= が勝つ（?sel= は外す）
  const views = JSON.parse(readFileSync(join(out, 'graph.json'), 'utf8')).views as { id: string }[];
  await page.goto(`${URL0}&view=${views[0]!.id}&sel=route%3A%2F`);
  await waitReady(page);
  expect(new URL(page.url()).searchParams.get('view')).toBe(views[0]!.id);
  expect(new URL(page.url()).searchParams.has('sel')).toBe(false);
  expect(errors).toEqual([]);
});

test('メモの store は 2 面で共有: 地図から選んだ group のメモを配線図の札で書くと、地図のラベルに 📝', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await open(page);
  await clickMapNode(page, REQUEST);
  const ta = page.locator(`.split-wiring textarea[data-memo-id="${REQUEST}"]`);
  await expect(ta).toBeVisible();
  // 札の見出しは地図のノードの名前
  await expect(page.locator(`.split-wiring [data-memo="${REQUEST}"] .wv-memo-label`)).toHaveText(
    'spend/request',
  );
  await ta.fill('group のメモ');
  await expect(page.locator(`.split-map .nl[data-id="${REQUEST}"] .memo`)).toHaveText('📝');
  // 地図のノードのメモは孤立メモにならない
  await expect(page.locator('.split-wiring .wv-top [data-orphans]')).toBeHidden();
  expect(errors).toEqual([]);
});

test('差分: 前が v2 なら地図も projectMap(前) と比べる（幽霊）。前が v1 なら地図は比べず「前の graph が v1 です」', async ({
  page,
}) => {
  const errors = collectErrors(page);
  const g = JSON.parse(readFileSync(join(out, 'graph.json'), 'utf8')) as {
    nodes: { id: string; group?: string }[];
    wires: { from: string; to: string }[];
  };
  // 前の graph には今は無い箱（とその線）がある = 今の graph から endpoint:DELETE /push/subscriptions を消したのが今
  const gone = 'endpoint:DELETE /push/subscriptions';
  expect(g.nodes.some((n) => n.id === gone)).toBe(true);
  const now = {
    ...g,
    nodes: g.nodes.filter((n) => n.id !== gone),
    wires: g.wires.filter((w) => !w.from.startsWith(`${gone}#`) && !w.to.startsWith(`${gone}#`)),
  };
  await serve(page, { 'graph.json': JSON.stringify(now), 'prev.json': JSON.stringify(g) });
  await page.goto(`${URL0}&prev=built-split/prev.json`);
  await waitReady(page);
  expect((await mapInfo(page)).ghosts).toBe(1);
  await expect(page.locator('.split-map .top .diffpill')).toBeVisible();
  // 前が v1（race-site）: 地図は比べない
  await page.goto(`${URL0}&prev=samples/race-site.graph.json`);
  await waitReady(page);
  expect((await mapInfo(page)).ghosts).toBe(0);
  await expect(page.locator('.split-map .top .diffpill')).toHaveCount(0);
  await expect(page.locator('.split-wiring .wv-top .wv-note')).toHaveText('前の graph が v1 です');
  expect(errors).toEqual([]);
});

test.describe('狭い画面（1000px）', () => {
  test.use({ viewport: { width: 1000, height: 800 } });

  test('面は 1 つ（最初は配線図）。リンクで切り替えると選択が引き継がれ、隠れた面は描かない', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await open(page);
    expect(await split(page)).toMatchObject({ pane: 'wiring', narrow: true });
    await expect(page.locator('.split-map')).toHaveCSS('visibility', 'hidden');
    await expect(page.locator('.split-divider')).toBeHidden();
    const f0 = (await mapInfo(page)).frames;
    await page.evaluate(() =>
      (window as unknown as SplitWin).__stackAtlas.wiring!.select({ kind: 'box', id: 'route:/' }),
    );
    await frames(page, 3);
    // 隠れた地図は再生中でも描かない
    expect((await mapInfo(page)).frames).toBe(f0);
    const toMap = page.locator('.split-wiring .wv-top a.alt-link');
    await expect(toMap).toHaveText('3D の地図');
    await toMap.click();
    expect((await split(page)).pane).toBe('map');
    await expect(page.locator('.split-map')).toHaveCSS('visibility', 'visible');
    await expect(page.locator('.split-wiring')).toHaveCSS('visibility', 'hidden');
    expect((await split(page)).mapLit!.starts).toEqual(['route:/']);
    await frames(page, 2);
    expect((await mapInfo(page)).frames).toBeGreaterThan(f0);
    // 地図の面は窓いっぱい（狭い画面の並べ方ではない）
    expect((await mapInfo(page)).narrow).toBe(false);
    const toWiring = page.locator('.split-map .top h1 a.alt-link');
    await expect(toWiring).toHaveText('配線図');
    await toWiring.click();
    expect((await split(page)).pane).toBe('wiring');
    expect(await wsel(page)).toEqual({ kind: 'box', id: 'route:/' });
    expect(errors).toEqual([]);
  });
});

test('v1 の graph は今までどおり 3D の地図だけ（2 面にしない）', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto(SAMPLE_URL);
  await waitReady(page);
  await expect(page.locator('.split')).toHaveCount(0);
  await expect(page.locator('.stage canvas')).toBeVisible();
  await expect(page.locator('.legend')).toBeVisible();
  expect((await mapInfo(page)).linked).toBe(false);
  expect(errors).toEqual([]);
});
