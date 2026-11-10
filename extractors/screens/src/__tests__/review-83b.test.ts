// 8-3b のレビュー（2026-11-09）の指摘を固定する。どれも直す前に失敗したもの:
// 2 乗の解析（敵対的な入力を大きくして CPU 時間の上限で見る）、SVG の data: URL の膨張、不正なルートの URL が index.html になる、
// <pre> の直後の改行、印の無い screens/ への書き込み、issues.json に出る制御文字
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PartialGraph, RepoContext, StackAtlasConfig } from '@stack-atlas/core';
import { AssetStore, normalizePrefix } from '../assets.js';
import { SafeOutput } from '../fsafe.js';
import { parseHtml } from '../html.js';
import { extractor, htmlCandidates, printable } from '../index.js';
import { sanitizeHtml, type UrlKind, type UrlVerdict } from '../sanitize.js';
import { sanitizeStylesheet } from '../css.js';
import { classifyUrl, normalizeUrl, parseSrcset } from '../urls.js';

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), `stack-atlas-83b-${p}-`)));
function repo(files: Record<string, string>) {
  const root = tmp('repo');
  for (const [rel, data] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), data);
  }
  return root;
}
function ctxFor(root: string, config: StackAtlasConfig) {
  const logs: string[] = [];
  const ctx: RepoContext = {
    root,
    repoName: 'app',
    repos: { app: root },
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
const page = (body: string) =>
  `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;
const routes = (...ids: string[]): PartialGraph => ({
  nodes: ids.map((id) => ({ id, kind: 'page' })),
  edges: [],
});
const relUrl = (raw: string, kind: UrlKind): UrlVerdict => {
  const c = classifyUrl(raw);
  return c.type === 'relative'
    ? { ok: true, url: kind === 'link' ? c.value : 'x' }
    : { ok: false, why: 'unsafe' };
};
const doc = (b: string) => `<!doctype html><html><head></head><body>${b}</body></html>`;
/** fn を走らせた CPU 時間（ms） */
const time = (fn: () => void) => {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
};

describe('2 乗の解析（敵対的な入力。直す前の時間は sec83b の dos.mjs で測った値）', () => {
  it('コメント `<!----!>` の並び（`-->` が無い。直す前は 160 KB で 12 秒・320 KB で 48 秒）', () => {
    const html = doc(`${'<!----!>'.repeat(40_000)}<p>after</p>`);
    let out = '';
    expect(
      time(() => {
        const r = sanitizeHtml(html, { url: relUrl });
        out = r.ok ? r.html : '';
      }),
    ).toBeLessThan(1500);
    expect(out).toContain('<p>after</p>');
  });

  it('コメントの終わりは `-->` と `--!>` の早い方（位置を覚えても変わらない）', () => {
    const body = (b: string) => {
      const r = sanitizeHtml(doc(b), { url: relUrl });
      return r.ok ? /<body>([\s\S]*)<\/body>/.exec(r.html)![1] : r.reason;
    };
    expect(body('<!--a--!><p>1</p>--><p>2</p>')).toBe('<p>1</p>--&gt;<p>2</p>');
    expect(body('<!--a--><p>1</p><!--b--!><p>2</p>')).toBe('<p>1</p><p>2</p>');
    expect(body('<!--a--!>x<!--b-->y<!--c--!>z')).toBe('xyz');
    expect(body('<!---->a<!--->b<!-->c')).toBe('abc');
    expect(parseHtml('<!--a--!>x<!--never').truncated).toBe('comment');
  });

  it('URL の前後の空白・C0 を外す（途中の空白 40k で、直す前は 4.2 秒）', () => {
    const inner = ' '.repeat(40_000);
    expect(
      time(() => sanitizeHtml(doc(`<a href="a${inner}a">x</a>`), { url: relUrl })),
    ).toBeLessThan(1000);
    expect(
      time(() =>
        sanitizeStylesheet(`a{background:url("a${inner}a")}`, {
          url: (r) => (classifyUrl(r), { ok: false }),
        }),
      ),
    ).toBeLessThan(1000);
    expect(normalizeUrl(' \u0000\t a b \n\u001f ')).toBe('a b');
    expect(normalizeUrl('\u0001')).toBe('');
    expect(normalizeUrl('a\u0001b')).toBeUndefined();
  });

  it('srcset の末尾のカンマ（40k 個で、直す前は 5 秒）', () => {
    let got: ReturnType<typeof parseSrcset> = [];
    expect(time(() => (got = parseSrcset(`a${','.repeat(40_000)}a,`)))).toBeLessThan(1000);
    expect(got).toEqual([{ url: `a${','.repeat(40_000)}a` }]);
    expect(parseSrcset('a.png,,, b.png 2x')).toEqual([
      { url: 'a.png' },
      { url: 'b.png', descriptor: '2x' },
    ]);
  });

  it('basePath・assetPrefix の末尾の `/`（40k 個の `/` の後に a で、直す前は 4.3 秒）', () => {
    let got: string | undefined;
    expect(time(() => (got = normalizePrefix(`${'/'.repeat(40_000)}a`)))).toBeLessThan(1000);
    expect(got).toBe(`${'/'.repeat(40_000)}a`);
    expect(normalizePrefix('/docs///')).toBe('/docs');
    expect(normalizePrefix('///')).toBeUndefined();
  });
});

describe('<pre> の直後の改行（HTML の仕様どおり字句の側で 1 つ捨てる）', () => {
  const pre = (b: string) => {
    const r = sanitizeHtml(doc(b), { url: relUrl });
    return r.ok ? /<body>([\s\S]*)<\/body>/.exec(r.html)![1] : r.reason;
  };
  it('`<pre>\\ncode` は code（直す前は改行が 2 つになり、上に空の行が出た）', () => {
    expect(pre('<pre>\ncode</pre>')).toBe('<pre>code</pre>');
    // 中身が改行で始まるなら、ブラウザが捨てる分を 1 つ足す（描くと \ncode）
    expect(pre('<pre>\n\ncode</pre>')).toBe('<pre>\n\ncode</pre>');
    expect(pre('<pre>&#10;code</pre>')).toBe('<pre>code</pre>');
    expect(pre('<pre>\n</pre>')).toBe('<pre></pre>');
    expect(pre('<pre><b>\nx</b></pre>')).toBe('<pre><b>\nx</b></pre>'); // 直後が要素なら捨てない
  });
});

describe('ルートの URL → HTML', () => {
  it('htmlCandidates: サイトの中のパスにできない URL は空（直す前は index.html で、別の画面を写した）', () => {
    expect(htmlCandidates('/../a')).toEqual([]);
    expect(htmlCandidates('/a%')).toEqual([]);
    expect(htmlCandidates('/%E0%A4%A')).toEqual([]);
    expect(htmlCandidates('/a%2F..%2F..%2Fb')).toEqual([]);
    expect(htmlCandidates('/')).toEqual(['index.html']);
    expect(htmlCandidates('/a/..')).toEqual(['index.html']); // 根に戻るだけのものは根
  });

  it('抽出器: サンプルが不正なパスになるルートは画面を出さずに警告（index.html を写さない）', async () => {
    const root = repo({ 'site/index.html': page('<p>top</p>') });
    const out = tmp('out');
    const { ctx } = ctxFor(root, {
      screens: { from: 'dir', dir: 'site', outDir: out, routes: { '/items/[id]': ['../../a'] } },
    });
    const g = await extractor.extract(ctx, routes('route:/items/[id]'));
    expect(g.nodes).toEqual([]);
    expect(g.issues).toEqual([
      {
        level: 'warning',
        path: 'screens:/items/[id]',
        message:
          'ルートの URL /items/../../a をサイトの中のパスにできない（`..` で根の外に出る・壊れた % エンコードなど）ので、HTML を探しません',
      },
    ]);
  });
});

describe('SVG の data: URL の膨張（1 つの文書に 2 MB まで）と書き出しの上限（10 MB）', () => {
  const big = `<svg xmlns="http://www.w3.org/2000/svg">${' '.repeat(250 * 1024)}</svg>`;

  it('250 KB の SVG を 2000 回参照しても落ちない（直す前は 100 回で 34 MB、2000 回で RangeError）', async () => {
    const root = repo({
      'site/index.html': page(
        `<p data-component="A">${'<img src="img/big.svg" alt="">'.repeat(2000)}</p><div style="background:url(img/big.svg)"></div>`,
      ),
      'site/img/big.svg': big,
    });
    const out = tmp('out');
    const { ctx } = ctxFor(root, { screens: { from: 'dir', dir: 'site', outDir: out } });
    const g = await extractor.extract(ctx, routes('route:/'));
    expect(g.nodes.map((n) => n.id)).toEqual(['route:/']);
    const html = readFileSync(join(out, 'screens/index/index.html'), 'utf8');
    const inlined = html.split('data:image/svg+xml;base64,').length - 1;
    const each = Math.ceil(big.length / 3) * 4 + 'data:image/svg+xml;base64,'.length;
    expect(inlined).toBe(Math.floor((2 * 1024 * 1024) / each)); // 6 回
    expect(html.length).toBeLessThan(2.2 * 1024 * 1024);
    expect(g.issues).toContainEqual({
      level: 'info',
      path: 'screens:/',
      message: `index.html に data: URL で埋め込む SVG が合計 2 MB を超えるので、${2001 - inlined} 件の参照を入れない（写せない資産に数えた）`,
    });
  });

  it('写す CSS も 1 ファイルに 2 MB まで。上限を超えた参照は info で報告', async () => {
    const root = repo({
      'site/index.html':
        '<!DOCTYPE html><html><head><link rel="stylesheet" href="s.css"></head><body><p>x</p></body></html>',
      'site/s.css': Array.from(
        { length: 50 },
        (_, i) => `.c${i}{background:url(img/big.svg)}`,
      ).join(''),
      'site/img/big.svg': big,
    });
    const out = tmp('out');
    const g = await extractor.extract(
      ctxFor(root, { screens: { from: 'dir', dir: 'site', outDir: out } }).ctx,
      routes('route:/'),
    );
    const css = readdirSync(join(out, 'screens/_assets')).filter((f) => f.endsWith('.css'));
    expect(css).toHaveLength(1);
    expect(readFileSync(join(out, 'screens/_assets', css[0]!), 'utf8').length).toBeLessThan(
      2.1 * 1024 * 1024,
    );
    expect(g.issues).toContainEqual({
      level: 'info',
      path: 'screens:s.css',
      message:
        's.css に data: URL で埋め込む SVG が合計 2 MB を超えるので、44 件の参照を入れない（写せない資産に数えた）',
    });
  });

  it('消毒した HTML が 10 MB を超えたら画面を出さずに警告（& のエスケープで 5 倍）', async () => {
    const root = repo({ 'site/index.html': page(`<p>${'&'.repeat(2_200_000)}</p>`) });
    const out = tmp('out');
    const g = await extractor.extract(
      ctxFor(root, { screens: { from: 'dir', dir: 'site', outDir: out } }).ctx,
      routes('route:/'),
    );
    expect(g.nodes).toEqual([]);
    expect(g.issues).toEqual([
      {
        level: 'warning',
        path: 'screens:/',
        message: 'index.html の消毒した HTML（11 MB）が上限 10 MB を超えるので、画面を出しません',
      },
    ]);
    expect(readdirSync(out)).toEqual([]);
  });

  it('AssetStore: 消毒した CSS が output の上限を超えたら書かない（写せない資産）', () => {
    const site = repo({ 'a.css': `.a{color:red}${'.b{color:blue}'.repeat(100)}` });
    const out = tmp('out');
    const store = new AssetStore({
      roots: [site],
      out: new SafeOutput(out),
      limits: { output: 1000 },
    });
    expect(store.verdict('a.css', 'style', 'index.html', '../_assets/', store.budget())).toEqual({
      ok: false,
      why: 'missing',
    });
    expect([...store.oversizedCss.keys()]).toEqual(['a.css']);
    expect(readdirSync(out)).toEqual([]);
  });
});

describe('印の無い screens/ には書かない（抽出器の側。build は cli のテスト）', () => {
  it('出力先の screens/ が印の無いディレクトリなら、警告して何も書かない', async () => {
    const root = repo({ 'site/index.html': page('<p>top</p>') });
    const out = tmp('out');
    mkdirSync(join(out, 'screens'));
    writeFileSync(join(out, 'screens', 'mine.txt'), 'mine');
    const { ctx, logs } = ctxFor(root, { screens: { from: 'dir', dir: 'site', outDir: out } });
    const g = await extractor.extract(ctx, routes('route:/'));
    expect(g.nodes).toEqual([]);
    expect(g.issues).toEqual([
      expect.objectContaining({
        level: 'warning',
        path: 'screens',
        message: expect.stringContaining('印 .stack-atlas-screens が無い'),
      }),
    ]);
    expect(readdirSync(join(out, 'screens'))).toEqual(['mine.txt']);
    expect(logs.join('\n')).toContain('画面を書きません');
  });
});

describe('issues.json と要約に出す文字列の制御文字', () => {
  it('タグ名・data-component の ESC などは \\u{1b} の形にする（直す前はそのまま出て端末を操作できた）', async () => {
    const root = repo({
      'site/index.html': page(
        '<x\u001b[2J>a</x\u001b[2J><p data-component="\u001b]0;pwn\u0007\u009b">b</p><link rel="icon‮" href="a.css">',
      ),
    });
    const g = await extractor.extract(
      ctxFor(root, { screens: { from: 'dir', dir: 'site', outDir: tmp('out') } }).ctx,
      {
        nodes: [
          { id: 'route:/', kind: 'page' },
          { id: 'comp:A', kind: 'component' },
        ],
        edges: [{ from: 'route:/', to: 'comp:A', kind: 'uses' }],
      },
    );
    const text = g.issues!.map((i) => `${i.path} ${i.message}`).join('\n');
    // eslint-disable-next-line no-control-regex -- 制御文字が残っていないことを見る
    expect(text).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮]/);
    expect(text).toContain('x\\u{1b}[2j');
    expect(text).toContain('\\u{1b}]0;pwn\\u{7}\\u{9b}');
    expect(text).toContain('icon\\u{202e}');
    expect(printable('a\u0000b\u007fc⁦d\n')).toBe('a\\u{0}b\\u{7f}c\\u{2066}d\\u{a}');
    expect(printable('日本語 ok')).toBe('日本語 ok');
  });
});
