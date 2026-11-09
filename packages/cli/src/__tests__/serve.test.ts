import { SCREEN_CSP } from '@stack-atlas/extractor-screens';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SCREENS_CSP,
  contentType,
  createAtlasServer,
  hostnameOf,
  isAllowedHost,
  isScreensPath,
  resolveStaticPath,
} from '../commands/serve.js';

describe('resolveStaticPath', () => {
  const root = '/srv/out';
  it('root 内のファイルに解決する', () => {
    expect(resolveStaticPath(root, '/graph.json')).toBe('/srv/out/graph.json');
    expect(resolveStaticPath(root, '/index.html?graph=./graph.json')).toBe('/srv/out/index.html');
    expect(resolveStaticPath(root, '/shots/')).toBe('/srv/out/shots/index.html');
    expect(resolveStaticPath(root, '/a/../b.json')).toBe('/srv/out/b.json');
    expect(resolveStaticPath(root, '/races%2F%5Bid%5D.png')).toBe('/srv/out/races/[id].png');
  });

  it('root の外・不正なエンコード・NUL・バックスラッシュは null', () => {
    for (const p of [
      '/../etc/passwd',
      '/..%2f..%2fetc/passwd',
      '/%2e%2e/%2e%2e/etc/passwd',
      '/..',
      '/%E0%A4%A',
      '/a%00.json',
      '/..%5c..%5cwin.ini',
      '//etc/passwd/../../..',
    ]) {
      const r = resolveStaticPath(root, p);
      expect(r === null || r.startsWith('/srv/out/'), p).toBe(true);
    }
    expect(resolveStaticPath(root, '/../etc/passwd')).toBe('/srv/out/etc/passwd');
    expect(resolveStaticPath(root, '/%E0%A4%A')).toBeNull();
    expect(resolveStaticPath(root, '/a%00.json')).toBeNull();
    expect(resolveStaticPath(root, '/..%5c..%5cwin.ini')).toBeNull();
  });

  it('content type', () => {
    expect(contentType('a/index.html')).toMatch(/^text\/html/);
    expect(contentType('x.JSON')).toMatch(/^application\/json/);
    expect(contentType('s.png')).toBe('image/png');
    expect(contentType('blob.bin')).toBe('application/octet-stream');
  });
});

