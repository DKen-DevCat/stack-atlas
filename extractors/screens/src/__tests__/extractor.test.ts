// screens 抽出器: fixture-poly（web/export。Next の静的エクスポートに寄せた合成）と fixture-repo（site/）、設定と境目
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { PartialGraph, PartialNode, RepoContext, StackAtlasConfig } from '@stack-atlas/core';
import type { Edge } from '@stack-atlas/schema';
import { SCREENS_MARKER } from '@stack-atlas/core';
import { uniqueSlug } from '@stack-atlas/extractor-screenshots';
import { extractor, htmlCandidates } from '../index.js';
import { SCREEN_CSP } from '../sanitize.js';

const here = dirname(fileURLToPath(import.meta.url));
const examples = resolve(here, '../../../../examples');

function ctxFor(
  root: string,
  config: StackAtlasConfig,
  opts: { repoName?: string; repos?: Record<string, string> } = {},
) {
  const logs: string[] = [];
  const repoName = opts.repoName ?? 'app';
  const ctx: RepoContext = {
    root,
    repoName,
    repos: opts.repos ?? { [repoName]: root },
    configDir: root,
    config,
    log: {
      debug() {},
      info: (m) => logs.push(m),
      warn: (m) => logs.push(m),
      error: (m) => logs.push(m),
    },
    resolve: (...s) => resolve(root, ...s),
  };
  return { ctx, logs };
}
const N = (id: string, extra: Partial<PartialNode> = {}): PartialNode => ({ id, ...extra });
const uses = (from: string, to: string): Edge => ({ from, to, kind: 'uses' });
const tmpOut = () => realpathSync(mkdtempSync(join(tmpdir(), 'stack-atlas-screens-out-')));

/** 出力先の中の全部のファイル（相対パス） */
function listFiles(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((d) => {
    const p = join(dir, d);
    return statSync(p).isDirectory() ? listFiles(p, base) : [p.slice(base.length + 1)];
  });
}

