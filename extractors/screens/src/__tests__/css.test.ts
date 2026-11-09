// CSS の字句解析と消毒（@import・image-set()・外部の url()・エスケープ・`<` の無い書き出し）
import { describe, expect, it } from 'vitest';
import {
  sanitizeDeclarations,
  sanitizeStylesheet,
  serializeIdent,
  serializeString,
  tokenizeCss,
  type CssUrlResult,
} from '../css.js';
import { classifyUrl, dataAllowed } from '../urls.js';

/** 相対パスは `A/<値>`、data: の画像・フォントは残す、ほかは落とす */
const url = (raw: string): CssUrlResult => {
  const c = classifyUrl(raw);
  if (c.type === 'relative') return { ok: true, url: `A/${c.value}` };
  if (c.type === 'fragment') return { ok: true, url: c.value };
  if (c.type === 'data' && dataAllowed(c.mime, 'image-or-font')) return { ok: true, url: c.value };
  return { ok: false };
};
const sheet = (css: string) => sanitizeStylesheet(css, { url });
const decl = (css: string) => sanitizeDeclarations(css, { url });

describe('字句', () => {
  it('エスケープを解く（16 進・1 文字・改行の続き）', () => {
    expect(tokenizeCss('u\\72l(x) \\75 rl("y") \\@a "a\\\nb" "\\22"')).toEqual([
      { t: 'url', v: 'x' },
      { t: 'ws' },
      { t: 'function', v: 'url' },
      { t: 'string', v: 'y' },
      { t: ')' },
      { t: 'ws' },
      { t: 'ident', v: '@a' },
      { t: 'ws' },
      { t: 'string', v: 'ab' },
      { t: 'ws' },
      { t: 'string', v: '"' },
    ]);
  });

  it('url( の中の引用符・括弧・空白の後の文字は bad-url、改行のある文字列は bad-string', () => {
    expect(tokenizeCss('url(a"b)').map((t) => t.t)).toEqual(['bad-url']);
    // 仕様どおり、壊れた url( は最初の `)` まで。外側の `)` は残る（消毒では宣言ごと落ちる）
    expect(tokenizeCss('url(var(--x))').map((t) => t.t)).toEqual(['bad-url', ')']);
    expect(tokenizeCss('url(a b)').map((t) => t.t)).toEqual(['bad-url']);
    expect(tokenizeCss('"a\nb"')[0]!.t).toBe('bad-string');
  });

  it('数・次元・百分率・unicode-range', () => {
    expect(tokenizeCss('1.5e3px 10% -.5 U+0025-00FF')).toEqual([
      { t: 'dimension', repr: '1.5e3', unit: 'px' },
      { t: 'ws' },
      { t: 'percentage', repr: '10' },
      { t: 'ws' },
      { t: 'number', repr: '-.5' },
      { t: 'ws' },
      { t: 'ident', v: 'U' },
      { t: 'number', repr: '+0025' },
      { t: 'dimension', repr: '-00', unit: 'FF' },
    ]);
  });
});

describe('落とすもの', () => {
  it('@import は形・大文字小文字・エスケープを問わず落とす。@charset・@namespace・知らない at-rule も', () => {
    const r = sheet(
      '@import url(https://e.example/a.css);@IMPORT "b.css";@\\69mport url(c.css) screen;@charset "utf-8";' +
        '@namespace svg url(http://www.w3.org/2000/svg);@document url(https://e.example){a{color:red}}a{color:blue}',
    );
    expect(r.css).toBe('a{color:blue}');
    expect(r.stats.imports).toBe(3);
  });

  it('外部の url()（エスケープした u\\72l( と \\75 rl( と URL( を含む）は宣言ごと落とす', () => {
    for (const v of [
      'url(https://e.example/x.png)',
      'url("//e.example/x.png")',
      'u\\72l(https://e.example/x.png)',
      '\\75 rl(https://e.example/x.png)',
      'URL(https://e.example/x.png)',
      "url('javascript:alert(1)')",
      'url(data:text/html,x)',
      'src("https://e.example/x.png")',
      'src(var(--u))',
      'url(var(--u))',
      'url(/\\\\e.example/x.png)',
    ]) {
      const r = decl(`background:${v};color:red`);
      expect(r.css, v).toBe('color:red');
    }
  });

  it('image-set()・-webkit-image-set()・image()・element()・expression() を含む宣言は落とす', () => {
    for (const v of [
      'image-set("a.png" 1x)',
      '-webkit-image-set(url(a.png) 1x)',
      'image("a.png")',
      '-moz-element(#x)',
      'expression(alert(1))',
      'linear-gradient(red,blue),image-set("a.png" 1x)',
    ]) {
      const r = decl(`background:${v};color:red`);
      expect(r.css, v).toBe('color:red');
      expect(r.stats.imageSets, v).toBe(1);
    }
  });

  it('behavior・-moz-binding は落とす', () => {
    expect(decl('behavior:url(x.htc);-moz-binding:url(x.xml#a);color:red').css).toBe('color:red');
  });

  it('セレクタ・at-rule の前置きに URL があれば規則ごと落とす', () => {
    expect(
      sheet('@supports (background:url(https://e.example/x)){a{color:red}}b{color:blue}').css,
    ).toBe('b{color:blue}');
    expect(sheet('a:url(x){color:red}b{color:blue}').css).toBe('b{color:blue}');
  });

  it('壊れた字句（bad-string）を含む宣言は落とし、次の宣言は残す', () => {
    expect(decl('content:"abc\n;color:red').css).toBe('color:red');
  });

  it('custom property の url() も判定する', () => {
    expect(decl('--bg:url(https://e.example/x.png);--ok:url(a.png)').css).toBe(
      '--ok:url("A/a.png")',
    );
  });
});

