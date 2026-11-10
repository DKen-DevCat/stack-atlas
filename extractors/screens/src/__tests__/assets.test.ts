// URL の判定・資産の写し（パストラバーサル・シンボリックリンク・拡張子・basePath / assetPrefix）・書き出しの安全
import { createHash } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AssetStore, DEFAULT_LIMITS, WRITTEN_EXT, toSitePath } from '../assets.js';
import {
  confineDir,
  findSiteFile,
  readNoFollow,
  readNoFollowResult,
  SafeOutput,
} from '../fsafe.js';
import { sanitizeHtml } from '../sanitize.js';
import { classifyUrl, parseSrcset } from '../urls.js';

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), `stack-atlas-screens-${p}-`)));
function tree(root: string, files: Record<string, string | Buffer>) {
  for (const [rel, data] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), data);
  }
}
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex').slice(0, 20);

describe('classifyUrl', () => {
  it.each([
    ['', 'empty'],
    ['  ', 'empty'],
    ['#top', 'fragment'],
    ['/a/b.png', 'relative'],
    ['a/b.png', 'relative'],
    ['?q=1', 'relative'],
    ['java script:alert(1)', 'relative'], // 空白があると scheme にならない（URL の仕様）
    ['https://e.example', 'external'],
    ['HTTP://e.example', 'external'],
    ['//e.example/x', 'external'],
    ['/\\e.example/x', 'external'],
    ['\\\\e.example/x', 'external'],
    ['mailto:a@example.com', 'external'],
    ['javascript:alert(1)', 'unsafe'],
    ['  JavaScript:alert(1)', 'unsafe'],
    ['java\tscript:alert(1)', 'unsafe'],
    ['java\u0000script:alert(1)', 'unsafe'],
    ['\u0001javascript:alert(1)', 'unsafe'],
    ['vbscript:x', 'unsafe'],
    ['blob:https://e.example/x', 'unsafe'],
    ['data:', 'unsafe'],
    ['data:image/png;base64,AA', 'data'],
  ])('%j → %s', (raw, type) => {
    expect(classifyUrl(raw).type).toBe(type);
  });

  it('data: の種類は小文字・引数を外して見る', () => {
    expect(classifyUrl('data:Image/PNG ;base64,AA')).toMatchObject({
      type: 'data',
      mime: 'image/png',
    });
  });

  it('srcset の候補（URL の中のカンマは残す）', () => {
    expect(parseSrcset(' a.png 1x,b.png 2x , data:image/png;base64,AA,BB 3x,c.png,')).toEqual([
      { url: 'a.png', descriptor: '1x' },
      { url: 'b.png', descriptor: '2x' },
      { url: 'data:image/png;base64,AA,BB', descriptor: '3x' },
      { url: 'c.png' },
    ]);
  });
});

describe('toSitePath', () => {
  it('相対は文書のディレクトリから、/ で始まるものは basePath・assetPrefix を外す', () => {
    expect(toSitePath('../../assets/style.css', 'races/42')).toBe('assets/style.css');
    expect(toSitePath('/_next/static/css/a.css?v=1#x', 'calendar')).toBe('_next/static/css/a.css');
    expect(toSitePath('/docs/_next/static/a.css', '', ['/docs'])).toBe('_next/static/a.css');
    expect(toSitePath('/docsx/a.css', '', ['/docs'])).toBe('docsx/a.css');
    expect(toSitePath('/a%20b.png', '')).toBe('a b.png');
  });

  it('パストラバーサル: 根の上に出る・壊れたエンコード・段の中の / \\ NUL は undefined', () => {
    expect(toSitePath('/_next/static/../../.env', '')).toBe('.env'); // 根の中（拡張子で止まる）
    expect(toSitePath('/_next/static/../../../.env', '')).toBeUndefined();
    expect(toSitePath('/%2e%2e/%2e%2e/etc/passwd', '')).toBeUndefined();
    expect(toSitePath('../../../x.png', '_next/static/css')).toBe('x.png'); // ちょうど根
    expect(toSitePath('../../../../x.png', '_next/static/css')).toBeUndefined();
    expect(toSitePath('/a%2f..%2f..%2fx.png', '')).toBeUndefined();
    expect(toSitePath('/a%5cx.png', '')).toBeUndefined();
    expect(toSitePath('/a%00.png', '')).toBeUndefined();
    expect(toSitePath('/%E0%A4%A.png', '')).toBeUndefined();
    // 2026-11-09 変更（8-3b のレビュー）: 根は undefined（不正なパスと同じ）でなく空文字列。htmlCandidates が根だけを index.html にする
    expect(toSitePath('/', '')).toBe('');
  });
});

