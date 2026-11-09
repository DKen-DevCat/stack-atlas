// HTML の消毒（docs/18 §3.3 の落とすもの全部・文字参照の javascript:・壊れた HTML・CSP の位置・doctype）
import { describe, expect, it } from 'vitest';
import { SCREEN_CSP, sanitizeHtml, type UrlKind, type UrlVerdict } from '../sanitize.js';
import { classifyUrl, dataAllowed } from '../urls.js';

/** 資産の解決の代わり: 相対パスは `A(<値>)`、リンクはそのまま。外部・危険は落とす（本物の AssetStore と同じ分け方） */
function fakeUrl(raw: string, kind: UrlKind): UrlVerdict {
  const c = classifyUrl(raw);
  switch (c.type) {
    case 'empty':
      return { ok: false, why: 'empty' };
    case 'external':
      return { ok: false, why: 'external' };
    case 'unsafe':
      return { ok: false, why: 'unsafe' };
    case 'data':
      return kind !== 'link' && kind !== 'style' && dataAllowed(c.mime, kind)
        ? { ok: true, url: c.value }
        : { ok: false, why: 'unsafe' };
    case 'fragment':
      return { ok: true, url: c.value };
    case 'relative':
      return { ok: true, url: kind === 'link' ? c.value : `A(${c.value})` };
  }
}

const doc = (head: string, body: string) =>
  `<!DOCTYPE html><html lang="ja"><head>${head}</head><body>${body}</body></html>`;
const run = (html: string) => {
  const r = sanitizeHtml(html, { url: fakeUrl });
  if (!r.ok) throw new Error(r.reason);
  return r;
};
const body = (b: string, head = '') => {
  const r = run(doc(head, b));
  const m = /<body>([\s\S]*)<\/body>/.exec(r.html);
  return { ...r, body: m?.[1] ?? '' };
};
const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${SCREEN_CSP}">`;

describe('文書の形: doctype・CSP の meta・charset', () => {
  it('doctype が先頭、CSP の meta が <head> の最初の子、その次に charset', () => {
    const r = run(doc('<meta charSet="utf-8"/><link rel="stylesheet" href="/a.css"/>', '<p>x</p>'));
    expect(
      r.html.startsWith(
        '<!DOCTYPE html><html lang="ja"><head>' + CSP_META + '<meta charset="utf-8">',
      ),
    ).toBe(true);
    expect(r.html.match(/<meta charset/g)).toHaveLength(1);
  });

  it('doctype が無い・古い doctype でも <!DOCTYPE html>（標準モード）', () => {
    expect(
      run('<html><head></head><body></body></html>').html.startsWith('<!DOCTYPE html><html>'),
    ).toBe(true);
    expect(
      run(
        '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN"><html><head></head><body></body></html>',
      ).html.startsWith('<!DOCTYPE html>'),
    ).toBe(true);
  });

  it('CSP の meta は全部の link・style より前（head の前・html の外にあったものは落とす）', () => {
    const r = run(
      '<!-- c --><style>a{color:red}</style><html><link rel=stylesheet href=/x.css><style>b{}</style>' +
        '<head><style>c{color:blue}</style><link rel=stylesheet href=/y.css></head>' +
        '<body><style>d{color:green}</style><link rel=stylesheet href=/z.css></body></html>',
    );
    const csp = r.html.indexOf(CSP_META);
    expect(csp).toBeGreaterThan(0);
    for (const m of r.html.matchAll(/<(link|style)\b/g)) expect(m.index!).toBeGreaterThan(csp);
    expect(r.html).not.toContain('/x.css');
    expect(r.html).not.toContain('b{}');
    expect(r.html).toContain('c{color:blue}');
    expect(r.html).toContain('A(/z.css)');
    expect(r.stats.elements.style).toBe(2);
    expect(r.stats.elements.link).toBe(1);
  });

  it('<head> を決められない文書は出さない', () => {
    for (const bad of [
      '<html><body><p>x</p></body></html>',
      '<p>no structure</p>',
      '<html><div><head></head></div></html>',
      '',
    ]) {
      const r = sanitizeHtml(bad, { url: fakeUrl });
      expect(r.ok, bad).toBe(false);
    }
  });

  it('html と body を省いた文書（head だけ明示）は読む', () => {
    const r = run('<!doctype html><head><meta name="x" content="y"></head><p>本文');
    expect(r.html).toContain('<meta name="x" content="y"></head><p>本文</p>');
  });
});

