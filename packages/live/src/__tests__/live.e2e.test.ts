// ライブ（docs/27）を、実際のブラウザで確かめる。人の代わりに、テストがアプリの枠を操作する（道具は押さない）。
// 図は、試しでエージェントが書いたもの。アプリは、試しのサンプルのアプリ（prototype/live/app）。
// ブラウザが起動できない環境では、飛ばさずに失敗させる（CI は STACK_ATLAS_CHROMIUM_NO_SANDBOX=1 で起動する）
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LiveMessage } from '@stack-atlas/wiring';
import type { Page } from 'playwright';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MINIMAL_PAGE_DIR, VIEWER_LIVE_DIR } from '../server.js';
import { LiveError, startLive, type LiveSession } from '../session.js';

const APP_DIR = fileURLToPath(new URL('../../../../prototype/live/app/', import.meta.url));
const ATLAS = fileURLToPath(
  new URL('../../../core/src/__tests__/fixtures/atlas-live-agent/', import.meta.url),
);
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => boolean | void;
/** 手元だけで聞くサーバー。handler が答えなければ、dir の下のファイルを配る。受けた通信を数える */
async function serve(dir: string | undefined, handler?: Handler, host = '127.0.0.1') {
  const got: string[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
      got.push(`${req.method} ${path}`);
      if (handler?.(req, res, body)) return;
      if (!dir) return void res.writeHead(404).end();
      const file = normalize(join(dir, path.endsWith('/') ? `${path}index.html` : path));
      if (!file.startsWith(dir) || !existsSync(file)) return void res.writeHead(404).end();
      res.writeHead(200, {
        'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(readFileSync(file));
    });
  });
  server.on('upgrade', (req, socket) => {
    got.push(`UPGRADE ${req.url}`);
    socket.destroy();
  });
  await new Promise<void>((ok) => server.listen(0, host, ok));
  const port = (server.address() as AddressInfo).port;
  return { server, got, url: `http://${host}:${port}/`, port };
}

const sessions: LiveSession[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close();
  for (const s of servers.splice(0)) s.close();
});
async function open(url: string, more: Partial<Parameters<typeof startLive>[0]> = {}) {
  const lines: string[] = [];
  // 見張りの確かめは、最小のライブの画面で行う（ビューアのライブの画面を組み立てたかどうかで、結果を変えない）
  const session = await startLive({
    root: ATLAS,
    url,
    headless: true,
    log: (l) => lines.push(l),
    pageDir: MINIMAL_PAGE_DIR,
    ...more,
  });
  sessions.push(session);
  return { session, lines };
}
/** ライブの画面に届いた知らせ */
const delivered = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __stackAtlasLiveDelivered: LiveMessage[] }).__stackAtlasLiveDelivered,
  );
const eventsOf = async (page: Page) =>
  (await delivered(page)).flatMap((m) => (m.t === 'events' ? m.events : []));