describe('AssetStore', () => {
  function setup(extra: Record<string, string | Buffer> = {}) {
    const base = tmp('assets');
    const site = join(base, 'repo', 'export');
    const pub = join(base, 'repo', 'public');
    const out = join(base, 'out');
    const outside = join(base, 'outside');
    tree(site, {
      '_next/static/css/a.css':
        '@import url(https://e.example/x.css);@font-face{src:url(/_next/static/media/f.woff2) format("woff2")}' +
        '.a{background:url(../../../img/p.png)}.b{background:url(../../../../../outside/secret.png)}' +
        '.c{background:url(/_next/static/../../.env)}.d{background:url(https://cdn.example/x.png)}.e{background:url(x.js)}',
      '_next/static/media/f.woff2': 'wOF2',
      'img/p.png': 'PNG',
      'img/q.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
      '.env': 'SECRET=1',
      'x.js': 'alert(1)',
      ...extra,
    });
    tree(pub, { 'logo.png': 'LOGO' });
    tree(outside, { 'secret.png': 'SECRET', 'secret.css': 'a{color:red}' });
    const so = new SafeOutput(out);
    const store = new AssetStore({ roots: [site, pub], out: so });
    const v = (raw: string, kind: Parameters<AssetStore['verdict']>[1], doc = 'index.html') =>
      store.verdict(raw, kind, doc, '../_assets/', store.budget());
    const written = () =>
      existsSync(join(out, 'screens', '_assets'))
        ? readdirSync(join(out, 'screens', '_assets')).sort()
        : [];
    return { base, site, pub, out, outside, store, v, written };
  }

  it('CSS を消毒して中の url() を写した名前に書き換え、内容のハッシュで書く。同じファイルは 1 回だけ', () => {
    const { v, out, written, store } = setup();
    const r = v('/_next/static/css/a.css', 'style');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const name = r.url.replace('../_assets/', '');
    const css = readFileSync(join(out, 'screens', '_assets', name), 'utf8');
    expect(name).toBe(`${sha(css)}.css`);
    expect(css).toBe(
      `@font-face{src:url("${sha('wOF2')}.woff2") format("woff2")}\n.a{background:url("${sha('PNG')}.png")}\n.b{}\n.c{}\n.d{}\n.e{}\n`,
    );
    expect(v('/_next/static/css/a.css', 'style')).toEqual(r);
    expect(written()).toEqual([name, `${sha('wOF2')}.woff2`, `${sha('PNG')}.png`].sort());
    const f = store.cssFiles.get('_next/static/css/a.css')!;
    expect(f.stats).toMatchObject({ external: 1, missing: 3, css: { imports: 1, urlDrops: 4 } });
  });

  it('パストラバーサル（/_next/static/../../.env、%2e%2e、CSS の url(../../..)）は読まない', () => {
    const { v, written } = setup();
    for (const raw of [
      '/_next/static/../../.env',
      '/%2e%2e/outside/secret.png',
      '../../outside/secret.png',
      '/../outside/secret.css',
    ])
      for (const kind of ['style', 'image', 'image-or-font'] as const)
        expect(v(raw, kind, 'a/b/index.html'), `${raw} ${kind}`).toEqual({
          ok: false,
          why: 'missing',
        });
    expect(written()).toEqual([]);
  });

  it('シンボリックリンク（ファイル・途中のディレクトリ）は辿らない', () => {
    const { v, site, outside, written } = setup();
    symlinkSync(join(outside, 'secret.png'), join(site, 'img', 'link.png'));
    symlinkSync(outside, join(site, 'out-dir'));
    symlinkSync(join(outside, 'secret.css'), join(site, 'evil.css'));
    expect(v('/img/link.png', 'image')).toEqual({ ok: false, why: 'missing' });
    expect(v('/out-dir/secret.png', 'image')).toEqual({ ok: false, why: 'missing' });
    expect(v('/evil.css', 'style')).toEqual({ ok: false, why: 'missing' });
    expect(findSiteFile([site], 'img/link.png')).toEqual({ why: 'symlink' });
    expect(findSiteFile([site], 'out-dir/secret.png')).toEqual({ why: 'symlink' });
    expect(readNoFollow(join(site, 'img', 'link.png'), 100)).toBeUndefined();
    expect(readNoFollowResult(join(site, 'img', 'link.png'), 100)).toEqual({ why: 'unreadable' });
    expect(readNoFollowResult(join(site, 'img', 'p.png'), 2)).toEqual({
      why: 'too-large',
      size: 3,
    });
    expect(written()).toEqual([]);
  });

  it('拡張子の許可リスト: 種類に合わないもの（js・html・CSS を画像として）は写さない', () => {
    const { v, written } = setup({ 'page.html': '<p>x</p>', 'a.json': '{}' });
    expect(v('/x.js', 'image')).toEqual({ ok: false, why: 'missing' });
    expect(v('/page.html', 'style')).toEqual({ ok: false, why: 'missing' });
    expect(v('/a.json', 'image-or-font')).toEqual({ ok: false, why: 'missing' });
    expect(v('/_next/static/css/a.css', 'image')).toEqual({ ok: false, why: 'missing' });
    expect(v('/img/p.png', 'style')).toEqual({ ok: false, why: 'missing' });
    expect(written()).toEqual([]);
    // 2026-11-09 変更（8-3b）: SVG はファイルで写していたが、data: URL で埋め込む（下のテスト）。CSS としては読まない
    expect(v('/img/q.svg', 'style')).toEqual({ ok: false, why: 'missing' });
    expect(WRITTEN_EXT.has('svg')).toBe(false);
  });

  describe('SVG はファイルにせず data:image/svg+xml;base64 で埋め込む（直接開ける SVG を出力先に置かない）', () => {
    const evil =
      '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><script>alert(document.domain)</script>' +
      '<rect width="8" height="8" fill="#2a62d6"/></svg>';
    const dataUrl = `data:image/svg+xml;base64,${Buffer.from(evil).toString('base64')}`;

    it('img・srcset・style 属性・<style>・写した CSS の url() から参照しても data: URL だけ。.svg は書かない', () => {
      const { store, written, out } = setup({
        'img/evil.svg': evil,
        'css/b.css': '.x{background:url(../img/evil.svg#frag) no-repeat}',
      });
      const r = sanitizeHtml(
        '<!DOCTYPE html><html><head><link rel="stylesheet" href="/css/b.css">' +
          '<style>.y{background-image:url("/img/evil.svg")}</style></head><body>' +
          '<img src="/img/evil.svg" alt="a"><img srcset="/img/evil.svg 1x, img/evil.svg 2x">' +
          '<span style="background:url(/img/evil.svg)">s</span><input type="image" src="/img/evil.svg">' +
          '<a href="/img/evil.svg">リンクはたどるだけ</a></body></html>',
        {
          url: (raw, kind) => store.verdict(raw, kind, 'index.html', '../_assets/', store.budget()),
        },
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.html).toContain(`<img src="${dataUrl}" alt="a">`);
      expect(r.html).toContain(`<img srcset="${dataUrl} 1x, ${dataUrl} 2x">`);
      expect(r.html).toContain(`<span style="background:url(&quot;${dataUrl}&quot;)">s</span>`);
      expect(r.html).toContain(`.y{background-image:url("${dataUrl}")}`);
      expect(r.html).toContain(`<input type="image" src="${dataUrl}">`);
      expect(r.html).toContain('<a href="/img/evil.svg">');
      expect(r.html).not.toContain('<script');
      // 写した CSS の中も data: URL（断片 #frag は残す）。書いたのは CSS だけ
      const files = written();
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^[0-9a-f]{20}\.css$/);
      expect(readFileSync(join(out, 'screens', '_assets', files[0]!), 'utf8')).toBe(
        `.x{background:url("${dataUrl}#frag") no-repeat}\n`,
      );
      expect(files.some((f) => f.endsWith('.svg'))).toBe(false);
      expect(store.inlined).toBe(1); // 同じファイルは 1 回だけ読む
      expect(store.written).toBe(1);
    });

    it(`上限（既定 ${DEFAULT_LIMITS.svg / 1024} KB）を超える SVG は写さず oversized に数える`, () => {
      const base = tmp('svg-limit');
      tree(join(base, 's'), { 'big.svg': `<svg>${'x'.repeat(100)}</svg>`, 'small.svg': '<svg/>' });
      const s = new AssetStore({
        roots: [join(base, 's')],
        out: new SafeOutput(join(base, 'o')),
        limits: { svg: 64 },
      });
      expect(s.verdict('/big.svg', 'image', 'index.html', '', s.budget())).toEqual({
        ok: false,
        why: 'missing',
      });
      expect(s.verdict('big.svg', 'image-or-font', 'index.html', '', s.budget()).ok).toBe(false);
      expect(s.verdict('/small.svg', 'image', 'index.html', '', s.budget())).toEqual({
        ok: true,
        url: `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`,
      });
      expect([...s.oversized]).toEqual([['big.svg', 111]]);
      expect(existsSync(join(base, 'o'))).toBe(false);
      expect(DEFAULT_LIMITS.svg).toBe(256 * 1024);
    });
  });

  it('public のディレクトリは 2 つ目の探し先', () => {
    const { v } = setup();
    expect(v('/logo.png', 'image')).toEqual({ ok: true, url: `../_assets/${sha('LOGO')}.png` });
  });

  it('外部・危険・data:（リンクや CSS では危険）・リンクの相対パス', () => {
    const { v } = setup();
    expect(v('https://e.example/x.png', 'image')).toEqual({ ok: false, why: 'external' });
    expect(v('javascript:alert(1)', 'link')).toEqual({ ok: false, why: 'unsafe' });
    expect(v('data:image/png;base64,AA', 'image')).toEqual({
      ok: true,
      url: 'data:image/png;base64,AA',
    });
    expect(v('data:image/png;base64,AA', 'link')).toEqual({ ok: false, why: 'unsafe' });
    expect(v('data:text/css,a{}', 'style')).toEqual({ ok: false, why: 'unsafe' });
    expect(v('data:font/woff2;base64,AA', 'image')).toEqual({ ok: false, why: 'unsafe' });
    expect(v('/calendar/', 'link')).toEqual({ ok: true, url: '/calendar/' });
    expect(v('#x', 'image')).toEqual({ ok: false, why: 'missing' });
  });

  it('basePath と assetPrefix（パス・URL）を外して読む', () => {
    const base = tmp('prefix');
    const site = join(base, 'export');
    tree(site, { '_next/static/a.png': 'A', 'logo.png': 'L' });
    const mk = (opts: { basePath?: string; assetPrefix?: string }) =>
      new AssetStore({ roots: [site], out: new SafeOutput(join(base, 'out')), ...opts });
    const ok = (s: AssetStore, raw: string) =>
      s.verdict(raw, 'image', 'index.html', '', s.budget()).ok;
    const b = mk({ basePath: '/docs/' });
    expect(ok(b, '/docs/_next/static/a.png')).toBe(true);
    expect(ok(b, '/docs/logo.png')).toBe(true);
    const p = mk({ basePath: '/docs', assetPrefix: '/cdn' });
    expect(ok(p, '/cdn/_next/static/a.png')).toBe(true);
    expect(ok(p, '/docs/logo.png')).toBe(true);
    const u = mk({ assetPrefix: 'https://cdn.example.com/' });
    expect(ok(u, 'https://cdn.example.com/_next/static/a.png')).toBe(true);
    expect(ok(u, 'HTTPS://CDN.example.com/_next/static/a.png')).toBe(true);
    expect(
      u.verdict(
        'https://cdn.example.com.evil/_next/static/a.png',
        'image',
        'index.html',
        '',
        u.budget(),
      ),
    ).toEqual({
      ok: false,
      why: 'external',
    });
    expect(
      u.verdict('https://cdn.example.com/../../etc/x.png', 'image', 'index.html', '', u.budget()),
    ).toEqual({
      ok: false,
      why: 'missing',
    });
    const r = mk({ assetPrefix: '//cdn.example.com' });
    expect(ok(r, '//cdn.example.com/_next/static/a.png')).toBe(true);
  });

  it('大きさの上限を超えるものは写さない', () => {
    const base = tmp('limit');
    tree(join(base, 's'), { 'big.png': Buffer.alloc(2048), 'a.css': 'a{color:red}' });
    const s = new AssetStore({
      roots: [join(base, 's')],
      out: new SafeOutput(join(base, 'o')),
      limits: { css: 4, asset: 1024 },
    });
    expect(s.verdict('/big.png', 'image', 'index.html', '', s.budget()).ok).toBe(false);
    expect(s.verdict('/a.css', 'style', 'index.html', '', s.budget()).ok).toBe(false);
  });
});