describe('fixture-poly（web/export。from: dir、trailingSlash の a/index.html）', async () => {
  const poly = join(examples, 'fixture-poly');
  const web = join(poly, 'web');
  const out = tmpOut();
  const config: StackAtlasConfig = {
    repos: { web: './web', platform: './platform' },
    next: { repo: 'web', appDir: 'src/app' },
    screens: { repo: 'web', from: 'dir', dir: 'export', outDir: out },
  };
  // nextjs-app と ts-imports が出す route と uses（複数 repo なので file は web/…）
  const upstream: PartialGraph = {
    nodes: [
      N('route:/', { kind: 'page', file: 'web/src/app/page.tsx' }),
      N('route:/calendar', { kind: 'page', file: 'web/src/app/calendar/page.tsx' }),
      N('route:/push', { kind: 'page', file: 'web/src/app/push/page.tsx' }),
      N('layout:/', { kind: 'layout', file: 'web/src/app/layout.tsx' }),
      ...[
        'TodayIsland',
        'TotalCard',
        'EntryList',
        'CalendarIsland',
        'CalendarGrid',
        'PushToggle',
      ].map((c) => N(`comp:${c}`, { kind: 'component' })),
      N('lib:fetcher', { kind: 'lib' }),
      N('handler:cmd/api', { kind: 'handler', file: 'platform/cmd/api/main.go' }),
    ],
    edges: [
      uses('route:/', 'comp:TodayIsland'),
      uses('comp:TodayIsland', 'comp:TotalCard'),
      uses('comp:TodayIsland', 'comp:EntryList'),
      uses('route:/calendar', 'comp:CalendarIsland'),
      uses('comp:CalendarIsland', 'comp:CalendarGrid'),
      uses('route:/push', 'comp:PushToggle'),
    ],
  };
  const repos = { web, platform: join(poly, 'platform') };
  const { ctx } = ctxFor(web, config, { repoName: 'web', repos });
  expect(await extractor.detect(ctx)).toBe(true);
  expect(
    await extractor.detect(
      ctxFor(join(poly, 'platform'), config, { repoName: 'platform', repos }).ctx,
    ),
  ).toBe(false);
  const g = await extractor.extract(ctx, upstream);
  const files = listFiles(out);
  const issue = (path: string, re: RegExp) =>
    g.issues!.find((i) => i.path === path && re.test(i.message));

  it('3 つの route に screen = { html, width, height, source: dir }（trailingSlash の calendar/index.html）', () => {
    expect(g.edges).toEqual([]);
    expect(Object.fromEntries(g.nodes.map((n) => [n.id, n.screen]))).toEqual({
      'route:/': { html: 'screens/index/index.html', width: 1280, height: 800, source: 'dir' },
      'route:/calendar': {
        html: 'screens/calendar/index.html',
        width: 1280,
        height: 800,
        source: 'dir',
      },
      'route:/push': { html: 'screens/push/index.html', width: 1280, height: 800, source: 'dir' },
    });
  });

  it('書くのは screens/ の下だけ: 画面の HTML・資産（CSS・フォント・画像）・印。script・404・SVG のファイルは写さない', () => {
    expect(files.every((f) => f.startsWith('screens/'))).toBe(true);
    expect(files.filter((f) => !f.startsWith('screens/_assets/')).sort()).toEqual(
      [
        'screens/calendar/index.html',
        'screens/index/index.html',
        'screens/push/index.html',
        `screens/${SCREENS_MARKER}`,
      ].sort(),
    );
    const assets = files
      .filter((f) => f.startsWith('screens/_assets/'))
      .map((f) => f.split('.').pop());
    // 2026-11-09 変更（8-3b）: images/logo.svg はファイルで写していた（svg があった）が、img の src に data: URL で埋め込む
    expect(assets.sort()).toEqual(['css', 'png', 'woff2']);
    for (const f of files)
      expect(f).toMatch(
        /^screens\/(_assets\/[0-9a-f]{20}\.(css|png|woff2)|[a-z]+\/index\.html|\.stack-atlas-screens)$/,
      );
  });

  it('書いた HTML: doctype が先頭、CSP の meta が全部の link・style より前、script・on*・外部 URL・javascript: が無い', () => {
    for (const f of files.filter((x) => x.endsWith('.html'))) {
      const html = readFileSync(join(out, f), 'utf8');
      expect(
        html.startsWith(
          '<!DOCTYPE html><html lang="ja" class="__variable_a1b2c3"><head><meta http-equiv="Content-Security-Policy"',
        ),
        f,
      ).toBe(true);
      expect(html).toContain(`content="${SCREEN_CSP}"`);
      const csp = html.indexOf('Content-Security-Policy');
      for (const m of html.matchAll(/<(link|style)\b/g)) expect(m.index!, f).toBeGreaterThan(csp);
      expect(html, f).not.toMatch(
        /<script|<noscript|<iframe|<title|\son\w+=|javascript|googletagmanager|example\.com|https?:|\/\/www|modulepreload|preload|preconnect/i,
      );
      expect(html, f).toMatch(
        /<link rel="stylesheet" href="\.\.\/_assets\/[0-9a-f]{20}\.css" data-precedence="next">/,
      );
    }
    const index = readFileSync(join(out, 'screens/index/index.html'), 'utf8');
    expect(index).toContain('<p data-component="TodayIsland">読み込み中</p>');
    const logo = readFileSync(join(web, 'export', 'images', 'logo.svg')).toString('base64');
    expect(index).toContain(`<img src="data:image/svg+xml;base64,${logo}" alt="ロゴ"`);
    expect(index).toContain('<img alt="外部のバナー" width="120" height="40">');
    expect(index).toContain(
      '<button type="button">閉じる</button><a>詳しく</a><a href="/calendar/">カレンダーへ</a>',
    );
    expect(index).toContain('<span class="hero" style="color:#5b6577">お知らせ</span>');
  });

  it('写した CSS: @import・外部の url()（エスケープした u\\72l( も）・image-set を落とし、next/font の url() はフォントの資産に', () => {
    const css = files
      .filter((f) => f.endsWith('.css'))
      .map((f) => readFileSync(join(out, f), 'utf8'))[0]!;
    expect(css).not.toMatch(/@import|https?:|image-set|<|cdn\.example/);
    expect(css).toMatch(
      /src:url\("[0-9a-f]{20}\.woff2"\) format\("woff2"\);unicode-range:U\+0020-007F,U\+3000-30FF/,
    );
    expect(css).toMatch(
      /\.cms-banner\{[^}]*background:url\("[0-9a-f]{20}\.png"\) right center\/contain no-repeat,#fff\}/,
    );
    expect(css).toContain('.cms-banner .hero{}');
  });

  it('issues: 消毒で落とした数（/ は外部・危険な URL と on* で警告、CSS は 1 回だけ警告）とカバー率', () => {
    const sanitizeTop = issue('screens:/', /^消毒/)!;
    expect(sanitizeTop.level).toBe('warning');
    expect(sanitizeTop.message).toBe(
      '消毒（index.html）: 落とした要素 script 8・link[rel=preload] 2・link[rel=icon] 1・link[rel=modulepreload] 1・' +
        'link[rel=preconnect] 1・noscript 1・title 1、on* 属性 1、外部 URL 3、危険な URL 1、url() で落とした CSS の宣言・規則 1。' +
        '外部・危険な URL は読み込まない（画面に出ない）',
    );
    expect(issue('screens:/calendar', /^消毒/)!.level).toBe('info');
    expect(issue('screens:/push', /^消毒/)!.level).toBe('info');
    const css = g.issues!.filter((i) => i.path.startsWith('screens:_next/static/css/'));
    expect(css).toHaveLength(1);
    expect(css[0]).toMatchObject({
      level: 'warning',
      path: 'screens:_next/static/css/7f3a9c1d2e4b5a60.css',
    });
    expect(css[0]!.message).toMatch(
      /外部 URL 1、CSS の @import 1、image-set\(\) などの宣言 1、url\(\) で落とした CSS の宣言・規則 1/,
    );

    // カバー率: / は TodayIsland の「読み込み中」だけ（TotalCard・EntryList は fetch の後に描く。docs/14 §3.3 の SPA 型の限界）
    // 2026-11-09 変更（8-4）: data に数（build --dry-run --json の screens が読む。docs/19 §3.2）
    expect(issue('screens:/', /カバー率/)).toEqual({
      level: 'info',
      path: 'screens:/',
      message: 'regions のカバー率 1/3（33%）。HTML に無い部品: comp:EntryList, comp:TotalCard',
      data: { reachable: 3, dom: 1, yaml: 0 },
    });
    expect(issue('screens:/calendar', /カバー率/)!.message).toBe('regions のカバー率 2/2（100%）');
    expect(issue('screens:/push', /カバー率/)!.message).toBe('regions のカバー率 1/1（100%）');
    expect(g.issues!.every((i) => i.level === 'info' || i.level === 'warning')).toBe(true);
  });
});

