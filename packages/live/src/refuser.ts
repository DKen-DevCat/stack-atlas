/**
 * 行き先の無い中継（docs/27 §5.2、D231）。ブラウザは、手元ではない宛先への通信を、すべてここへ回す。
 * ここは、何も中継せずに断る。ループバックだけで聞く。
 * 断った宛先は、名前だけを覚える（パスや中身は、値を含みうるので覚えない）
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Refuser {
  server: Server;
  /** ブラウザの中継の設定に書く `http://127.0.0.1:<port>` */
  url: string;
  /** 断った数 */
  count(): number;
  /** 断った宛先の名前（重複なし。数に上限） */
  hosts(): string[];
  close(): Promise<void>;
}

const MAX_HOSTS = 50;
const hostOf = (target: string | undefined): string => {
  if (!target) return '?';
  try {
    return new URL(target.includes('://') ? target : `http://${target}`).hostname || '?';
  } catch {
    return '?';
  }
};

export async function startRefuser(): Promise<Refuser> {
  let count = 0;
  const hosts = new Set<string>();
  const note = (target: string | undefined) => {
    count++;
    if (hosts.size < MAX_HOSTS) hosts.add(hostOf(target));
  };
  const server = createServer((req, res) => {
    note(req.url);
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
    res.end('stack-atlas live: 手元の外へは、つながりません');
  });
  server.on('connect', (req, socket) => {
    note(req.url);
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
  });
  server.on('upgrade', (req, socket) => {
    note(req.url);
    socket.destroy();
  });
  server.on('clientError', (_err, socket) => socket.destroy());
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address() as AddressInfo;
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    count: () => count,
    hosts: () => [...hosts],
    close: () =>
      new Promise<void>((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}
