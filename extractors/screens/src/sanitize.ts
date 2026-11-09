/**
 * ビルド成果物の HTML の消毒（許可リスト。docs/18 §3.3・D63）。
 *
 * 字句から組んだ木（html.ts）を、許可した要素・属性だけで**書き直す**（元の文字列は写さない）。
 * - doctype は先頭（いつも `<!DOCTYPE html>`。標準モード）。CSP の meta を `<head>` の最初の子に入れ、その次に `<meta charset="utf-8">`。
 *   `<head>` を決められない文書は出さない
 * - まるごと落とす: script noscript iframe object embed base meta[http-equiv] svg math template title textarea xmp
 *   noembed noframes plaintext（と、許可リストに無い要素）、コメント・CDATA、閉じていない要素。`<link>` は rel=stylesheet だけ
 * - `<form>` は `<div>` に書き換える（中身は残し、属性は div の許可リスト。action method enctype target novalidate
 *   autocomplete name などは落ちる）。送信は CSP の form-action 'none' と sandbox（allow-forms 無し）でも止める
 * - 属性はタグごとの許可リスト。`on*` は落とす。URL の属性（src href srcset poster background cite …）は
 *   文字参照を解いた後で呼び出し側の判定（opts.url）を通す。`style` 属性と `<style>` の中身は CSS の消毒（css.ts）を通す
 * - 書き出す CSS には `<` が無く、属性値は `&` `"` `<` `>` を、テキストは `&` `<` `>` をエスケープする
 */
import {
  emptyCssStats,
  sanitizeDeclarations,
  sanitizeStylesheet,
  type CssStats,
  type CssUrlResult,
} from './css.js';
import { parseHtml, type Attr, type ElementNode, type HtmlNode } from './html.js';
import { parseSrcset, validDescriptor } from './urls.js';

/** `<head>` の最初の子に入れる CSP（docs/18 §3.3）。serve の応答ヘッダは、これに `sandbox allow-same-origin` を足したもの */
export const SCREEN_CSP =
  "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; base-uri 'none'; form-action 'none'";

/** URL を何として使うか。link はたどるだけ（読み込まない）、それ以外は資産として写す */
export type UrlKind = 'link' | 'style' | 'image' | 'font' | 'image-or-font';

/** 判定の結果。ok でなければ理由で数え分ける */
export type UrlVerdict =
  { ok: true; url: string } | { ok: false; why: 'external' | 'unsafe' | 'missing' | 'empty' };

export interface SanitizeOptions {
  /** URL（文字参照・CSS のエスケープを解いた値）を判定し、書き出す URL を返す */
  url(raw: string, kind: UrlKind): UrlVerdict;
}

export interface SanitizeStats {
  /** 落とした要素（タグ名 → 数。閉じていない要素は `(閉じていない)`、許可リストに無い要素はタグ名） */
  elements: Record<string, number>;
  /** 落とした on* 属性 */
  handlers: number;
  /** 外した外部 URL（http(s)・`//`・mailto など。読み込まない） */
  external: number;
  /** 外した危険な URL（javascript: など・画像でない data:・制御文字） */
  unsafe: number;
  /** 見つからない・書き出せない資産（相対パスの先が無い・export の外・シンボリックリンク・拡張子） */
  missing: number;
  /** `<style>` と style 属性の CSS で落としたもの */
  css: CssStats;
}

export const emptyStats = (): SanitizeStats => ({
  // タグ名をキーにするので、__proto__ や constructor が来ても壊れないように prototype の無いオブジェクト
  elements: Object.create(null) as Record<string, number>,
  handlers: 0,
  external: 0,
  unsafe: 0,
  missing: 0,
  css: emptyCssStats(),
});

export type SanitizeResult =
  | {
      ok: true;
      html: string;
      stats: SanitizeStats;
      /** 残った要素の data-component（出てきた順、重複あり） */
      dataComponents: string[];
    }
  | { ok: false; reason: string; stats: SanitizeStats };

/** まるごと落とす要素（中身も） */
export const DROP_ELEMENTS = new Set([
  'script',
  'noscript',
  'iframe',
  'object',
  'embed',
  'base',
  'svg',
  'math',
  'template',
  'title',
  'textarea',
  'xmp',
  'noembed',
  'noframes',
  'plaintext',
  'frame',
  'frameset',
  'applet',
  'param',
  'portal',
  'fencedframe',
  'slot',
  'marquee',
  'isindex',
  'image',
  'keygen',
  'listing',
  'bgsound',
  'basefont',
]);

/**
 * 別の要素に書き換える要素（中身は残す。属性は書き換えた先の許可リスト）。
 * form は div に: 部品のルート要素（data-component）になりやすく、落とすと画面の領域が取れない
 */
export const REWRITE_ELEMENTS: ReadonlyMap<string, string> = new Map([['form', 'div']]);