describe('まるごと落とす要素（中身も）', () => {
  const cases: Array<[string, string]> = [
    ['script', '<script>alert(1)</script>'],
    ['script', '<script src="/a.js"></script>'],
    [
      'noscript',
      '<noscript><iframe src="https://www.googletagmanager.com/ns.html"></iframe></noscript>',
    ],
    ['iframe', '<iframe src="/x" srcdoc="<script>alert(1)</script>"></iframe>'],
    ['object', '<object data="/x.swf"><param name="a" value="b"></object>'],
    ['embed', '<embed src="/x.swf">'],
    [
      'form',
      '<form action="https://evil.example"><input name="q" value="LEAK"><button>送信</button></form>',
    ],
    ['base', '<base href="https://evil.example/">'],
    ['svg', '<svg><script>alert(1)</script><a xlink:href="javascript:alert(1)">LEAK</a></svg>'],
    ['math', '<math><mi xlink:href="javascript:alert(1)">LEAK</mi></math>'],
    ['template', '<template><img src=x onerror=alert(1)>LEAK</template>'],
    ['title', '<title>LEAK</title>'],
    ['textarea', '<textarea><img src=x onerror=alert(1)>LEAK</textarea>'],
    ['xmp', '<xmp><img src=x onerror=alert(1)>LEAK</xmp>'],
    ['noembed', '<noembed>LEAK</noembed>'],
    ['noframes', '<noframes>LEAK</noframes>'],
  ];
  it.each(cases)('%s', (tag, html) => {
    const r = body(`<p>前</p>${html}<p>後</p>`);
    expect(r.body).toBe('<p>前</p><p>後</p>');
    expect(r.stats.elements[tag]).toBe(1);
    expect(r.html).not.toMatch(/LEAK|alert|evil|onerror/);
  });

  it('meta[http-equiv]（refresh・CSP の上書き・set-cookie）は落とし、meta[name] は残す', () => {
    const r = run(
      doc(
        '<meta http-equiv="refresh" content="0;url=https://evil.example"><meta HTTP-EQUIV="Content-Security-Policy" content="default-src *">' +
          '<meta name="viewport" content="width=device-width">',
        '',
      ),
    );
    expect(r.stats.elements['meta[http-equiv]']).toBe(2);
    expect(r.html).not.toContain('evil');
    expect(r.html).not.toContain('default-src *');
    expect(r.html).toContain('<meta name="viewport" content="width=device-width">');
    // 書き直した文書の http-equiv は自分の CSP の 1 つだけ
    expect(r.html.match(/http-equiv/g)).toHaveLength(1);
  });

  it('plaintext は残り全部ごと落とす', () => {
    const r = sanitizeHtml(doc('', '<p>a</p><plaintext><p>LEAK</p>'), { url: fakeUrl });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.html).toContain('<p>a</p>');
    expect(r.html).not.toContain('LEAK');
  });

  it('コメント・CDATA・<? ?>・<!...> は落とす', () => {
    const r = body(
      '<p>a<!-- <img src=x onerror=alert(1)> -->b<![CDATA[ LEAK ]]>c<?xml LEAK ?>d<!LEAK>e</p>',
    );
    expect(r.body).toBe('<p>abcde</p>');
    // HTML の中の CDATA は最初の `>` までの偽のコメント（ブラウザと同じ）。残りはテキスト
    expect(body('<p><![CDATA[x>y]]></p>').body).toBe('<p>y]]&gt;</p>');
  });

  it('許可リストに無い要素は中身ごと落とす。カスタム要素（a-b）は残す', () => {
    const r = body(
      '<blink>LEAK</blink><marquee>LEAK</marquee><my-card class="c">残る</my-card><x>LEAK</x>',
    );
    expect(r.body).toBe('<my-card class="c">残る</my-card>');
    expect(r.stats.elements).toMatchObject({ blink: 1, marquee: 1, x: 1 });
  });
});