describe('fixture-repo（site/。相対パスの CSS、動的ルートのサンプル）', async () => {
  const root = join(examples, 'fixture-repo');
  const out = tmpOut();
  const config: StackAtlasConfig = {
    screens: { from: 'dir', dir: 'site', routes: { '/races/[id]': ['42'] }, outDir: out },
  };
  const routes = ['/', '/races', '/races/[id]', '/admin/entry', '/login'];
  const upstream: PartialGraph = {
    nodes: [
      ...routes.map((r) => N(`route:${r}`, { kind: 'page' })),
      N('layout:/', { kind: 'layout' }),
      ...['Header', 'RaceCard', 'Pagination', 'ResultTable', 'EntryForm', 'AuthGuard'].map((c) =>
        N(`comp:${c}`, { kind: 'component' }),
      ),
      N('hook:useSession', { kind: 'hook' }),
      N('hook:useRaces', { kind: 'hook' }),
      N('lib:apiClient', { kind: 'lib' }),
    ],
    edges: [
      uses('layout:/', 'comp:Header'),
      uses('comp:Header', 'hook:useSession'),
      uses('route:/', 'comp:RaceCard'),
      uses('route:/', 'hook:useRaces'),
      uses('hook:useRaces', 'lib:apiClient'),
      uses('route:/races', 'comp:Pagination'),
      uses('route:/races', 'comp:RaceCard'),
      uses('route:/races', 'hook:useRaces'),
      uses('route:/races/[id]', 'comp:ResultTable'),
      uses('route:/admin/entry', 'comp:AuthGuard'),
      uses('route:/admin/entry', 'comp:EntryForm'),
      uses('route:/admin/entry', 'comp:ResultTable'),
      uses('comp:AuthGuard', 'hook:useSession'),
      uses('route:/login', 'hook:useSession'),
    ],
  };
  const g = await extractor.extract(ctxFor(root, config, { repoName: 'fixture' }).ctx, upstream);
  const files = listFiles(out);

  it('5 つの route（/races/[id] はサンプル 42 の races/42/index.html）', () => {
    expect(g.nodes.map((n) => [n.id, n.screen?.html]).sort()).toEqual(
      [
        ['route:/', 'screens/index/index.html'],
        ['route:/admin/entry', 'screens/admin-entry/index.html'],
        ['route:/login', 'screens/login/index.html'],
        ['route:/races', 'screens/races/index.html'],
        ['route:/races/[id]', 'screens/races-id/index.html'],
      ].sort(),
    );
  });

  it('相対パスの CSS（../../assets/style.css）は 1 つの資産に写して全部の画面から参照する', () => {
    const css = files.filter((f) => f.endsWith('.css'));
    expect(css).toHaveLength(1);
    const name = css[0]!.split('/').pop()!;
    for (const f of files.filter((x) => x.endsWith('index.html')))
      expect(readFileSync(join(out, f), 'utf8')).toContain(
        `<link rel="stylesheet" href="../_assets/${name}">`,
      );
  });

  // 2026-11-09 変更（8-3b）: form は中身ごと落としていた（EntryForm の領域が取れなかった）が、div に書き換える
  it('form は div に書き換え、中身（入力の見た目）を残す。EntryForm の領域が取れる', () => {
    const admin = readFileSync(join(out, 'screens/admin-entry/index.html'), 'utf8');
    expect(admin).not.toMatch(/<form/);
    expect(admin).toContain(
      '<div data-component="EntryForm"><h1 style="font-size:18px;margin:0">結果を入稿</h1>' +
        '<input name="raceId" placeholder="大会ID" value="42">',
    );
    expect(admin).toContain('<button type="submit">保存</button></div>');
    expect(admin).toContain('data-component="ResultTable"');
  });

  it('カバー率（layout:/ の Header と useSession も分母に入る）', () => {
    const cov = Object.fromEntries(
      g
        .issues!.filter((i) => /カバー率/.test(i.message))
        .map((i) => [i.path, i.message.replace(/。.*$/, '')]),
    );
    expect(cov).toEqual({
      'screens:/': 'regions のカバー率 2/4（50%）',
      'screens:/races': 'regions のカバー率 3/5（60%）',
      'screens:/races/[id]': 'regions のカバー率 2/3（67%）',
      // 2026-11-09 変更（8-3b）: form を div に書き換えるので EntryForm が解ける（3/5（60%）→ 4/5。残りは DOM の無い useSession）
      'screens:/admin/entry': 'regions のカバー率 4/5（80%）',
      'screens:/login': 'regions のカバー率 2/2（100%）',
    });
    expect(g.issues!.filter((i) => i.level === 'warning')).toEqual([]);
  });
});

