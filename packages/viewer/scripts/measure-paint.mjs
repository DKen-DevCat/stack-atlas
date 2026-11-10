#!/usr/bin/env node
// 配線図の「選ぶ → 光る」「解除」の速さを測る（docs/18 §11.14、Phase 8-7）。手元で回す道具で、CI では回さない。
//
// 使い方（先に `pnpm build`。ビューアの dist と wiring の dist を使う）:
//   node packages/viewer/scripts/measure-paint.mjs --synthetic                 合成（箱 300・項目 3000・線 1000）
//   node packages/viewer/scripts/measure-paint.mjs --graph out/graph.json      手元の graph.json（v2）
//   node packages/viewer/scripts/measure-paint.mjs --url http://127.0.0.1:4173 動いている `stack-atlas serve`
// 主なオプション:
//   --pane wiring|split   配線図だけ（既定）か 2 面       --view open|fit   開いた直後の倍率（既定）か全体（F）
//   --dpr 1,2             画面の密度（既定は 1 と 2 の両方） --repeat 5        箱ごとの回数（1 回目と 2 回目以降を分けて出す）
//   --width 1440          窓の幅（高さは 900）              --ids a,b         押す箱の id（無ければ見えている箱から 3 つ）
//   --chrome              手元の Chrome（GPU）。既定は Playwright の Chromium（SwiftShader）
//   --anon                箱の id を出さない（実リポジトリの graph では必ず付ける。出るのは件数と時間だけ）
//   --this-viewer         --url と一緒に: ビューアはこの worktree の dist を配り、graph.json・screens/ などは --url から中継する
//                         （serve が古いビューアを配っていても、今の実装で測れる。graph はディスクに書かない）
//   --rebuild             選んだ状態で「全体を作り直す」（debug の rebuild()）も測る（新しい CSS ＋ 全体を作る、の比べ）
//
// 測るもの（1 回の操作ごと）:
//   handler      click / keydown のハンドラの中（捕まえた時 → 泡の終わり）
//   →frame       入力の時刻 → 次のフレームの終わり（rAF のあとの task。メインスレッドの分）
//   →paint       Event Timing の duration（入力 → 次の描画。8ms 刻み。16ms 未満は出ない）
//   renders/paints  `__stackAtlas.wiring` の数え（作り直し・付け替えの回数。選ぶ・解除は renders 0 / paints 1 が正しい）
// 操作は本物の入力（CDP の mouse.click / keyboard.press）で行う。ビューアの中に計測用のコードは要らない
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};
if (flag('--help') || flag('-h') || !(flag('--synthetic') || opt('--graph') || opt('--url'))) {
  console.log(
    'usage: measure-paint.mjs (--synthetic | --graph <graph.json> | --url <http://host:port>)\n' +
      '       [--pane wiring|split] [--view open|fit] [--dpr 1,2] [--repeat 5] [--width 1440]\n' +
      '       [--ids a,b,c] [--chrome] [--anon] [--rebuild] [--this-viewer]',
  );
  process.exit(flag('--help') || flag('-h') ? 0 : 1);
}
const pane = opt('--pane', 'wiring');
const view = opt('--view', 'open');
const dprs = opt('--dpr', '1,2').split(',').map(Number);
const repeat = Math.max(2, Number(opt('--repeat', '5')));
const width = Number(opt('--width', '1440'));
const ids = opt('--ids')?.split(',');
const anon = flag('--anon');
const withRebuild = flag('--rebuild');

