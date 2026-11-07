/**
 * `stack-atlas serve <outDir> [--port 4173] [--host 127.0.0.1] [--repo <repo>] [--allowed-host <name>]...`
 *
 * - Host ヘッダがループバック・`--host`・`--allowed-host` のどれでもなければ 403（DNS リバインディング対策）
 * - outDir を静的配信する。outDir に index.html が無ければ、ワークスペースのビューア（packages/viewer/dist）を
 *   後ろに重ねて配信する（graph.json などは outDir が優先）
 * - `/` は `/index.html?graph=./graph.json` へリダイレクト
 * - `GET /api/memos`: メモを返す（--repo があれば <repo>/.stack-atlas/memos.json、無ければ outDir/memos.json）
 * - `POST /api/memos`: body（`Record<string,string>`、Content-Type: application/json）を
 *   <repo>/.stack-atlas/memos.json と outDir/memos.json に書く。--repo が無ければ 405
 */
import {
  isMemos,
  saveMemos,
  serializeMemos,
  silentLogger,
  type Logger,
  type Memos,
} from '@stack-atlas/core';
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { VIEWER_DIST } from '../paths.js';

export const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

export function contentType(file: string): string {
  return CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * URL のパス部分を root 内のファイルパスにする。root の外に出る・不正なエンコード・NUL を含む場合は null。
 * 末尾が / なら index.html を足す。
 */
export function resolveStaticPath(root: string, urlPath: string): string | null {
  const pathname = urlPath.split(/[?#]/)[0] ?? '';
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  if (!decoded.startsWith('/')) decoded = `/${decoded}`;
  if (decoded.endsWith('/')) decoded += 'index.html';
  const base = resolve(root);
  const target = resolve(base, `.${normalize(decoded)}`);
  const rel = relative(base, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..'))
    return null;
  return target;
}

export interface ServeOptions {
  outDir: string;
  repo?: string;
  viewerDist?: string;
  log?: Logger;
  /**
   * 受け付ける Host ヘッダのホスト名。ループバック（localhost / 127.0.0.1 / ::1）はいつも許可する。
   * `--host` で待ち受けアドレスを変えたときはそれも許可する。社内の名前で配信するなら `--allowed-host` で足す
   */
  allowedHosts?: string[];
}

export const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]'];

/** Host ヘッダ（`example.com:4173`、`[::1]:4173`）からホスト名だけを取る。小文字にする */
export function hostnameOf(hostHeader: string | undefined): string {
  const h = (hostHeader ?? '').trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end < 0 ? h : h.slice(0, end + 1);
  }
  const i = h.lastIndexOf(':');
  return i < 0 ? h : h.slice(0, i);
}

/**
 * Host ヘッダが許可されたホスト名か。
 * DNS リバインディング（攻撃者のドメインを 127.0.0.1 に解決し直し、同一オリジンとして graph.json を読んだり
 * メモを書き換えたりする）を防ぐため、知らない Host は 403 にする。Host が無い（HTTP/1.0）ものは通す
 */
export function isAllowedHost(hostHeader: string | undefined, allowed: readonly string[]): boolean {
  if (hostHeader === undefined || hostHeader === '') return true;
  const name = hostnameOf(hostHeader);
  if (name === '') return false;
  return [...LOOPBACK_HOSTS, ...allowed].some((a) => a.toLowerCase() === name);
}

const MAX_BODY = 5 * 1024 * 1024;

function send(
  res: ServerResponse,
  status: number,
  body: string,
  type = 'text/plain; charset=utf-8',
) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}
const sendJson = (res: ServerResponse, status: number, v: unknown) =>
  send(res, status, `${JSON.stringify(v)}\n`, CONTENT_TYPES['.json']);

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((ok, ng) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        ng(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
    req.on('error', ng);
  });
}