/** どの要素にも付けてよい属性（data-* と aria-* は別に通す） */
const GLOBAL_ATTRS = new Set([
  'id',
  'class',
  'title',
  'lang',
  'dir',
  'hidden',
  'role',
  'translate',
  'style',
]);

/** 要素 → その要素に付けてよい属性（グローバル以外）。ここに無い要素は落とす（引くのは ELEMENTS。constructor などを引かない Map） */
const ELEMENT_LIST: Record<string, readonly string[]> = {
  html: [],
  head: [],
  body: ['background'],
  meta: ['name', 'content'],
  link: ['rel', 'href', 'media'],
  style: ['media'],
  // 区分・まとまり
  address: [],
  article: [],
  aside: [],
  footer: [],
  header: [],
  h1: [],
  h2: [],
  h3: [],
  h4: [],
  h5: [],
  h6: [],
  hgroup: [],
  main: [],
  nav: [],
  section: [],
  search: [],
  blockquote: ['cite'],
  dd: [],
  div: ['align'],
  dl: [],
  dt: [],
  figcaption: [],
  figure: [],
  hr: ['align', 'size', 'width', 'noshade'],
  li: ['value', 'type'],
  menu: [],
  ol: ['start', 'reversed', 'type'],
  p: ['align'],
  pre: [],
  ul: ['type'],
  center: [],
  // 文中
  a: ['href', 'hreflang', 'type', 'name'],
  abbr: [],
  b: [],
  bdi: [],
  bdo: [],
  br: ['clear'],
  cite: [],
  code: [],
  data: ['value'],
  dfn: [],
  em: [],
  i: [],
  kbd: [],
  mark: [],
  q: ['cite'],
  rp: [],
  rt: [],
  ruby: [],
  s: [],
  samp: [],
  small: [],
  span: [],
  strong: [],
  sub: [],
  sup: [],
  time: ['datetime'],
  u: [],
  var: [],
  wbr: [],
  del: ['cite', 'datetime'],
  ins: ['cite', 'datetime'],
  font: ['color', 'face', 'size'],
  big: [],
  tt: [],
  nobr: [],
  strike: [],
  // 埋め込み（画像だけ。動画・音声は読み込まない）
  img: ['src', 'srcset', 'sizes', 'alt', 'width', 'height', 'loading', 'decoding'],
  picture: [],
  source: ['srcset', 'sizes', 'media', 'type', 'width', 'height'],
  video: ['poster', 'width', 'height', 'controls', 'muted', 'loop', 'playsinline'],
  audio: ['controls', 'muted', 'loop'],
  canvas: ['width', 'height'],
  // 表
  table: [
    'border',
    'cellpadding',
    'cellspacing',
    'width',
    'align',
    'bgcolor',
    'background',
    'summary',
  ],
  caption: ['align'],
  colgroup: ['span', 'width'],
  col: ['span', 'width'],
  thead: ['align', 'valign'],
  tbody: ['align', 'valign'],
  tfoot: ['align', 'valign'],
  tr: ['align', 'valign', 'bgcolor'],
  td: [
    'colspan',
    'rowspan',
    'headers',
    'abbr',
    'align',
    'valign',
    'width',
    'height',
    'bgcolor',
    'background',
    'nowrap',
  ],
  th: [
    'colspan',
    'rowspan',
    'headers',
    'scope',
    'abbr',
    'align',
    'valign',
    'width',
    'height',
    'bgcolor',
    'background',
    'nowrap',
  ],
  // 入力の見た目（送信はしない。form は div に書き換え、formaction などは許可しない）
  button: ['type', 'name', 'value', 'disabled'],
  fieldset: ['disabled', 'name'],
  input: [
    'type',
    'name',
    'value',
    'placeholder',
    'checked',
    'disabled',
    'readonly',
    'size',
    'min',
    'max',
    'step',
    'multiple',
    'required',
    'maxlength',
    'minlength',
    'alt',
    'width',
    'height',
    'src',
  ],
  label: ['for'],
  legend: [],
  meter: ['value', 'min', 'max', 'low', 'high', 'optimum'],
  optgroup: ['label', 'disabled'],
  option: ['value', 'selected', 'disabled', 'label'],
  output: ['for', 'name'],
  progress: ['value', 'max'],
  select: ['name', 'multiple', 'size', 'disabled', 'required'],
  details: ['open'],
  summary: [],
  dialog: ['open'],
};

const ELEMENTS: ReadonlyMap<string, readonly string[]> = new Map(Object.entries(ELEMENT_LIST));

/** URL の属性（docs/18 §3.3 の一覧）。許可した属性のうち URL のものは、ここで種類を決めて判定する */
export const URL_ATTRS = new Set([
  'src',
  'href',
  'srcset',
  'poster',
  'background',
  'xlink:href',
  'ping',
  'formaction',
  'action',
  'data',
  'cite',
]);