describe('link は rel=stylesheet だけ', () => {
  it.each([
    'preload',
    'modulepreload',
    'preconnect',
    'dns-prefetch',
    'prefetch',
    'icon',
    'manifest',
    'alternate stylesheet',
    'stylesheet preload',
    '',
  ])('rel="%s" は落とす', (rel) => {
    const r = run(doc(`<link rel="${rel}" href="/a.css">`, ''));
    expect(r.html).not.toContain('/a.css');
  });

  it('rel=stylesheet（大文字小文字・空白）は href を資産に書き換えて残す。integrity・crossorigin は落とす', () => {
    const r = run(
      doc(
        '<link rel=" StyleSheet " href="/_next/static/css/a.css" integrity="sha384-x" crossorigin="" media="print" data-precedence="next">',
        '',
      ),
    );
    expect(r.html).toContain(
      '<link rel=" StyleSheet " href="A(/_next/static/css/a.css)" media="print" data-precedence="next">',
    );
  });

  it('外部の stylesheet は要素ごと落として外部 URL に数える', () => {
    const r = run(
      doc('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=X">', ''),
    );
    expect(r.html).not.toContain('googleapis');
    expect(r.stats.external).toBe(1);
  });
});

describe('属性', () => {
  it('on* は全部落とす（大文字・値の無いもの・body・img）', () => {
    const r = run(
      '<!DOCTYPE html><html><head></head><body onload="alert(1)"><img src="/a.png" ONERROR=alert(1) onLoad><button onclick="alert(document.domain)">x</button><p on="x">y</p></body></html>',
    );
    expect(r.html).not.toMatch(/\son\w*=/i);
    expect(r.stats.handlers).toBe(5);
  });

  it('タグごとの許可リスト: 知らない属性は落とし、data-* と aria-* は残す', () => {
    const r = body(
      '<div id="a" class="b" data-component="TodayIsland" aria-label="c" role="d" tabindex="1" contenteditable autofocus is="x-y" nonce="n" draggable="true">t</div>',
    );
    expect(r.body).toBe(
      '<div id="a" class="b" data-component="TodayIsland" aria-label="c" role="d">t</div>',
    );
    expect(r.dataComponents).toEqual(['TodayIsland']);
  });

  it('属性値とテキストはエスケープして書き直す（元の文字列を写さない）', () => {
    const r = body(
      '<p title="a&quot;b&lt;c&gt;&amp;">1 &lt; 2 &amp;&amp; 3 &gt; 2 &copy; &unknown; &#x1F600;</p>',
    );
    expect(r.body).toBe(
      '<p title="a&quot;b&lt;c&gt;&amp;">1 &lt; 2 &amp;&amp; 3 &gt; 2 © &amp;unknown; 😀</p>',
    );
  });

  it('許可していない URL の属性（ping・formaction・action・data・xlink:href）は落とし、外部・危険なら数える', () => {
    const r = body(
      '<a href="/x" ping="https://evil.example/p">a</a><button formaction="javascript:alert(1)">b</button><div data="https://e.example" xlink:href="/y" action="/z">c</div>',
    );
    expect(r.body).toBe('<a href="/x">a</a><button>b</button><div>c</div>');
    expect(r.stats.external).toBe(2);
    expect(r.stats.unsafe).toBe(1);
  });
});