/** 合成の graph（wiring の dist。`pnpm build` で出来る）か、--graph のファイル */
async function graphJson() {
  if (opt('--graph')) return readFile(resolve(opt('--graph')), 'utf8');
  const built = join(here, '../../wiring/dist/synthetic.js');
  if (!existsSync(built))
    throw new Error('packages/wiring/dist が無い。先に `pnpm build` を実行する');
  const { synthetic } = await import(pathToFileURL(built).href);
  return JSON.stringify(synthetic());
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

/**
 * ビューアの dist と graph.json を 127.0.0.1 の空いているポートで配る（dist の外は読まない）。upstream があれば、
 * index.html と assets/ だけを dist から配り、ほか（graph.json・graph.v1.json・screens/・memos.json など）は upstream から
 * GET で中継する（応答ヘッダの content-type と CSP は写す）
 */
async function serveDist(graph, upstream) {
  const dist = resolve(here, '../dist');
  if (!existsSync(join(dist, 'index.html')))
    throw new Error('packages/viewer/dist が無い。先に `pnpm build` を実行する');
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    if (upstream && path !== '/' && path !== '/index.html' && !path.startsWith('/assets/')) {
      const raw = req.url ?? '/';
      if (!raw.startsWith('/') || raw.startsWith('//')) {
        res.writeHead(400).end();
        return;
      }
      try {
        const r = await fetch(`${new URL(upstream).origin}${raw}`);
        const headers = {};
        for (const h of ['content-type', 'content-security-policy', 'x-content-type-options']) {
          const v = r.headers.get(h);
          if (v) headers[h] = v;
        }
        res.writeHead(r.status, headers).end(Buffer.from(await r.arrayBuffer()));
      } catch {
        res.writeHead(502).end();
      }
      return;
    }
    if (path === '/graph.json') {
      res.writeHead(200, { 'content-type': TYPES['.json'] }).end(graph);
      return;
    }
    const file = resolve(dist, `.${path === '/' ? '/index.html' : path}`);
    if (file !== dist && !file.startsWith(dist + sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      res
        .writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
        .end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

/** ページの中に置く計り（入力の時刻・ハンドラの終わり・次のフレームの終わり、Event Timing） */
function installProbe() {
  const m = (window.__measure = { events: [], marks: [], cur: null });
  const end = () => {
    const c = m.cur;
    if (!c || c.handlerEnd !== undefined) return;
    c.handlerEnd = performance.now();
    requestAnimationFrame(() => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => {
        c.frameEnd = performance.now();
        m.marks.push(c);
        m.cur = null;
      };
      ch.port2.postMessage(0);
    });
  };
  const begin = (e) => {
    m.cur = { type: e.type, input: e.timeStamp, handlerStart: performance.now() };
    // 泡の最後（window の bubble）で終わりを取る。毎回付け直して、いちばん後ろに並べる
    window.removeEventListener(e.type, end);
    window.addEventListener(e.type, end);
  };
  window.addEventListener('click', begin, true);
  window.addEventListener('keydown', begin, true);
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries())
        if (e.name === 'click' || e.name === 'keydown')
          m.events.push({ name: e.name, start: e.startTime, duration: e.duration });
    }).observe({ type: 'event', durationThreshold: 16, buffered: true });
  } catch {
    // Event Timing の無いブラウザでは →paint の列が空になる
  }
}

async function measure(browser, base, dpr) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: dpr });
  await page.addInitScript(installProbe);
  await page.goto(
    `${base}/index.html?graph=./graph.json${pane === 'wiring' ? '&pane=wiring' : ''}`,
  );
  await page.waitForFunction(() => window.__stackAtlas?.status === 'ready', null, {
    timeout: 60_000,
  });
  await page.waitForTimeout(1500);
  const stage = await page.locator('.wv svg').first().boundingBox();
  const blank = { x: stage.x + stage.width - 6, y: stage.y + stage.height / 2 };
  if (view === 'fit') {
    await page.mouse.click(blank.x, blank.y);
    await page.keyboard.press('f');
    // 開いた直後の倍率では「空白」が箱に当たることがある。選択を解いてから測る（1 回目が選択中のクリックにならない）
    await page.keyboard.press('Escape');
    await page.waitForTimeout(800);
  }
  const info = await page.evaluate(() => ({
    split: !!window.__stackAtlas.split,
    boxes: document.querySelectorAll('.wv svg [data-box]').length,
    elements: document.querySelectorAll('.wv svg *').length,
    chrome: navigator.userAgent.replace(/.*(Chrome\/[\d.]+).*/, '$1'),
  }));
  // 押す箱の候補: 面の中に見えている箱（DOM の順）。押すのは名前の帯（項目でなく箱が選ばれる）
  const candidates = await page.evaluate((stage) => {
    return [...document.querySelectorAll('.wv svg [data-box]')]
      .map((g) => {
        const r = g.querySelector('rect.shape').getBoundingClientRect();
        return {
          id: g.dataset.box,
          x: r.left + Math.min(r.width / 2, 40),
          y: r.top + Math.min(5, r.height / 4),
        };
      })
      .filter(
        (b) =>
          b.x > stage.x + 4 &&
          b.x < stage.x + stage.width - 4 &&
          b.y > stage.y + 50 &&
          b.y < stage.y + stage.height - 70,
      );
  }, stage);
  /** その点でいちばん上にあるのがその箱か（選んだあとに出るメモの札などの下になっていないか） */
  const hits = (t) =>
    page.evaluate(
      (t) => document.elementFromPoint(t.x, t.y)?.closest('[data-box]')?.dataset.box === t.id,
      t,
    );
  // --ids か、候補から等間隔に 3 つ。1 周目に、押す時点で他の面の下にある箱は次の候補に替える
  const slots = ids
    ? ids.map((id) => candidates.findIndex((b) => b.id === id)).filter((i) => i >= 0)
    : [0, 1, 2].map((k) => Math.floor((k * candidates.length) / 3));
  if (candidates.length === 0 || slots.length === 0)
    throw new Error('押せる箱が面の中に無い（--view fit か --ids を試す）');
  const chosen = [];
  const targetOf = async (i) => {
    if (chosen[i] !== undefined) return (await hits(chosen[i])) ? chosen[i] : null;
    for (let k = slots[i]; k < candidates.length; k++) {
      const t = candidates[k];
      if (chosen.includes(t) || !(await hits(t))) continue;
      chosen[i] = t;
      return t;
    }
    return null;
  };

  const rows = [];
  let skipped = 0;
  /** 今の状態のまま全体を作り直す（入力ではないので →paint は無い。handler = rebuild() の中、→frame = 次のフレームの終わり） */
  const rebuildOnce = async () => {
    const r = await page.evaluate(
      () =>
        new Promise((res) => {
          const w = window.__stackAtlas.wiring;
          const before = { renders: w.renders, paints: w.paints };
          const t0 = performance.now();
          w.rebuild();
          const t1 = performance.now();
          requestAnimationFrame(() => {
            const ch = new MessageChannel();
            ch.port1.onmessage = () =>
              res({
                handler: t1 - t0,
                frame: performance.now() - t0,
                paint: null,
                renders: w.renders - before.renders,
                paints: w.paints - before.paints,
                lit: w.lit
                  ? `${w.lit.boxes.length}/${w.lit.wires.length}/${w.lit.items.length}`
                  : '-',
              });
            ch.port2.postMessage(0);
          });
        }),
    );
    await page.waitForTimeout(200);
    return r;
  };
  const once = async (name, round, act) => {
    const before = await page.evaluate(() => ({
      marks: window.__measure.marks.length,
      renders: window.__stackAtlas.wiring.renders,
      paints: window.__stackAtlas.wiring.paints,
    }));
    await act();
    await page.waitForFunction((n) => window.__measure.marks.length > n, before.marks, {
      timeout: 30_000,
    });
    await page.waitForTimeout(400); // Event Timing の記録と、点滅（400ms）が終わるのを待つ
    rows.push(
      await page.evaluate(
        ({ before, name, round }) => {
          const m = window.__measure;
          const c = m.marks[m.marks.length - 1];
          const ev = m.events
            .filter((e) => Math.abs(e.start - c.input) < 2)
            .sort((a, b) => b.duration - a.duration)[0];
          const w = window.__stackAtlas.wiring;
          return {
            name,
            round,
            handler: c.handlerEnd - c.handlerStart,
            frame: c.frameEnd - c.input,
            paint: ev?.duration ?? null,
            renders: w.renders - before.renders,
            paints: w.paints - before.paints,
            lit: w.lit ? `${w.lit.boxes.length}/${w.lit.wires.length}/${w.lit.items.length}` : '-',
          };
        },
        { before, name, round },
      ),
    );
  };
  for (let round = 0; round < repeat; round++) {
    for (let i = 0; i < slots.length; i++) {
      const t = await targetOf(i);
      if (!t) {
        skipped++;
        continue;
      }
      await once(anon ? `選ぶ ${i + 1}` : `選ぶ ${t.id}`, round, () => page.mouse.click(t.x, t.y));
      await page.mouse.move(blank.x, blank.y);
      if (withRebuild) rows.push({ ...(await rebuildOnce()), name: `作り直す ${i + 1}`, round });
    }
    await once('解除（Esc）', round, () => page.keyboard.press('Escape'));
  }
  await page.close();
  return { info, rows, skipped };
}

