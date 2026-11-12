// ライブの試しを動かす（docs/25 §3.5「ライブ」、10-2 の前の試し）。
//
//   node prototype/live/run.mjs           ブラウザの窓が開く。左のアプリを操作すると、右に流れが出る。窓を閉じると終わる
//   node prototype/live/run.mjs --check   窓を出さずに、決まった操作をして、確かめた結果を JSON で出す（--shot <png> で最後の画面を保存）
//
// やること: 手元だけで聞く HTTP サーバーを 2 つ立てる（アプリとビューア。別の出所にする）。ブラウザを開き、
// すべての枠に inject.js を入れ、ビューアを開く。道具は、アプリを押さない（--check のときだけ、人の代わりに操作する）。
// 依存は足さない。ブラウザの操作は、ビューアの e2e が使っているものを借りる。
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atlasInject } from './inject.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '../../packages/viewer/package.json'));
const { chromium } = require('@playwright/test');
const check = process.argv.includes('--check');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };

/** root の下だけを配る、手元だけで聞くサーバー */
function serve(root) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p.endsWith('/')) p += 'index.html';
      const file = path.join(root, path.normalize(p));
      if (!file.startsWith(root + path.sep)) return void res.writeHead(403).end();
      try {
        const body = await readFile(file);
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(body);
      } catch {
        res.writeHead(404).end('not found');
      }
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` }));
  });
}

const app = await serve(path.join(here, 'app'));
const viewer = await serve(here);
const data = JSON.parse(await readFile(path.join(here, 'data.json'), 'utf8'));

const browser = await chromium.launch({ headless: check });
const context = await browser.newContext({ viewport: check ? { width: 1280, height: 800 } : null });
await context.addInitScript(atlasInject, { parts: data.parts });
const page = await context.newPage();

// 道具の側（ブラウザの外）から見える通信。Service Worker が返事を差し替えた通信も、ここに出るかを確かめる
const outside = [];
page.on('request', (r) => {
  const u = new URL(r.url());
  if (u.pathname.startsWith('/api/')) outside.push({ method: r.method(), path: u.pathname, viaServiceWorker: null });
});
page.on('response', (r) => {
  const u = new URL(r.url());
  if (!u.pathname.startsWith('/api/')) return;
  const hit = outside.find((x) => x.method === r.request().method() && x.path === u.pathname && x.viaServiceWorker === null);
  if (hit) hit.viaServiceWorker = r.fromServiceWorker();
});

await page.goto(`${viewer.url}viewer/index.html?app=${encodeURIComponent(app.url)}`);

async function stop(code) {
  await browser.close().catch(() => {});
  app.server.close();
  viewer.server.close();
  process.exit(code);
}

if (!check) {
  await page.bringToFront();
  console.log(
    [
      '窓を 1 つ開きました（Chromium か「Chrome for Testing」という名前の、別のブラウザです）。',
      'その窓の中で、左のアプリを操作してください。',
      'ふだんのブラウザで URL を開いても動きません（見るためのスクリプトは、道具が開いた窓にだけ入ります）。',
      '窓を閉じると終わります。',
    ].join('\n'),
  );
  page.on('close', () => stop(0));
  browser.on('disconnected', () => stop(0));
} else {
  const text = 'ライブの試しのコメント';
  const inApp = page.frameLocator('#app');
  const replayed = (n) => page.waitForFunction((want) => window.__replayed >= want, n, { timeout: 30000 });
  await inApp.locator('.card').first().waitFor({ timeout: 15000 });   // 開いたときの読みこみ
  const setRange = (id, value) => page.evaluate(([i, v]) => { const el = document.getElementById(i); el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); }, [id, value]);
  await page.locator('#p-play').waitFor({ timeout: 15000 });         // 記録が済むと、再生の操作が出る
  await setRange('p-speed', 1);                                      // 見せる速さを 1 倍に
  await replayed(1);
  await inApp.locator('textarea').fill(text);
  await inApp.locator('#comment-form button').click();               // 人の代わりに押す（--check のときだけ）
  await inApp.locator('.card', { hasText: text }).waitFor({ timeout: 15000 });
  await replayed(2);
  const afterPost = await page.evaluate(() => ({ verdict: document.getElementById('f-verdict').textContent, player: window.__player() }));
  await setRange('p-seek', afterPost.player.total * 0.5);            // 再生バーを、まん中へ動かす
  const seeked = await page.evaluate(() => window.__player());
  await page.locator('#p-play').click();                             // go: そこから再生
  await page.waitForTimeout(60);
  const going = await page.evaluate(() => window.__player());
  await page.locator('#p-play').click();                             // stop: 止める
  const stopped = await page.evaluate(() => window.__player());
  await page.waitForTimeout(200);
  const still = await page.evaluate(() => window.__player());
  await page.locator('#p-play').click();                             // go: 続きから最後まで
  await replayed(3);
  const texts = await page.locator('#player').innerText();           // 再生の操作に、文字が出ていないこと
  await inApp.locator('button.del').first().click();
  await inApp.locator('.card', { hasText: text }).waitFor({ state: 'detached', timeout: 15000 });
  await replayed(4);
  const shotAt = process.argv.indexOf('--shot');
  if (shotAt > 0 && process.argv[shotAt + 1]) await page.screenshot({ path: path.resolve(process.argv[shotAt + 1]), fullPage: true });

  const { seen, ops } = await page.evaluate(() => ({
    seen: window.__seen,
    ops: window.__ops.map((o) => ({ behavior: o.behavior, verdict: o.verdict, reqs: [...o.reqs.values()], net: o.net ?? [], steps: o.steps ?? [], total: o.total })),
  }));
  const postOp = ops.find((o) => o.behavior === 'post-comment');
  const delOp = ops.find((o) => o.behavior === 'delete-comment');
  const postReq = postOp?.steps.find((s) => s.kind === 'req' && s.main);
  const result = {
    '1. アプリを左の枠に入れて動かせた': ops.some((o) => o.behavior === 'open' && o.net.some((c) => c.kind === 'added')),
    '2. 押した部品が分かった': seen.some((e) => e.t === 'part' && e.part === 'comment-form' && e.how === 'submit'),
    '3. 送った中身が見えた': !!postOp && postOp.reqs.some((r) => r.method === 'POST' && (r.body ?? '').includes(text)),
    '4. 返ってきた中身が見えた': !!postOp && postOp.reqs.some((r) => r.status === 201 && (r.resBody ?? '').includes(text)),
    '5. 画面に反映されたものが分かった': !!postOp && postOp.net.length === 1 && postOp.net[0].kind === 'added' && postOp.net[0].text.includes(text)
      && !!delOp && delOp.net.length === 1 && delOp.net[0].kind === 'removed' && delOp.net[0].text.includes(text),
    '6. 図と実際の通信を照らし合わせた': afterPost.verdict === '図と合っている' && postOp?.verdict === true && delOp?.verdict === true,
    '7. 差し替えられた通信が、枠の中から見えた': seen.filter((e) => e.t === 'req').length >= 4,
    '8. 差し替えられた通信が、ブラウザの外から見えた': outside.some((x) => x.method === 'POST'),
    '9. 時間の内訳が出た（投稿の通信が、いちばん長い）': !!postReq && postReq.ms >= 400 && postOp.steps.every((s) => s.ms <= postReq.ms),
    '10. 見せる速さを変えて、最後まで再生できた': afterPost.player.done && afterPost.player.speed === 1,
    '11. 再生バーで、好きな所へ動かせた': Math.abs(seeked.pos - afterPost.player.total * 0.5) < 1 && seeked.k === 1 && !seeked.running,
    '12. 止める・進めるが効いた': going.running && going.pos > seeked.pos && !stopped.running && Math.abs(still.pos - stopped.pos) < 0.001,
    '13. 再生の操作は、部品だけ（文字なし）': texts.trim() === '',
    '投稿の時間の内訳': postOp?.steps.map((s) => `${s.label}: ${s.ms.toFixed(1)} ms`),
    '外から見えた通信': outside.map((x) => `${x.method} ${x.path}（差し替え: ${x.viaServiceWorker}）`),
  };
  console.log(JSON.stringify(result, null, 2));
  const ok = Object.entries(result).filter(([k]) => /^\d+\./.test(k)).every(([, v]) => v === true);
  await stop(ok ? 0 : 1);
}