describe('URL の属性（文字参照を解き、空白・制御文字を除いてから判定）', () => {
  const hrefs = [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    '&#x6A;avascript:alert(1)',
    '&#106;avascript:alert(1)',
    '&#x6a;&#x61;&#x76;&#x61;&#x73;&#x63;&#x72;&#x69;&#x70;&#x74;&#x3a;alert(1)',
    '&#0000106avascript:alert(1)',
    'jav&#x09;ascript:alert(1)',
    'jav&Tab;ascript:alert(1)',
    'jav&#x0A;ascript:alert(1)',
    'java\nscript:alert(1)',
    'javascript&colon;alert(1)',
    ' \u0001javascript:alert(1)',
    'vbscript:msgbox(1)',
    'data:text/html,<script>alert(1)</script>',
    'data:image/png;base64,AAAA',
    'file:///etc/passwd',
  ];
  it.each(hrefs)('href="%s" は落とす', (href) => {
    const r = body(`<a href="${href.replace(/"/g, '&quot;')}">x</a>`);
    expect(r.body).toBe('<a>x</a>');
    expect(r.stats.unsafe).toBe(1);
  });

  it.each([
    'https://evil.example/',
    'http://evil.example',
    '//evil.example/x',
    '/\\evil.example/x',
    'mailto:a@example.com',
  ])('href="%s" は外部として落とす', (href) => {
    const r = body(`<a href="${href}">x</a>`);
    expect(r.body).toBe('<a>x</a>');
    expect(r.stats.external).toBe(1);
  });

  it('相対パス・#・? のリンクは残す（読み込まない）', () => {
    const r = body(
      '<a href="/calendar/">a</a><a href="races/42/index.html">b</a><a href="#top">c</a><a href="?q=1">d</a>',
    );
    expect(r.body).toBe(
      '<a href="/calendar/">a</a><a href="races/42/index.html">b</a><a href="#top">c</a><a href="?q=1">d</a>',
    );
  });

  it('img: 相対は資産、data: の画像は残す。外部・画像でない data:・javascript: は落とす', () => {
    const r = body(
      '<img src="/images/a.png"><img src="data:image/png;base64,iVBORw0KGgo="><img src="data:image/svg+xml,%3Csvg%3E"><img src="https://images.example.com/b.png"><img src="data:text/html;base64,PHNjcmlwdD4="><img src="&#x6A;avascript:alert(1)">',
    );
    expect(r.body).toBe(
      '<img src="A(/images/a.png)"><img src="data:image/png;base64,iVBORw0KGgo="><img src="data:image/svg+xml,%3Csvg%3E"><img><img><img>',
    );
    expect(r.stats).toMatchObject({ external: 1, unsafe: 2 });
  });

  it('srcset は候補ごとに判定し、記述子は形の正しいものだけ', () => {
    const r = body(
      '<img srcset="/a.png 1x, https://e.example/b.png 2x, /c.png 640w, data:image/png;base64,AA,BB 3x, /d.png bogus">',
    );
    expect(r.body).toBe(
      '<img srcset="A(/a.png) 1x, A(/c.png) 640w, data:image/png;base64,AA,BB 3x, A(/d.png)">',
    );
    expect(r.stats.external).toBe(1);
  });

  it('poster・background・cite・input[type=image] の src も判定する。input[type=text] の src は落とす', () => {
    const r = run(
      '<!DOCTYPE html><html><head></head><body background="https://e.example/bg.png"><video poster="/p.png" src="/v.mp4" autoplay></video><table background="/t.png"><tr><td background="javascript:x">c</td></tr></table><blockquote cite="https://e.example">q</blockquote><input type="image" src="/i.png"><input type="text" src="/j.png"></body></html>',
    );
    expect(r.html).toContain('<body>');
    expect(r.html).toContain('<video poster="A(/p.png)"></video>');
    expect(r.html).toContain('<table background="A(/t.png)"><tr><td>c</td></tr></table>');
    expect(r.html).toContain('<blockquote>q</blockquote>');
    expect(r.html).toContain('<input type="image" src="A(/i.png)"><input type="text">');
    expect(r.stats).toMatchObject({ external: 2, unsafe: 1 });
  });
});