describe('createAtlasServer', () => {
  const servers: Array<{ close(): void }> = [];
  afterEach(() => servers.splice(0).forEach((s) => s.close()));

  async function start(
    opts: { withIndex?: boolean; repo?: boolean; allowedHosts?: string[] } = {},
  ) {
    const base = mkdtempSync(join(tmpdir(), 'stack-atlas-serve-'));
    const out = join(base, 'out');
    const viewer = join(base, 'viewer');
    const repo = join(base, 'repo');
    mkdirSync(out);
    mkdirSync(viewer);
    mkdirSync(repo);
    writeFileSync(join(out, 'graph.json'), '{"version":1}');
    writeFileSync(join(out, 'graph.v1.json'), '{"version":1,"v1":true}');
    writeFileSync(join(base, 'secret.txt'), 'secret');
    writeFileSync(join(viewer, 'index.html'), '<p>viewer</p>');
    if (opts.withIndex) writeFileSync(join(out, 'index.html'), '<p>bundled</p>');
    const server = createAtlasServer({
      outDir: out,
      viewerDist: viewer,
      repo: opts.repo ? repo : undefined,
      allowedHosts: opts.allowedHosts,
    });
    servers.push(server);
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { url, out, repo };
  }

  it('/ をリダイレクトし、index.html が無ければワークスペースのビューアを配信する', async () => {
    const { url } = await start();
    const r = await fetch(`${url}/`, { redirect: 'manual' });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/index.html?graph=./graph.json');
    const index = await fetch(`${url}/index.html?graph=./graph.json`);
    expect(await index.text()).toBe('<p>viewer</p>');
    const g = await fetch(`${url}/graph.json`);
    expect(g.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await g.text()).toBe('{"version":1}');
    expect((await fetch(`${url}/missing.js`)).status).toBe(404);
    expect((await fetch(`${url}/..%2fsecret.txt`)).status).not.toBe(200);
  });

  it('build の graph.v1.json（3D の地図）も配信し、HEAD に答える（ビューアは HEAD で有無を見る）', async () => {
    const { url } = await start();
    const g = await fetch(`${url}/graph.v1.json`);
    expect(g.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await g.text()).toBe('{"version":1,"v1":true}');
    const head = await fetch(`${url}/graph.v1.json`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect((await fetch(`${url}/nope.v1.json`, { method: 'HEAD' })).status).toBe(404);
  });

  it('/screens/ の下（画面の HTML と資産）だけに sandbox 付きの CSP と nosniff を付ける（8-3b）', async () => {
    const { url, out } = await start();
    mkdirSync(join(out, 'screens', 'index'), { recursive: true });
    mkdirSync(join(out, 'screens', '_assets'), { recursive: true });
    writeFileSync(join(out, 'screens', 'index', 'index.html'), '<!DOCTYPE html><p>screen</p>');
    writeFileSync(
      join(out, 'screens', '_assets', 'a.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
    );
    writeFileSync(join(out, 'screens.json'), '{}');
    for (const path of [
      '/screens/index/index.html',
      '/screens/index/',
      '/screens/_assets/a.svg',
      '/%73creens/index/index.html', // URL ではなく解決したパスで判定する
      '/graph.json/../screens/index/index.html',
    ]) {
      const r = await fetch(`${url}${path}`);
      expect(r.status, path).toBe(200);
      expect(r.headers.get('content-security-policy'), path).toBe(SCREENS_CSP);
      expect(r.headers.get('x-content-type-options'), path).toBe('nosniff');
    }
    expect(SCREENS_CSP).toMatch(/^sandbox allow-same-origin; default-src 'none'; /);
    expect(SCREENS_CSP).not.toMatch(/allow-scripts|allow-forms|allow-popups/);
    for (const path of ['/graph.json', '/screens.json', '/index.html']) {
      const r = await fetch(`${url}${path}`);
      expect(r.status, path).toBe(200);
      expect(r.headers.get('content-security-policy'), path).toBeNull();
    }
    const head = await fetch(`${url}/screens/index/index.html`, { method: 'HEAD' });
    expect(head.headers.get('content-security-policy')).toBe(SCREENS_CSP);
  });

  it('応答ヘッダの CSP は、消毒した HTML の meta の CSP に sandbox を足したもの。docs/11・docs/18 と同じ文字列', () => {
    expect(SCREENS_CSP).toBe(`sandbox allow-same-origin; ${SCREEN_CSP}`);
    const doc = (name: string) =>
      readFileSync(new URL(`../../../../docs/${name}`, import.meta.url), 'utf8');
    expect(doc('11-sharing.md')).toContain(SCREENS_CSP);
    expect(doc('18-design-wiring-viewer.md')).toContain(SCREENS_CSP);
    expect(doc('18-design-wiring-viewer.md')).toContain(SCREEN_CSP);
  });

  // 2026-11-09 追加（8-3b のレビュー）: 大文字小文字を区別しない FS（macOS の既定）では /SCREENS/ が同じファイルを CSP 無しで返していた
  it('/SCREENS/・/%53creens/・screens/ を指す別名のディレクトリでも、screens/ の中のファイルには CSP を付ける', async () => {
    const { url, out } = await start();
    mkdirSync(join(out, 'screens', 'index'), { recursive: true });
    writeFileSync(join(out, 'screens', 'index', 'index.html'), '<!DOCTYPE html><p>screen</p>');
    symlinkSync(join(out, 'screens'), join(out, 'alias'));
    const caseInsensitive = existsSync(join(out, 'SCREENS'));
    for (const path of [
      '/SCREENS/index/index.html',
      '/%53creens/index/index.html',
      '/Screens/index/',
      '/alias/index/index.html',
    ]) {
      const r = await fetch(`${url}${path}`);
      if (path.startsWith('/alias') || caseInsensitive) expect(r.status, path).toBe(200);
      if (r.status === 200)
        expect(r.headers.get('content-security-policy'), path).toBe(SCREENS_CSP);
    }
  });

  it('isScreensPath は root からの相対パスの最初の段で見る', () => {
    expect(isScreensPath('/srv/out', '/srv/out/SCREENS/a/index.html')).toBe(true);
    expect(isScreensPath('/srv/out', '/srv/out/screens/a/index.html')).toBe(true);
    expect(isScreensPath('/srv/out/', '/srv/out/screens/_assets/x.css')).toBe(true);
    expect(isScreensPath('/srv/out', '/srv/out/screens.json')).toBe(false);
    expect(isScreensPath('/srv/out', '/srv/out/a/screens/x.html')).toBe(false);
    expect(isScreensPath('/srv/out', '/srv/viewer/screens/x.html')).toBe(false);
  });

  it('outDir に index.html があればそちらを使う', async () => {
    const { url } = await start({ withIndex: true });
    expect(await (await fetch(`${url}/index.html`)).text()).toBe('<p>bundled</p>');
  });

  it('Host ヘッダがループバックでも許可リストでもなければ 403（DNS リバインディング対策）', async () => {
    const { url, repo } = await start({ repo: true, allowedHosts: ['atlas.internal'] });
    // fetch() は Host を書き換えさせない（forbidden header）ので node:http で送る
    const raw = (host: string, path: string, method = 'GET', body?: string) =>
      new Promise<number>((ok, ng) => {
        const req = request(
          `${url}${path}`,
          {
            method,
            headers: {
              Host: host,
              ...(body ? { 'Content-Type': 'application/json' } : {}),
            },
          },
          (res) => {
            res.resume();
            res.on('end', () => ok(res.statusCode ?? 0));
          },
        );
        req.on('error', ng);
        req.end(body);
      });
    expect(await raw('rebind.attacker.example:4173', '/graph.json')).toBe(403);
    expect(await raw('rebind.attacker.example:4173', '/')).toBe(403);
    expect(await raw('localhost:4173', '/graph.json')).toBe(200);
    expect(await raw('127.0.0.1', '/graph.json')).toBe(200);
    expect(await raw('ATLAS.internal:4173', '/graph.json')).toBe(200);
    expect(await raw('[::1]:4173', '/graph.json')).toBe(200);
    // 書き込みも同じ。拒否されたらファイルは変わらない
    expect(await raw('rebind.attacker.example:4173', '/api/memos', 'POST', '{"a":"b"}')).toBe(403);
    expect(existsSync(join(repo, '.stack-atlas', 'memos.json'))).toBe(false);
    expect(await raw('localhost:4173', '/api/memos', 'POST', '{"a":"b"}')).toBe(200);
    expect(existsSync(join(repo, '.stack-atlas', 'memos.json'))).toBe(true);
  });

  it('hostnameOf / isAllowedHost', () => {
    expect(hostnameOf('example.com:4173')).toBe('example.com');
    expect(hostnameOf('Example.com')).toBe('example.com');
    expect(hostnameOf('[::1]:4173')).toBe('[::1]');
    expect(hostnameOf(undefined)).toBe('');
    expect(isAllowedHost(undefined, [])).toBe(true); // HTTP/1.0（Host なし）
    expect(isAllowedHost('', [])).toBe(true);
    expect(isAllowedHost('localhost:1', [])).toBe(true);
    expect(isAllowedHost('evil.example', [])).toBe(false);
    expect(isAllowedHost('evil.example', ['evil.example'])).toBe(true);
    expect(isAllowedHost(':4173', [])).toBe(false);
  });

  it('メモ API: --repo なしの POST は 405', async () => {
    const { url } = await start();
    const r = await fetch(`${url}/api/memos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"a":"b"}',
    });
    expect(r.status).toBe(405);
    expect(await (await fetch(`${url}/api/memos`)).json()).toEqual({});
  });

  it('メモ API: --repo ありなら書き戻し、GET で読める', async () => {
    const { url, repo, out } = await start({ repo: true });
    const post = (body: string, type = 'application/json') =>
      fetch(`${url}/api/memos`, { method: 'POST', headers: { 'Content-Type': type }, body });
    expect((await post('{"infra:next":"メモ"}')).status).toBe(200);
    expect(JSON.parse(readFileSync(join(repo, '.stack-atlas', 'memos.json'), 'utf8'))).toEqual({
      'infra:next': 'メモ',
    });
    expect(JSON.parse(readFileSync(join(out, 'memos.json'), 'utf8'))).toEqual({
      'infra:next': 'メモ',
    });
    expect(await (await fetch(`${url}/api/memos`)).json()).toEqual({ 'infra:next': 'メモ' });
    expect((await post('{"a":1}')).status).toBe(400);
    expect((await post('not json')).status).toBe(400);
    expect((await post('{"a":"b"}', 'text/plain')).status).toBe(415);
  });
});