/** 静的配信 + メモ API のサーバを作る（listen は呼び出し側） */
export function createAtlasServer(opts: ServeOptions): Server {
  const outDir = resolve(opts.outDir);
  const log = opts.log ?? silentLogger;
  const viewerDist = opts.viewerDist ?? VIEWER_DIST;
  const roots = existsSync(join(outDir, 'index.html')) ? [outDir] : [outDir, viewerDist];
  const repo = opts.repo ? resolve(opts.repo) : undefined;
  const allowedHosts = opts.allowedHosts ?? [];

  const memosPath = () =>
    repo ? join(repo, '.stack-atlas', 'memos.json') : join(outDir, 'memos.json');

  async function handleMemos(req: IncomingMessage, res: ServerResponse) {
    if (req.method === 'GET' || req.method === 'HEAD') {
      const p = memosPath();
      let memos: Memos = {};
      try {
        if (existsSync(p)) memos = JSON.parse(readFileSync(p, 'utf8')) as Memos;
      } catch {
        return sendJson(res, 500, { error: 'memos.json を読めません' });
      }
      return sendJson(res, 200, memos);
    }
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'GET か POST だけです' });
    if (!repo) return sendJson(res, 405, { error: '--repo を付けて起動したときだけ書き込めます' });
    // 他サイトからの単純リクエスト（text/plain）で書き換えられないよう JSON に限る
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
      return sendJson(res, 415, { error: 'Content-Type: application/json で送ってください' });
    }
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: 'JSON として読めません' });
    }
    if (!isMemos(body))
      return sendJson(res, 400, { error: '{ "ノードID": "メモ" } の形にしてください' });
    const file = saveMemos(repo, body);
    writeFileSync(join(outDir, 'memos.json'), serializeMemos(body));
    log.info(`メモを保存しました: ${file}（${Object.keys(body).length} 件）`);
    return sendJson(res, 200, { ok: true, count: Object.keys(body).length });
  }

  return createServer((req, res) => {
    const url = req.url ?? '/';
    const pathname = url.split(/[?#]/)[0] ?? '/';
    if (!isAllowedHost(req.headers.host, allowedHosts)) {
      log.warn(
        `許可していない Host ヘッダ（${req.headers.host}）を拒否しました。--allowed-host で許可できます`,
      );
      return send(res, 403, 'Forbidden: Host');
    }
    if (pathname === '/api/memos') {
      handleMemos(req, res).catch((e: Error) => sendJson(res, 500, { error: e.message }));
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method Not Allowed');
    if (pathname === '/') {
      res.writeHead(302, { Location: '/index.html?graph=./graph.json' });
      return res.end();
    }
    for (const root of roots) {
      const file = resolveStaticPath(root, url);
      if (file === null) return send(res, 400, 'Bad Request');
      let st;
      try {
        st = statSync(file);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      res.writeHead(200, {
        'Content-Type': contentType(file),
        'Content-Length': st.size,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      if (req.method === 'HEAD') return res.end();
      createReadStream(file).pipe(res);
      return;
    }
    send(res, 404, 'Not Found');
  });
}

export function runServe(opts: ServeOptions & { port?: number; host?: string }): Promise<number> {
  const log = opts.log ?? silentLogger;
  const outDir = resolve(opts.outDir);
  if (!existsSync(outDir)) {
    log.error(`${outDir} がありません（先に stack-atlas build を実行してください）`);
    return Promise.resolve(2);
  }
  const viewerDist = opts.viewerDist ?? VIEWER_DIST;
  if (!existsSync(join(outDir, 'index.html')) && !existsSync(join(viewerDist, 'index.html'))) {
    log.error(
      `ビューアがありません。build --with-viewer を使うか、pnpm build でビューアをビルドしてください`,
    );
    return Promise.resolve(2);
  }
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 4173;
  // --host で待ち受けアドレスを変えたら、そのアドレスを Host に書いたリクエストは通す（0.0.0.0 / :: は除く）
  const allowedHosts = [...(opts.allowedHosts ?? [])];
  if (!['0.0.0.0', '::', '[::]'].includes(host)) allowedHosts.push(host);
  const server = createAtlasServer({ ...opts, viewerDist, log, allowedHosts });
  return new Promise((done) => {
    server.on('error', (e) => {
      log.error(`サーバを起動できません: ${e.message}`);
      done(1);
    });
    server.listen(port, host, () => {
      log.info(`http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/ で配信中（${outDir}）`);
      if (opts.repo)
        log.info(`メモの保存先: ${join(resolve(opts.repo), '.stack-atlas', 'memos.json')}`);
      log.info('Ctrl+C で終了');
    });
  });
}