describe('CSS（style 属性と <style>）', () => {
  it('style 属性: エスケープした url( も外部なら宣言ごと落とす', () => {
    const r = body(
      '<span style="background-image:u\\72l(https://cdn.example.com/hero.png);color:#5b6577">a</span><i style="background:url(/ok.png)">b</i>',
    );
    expect(r.body).toBe(
      '<span style="color:#5b6577">a</span><i style="background:url(&quot;A(/ok.png)&quot;)">b</i>',
    );
    expect(r.stats.external).toBe(1);
    expect(r.stats.css.urlDrops).toBe(1);
  });

  it('<style>: @import・image-set・外部の url() を落とし、CSS のエスケープで </style> を作れない', () => {
    const r = run(
      doc(
        '<style>@import url(https://e.example/x.css);a{background:image-set("x.png" 1x)}' +
          'b{content:"\\3c/style><img src=x onerror=alert(1)>"}\\3c/style{color:red}c{color:red}</style>',
        '',
      ),
    );
    const style = /<style>([\s\S]*?)<\/style>/.exec(r.html)![1]!;
    expect(style).not.toContain('<');
    expect(style).not.toContain('@import');
    expect(style).not.toContain('image-set');
    expect(style).toContain('b{content:"\\3c /style>\\3c img src=x onerror=alert(1)>"}');
    expect(style).toContain('c{color:red}');
    expect(r.html.match(/<\/style>/g)).toHaveLength(1);
    expect(r.stats.css).toMatchObject({ imports: 1, imageSets: 1 });
  });

  it('<style> の中の CSS の文字列の </style> では、ブラウザと同じく style が終わる（後ろは HTML として消毒する）', () => {
    const r = run(doc('<style>b{content:"</style><img src=x onerror=alert(1)>"}</style>', ''));
    expect(r.html).not.toMatch(/onerror|alert/);
    expect(r.html.match(/<\/style>/g)).toHaveLength(1);
  });

  it('閉じていない <style> は落とす', () => {
    const r = sanitizeHtml('<!DOCTYPE html><html><head><style>a{color:red}', { url: fakeUrl });
    if (r.ok) expect(r.html).not.toContain('color:red');
    else expect(r.reason).toContain('head');
  });
});