describe('残すもの（書き直したもの）', () => {
  it('相対の url() は書き換え、data: の画像・フォントは残す', () => {
    const r = sheet(
      '@font-face{font-family:"X";src:url(/_next/static/media/a.woff2) format("woff2"),url(data:font/woff2;base64,AAAA) format("woff2"),local("Arial");unicode-range:U+0020-007F,U+1E00-1EFF}' +
        '.a{background:url(../img/b.png) right center/contain no-repeat,#fff}.b{filter:url(#f)}',
    );
    expect(r.css).toBe(
      '@font-face{font-family:"X";src:url("A//_next/static/media/a.woff2") format("woff2"),url("data:font/woff2;base64,AAAA") format("woff2"),local("Arial");unicode-range:U+0020-007F,U+1E00-1EFF}\n' +
        '.a{background:url("A/../img/b.png") right center/contain no-repeat,#fff}\n.b{filter:url("#f")}',
    );
  });

  it('@media・@supports・@layer・@keyframes・入れ子（CSS Nesting）', () => {
    const r = sheet(
      '@media (min-width:600px){a{color:red}@import "x.css";}@layer base,app;@layer app{b{color:blue}}' +
        '@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}' +
        '.c{color:red;&:hover{color:blue;background:url(https://e.example/x)}@media (hover){color:green}}',
    );
    expect(r.css).toBe(
      '@media (min-width:600px){a{color:red}}\n@layer base,app;\n@layer app{b{color:blue}}\n' +
        '@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}\n' +
        '.c{color:red;&:hover{color:blue};@media (hover){color:green}}',
    );
    expect(r.stats.imports).toBe(1);
  });

  it('style 属性の中の規則と at-rule は落とす', () => {
    expect(decl('color:red;a{color:blue};@media x{color:green};margin:0').css).toBe(
      'color:red;margin:0',
    );
  });

  it('コメントは字句の境目を保つ（/**/）', () => {
    expect(sheet('a/**/b{color:red}').css).toBe('a/**/b{color:red}');
  });
});

describe('書き出しに `<` を含めない（`</style` を作れない）', () => {
  it('文字列・識別子・セレクタの `<` は \\3c ', () => {
    const r = sheet('a[title="</style>"]{content:"<\\/style><script>"}\\3c/style{color:red}');
    expect(r.css).not.toContain('<');
    expect(r.css).toBe(
      'a[title="\\3c /style>"]{content:"\\3c /style>\\3c script>"}\n\\3c /style{color:red}',
    );
    expect(sheet('<!-- a{color:red} -->').css).toBe('a{color:red}');
  });

  it('識別子・文字列の書き出し', () => {
    expect(serializeIdent('1a')).toBe('\\31 a');
    expect(serializeIdent('-1')).toBe('-\\31 ');
    expect(serializeIdent('-')).toBe('\\-');
    expect(serializeIdent('a b(')).toBe('a\\ b\\(');
    expect(serializeIdent('日本')).toBe('日本');
    expect(serializeString('a"\\\n<')).toBe('"a\\"\\\\\\a \\3c "');
  });

  it('指数に読める単位はエスケープする（1\\65 3 を 1e3 にしない）', () => {
    expect(decl('width:1\\65 3').css).toBe('width:1\\65 3');
  });
});
