/**
 * ライブの画面を配る、手元のサーバー（docs/27 §5.4）。ループバックだけで聞く。
 * 配るのは、ライブの画面のファイル（決まった名前だけ）。図や出来事は、ここでは配らない（道具が、ブラウザを動かす部品の口で、
 * ライブの画面に直に渡す。D230）。対象の repo の中のファイルは配らない。
 * 届いたヘッダ（アプリの Cookie も届く）は、使わない・記録しない
 */
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

/** ライブの画面のファイル（この名前だけを配る） */
export const PAGE_FILES: Record<string, string> = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/live.js': 'live.js',
  '/live.css': 'live.css',
};
const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
};

/** 最小のライブの画面（出来事を文字で並べるだけ）。ビューアのライブの画面を組み立てていないときに使う */
export const MINIMAL_PAGE_DIR = fileURLToPath(new URL('../page/', import.meta.url));
/** ビューアのライブの画面（`pnpm --filter @stack-atlas/viewer build` が、決まった名前のファイルを出す。docs/27 §4.4） */
export const VIEWER_LIVE_DIR = fileURLToPath(new URL('../../viewer/dist-live/', import.meta.url));
/** 配るライブの画面: ビューアのものを組み立ててあれば、それ。無ければ、最小のもの */
export const defaultPageDir = (): string =>
  Object.values(PAGE_FILES).every((name) => existsSync(`${VIEWER_LIVE_DIR}${name}`))
    ? VIEWER_LIVE_DIR
    : MINIMAL_PAGE_DIR;

export interface LiveServer {
  server: Server;
  /** ライブの画面の URL（アプリと同じ名前・別のポート。D234） */
  url: string;
  origin: string;
  close(): Promise<void>;
}

export interface LiveServerOptions {
  /** ライブの画面の URL に使う名前（アプリの URL の hostname と同じ） */
  hostname: string;
  /** 枠に入れてよいアプリの出所 */
  appOrigin: string;
  pageDir?: string;
}

/** 読みこみ元を絞るヘッダ: スクリプトと様式は自分の出所だけ、枠はアプリの出所だけ、ほかの画面の枠には入らない */
export function pageHeaders(appOrigin: string): Record<string, string> {
  return {
    'Content-Security-Policy': [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      `frame-src ${appOrigin}`,
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join('; '),
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  };
}

export async function startLiveServer(opts: LiveServerOptions): Promise<LiveServer> {
  const dir = opts.pageDir ?? defaultPageDir();
  // 起動のときに読んでおく（配る途中で、ファイルを開かない）
  const files = new Map<string, { body: Buffer; type: string }>();
  for (const [path, name] of Object.entries(PAGE_FILES))
    files.set(path, {
      body: readFileSync(`${dir}${name}`),
      type: TYPES[name.split('.').pop()!] ?? 'application/octet-stream',
    });
  // アプリと同じ名前にするため、アプリがループバックのアドレス（127.0.0.2 など・::1）なら、そのアドレスで聞く。名前なら 127.0.0.1
  const listenHost =
    opts.hostname === '[::1]'
      ? '::1'
      : /^127\.\d+\.\d+\.\d+$/.test(opts.hostname)
        ? opts.hostname
        : '127.0.0.1';
  let origin = '';
  const server = createServer((req, res) => {
    // Host が、ライブの画面の名前と違えば断る（ほかの名前で届く通信を受けない。DNS の付け替えへの守り）
    const host = req.headers.host ?? '';
    if (host !== new URL(origin).host) {
      res.writeHead(403).end();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    const file = files.get((req.url ?? '/').split(/[?#]/)[0]!);
    if (!file) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': file.type,
      'Content-Length': file.body.length,
      ...pageHeaders(opts.appOrigin),
    });
    res.end(req.method === 'HEAD' ? undefined : file.body);
  });
  await new Promise<void>((ok) => server.listen(0, listenHost, ok));
  const { port } = server.address() as AddressInfo;
  origin = `http://${opts.hostname}:${port}`;
  return {
    server,
    url: `${origin}/`,
    origin,
    close: () =>
      new Promise<void>((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}