describe('壊れた HTML（解析できない所は要素ごと落とす）', () => {
  it('閉じていない要素は中身ごと落とす（親の終了タグで閉じられたもの・入力の終わり）', () => {
    expect(body('<div><span>LEAK</div><p>後</p>').body).toBe('<div></div><p>後</p>');
    const r = run('<!DOCTYPE html><html><head></head><body><div><p>a</p><section>LEAK');
    expect(r.html).not.toContain('LEAK');
    expect(r.stats.elements['(閉じていない)']).toBeGreaterThan(0);
  });

  it('途中で切れたタグ（`>` が無い・引用符が閉じていない）は落とす', () => {
    for (const tail of [
      '<img src="/a.png" alt="x',
      '<div class=a',
      '<a href="javascript:alert(1)"',
      '</p',
    ]) {
      const r = sanitizeHtml(`<!DOCTYPE html><html><head></head><body><p>前</p>${tail}`, {
        url: fakeUrl,
      });
      expect(r.ok, tail).toBe(true);
      if (!r.ok) continue;
      expect(r.html, tail).toContain('<p>前</p>');
      expect(r.html, tail).not.toMatch(/a\.png|class=|javascript/);
    }
  });

  it('閉じていないコメントは残り全部を落とす', () => {
    const r = run('<!DOCTYPE html><html><head></head><body><p>前</p><!-- <p>LEAK</p>');
    expect(r.html).toContain('<p>前</p>');
    expect(r.html).not.toContain('LEAK');
  });

  it('終了タグを省ける要素（li・p・td・option）と、対応の無い終了タグ', () => {
    expect(body('<ul><li>a<li>b</ul><p>c<p>d<div>e</div>').body).toBe(
      '<ul><li>a</li><li>b</li></ul><p>c</p><p>d</p><div>e</div>',
    );
    expect(body('<table><tr><td>1<td>2<tr><td>3</table></span></div>').body).toBe(
      '<table><tr><td>1</td><td>2</td></tr><tr><td>3</td></tr></table>',
    );
    expect(body('<select><option>a<option>b</select>').body).toBe(
      '<select><option>a</option><option>b</option></select>',
    );
  });

  it('noscript の中の終了タグで抜け出す細工（mXSS）でも、書き出す木に on* は無い', () => {
    const r = body(
      '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></p></noscript><style><img src=x onerror=alert(2)></style>',
    );
    expect(r.html).not.toMatch(/onerror|alert/);
  });

  it('生テキストの要素の終了タグは大文字小文字を問わず、`</stylex` では閉じない', () => {
    const r = run(doc('<STYLE>a{color:red}</stylex>b{color:blue}</STYLE >', ''));
    expect(r.html).toContain('<style>a{color:red}');
    expect(r.html).not.toContain('</stylex>');
  });

  it('自己終了の書き方（`<div/>`）は開始タグ扱い。void はそのまま', () => {
    expect(body('<div/>a</div><br/><img src="/a.png"/>').body).toBe(
      '<div>a</div><br><img src="A(/a.png)">',
    );
  });
});

describe('悪意のある入力でも落ちない・重くならない（抽出器の失敗は build のエラーになるため）', () => {
  it('constructor・__proto__・toString のような名前の要素と属性', () => {
    // タグ名は英字で始まるので __proto__ は要素にならない（ブラウザと同じくテキスト）。属性名は何でもよい
    const r = body(
      '<constructor>a</constructor><toString>b</toString><valueOf __proto__="x" constructor="y">c</valueOf><p toString="z" hasOwnProperty __proto__>d</p>',
    );
    expect(r.body).toBe('<p>d</p>');
    expect(r.stats.elements.constructor).toBe(1);
    expect(r.stats.elements.tostring).toBe(1);
    expect(r.stats.elements.valueof).toBe(1);
    expect(body('<__proto__>e</__proto__>').body).toBe('&lt;__proto__&gt;e');
  });

  it('ASCII 以外の大文字（İ は小文字にすると 2 文字）があっても、生テキストの終わりの位置がずれない', () => {
    const r = run(doc('<style>a{content:"İİİİ"}</style><style>b{color:red}</style>', '<p>İ</p>'));
    expect(r.html).toContain('<style>a{content:"İİİİ"}</style><style>b{color:red}</style>');
    expect(r.html).toContain('<p>İ</p>');
  });

  it('深い入れ子（HTML 2 万段・CSS 2 万段）は先を読まずに落とす', () => {
    const t0 = Date.now();
    const deep = sanitizeHtml(
      doc('', `${'<div>'.repeat(20000)}LEAK${'</div>'.repeat(20000)}<p>後</p>`),
      { url: fakeUrl },
    );
    expect(deep.ok).toBe(true);
    if (deep.ok) expect(deep.html).not.toContain('LEAK');
    const css = run(doc(`<style>a{color:${'('.repeat(20000)}}b{color:red}</style>`, ''));
    expect(css.html).toContain('<style></style>');
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('コメント・終了タグ・生テキストの要素がたくさんあっても線形（5 万個で数秒以内）', () => {
    const t0 = Date.now();
    const many = run(
      doc(
        '',
        `${'<!-- c -->'.repeat(50000)}${'<style>a{}</stylex>'.repeat(1)}</style>${'<b></span>'.repeat(50000)}`,
      ),
    );
    expect(many.ok).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});