/** 条件が成り立つまで待つ（届くのは、並べ直しのため、少し遅れる） */
async function until<T>(get: () => Promise<T>, ok: (v: T) => boolean, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await get();
    if (ok(v) || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('stack-atlas live（実際のブラウザ）', () => {
  it('サンプルのアプリ: 押した部品・通信・返事・画面の変化が、値を伏せたまま、ライブの画面に届く', async () => {
    const app = await serve(APP_DIR);
    servers.push(app.server);
    const root = mkdtempSync(join(tmpdir(), 'stack-atlas-live-root-'));
    cpSync(ATLAS, root, { recursive: true });
    const before = readdirSync(root, { recursive: true }).sort();
    const { session, lines } = await open(app.url, { root });
    const live = session.livePage;
    const frame = live.frameLocator('#app-pane iframe');

    // 開いた: 画面（図の画面の箱）と、読みこみの通信
    let events = await until(
      () => eventsOf(live),
      (es) => es.some((e) => e.t === 'response'),
    );
    expect(events.find((e) => e.t === 'open')).toMatchObject({ screen: 'screen:/' });
    expect(events.find((e) => e.t === 'request')).toMatchObject({
      method: 'GET',
      path: '/api/comments',
      route: 'GET /api/comments',
      kind: 'script',
    });

    // 投稿する（人の代わりに、テストが押す）
    const TEXT = 'ライブの確かめの投稿 7f3a';
    await frame.locator('.card').first().waitFor();
    await frame.locator('textarea').fill(TEXT);
    await frame.locator('#comment-form button').click();
    await frame.locator('.card', { hasText: TEXT }).waitFor();
    // 削除する（削除のボタンは、一覧の部品の中にある）
    await frame.locator('.card', { hasText: TEXT }).locator('button.del').click();
    await frame.locator('.card', { hasText: TEXT }).waitFor({ state: 'detached' });

    events = await until(
      () => eventsOf(live),
      (es) =>
        es.some((e) => e.t === 'request' && e.method === 'DELETE') &&
        es.filter((e) => e.t === 'response').length >= 5,
    );
    const parts = events.filter((e) => e.t === 'part');
    expect(parts).toContainEqual(
      expect.objectContaining({ how: 'submit', parts: ['comment-form'] }),
    );
    expect(parts).toContainEqual(
      expect.objectContaining({ how: 'click', parts: ['delete-button', 'comment-list'] }),
    );
    const requests = events.filter((e) => e.t === 'request');
    expect(requests.map((r) => r.route)).toEqual(
      expect.arrayContaining([
        'POST /api/comments',
        'DELETE /api/comments/{id}',
        'GET /api/comments',
      ]),
    );
    // 図と合った通信は、図の書き方で出る（パスの中の値は出ない）
    expect(requests.find((r) => r.method === 'DELETE')).toMatchObject({
      path: '/api/comments/{id}',
    });
    const post = requests.find((r) => r.method === 'POST')!;
    expect(post.body).toEqual({
      kind: 'tree',
      shape: {
        t: 'object',
        keys: [['comment', { t: 'object', keys: [['body', { t: 'string' }]] }]],
      },
    });
    const responses = events.filter((e) => e.t === 'response');
    expect(responses.map((r) => r.status)).toEqual(expect.arrayContaining([200, 201, 204]));
    // 2026-11-12 追加（レビュー 1）: 返事は、いつも、その通信のあとに届く（時刻も、届いた順も）
    for (const res of responses) {
      const at = events.findIndex((e) => e === res);
      const reqAt = events.findIndex((e) => e.t === 'request' && e.id === res.id);
      expect(reqAt, res.id).toBeGreaterThanOrEqual(0);
      expect(reqAt, res.id).toBeLessThan(at);
      expect((events[reqAt] as { at: number }).at).toBeLessThanOrEqual(res.at);
    }
    // 返事を差し替える仕組み（サンプルのアプリの Service Worker）が作った返事
    expect(responses.every((r) => r.inBrowser)).toBe(true);
    // 中身の無い返事（204）のあとに来る失敗は、失敗にしない
    expect(events.filter((e) => e.t === 'failed')).toEqual([]);
    // 画面の変化: 増えた投稿と、件数の文字の変化
    const changes = events.flatMap((e) => (e.t === 'dom' ? e.changes : []));
    expect(changes.some((c) => c.kind === 'added' && c.text.includes(TEXT))).toBe(true);
    expect(changes.some((c) => c.kind === 'text' && /件のコメント/.test(c.text))).toBe(true);

    // 既定では、通信の値が、ライブの画面にも端末にも出ない（画面の文字は、左のアプリに出ているものなので出る）
    const network = JSON.stringify((await delivered(live)).filter((m) => m.t !== 'events'));
    expect(network).not.toContain(TEXT);
    expect(JSON.stringify(requests.concat(responses as never))).not.toContain(TEXT);
    expect(JSON.stringify(requests)).not.toContain('"raw"');
    expect(lines.join('\n')).not.toContain(TEXT);

    // アプリの枠からの、にせの合図は効かない（値は出ず、状態も変わらない）
    // 2026-11-12 変更（レビュー 12）: 口の呼び出しが済むのを待ってから確かめる（前は、決まった時間だけ寝ていた）
    await live.frames()[1]!.evaluate(async () => {
      const ch = (window as unknown as { __stackAtlasLive: (s: unknown) => Promise<void> })
        .__stackAtlasLive;
      await ch({ t: 'reveal', on: true });
      await ch({ t: 'hold', on: true });
    });
    expect(session.status()).toMatchObject({ reveal: false, hold: false });
    expect((await delivered(live)).some((m) => m.t === 'values')).toBe(false);

    // ライブの画面の合図で「値を見る」を入れると、メモリにある直近の値が届く
    await live.evaluate(() =>
      (window as unknown as { __stackAtlasLive: (s: unknown) => void }).__stackAtlasLive({
        t: 'reveal',
        on: true,
      }),
    );
    const values = await until(
      () => delivered(live),
      (ms) => ms.some((m) => m.t === 'values'),
    );
    expect(session.status().reveal).toBe(true);
    expect(JSON.stringify(values.find((m) => m.t === 'values'))).toContain(TEXT);

    // 道具は、図の置き場にファイルを書かない
    await session.close();
    expect(readdirSync(root, { recursive: true }).sort()).toEqual(before);
  }, 60_000);

  it('手元の外へは、読むことも書くことも、届かない（行き先の無い中継が断る）', async () => {
    const outside = await serve(
      undefined,
      (req, res) => {
        res.writeHead(200, { 'Access-Control-Allow-Origin': '*' }).end('outside');
        return true;
      },
      lanAddress() ?? '127.0.0.1',
    );
    servers.push(outside.server);
    const targets = [
      ...(lanAddress() ? [outside.url.replace(/\/$/, '')] : []),
      'http://outside.invalid:8080',
    ];
    const page = (out: string) => `<!doctype html><meta charset="utf-8"><body>
<form id="f" method="post" action="${out}/form"><button>go</button></form>
<script>
const OUT = ${JSON.stringify(out)};
window.fire = async () => {
  const go = (u, m) => fetch(u, { method: m, body: m === 'GET' ? undefined : 'x', mode: 'no-cors' }).catch(() => {});
  await go(OUT + '/fetch-post', 'POST');
  await go(OUT + '/fetch-get', 'GET');
  await go('/redirect?to=' + encodeURIComponent(OUT + '/redirected'), 'POST');
  navigator.sendBeacon(OUT + '/beacon', 'b');
  try { new WebSocket(OUT.replace('http', 'ws') + '/ws'); } catch {}
  try { new SharedWorker('/worker.js?out=' + encodeURIComponent(OUT)); } catch {}
};
addEventListener('pagehide', () => {
  navigator.sendBeacon(OUT + '/beacon-pagehide', 'b');
  fetch(OUT + '/keepalive', { method: 'POST', body: 'k', keepalive: true, mode: 'no-cors' }).catch(() => {});
});
</script>`;
    for (const out of targets) {
      const app = await serve(undefined, (req, res) => {
        const u = new URL(req.url ?? '/', 'http://x');
        if (u.pathname === '/' || u.pathname === '/second')
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page(out));
        else if (u.pathname === '/worker.js')
          res
            .writeHead(200, { 'Content-Type': 'text/javascript' })
            .end(
              `fetch(${JSON.stringify(out)} + '/shared-worker', { method: 'POST', body: 'w', mode: 'no-cors' }).catch(() => {});`,
            );
        else if (u.pathname === '/redirect')
          res.writeHead(307, { Location: u.searchParams.get('to') ?? '/' }).end();
        else res.writeHead(200).end('local');
        return true;
      });
      servers.push(app.server);
      const { session } = await open(app.url);
      await session.livePage.frameLocator('#app-pane iframe').locator('#f').waitFor();
      const frame = session.livePage.frames().find((f) => f.url().startsWith(app.url))!;
      await frame.evaluate(() => (window as unknown as { fire: () => Promise<void> }).fire());
      await frame.locator('#f button').click();
      await new Promise((r) => setTimeout(r, 800));
      // 画面を離れる・窓を閉じるときの送信も
      await session.livePage
        .frameLocator('#app-pane iframe')
        .locator('body')
        .waitFor()
        .catch(() => {});
      const events = await until(
        () => eventsOf(session.livePage),
        (es) => es.some((e) => e.t === 'failed' && e.why === 'outside'),
      );
      expect(events.some((e) => e.t === 'request' && e.outside)).toBe(true);
      await session.close();
      expect(session.refused().count, out).toBeGreaterThan(0);
    }
    // 外の代わりの受け側には、1 件も届かない
    expect(outside.got).toEqual([]);
  }, 60_000);

  it('止めて見る（起動のときに入れた）: 手元への書きこみが届かない。画面からは外せない', async () => {
    const app = await serve(undefined, (req, res) => {
      if (req.url === '/')
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(
          `<!doctype html><meta charset="utf-8"><button id="w">write</button><p id="r"></p><script>
document.getElementById('w').onclick = () => fetch('/write', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"secret":"s3cr3t"}' })
  .then((x) => (document.getElementById('r').textContent = 'ok ' + x.status), () => (document.getElementById('r').textContent = 'failed'));
</script>`,
        );
      else res.writeHead(200).end('{}');
      return true;
    });
    servers.push(app.server);
    const { session } = await open(app.url, { holdWrites: true });
    const frame = session.livePage.frameLocator('#app-pane iframe');
    await frame.locator('#w').click();
    await frame.locator('#r', { hasText: 'failed' }).waitFor();
    const events = await until(
      () => eventsOf(session.livePage),
      (es) => es.some((e) => e.t === 'failed'),
    );
    expect(events.find((e) => e.t === 'failed')).toMatchObject({ why: 'held' });
    expect(app.got.filter((g) => g.startsWith('POST'))).toEqual([]);
    // 画面の合図でも外れない
    await session.livePage.evaluate(() =>
      (window as unknown as { __stackAtlasLive: (s: unknown) => Promise<void> }).__stackAtlasLive({
        t: 'hold',
        on: false,
      }),
    );
    expect(session.status()).toMatchObject({ hold: true, holdLocked: true });
  }, 60_000);

  it('枠に入るのを拒むアプリは、別の窓で開く（見えるものは同じ）', async () => {
    const app = await serve(APP_DIR, (req, res) => {
      if (req.url !== '/' && req.url !== '/index.html') return false;
      res
        .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY' })
        .end(readFileSync(join(APP_DIR, 'index.html')));
      return true;
    });
    servers.push(app.server);
    const { session, lines } = await open(app.url);
    await until(
      async () => session.status().mode,
      (m) => m === 'window',
    );
    expect(lines.join('\n')).toContain('別の窓');
    const appPage = await until(
      async () => session.appPage(),
      (p) => p !== undefined,
    );
    await appPage!.locator('.card').first().waitFor();
    await appPage!.locator('textarea').fill('別の窓から');
    await appPage!.locator('#comment-form button').click();
    const events = await until(
      () => eventsOf(session.livePage),
      (es) => es.some((e) => e.t === 'request' && e.method === 'POST'),
    );
    expect(events).toContainEqual(expect.objectContaining({ t: 'part', how: 'submit' }));
    expect(await session.livePage.locator('#app-pane iframe').count()).toBe(0);
  }, 60_000);

  it('開けないとき: 手元ではない URL は 2、図に誤りがあれば 1（ブラウザを開く前に止まる）', async () => {
    const fail = async (opts: Parameters<typeof startLive>[0]) => {
      try {
        await startLive(opts);
      } catch (e) {
        return e as LiveError;
      }
      throw new Error('開けてしまった');
    };
    expect(await fail({ root: ATLAS, url: 'http://staging.example.com/' })).toMatchObject({
      exitCode: 2,
    });
    expect(
      await fail({ root: ATLAS, url: 'http://localhost/', localNames: ['10.0.0.1'] }),
    ).toMatchObject({ exitCode: 2 });
    const empty = mkdtempSync(join(tmpdir(), 'stack-atlas-live-empty-'));
    const e = await fail({ root: empty, url: 'http://localhost:9/' });
    expect(e).toMatchObject({ exitCode: 1 });
    expect(e.message).toContain('図に誤りがあるので、ライブを開きませんでした');
  });
});

// PR を作る前のコードレビューと、セキュリティのレビュー（10-2b）で見つかったことを、事実のまま固定する
describe('stack-atlas live（レビューで見つかったこと）', () => {
  /** 返事を差し替える仕組み（素通しするもの）・流しっぱなしの返事・隠れた文字・上の窓を移す、を持つ小さなアプリ */
  async function reviewApp() {
    const evil: string[] = [];
    const page = `<!doctype html><meta charset="utf-8"><body>
<div id="list"><p class="row">見える行<span hidden>隠れた文字 9q2</span></p></div>
<button id="rm">rm</button><button id="pass">pass</button><button id="stream">stream</button>
<button id="multi">multi</button><button id="top">top</button><p id="r"></p>
<script>
const ready = navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready).then(() =>
  navigator.serviceWorker.controller ? 0 : new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true })));
const out = (t) => (document.getElementById('r').textContent = t);
document.getElementById('rm').onclick = () => document.querySelector('.row').remove();
document.getElementById('pass').onclick = async () => { await ready; const x = await fetch('/api/pass', { method: 'POST', body: 'p' }); out('pass ' + x.status); };
document.getElementById('stream').onclick = async () => { const x = await fetch('/api/stream'); out('stream ' + x.status); };
document.getElementById('multi').onclick = async () => { const f = new FormData(); f.append('field', 'マルチの欄の値 4kd8'); const x = await fetch('/api/multi', { method: 'POST', body: f }); out('multi ' + x.status); };
document.getElementById('top').onclick = () => { top.location.href = location.origin + '/evil'; };
</script>`;
    const EVIL = `<!doctype html><meta charset="utf-8"><body><p>evil</p><script>
window.__stackAtlasLiveReceive = (m) => { navigator.sendBeacon('/evil-got', JSON.stringify(m).slice(0, 200)); };
</script>`;
    const SW = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => { if (new URL(e.request.url).pathname === '/api/pass') e.respondWith(fetch(e.request)); });`;
    const app = await serve(undefined, (req, res, body) => {
      const u = new URL(req.url ?? '/', 'http://x');
      if (u.pathname === '/')
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page);
      else if (u.pathname === '/evil')
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(EVIL);
      else if (u.pathname === '/evil-got') {
        evil.push(body);
        res.writeHead(204).end();
      } else if (u.pathname === '/sw.js')
        res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(SW);
      else if (u.pathname === '/api/stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: 1\n\n'); // 終わらない
      } else res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
      return true;
    });
    servers.push(app.server);
    return { app, evil };
  }

  it('素通しする差し替えは、「ブラウザの中で返事が作られた」にしない。流しっぱなしの返事も、返事の知らせが届く', async () => {
    const { app } = await reviewApp();
    const { session } = await open(app.url);
    const frame = session.livePage.frameLocator('#app-pane iframe');
    await frame.locator('#pass').click();
    await frame.locator('#r', { hasText: 'pass 200' }).waitFor();
    await frame.locator('#stream').click();
    await frame.locator('#r', { hasText: 'stream 200' }).waitFor();
    const events = await until(
      () => eventsOf(session.livePage),
      (es) => es.filter((e) => e.t === 'response').length >= 2,
      5_000,
    );
    const responseFor = (path: string) => {
      const req = events.find((e) => e.t === 'request' && e.path.includes(path));
      return events.find((e) => e.t === 'response' && req && e.id === (req as { id: string }).id);
    };
    expect(responseFor('pass')).toMatchObject({ status: 200, inBrowser: false });
    expect(app.got).toContain('POST /api/pass');
    expect(responseFor('stream')).toMatchObject({ status: 200 });
  }, 60_000);

  it('ファイルを運ぶ形の中身は、「値を見る」でも渡さない', async () => {
    const { app } = await reviewApp();
    const { session } = await open(app.url);
    const frame = session.livePage.frameLocator('#app-pane iframe');
    await frame.locator('#multi').click();
    await frame.locator('#r', { hasText: 'multi 200' }).waitFor();
    await until(
      () => eventsOf(session.livePage),
      (es) => es.some((e) => e.t === 'response'),
    );
    await session.livePage.evaluate(() =>
      (window as unknown as { __stackAtlasLive: (s: unknown) => Promise<void> }).__stackAtlasLive({
        t: 'reveal',
        on: true,
      }),
    );
    const all = await until(
      () => delivered(session.livePage),
      (ms) => ms.some((m) => m.t === 'values'),
    );
    expect(JSON.stringify(all)).not.toContain('4kd8');
  }, 60_000);

  it('初めからあった要素を消したとき、隠れていた文字は拾わない', async () => {
    const { app } = await reviewApp();
    const { session } = await open(app.url);
    const frame = session.livePage.frameLocator('#app-pane iframe');
    await frame.locator('#rm').click();
    const events = await until(
      () => eventsOf(session.livePage),
      (es) => es.some((e) => e.t === 'dom' && e.changes.some((c) => c.kind === 'removed')),
    );
    const removed = events
      .flatMap((e) => (e.t === 'dom' ? e.changes : []))
      .find((c) => c.kind === 'removed')!;
    expect(removed.text).toContain('見える行');
    expect(removed.text).not.toContain('9q2');
  }, 60_000);

  it('アプリが上の窓を移しても: 入れ替えは 1 回だけ、アプリの文書には何も渡らない、ライブの画面は 1 枚', async () => {
    const { app, evil } = await reviewApp();
    const { session, lines } = await open(app.url);
    const frame = session.livePage.frameLocator('#app-pane iframe');
    await frame.locator('#top').click();
    await until(
      async () => session.status().mode,
      (m) => m === 'window',
    );
    const appPage = await until(
      async () => session.appPage(),
      (p) => p !== undefined && p.url().endsWith('/evil'),
    );
    await appPage!.evaluate(() => history.pushState({}, '', '/evil#2'));
    await new Promise((r) => setTimeout(r, 1_000));
    expect(lines.filter((l) => l.includes('いちばん上の窓を移した'))).toHaveLength(1);
    expect(evil).toEqual([]);
    expect(session.livePage.url()).toBe(session.liveUrl);
    expect(
      await session.livePage.evaluate(
        () =>
          typeof (window as unknown as { __stackAtlasLiveReceive?: unknown })
            .__stackAtlasLiveReceive,
      ),
    ).toBe('function');
  }, 60_000);

  it('利用者がライブの画面を読み直すと、図と状態が渡し直され、アプリの枠が戻る', async () => {
    const app = await serve(APP_DIR);
    servers.push(app.server);
    const { session } = await open(app.url);
    await session.livePage.frameLocator('#app-pane iframe').locator('.card').first().waitFor();
    await session.livePage.reload();
    await session.livePage.frameLocator('#app-pane iframe').locator('.card').first().waitFor();
    const ms = await delivered(session.livePage);
    expect(ms.map((m) => m.t)).toEqual(expect.arrayContaining(['graph', 'status']));
  }, 60_000);

  it('リンクローカルの宛先（169.254.0.0/16）も、行き先の無い中継に回る', async () => {
    const app = await serve(undefined, (req, res) => {
      res
        .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        .end('<!doctype html><p id="x">app</p>');
      return true;
    });
    servers.push(app.server);
    const { session } = await open(app.url);
    await session.livePage.frameLocator('#app-pane iframe').locator('#x').waitFor();
    const frame = session.livePage.frames().find((f) => f.url().startsWith(app.url))!;
    // 守りが外れていても、ふつうは何も無い宛先にする（ポート 9 などは、ブラウザが通信を出す前に止めるので、使わない）
    await frame.evaluate(() =>
      fetch('http://169.254.0.1/ll', { method: 'POST', body: 'x', mode: 'no-cors' }).catch(
        () => {},
      ),
    );
    const refused = await until(
      async () => session.refused(),
      (r) => r.hosts.includes('169.254.0.1'),
      5_000,
    );
    expect(refused.hosts).toContain('169.254.0.1');
  }, 60_000);

  it.skipIf(process.platform === 'darwin')(
    '127.0.0.1 ではないループバックのアドレス（127.0.0.2）で開いたアプリも、ライブの画面が開く',
    async () => {
      const app = await serve(APP_DIR, undefined, '127.0.0.2');
      servers.push(app.server);
      const { session } = await open(app.url);
      expect(session.liveUrl).toMatch(/^http:\/\/127\.0\.0\.2:/);
      await session.livePage.frameLocator('#app-pane iframe').locator('.card').first().waitFor();
    },
    60_000,
  );
});

// ビューアのライブの画面（10-2c。docs/27 §4.4）。組み立てていなければ、初めに組み立てる
describe('ビューアのライブの画面（実際のブラウザ）', () => {
  beforeAll(() => {
    if (existsSync(join(VIEWER_LIVE_DIR, 'index.html'))) return;
    execFileSync('pnpm', ['--filter', '@stack-atlas/viewer', 'build:live'], {
      cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
      stdio: 'ignore',
    });
  }, 120_000);
  const played = (page: Page) =>
    page.evaluate(() =>
      (
        window as unknown as {
          __stackAtlasLivePlayed: () => Array<{ behavior?: string; ok?: boolean; total: number }>;
        }
      ).__stackAtlasLivePlayed(),
    );

  it('操作に合わせて挙動が選ばれ、経路・再生・時間の内訳・画面の変化が出る。値は伏せたまま。再生の操作に文字が無い', async () => {
    const app = await serve(APP_DIR);
    servers.push(app.server);
    const { session } = await open(app.url, { pageDir: VIEWER_LIVE_DIR });
    const live = session.livePage;
    const frame = live.frameLocator('#app-pane iframe');
    // 開いた: 「開く」の挙動が選ばれ、図と合っている
    await until(
      () => played(live),
      (ps) => ps.some((p) => p.behavior === 'open'),
    );
    expect((await played(live)).find((p) => p.behavior === 'open')).toMatchObject({ ok: true });
    expect(await live.locator('#behaviors button').count()).toBe(3);

    const TEXT = 'ビューアの画面の確かめ 2b9e';
    await frame.locator('.card').first().waitFor();
    await frame.locator('textarea').fill(TEXT);
    await frame.locator('#comment-form button').click();
    await frame.locator('.card', { hasText: TEXT }).waitFor();
    await until(
      () => played(live),
      (ps) => ps.some((p) => p.behavior === 'post-comment'),
    );
    expect((await played(live)).find((p) => p.behavior === 'post-comment')).toMatchObject({
      ok: true,
    });
    await expect.poll(() => live.locator('#f-name').textContent()).toBe('コメントを投稿する');
    expect(await live.locator('#f-verdict').textContent()).toBe('図と合っている');
    // 経路は 8 段。再生の操作は、部品だけ（文字が無い）
    expect(await live.locator('#path .hop').count()).toBe(8);
    expect(await live.locator('#player').isVisible()).toBe(true);
    expect((await live.locator('#player').innerText()).trim()).toBe('');
    expect(await live.locator('#p-speed').inputValue()).toBe('0.2');
    // 時間の内訳: いちばん長いのは、投稿の返事を待つ所（サンプルのバックエンドは、投稿を遅らせて返す）
    expect(await live.locator('#s-times .trow.max .lbl').textContent()).toBe(
      'POST /api/comments の返事を待つ',
    );
    // 画面に反映されたもの: 増えた投稿（丸ごと描き直しても、増えた 1 件だけ）
    expect(await live.locator('#s-dom').innerText()).toContain(`増えた: ${TEXT}`);
    // 値は伏せたまま。入れると出る
    // 「実際の通信」は、たたんだ欄の中にあるので、見えている文字（innerText）ではなく、要素の中の文字で確かめる
    expect(await live.locator('#s-reqs').textContent()).toContain('POST');
    expect(await live.locator('#s-reqs').textContent()).not.toContain(TEXT);
    await live.locator('#reveal').click();
    await expect.poll(() => live.locator('#s-reqs').textContent()).toContain(TEXT);
    expect(await live.locator('#reveal').getAttribute('aria-pressed')).toBe('true');

    // 削除（重なった部品）: 削除の挙動が選ばれる
    await frame.locator('.card', { hasText: TEXT }).locator('button.del').click();
    await until(
      () => played(live),
      (ps) => ps.some((p) => p.behavior === 'delete-comment'),
    );
    expect((await played(live)).find((p) => p.behavior === 'delete-comment')).toMatchObject({
      ok: true,
    });
    // 再生は、最後まで進む（見せる速さを 1 倍にして待つ）
    await live.locator('#p-speed').fill('1');
    await expect
      .poll(() =>
        live.evaluate(
          () =>
            (window as unknown as { __stackAtlasLiveReplayed?: number }).__stackAtlasLiveReplayed ??
            0,
        ),
      )
      .toBeGreaterThan(0);
    expect(await live.locator('#history li').count()).toBeGreaterThanOrEqual(3);
  }, 60_000);

  it('一覧から挙動を選ぶと、操作しなくても、経路と、始まりの部品の場所が出る', async () => {
    const app = await serve(APP_DIR);
    servers.push(app.server);
    const { session } = await open(app.url, { pageDir: VIEWER_LIVE_DIR });
    const live = session.livePage;
    await live.frameLocator('#app-pane iframe').locator('.card').first().waitFor();
    await until(
      () => played(live),
      (ps) => ps.length > 0,
    );
    await live.locator('#behaviors button', { hasText: 'コメントを投稿する' }).click();
    expect(await live.locator('#f-name').textContent()).toBe('コメントを投稿する');
    expect(await live.locator('#f-state').textContent()).toBe('図のまま');
    expect(await live.locator('#path .hop.drawn').count()).toBe(8);
    await expect.poll(() => live.locator('#overlay .box.part.stay').count()).toBe(1);
    expect(await live.locator('#player').isVisible()).toBe(false);
  }, 60_000);

  it('図とアプリから来た文字は、HTML として解釈されない', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stack-atlas-live-xss-'));
    cpSync(ATLAS, root, { recursive: true });
    const file = join(root, '.stack-atlas/behaviors.yaml');
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace(
        'name: "画面を開く"',
        'name: "<img src=x onerror=window.__pwned=1><b>開く</b>"',
      ),
    );
    const app = await serve(undefined, (req, res) => {
      res
        .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        .end(
          '<!doctype html><p id="x">app</p><script>document.getElementById("x").textContent = "<img src=y onerror=top.__pwned2=1>";</script>',
        );
      return true;
    });
    servers.push(app.server);
    const { session } = await open(app.url, { root, pageDir: VIEWER_LIVE_DIR });
    const live = session.livePage;
    await expect
      .poll(() => live.locator('#behaviors').innerText())
      .toContain('<img src=x onerror=window.__pwned=1><b>開く</b>');
    expect(await live.locator('#behaviors img, #behaviors b').count()).toBe(0);
    expect(
      await live.evaluate(() => (window as unknown as { __pwned?: number }).__pwned),
    ).toBeUndefined();
    expect(await live.locator('#s-dom img, #path img').count()).toBe(0);
  }, 60_000);
});

/** この機械の、ループバックではない IPv4 のアドレス（外の代わりの受け側を聞かせる。無ければ undefined） */
function lanAddress(): string | undefined {
  return Object.values(networkInterfaces())
    .flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
}