describe('confineDir', () => {
  it('repo の中のディレクトリ（realpath）だけ。外を指すリンク・無いものは理由', () => {
    const base = tmp('confine');
    tree(join(base, 'repo', 'export'), { 'index.html': 'x' });
    tree(join(base, 'outside'), { 'index.html': 'y' });
    symlinkSync(join(base, 'outside'), join(base, 'repo', 'escape'));
    symlinkSync(join(base, 'repo', 'export'), join(base, 'repo', 'alias'));
    expect(confineDir(join(base, 'repo'), 'export')).toEqual({ dir: join(base, 'repo', 'export') });
    expect(confineDir(join(base, 'repo'), 'alias')).toEqual({ dir: join(base, 'repo', 'export') });
    expect(confineDir(join(base, 'repo'), 'escape')).toEqual({ why: 'outside' });
    expect(confineDir(join(base, 'repo'), '../outside')).toEqual({ why: 'outside' });
    expect(confineDir(join(base, 'repo'), join(base, 'outside'))).toEqual({ why: 'outside' });
    expect(confineDir(join(base, 'repo'), 'nope')).toEqual({ why: 'missing' });
    expect(confineDir(join(base, 'repo'), 'export/index.html')).toEqual({ why: 'missing' });
  });
});

describe('SafeOutput', () => {
  it('書き出し先の中だけ。段の名前を確かめ、途中や書く先のシンボリックリンクは書かない', () => {
    const base = tmp('out');
    const victim = join(base, 'victim');
    tree(victim, { 'v.txt': 'keep' });
    const out = new SafeOutput(join(base, 'out'));
    out.write(['screens', 'a', 'index.html'], 'A');
    expect(readFileSync(join(base, 'out', 'screens', 'a', 'index.html'), 'utf8')).toBe('A');
    for (const bad of [['..', 'x'], ['screens', '../x'], ['a/b'], ['.'], [], ['-x', '']])
      expect(() => out.write(bad, 'x'), bad.join('/')).toThrow();
    symlinkSync(victim, join(base, 'out', 'screens', 'b'));
    expect(() => out.write(['screens', 'b', 'v.txt'], 'x')).toThrow(/シンボリックリンク/);
    symlinkSync(join(victim, 'v.txt'), join(base, 'out', 'screens', 'a', 'link.html'));
    expect(() => out.write(['screens', 'a', 'link.html'], 'x')).toThrow(/シンボリックリンク/);
    expect(readFileSync(join(victim, 'v.txt'), 'utf8')).toBe('keep');
  });

  it('既にあるファイルは消してから作る（ハードリンクの先を書き換えない）', () => {
    const base = tmp('hard');
    tree(base, { 'victim.txt': 'keep' });
    const out = new SafeOutput(join(base, 'out'));
    out.write(['screens', 'x.css'], 'first');
    linkSync(join(base, 'victim.txt'), join(base, 'out', 'screens', 'y.css'));
    out.write(['screens', 'y.css'], 'second');
    expect(readFileSync(join(base, 'victim.txt'), 'utf8')).toBe('keep');
    expect(readFileSync(join(base, 'out', 'screens', 'y.css'), 'utf8')).toBe('second');
    out.write(['screens', 'x.css'], 'again');
    expect(readFileSync(join(base, 'out', 'screens', 'x.css'), 'utf8')).toBe('again');
  });
});