const median = (a) => {
  const s = a.filter((x) => x !== null && !Number.isNaN(x)).sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};
const ms = (x) => (x === null ? '-' : x.toFixed(0));
const stat = (a) =>
  `${ms(median(a))}（最大 ${ms(a.some((x) => x !== null) ? Math.max(...a.filter((x) => x !== null)) : null)}）`;

const own =
  opt('--url') && flag('--this-viewer')
    ? await serveDist('', opt('--url'))
    : opt('--url')
      ? null
      : await serveDist(await graphJson());
const base = (own?.url ?? opt('--url')).replace(/\/$/, '');
const browser = await chromium.launch({
  headless: true,
  ...(flag('--chrome')
    ? { channel: 'chrome', args: ['--ignore-gpu-blocklist'] }
    : {
        args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
      }),
});
try {
  for (const dpr of dprs) {
    const { info, rows, skipped } = await measure(browser, base, dpr);
    console.log(
      `\n## pane=${pane} view=${view} 窓 ${width}×900 DPR ${dpr} / 箱 ${info.boxes}・SVG の要素 ${info.elements}` +
        ` / 2 面 ${info.split ? 'あり' : 'なし'} / ${info.chrome}${flag('--chrome') ? '' : '（SwiftShader）'}`,
    );
    console.log(
      '| 操作 | 光る 箱/線/項目 | 回 | handler ms | →frame ms | →paint ms | renders | paints |',
    );
    console.log('| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const name of [...new Set(rows.map((r) => r.name))]) {
      const all = rows.filter((r) => r.name === name);
      for (const [label, rs] of [
        ['1 回目', all.filter((r) => r.round === 0)],
        ['2 回目以降', all.filter((r) => r.round > 0)],
      ]) {
        console.log(
          `| ${name} | ${rs[0].lit} | ${label}（${rs.length}） | ${stat(rs.map((r) => r.handler))} | ` +
            `${stat(rs.map((r) => r.frame))} | ${stat(rs.map((r) => r.paint))} | ` +
            `${Math.max(...rs.map((r) => r.renders))} | ${Math.max(...rs.map((r) => r.paints))} |`,
        );
      }
    }
    if (skipped)
      console.log(`（他の面の下になって押せなかった操作: ${skipped} 回。数に入れていない）`);
  }
} finally {
  await browser.close();
  own?.close();
}