describe('設定と境目', () => {
  /** 一時的な repo（Next の app と HTML） */
  function repo(files: Record<string, string>) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'stack-atlas-screens-repo-')));
    for (const [rel, data] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), data);
    }
    return root;
  }
  const page = (body: string) =>
    `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;
  const routesOf = (...ids: string[]): PartialGraph => ({
    nodes: [...ids.map((id) => N(id, { kind: 'page' })), N('comp:A', { kind: 'component' })],
    edges: ids.map((id) => uses(id, 'comp:A')),
  });

  it('next-export: next.config の distDir と trailingSlash: false（a.html を先に）、動的ルートはサンプルが無ければ飛ばす', async () => {
    const root = repo({
      'app/page.tsx': '',
      'next.config.mjs':
        "export default { output: 'export', distDir: 'build', trailingSlash: false };",
      'build/index.html': page('<p data-component="A">top</p>'),
      'build/a.html': page('<p>a.html</p>'),
      'build/a/index.html': page('<p>a/index.html</p>'),
      'build/items/1.html': page('<p>item</p>'),
    });
    const out = tmpOut();
    const { ctx, logs } = ctxFor(root, { screens: { outDir: out } });
    const g = await extractor.extract(
      ctx,
      routesOf('route:/', 'route:/a', 'route:/items/[id]', 'route:/gone'),
    );
    expect(g.nodes.map((n) => [n.id, n.screen?.source])).toEqual([
      ['route:/', 'next-export'],
      ['route:/a', 'next-export'],
    ]);
    expect(readFileSync(join(out, 'screens/a/index.html'), 'utf8')).toContain('<p>a.html</p>');
    expect(logs.join('\n')).toContain(
      'サンプルの無い動的ルート（screens.routes に足す）: /items/[id]',
    );
    expect(logs.join('\n')).toContain('HTML の無いルート（プレースホルダのまま）: /gone');
    // カバー率 0 は警告（data-component を付けるきっかけ）
    expect(
      g.issues!.find((i) => i.path === 'screens:/a' && /regions/.test(i.message)),
    ).toMatchObject({
      level: 'warning',
      message: expect.stringContaining('docs/10'),
    });

    const g2 = await extractor.extract(
      ctxFor(root, { screens: { outDir: tmpOut(), routes: { '/items/[id]': ['1'] } } }).ctx,
      routesOf('route:/items/[id]'),
    );
    expect(g2.nodes.map((n) => n.screen?.html)).toEqual(['screens/items-id/index.html']);
  });

  it('SVG は data: URL で埋め込み、.svg のファイルは書かない。上限（256 KB）を超えるものは入れずに info で報告', async () => {
    const small = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    const root = repo({
      'site/index.html': page(
        '<p data-component="A"><img src="img/small.svg" alt="s"><img src="/img/big.svg" alt="b"></p>',
      ),
      'site/img/small.svg': small,
      'site/img/big.svg': `<svg xmlns="http://www.w3.org/2000/svg">${' '.repeat(300 * 1024)}</svg>`,
    });
    const out = tmpOut();
    const { ctx, logs } = ctxFor(root, { screens: { from: 'dir', dir: 'site', outDir: out } });
    const g = await extractor.extract(ctx, routesOf('route:/'));
    const html = readFileSync(join(out, 'screens/index/index.html'), 'utf8');
    expect(html).toContain(
      `<img src="data:image/svg+xml;base64,${Buffer.from(small).toString('base64')}" alt="s"><img alt="b">`,
    );
    expect(listFiles(out).filter((f) => f.endsWith('.svg'))).toEqual([]);
    expect(g.issues).toContainEqual({
      level: 'info',
      path: 'screens:img/big.svg',
      message:
        'SVG（301 KB）が data: URL にする上限 256 KB を超えるので、画面に入れない（写せない資産に数えた）',
    });
    expect(g.issues!.find((i) => i.path === 'screens:/' && /^消毒/.test(i.message))).toMatchObject({
      level: 'info',
      message: '消毒（index.html）: 写せない資産 1',
    });
    expect(logs.join('\n')).toContain('1 画面（資産 0、data: URL にした SVG 1）');
  });

  it('<head> を決められない HTML は画面を出さず警告', async () => {
    const root = repo({ 'site/index.html': '<p>no head</p>' });
    const g = await extractor.extract(
      ctxFor(root, { screens: { from: 'dir', dir: 'site', outDir: tmpOut() } }).ctx,
      routesOf('route:/'),
    );
    expect(g.nodes).toEqual([]);
    expect(g.issues).toEqual([
      expect.objectContaining({
        level: 'warning',
        path: 'screens:/',
        message: expect.stringContaining('<head>'),
      }),
    ]);
  });

  it('HTML のディレクトリが無い・repo の外を指すリンクなら警告して何もしない。outDir が無ければ何もしない', async () => {
    const outside = repo({ 'index.html': page('<p>secret</p>') });
    const root = repo({ 'x.txt': '' });
    symlinkSync(outside, join(root, 'export'));
    const out = tmpOut();
    const g = await extractor.extract(
      ctxFor(root, { screens: { from: 'dir', dir: 'export', outDir: out } }).ctx,
      routesOf('route:/'),
    );
    expect(g.nodes).toEqual([]);
    expect(g.issues![0]!.message).toContain('repo（app）の外');
    expect(readdirSync(out)).toEqual([]);
    const g2 = await extractor.extract(
      ctxFor(root, { screens: { from: 'dir', dir: 'nope', outDir: out } }).ctx,
      routesOf('route:/'),
    );
    expect(g2.issues![0]!.message).toContain('nope がありません');
    const g3 = await extractor.extract(
      ctxFor(root, { screens: { from: 'dir', dir: 'export' } }).ctx,
      routesOf('route:/'),
    );
    expect(g3).toEqual({ nodes: [], edges: [] });
  });

  it('HTML のファイルがシンボリックリンクなら読まない', async () => {
    const outside = repo({ 'secret.html': page('<p>secret</p>') });
    const root = repo({ 'site/a.html': page('<p>a</p>') });
    symlinkSync(join(outside, 'secret.html'), join(root, 'site', 'index.html'));
    const g = await extractor.extract(
      ctxFor(root, { screens: { from: 'dir', dir: 'site', outDir: tmpOut() } }).ctx,
      routesOf('route:/', 'route:/a'),
    );
    expect(g.nodes.map((n) => n.id)).toEqual(['route:/a']);
  });

  it('htmlCandidates と画面の名前（screenshots の uniqueSlug。2026-11-09（8-3b のレビュー）で screenSlug を一本にした）', () => {
    expect(htmlCandidates('/')).toEqual(['index.html']);
    expect(htmlCandidates('/a/b')).toEqual(['a/b.html', 'a/b/index.html']);
    expect(htmlCandidates('/a', true)).toEqual(['a/index.html', 'a.html']);
    expect(htmlCandidates('/items/a%20b')).toEqual(['items/a b.html', 'items/a b/index.html']);
    const used = new Map<string, string>();
    expect(uniqueSlug('/', used)).toBe('index');
    expect(uniqueSlug('/races/[id]', used)).toBe('races-id');
    expect(uniqueSlug('/races/id', used)).toMatch(/^races-id-[0-9a-f]{6}$/);
    expect(uniqueSlug('/..', used)).toMatch(/^r-[0-9a-f]{8}$/);
    expect(uniqueSlug('/_assets', used)).toMatch(/^r-[0-9a-f]{8}$/);
  });
});