/** 要素の名前として書き出してよいか（カスタム要素は `a-b` の形。スクリプトが無いので中身はただの要素） */
const CUSTOM_ELEMENT = /^[a-z][a-z0-9._]*-[a-z0-9._-]*$/;
/** data-* / aria-* の名前 */
const DATA_ATTR = /^(data|aria)-[a-z0-9_.-]+$/;

const SPACE = /^[\t\n\f\r ]*$/;

export function sanitizeHtml(input: string, opts: SanitizeOptions): SanitizeResult {
  const stats = emptyStats();
  const drop = (what: string) => {
    stats.elements[what] = (stats.elements[what] ?? 0) + 1;
  };
  const doc = parseHtml(input);

  // 文書の形: html（無ければ最上位）の中の head。head の前のもの（html の外・head より前の子）は落とす
  const topElements = doc.children.filter((c): c is ElementNode => c.type === 'element');
  const htmlEl = topElements.find((c) => c.tag === 'html' && !c.broken);
  const container = htmlEl ? htmlEl.children : doc.children;
  const headIdx = container.findIndex((c) => c.type === 'element' && c.tag === 'head');
  const head = headIdx < 0 ? undefined : (container[headIdx] as ElementNode);
  if (!head || head.broken) {
    return { ok: false, reason: '<head> を決められない（無い・閉じていない）', stats };
  }
  // 書き出さないもの（CSP より前に来てしまう・文書の外）: html の外の要素と、head より前の要素
  const outside = htmlEl ? doc.children.filter((c) => c !== htmlEl) : [];
  for (const c of [...outside, ...container.slice(0, headIdx)])
    if (c.type === 'element') drop(c.tag);

  const dataComponents: string[] = [];
  const cssUrl =
    (kind: UrlKind) =>
    (raw: string): CssUrlResult => {
      const v = judge(raw, kind);
      return v === undefined ? { ok: false } : { ok: true, url: v };
    };
  const addCss = (s: CssStats) => {
    for (const k of Object.keys(s) as (keyof CssStats)[]) stats.css[k] += s[k];
  };

  /** URL を判定して数える。通れば書き出す値 */
  function judge(raw: string, kind: UrlKind): string | undefined {
    const v = opts.url(raw, kind);
    if (v.ok) return v.url;
    if (v.why === 'external') stats.external++;
    else if (v.why === 'unsafe') stats.unsafe++;
    else if (v.why === 'missing') stats.missing++;
    return undefined;
  }

  /** tag は書き出す要素の名前（REWRITE_ELEMENTS で書き換えたもの） */
  function attrs(el: ElementNode, tag = el.tag): Attr[] | undefined {
    const allowed = ELEMENTS.get(tag) ?? [];
    const out: Attr[] = [];
    const get = (name: string) => el.attrs.find((a) => a.name === name)?.value;
    for (const a of el.attrs) {
      if (a.name.startsWith('on')) {
        stats.handlers++;
        continue;
      }
      const ok = GLOBAL_ATTRS.has(a.name) || allowed.includes(a.name) || DATA_ATTR.test(a.name);
      if (!ok) {
        // 許可していない URL の属性（ping・formaction・action・data・xlink:href…）も、値は数える
        if (URL_ATTRS.has(a.name)) judge(a.value, 'link');
        continue;
      }
      if (a.name === 'style') {
        const r = sanitizeDeclarations(a.value, { url: cssUrl('image-or-font') });
        addCss(r.stats);
        if (r.css) out.push({ name: 'style', value: r.css });
        continue;
      }
      if (URL_ATTRS.has(a.name)) {
        const kind = urlKindOf(tag, a.name, get('type'));
        if (kind === undefined) continue;
        if (a.name === 'srcset') {
          const kept: string[] = [];
          for (const cand of parseSrcset(a.value)) {
            const u = judge(cand.url, 'image');
            if (u === undefined) continue;
            // 書き出す URL にカンマや空白は無い（資産の名前か data:）。data: のカンマは srcset では区切りにならない
            if (/\s/.test(u)) continue;
            kept.push(
              cand.descriptor && validDescriptor(cand.descriptor) ? `${u} ${cand.descriptor}` : u,
            );
          }
          if (kept.length) out.push({ name: 'srcset', value: kept.join(', ') });
          continue;
        }
        const u = judge(a.value, kind);
        if (u === undefined) {
          // stylesheet の link は href が無ければ要素ごと落とす（呼び出し側）
          if (tag === 'link') return undefined;
          continue;
        }
        out.push({ name: a.name, value: u });
        continue;
      }
      out.push(a);
    }
    return out;
  }

  /** 要素を書き出す。落とすなら '' */
  function element(el: ElementNode): string {
    if (el.broken) {
      drop('(閉じていない)');
      return '';
    }
    if (DROP_ELEMENTS.has(el.tag)) {
      drop(el.tag);
      return '';
    }
    const tag = REWRITE_ELEMENTS.get(el.tag) ?? el.tag;
    if (!ELEMENTS.has(tag) && !CUSTOM_ELEMENT.test(tag)) {
      drop(tag);
      return '';
    }
    if (tag === 'html' || tag === 'head') {
      // 入れ子の html・head（本物は文書の形で処理した）は落とす
      drop(tag);
      return '';
    }
    if (tag === 'meta') {
      if (el.attrs.some((a) => a.name === 'http-equiv')) {
        drop('meta[http-equiv]');
        return '';
      }
      // charset は書き直した文書の側で付ける
      if (el.attrs.some((a) => a.name === 'charset')) return '';
    }
    if (tag === 'link') {
      const rel = (el.attrs.find((a) => a.name === 'rel')?.value ?? '')
        .toLowerCase()
        .split(/[\t\n\f\r ]+/)
        .filter(Boolean);
      if (rel.length !== 1 || rel[0] !== 'stylesheet') {
        drop(`link[rel=${rel.join(' ') || '?'}]`);
        return '';
      }
    }
    const as = attrs(el, tag);
    if (as === undefined) {
      drop(`${tag}（URL を外した）`);
      return '';
    }
    if (tag === 'link' && !as.some((a) => a.name === 'href')) {
      drop('link[rel=stylesheet]（href が無い）');
      return '';
    }
    const dc = as.find((a) => a.name === 'data-component')?.value;
    if (dc) dataComponents.push(dc);
    const open = `<${tag}${as.map((a) => ` ${a.name}="${escapeAttr(a.value)}"`).join('')}>`;
    if (VOID_OUT.has(tag)) return open;
    let inner: string;
    if (tag === 'style') {
      const raw = el.children.map((c) => (c.type === 'raw' ? c.text : '')).join('');
      const r = sanitizeStylesheet(raw, { url: cssUrl('image-or-font') });
      addCss(r.stats);
      inner = r.css;
    } else {
      inner = children(el.children);
      // <pre> の直後の改行はブラウザが捨てる（字句の側でも 1 つ捨ててある。html.ts）ので、中身が改行で始まるなら 1 つ足す
      if (tag === 'pre' && inner.startsWith('\n')) inner = `\n${inner}`;
    }
    return `${open}${inner}</${tag}>`;
  }

  function children(list: HtmlNode[]): string {
    let r = '';
    for (const c of list) {
      if (c.type === 'text') r += escapeText(c.text);
      else if (c.type === 'raw')
        continue; // 生テキストは style の中身だけ（element で扱う）
      else r += element(c);
    }
    return r;
  }

  const rest = container.slice(headIdx + 1);
  const headInner = children(head.children);
  const htmlAttrs = htmlEl ? (attrs(htmlEl) ?? []) : [];
  const body = rest
    .map((c) => {
      if (c.type === 'text') return SPACE.test(c.text) ? '' : escapeText(c.text);
      if (c.type === 'raw') return '';
      if (c.tag === 'body') {
        if (c.broken) {
          drop('(閉じていない)');
          return '';
        }
        const ba = attrs(c) ?? [];
        const dc = ba.find((a) => a.name === 'data-component')?.value;
        if (dc) dataComponents.push(dc);
        return `<body${ba.map((a) => ` ${a.name}="${escapeAttr(a.value)}"`).join('')}>${children(c.children)}</body>`;
      }
      return element(c);
    })
    .join('');

  const html =
    '<!DOCTYPE html>' +
    `<html${htmlAttrs.map((a) => ` ${a.name}="${escapeAttr(a.value)}"`).join('')}>` +
    `<head><meta http-equiv="Content-Security-Policy" content="${escapeAttr(SCREEN_CSP)}">` +
    '<meta charset="utf-8">' +
    headInner +
    '</head>' +
    body +
    '</html>\n';
  return { ok: true, html, stats, dataComponents };
}

/** 書き出すときに終了タグを付けない要素 */
const VOID_OUT = new Set(['br', 'col', 'hr', 'img', 'input', 'link', 'meta', 'source', 'wbr']);

/** 要素と属性 → URL の種類。undefined はその属性を落とす */
function urlKindOf(tag: string, attr: string, type: string | undefined): UrlKind | undefined {
  switch (attr) {
    case 'href':
      return tag === 'link' ? 'style' : 'link';
    case 'src':
      if (tag === 'input') return (type ?? '').toLowerCase() === 'image' ? 'image' : undefined;
      return 'image';
    case 'srcset':
    case 'poster':
    case 'background':
      return 'image';
    case 'cite':
      return 'link';
    default:
      return undefined;
  }
}

export function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
