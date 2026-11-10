/**
 * HTML の字句解析と木（消毒のための最小限。依存は足さない。D63）。
 *
 * - 字句は HTML の仕様に寄せる（タグ・属性・コメント・doctype・CDATA・`<?`・生テキストの要素）が、木の組み立ては簡略版:
 *   要素は終了タグで閉じる。終了タグの省略が仕様で許されるもの（`li` `p` `td` … と `html` `head` `body`）だけを暗黙に閉じ、
 *   それ以外で閉じていない要素は `broken`（消毒で要素ごと落とす）
 * - 入力の解釈がブラウザと違っても安全は崩れない: 消毒した HTML はこの木から書き直すので、ブラウザが見るのはこの木そのもの
 *   （違いは見た目だけに出る）
 */
import { decodeEntities } from './entities.js';

export interface Attr {
  /** 小文字 */
  name: string;
  /** 文字参照を解いた値 */
  value: string;
}

export type Token =
  | { type: 'doctype' }
  | { type: 'start'; name: string; attrs: Attr[]; selfClosing: boolean }
  | { type: 'end'; name: string }
  | { type: 'text'; text: string }
  /** 生テキストの要素（style・script など）の中身。文字参照は解かない */
  | { type: 'raw'; text: string }
  | { type: 'comment' }
  /** `<![CDATA[…]>`・`<!…>`・`<?…>`（HTML の中では偽のコメント） */
  | { type: 'bogus' }
  /** 閉じていないタグ・コメント・生テキストの要素（ここで入力が終わる） */
  | { type: 'eof-in'; what: string };

/** 中身を字句にしない要素（終了タグまでを raw にする） */
export const RAW_TEXT = new Set([
  'script',
  'style',
  'xmp',
  'iframe',
  'noembed',
  'noframes',
  'noscript',
  'title',
  'textarea',
]);

export const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
  'param',
  'keygen',
  'basefont',
  'bgsound',
  'frame',
]);

const isWs = (c: string | undefined) =>
  c === ' ' || c === '\t' || c === '\n' || c === '\f' || c === '\r';
const isAlpha = (c: string | undefined) => !!c && /[A-Za-z]/.test(c);

/** ASCII の英字だけを小文字にする（HTML の仕様。長さが変わらないので、元の文字列と位置が揃う） */
export const asciiLower = (s: string) => s.replace(/[A-Z]+/g, (m) => m.toLowerCase());

/** 木の深さの上限。超えたら、その先は読まない（深い入れ子で再帰や探索が重くならないように） */
export const MAX_DEPTH = 512;

/** 入力の前処理: BOM を外し、改行を LF に、NUL を U+FFFD にする */
export function preprocess(src: string): string {
  return src
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\0/g, '\uFFFD');
}

/** 字句に分ける。入力の途中で閉じていないものがあれば、最後の字句が eof-in */
export function tokenize(input: string): Token[] {
  const src = preprocess(input);
  const lower = asciiLower(src);
  const out: Token[] = [];
  const n = src.length;
  let i = 0;
  let text = '';
  const flush = () => {
    if (text) out.push({ type: 'text', text: decodeEntities(text) });
    text = '';
  };
  /** src[i] から `>` まで（含む）を飛ばす。見つからなければ -1 */
  const skipTo = (from: number, needle: string) => {
    const j = src.indexOf(needle, from);
    return j < 0 ? -1 : j + needle.length;
  };
  /**
   * from 以降で最初の needle の位置（無ければ -1）。前回の答えを覚えておき、まだ from より後ろならそれを返す
   * （i は前にしか進まないので、答えは変わらない）。2026-11-09（8-3b のレビュー）: コメントごとに `-->` を
   * 末尾まで探していたので、`-->` の無い文書の `<!----!>` の並びが 2 乗だった（320 KB で 48 秒）
   */
  const finder = (needle: string) => {
    let at = -2; // -2: まだ探していない
    let searchedFrom = 0;
    return (from: number) => {
      if (from >= searchedFrom && (at === -1 || at >= from)) return at;
      searchedFrom = from;
      at = src.indexOf(needle, from);
      return at;
    };
  };
  const nextCommentEnd = finder('-->');
  const nextBangEnd = finder('--!>');

  while (i < n) {
    const c = src[i]!;
    if (c !== '<') {
      const j = src.indexOf('<', i);
      text += src.slice(i, j < 0 ? n : j);
      i = j < 0 ? n : j;
      continue;
    }
    const next = src[i + 1];
    // コメント
    if (src.startsWith('<!--', i)) {
      flush();
      if (src.startsWith('<!-->', i)) {
        i += 5;
      } else if (src.startsWith('<!--->', i)) {
        i += 6;
      } else {
        // `-->` か `--!>` の早い方（どちらも位置を覚えて、文書を前から 1 回ずつしか走査しない）
        const a = nextCommentEnd(i + 4);
        const b = nextBangEnd(i + 4);
        const end = a < 0 && b < 0 ? -1 : b < 0 || (a >= 0 && a < b) ? a + 3 : b + 4;
        if (end < 0) {
          out.push({ type: 'eof-in', what: 'comment' });
          return out;
        }
        i = end;
      }
      out.push({ type: 'comment' });
      continue;
    }
    if (next === '!' || next === '?') {
      flush();
      const end = skipTo(i + 2, '>');
      if (end < 0) {
        out.push({ type: 'eof-in', what: 'markup declaration' });
        return out;
      }
      const body = src.slice(i + 2, end - 1);
      out.push(next === '!' && /^doctype/i.test(body) ? { type: 'doctype' } : { type: 'bogus' });
      i = end;
      continue;
    }
    if (next === '/') {
      if (src[i + 2] === '>') {
        // `</>` は無視（仕様）
        flush();
        i += 3;
        continue;
      }
      if (!isAlpha(src[i + 2])) {
        // `</` + 英字以外は偽のコメント
        flush();
        const end = skipTo(i + 2, '>');
        if (end < 0) {
          out.push({ type: 'eof-in', what: 'end tag' });
          return out;
        }
        out.push({ type: 'bogus' });
        i = end;
        continue;
      }
      flush();
      const tag = readTag(src, i + 2);
      if (!tag) {
        out.push({ type: 'eof-in', what: 'end tag' });
        return out;
      }
      out.push({ type: 'end', name: tag.name });
      i = tag.end;
      continue;
    }
    if (!isAlpha(next)) {
      text += '<';
      i++;
      continue;
    }
    flush();
    const tag = readTag(src, i + 1);
    if (!tag) {
      out.push({ type: 'eof-in', what: `<${readName(src, i + 1)}>` });
      return out;
    }
    out.push({ type: 'start', name: tag.name, attrs: tag.attrs, selfClosing: tag.selfClosing });
    i = tag.end;
    if (tag.name === 'plaintext') {
      // 残り全部がテキスト（閉じない）
      out.push({ type: 'eof-in', what: '<plaintext>' });
      return out;
    }
    // 生テキストの要素は `<style/>` でも開始タグ（HTML では自己終了の印を無視する）。中身は終了タグまで
    if (RAW_TEXT.has(tag.name)) {
      const close = findRawEnd(src, lower, i, tag.name);
      if (close < 0) {
        out.push({ type: 'eof-in', what: `<${tag.name}>` });
        return out;
      }
      out.push({ type: 'raw', text: src.slice(i, close) });
      const endTag = readTag(src, close + 2);
      if (!endTag) {
        out.push({ type: 'eof-in', what: `</${tag.name}>` });
        return out;
      }
      out.push({ type: 'end', name: tag.name });
      i = endTag.end;
    }
  }
  flush();
  return out;
}

function readName(src: string, from: number): string {
  let j = from;
  while (j < src.length && !isWs(src[j]) && src[j] !== '/' && src[j] !== '>') j++;
  return asciiLower(src.slice(from, j));
}

/** `</name` の位置（name の後が空白・`/`・`>`）。無ければ -1。lower は src を asciiLower したもの（位置が同じ） */
function findRawEnd(src: string, lower: string, from: number, name: string): number {
  let j = from;
  for (;;) {
    j = lower.indexOf(`</${name}`, j);
    if (j < 0) return -1;
    const after = src[j + 2 + name.length];
    if (after === undefined || isWs(after) || after === '/' || after === '>') return j;
    j += 2;
  }
}

/** タグ名と属性を読む（from はタグ名の最初の文字）。`>` が無ければ undefined */
function readTag(
  src: string,
  from: number,
): { name: string; attrs: Attr[]; selfClosing: boolean; end: number } | undefined {
  const n = src.length;
  const name = readName(src, from);
  let j = from + name.length;
  const attrs: Attr[] = [];
  const seen = new Set<string>();
  let selfClosing = false;
  for (;;) {
    while (j < n && isWs(src[j])) j++;
    if (j >= n) return undefined;
    const c = src[j]!;
    if (c === '>') return { name, attrs, selfClosing, end: j + 1 };
    if (c === '/') {
      j++;
      if (src[j] === '>') {
        selfClosing = true;
        return { name, attrs, selfClosing, end: j + 1 };
      }
      continue;
    }
    // 属性名（最初の文字は `=` でもよい。仕様）
    let k = j + 1;
    while (k < n && !isWs(src[k]) && src[k] !== '/' && src[k] !== '>' && src[k] !== '=') k++;
    const attrName = asciiLower(src.slice(j, k));
    j = k;
    while (j < n && isWs(src[j])) j++;
    let value = '';
    if (src[j] === '=') {
      j++;
      while (j < n && isWs(src[j])) j++;
      const q = src[j];
      if (q === '"' || q === "'") {
        const end = src.indexOf(q, j + 1);
        if (end < 0) return undefined;
        value = src.slice(j + 1, end);
        j = end + 1;
      } else {
        let e = j;
        while (e < n && !isWs(src[e]) && src[e] !== '>') e++;
        value = src.slice(j, e);
        j = e;
      }
    }
    // 同じ名前の 2 つ目以降は捨てる（ブラウザと同じ）
    if (!seen.has(attrName)) {
      seen.add(attrName);
      attrs.push({ name: attrName, value: decodeEntities(value) });
    }
  }
}

// ─── 木 ───

export interface ElementNode {
  type: 'element';
  tag: string;
  attrs: Attr[];
  children: HtmlNode[];
  /** 終了タグが無かった（閉じていない）。消毒で要素ごと落とす */
  broken?: boolean;
}
export interface TextNode {
  type: 'text';
  text: string;
}
/** 生テキストの要素の中身 */
export interface RawNode {
  type: 'raw';
  text: string;
}
export type HtmlNode = ElementNode | TextNode | RawNode;

export interface Document {
  /** doctype があった */
  doctype: boolean;
  children: HtmlNode[];
  /** 入力が途中で切れていた（閉じていないタグ・コメントなど）。その先は読まない */
  truncated?: string;
}

/** 終了タグを省略してよい要素（親の終了タグや入力の終わりで、壊れていない扱いで閉じる） */
const OPTIONAL_END = new Set([
  'html',
  'head',
  'body',
  'li',
  'dt',
  'dd',
  'p',
  'rt',
  'rp',
  'optgroup',
  'option',
  'colgroup',
  'caption',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
]);

/** 開いている p を閉じる開始タグ（仕様の「p を閉じる」要素） */
const CLOSES_P = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'details',
  'dialog',
  'div',
  'dl',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hgroup',
  'hr',
  'main',
  'menu',
  'nav',
  'ol',
  'p',
  'pre',
  'search',
  'section',
  'table',
  'ul',
]);

/** 開始タグ name が来たとき、開いている一番上の要素 top を閉じるか（兄弟になる要素） */
function closesTop(top: string, name: string): boolean {
  switch (top) {
    case 'li':
      return name === 'li';
    case 'dt':
    case 'dd':
      return name === 'dt' || name === 'dd';
    case 'option':
      return name === 'option' || name === 'optgroup';
    case 'optgroup':
      return name === 'optgroup';
    case 'td':
    case 'th':
      return name === 'td' || name === 'th' || name === 'tr';
    case 'tr':
      return name === 'tr';
    case 'thead':
    case 'tbody':
    case 'tfoot':
      return name === 'thead' || name === 'tbody' || name === 'tfoot';
    case 'rt':
    case 'rp':
      return name === 'rt' || name === 'rp';
    case 'p':
      return CLOSES_P.has(name);
    default:
      return false;
  }
}

/** head の中に書ける要素（これ以外の開始タグで head は暗黙に閉じる） */
const IN_HEAD = new Set([
  'meta',
  'link',
  'style',
  'title',
  'script',
  'noscript',
  'base',
  'template',
  'basefont',
  'bgsound',
]);

/** 開始タグの直後の改行 1 つを捨てる要素（HTML の仕様。ブラウザも捨てる） */
const DROPS_LEADING_NEWLINE = new Set(['pre', 'listing', 'textarea']);

/** 字句から木を組み立てる */
export function parseHtml(input: string): Document {
  const tokens = tokenize(input);
  const doc: Document = { doctype: false, children: [] };
  const root: ElementNode = { type: 'element', tag: '#root', attrs: [], children: [] };
  const stack: ElementNode[] = [root];
  const top = () => stack[stack.length - 1]!;
  const append = (node: HtmlNode) => top().children.push(node);
  /** stack[idx] より上を閉じる（省略してよい要素は壊れていない扱い） */
  const closeAbove = (idx: number) => {
    while (stack.length - 1 > idx) {
      const el = stack.pop()!;
      if (!OPTIONAL_END.has(el.tag)) el.broken = true;
    }
  };
  let sawElement = false;
  /** 直前の字句が pre・listing・textarea の開始タグ（次のテキストの先頭の改行を 1 つ捨てる） */
  let dropNewline = false;

  for (const t of tokens) {
    if (doc.truncated) break;
    // 2026-11-09（8-3b のレビュー）: 捨てずに木に残すと、消毒で `<pre>` の後に改行を 1 つ足す所（ブラウザが捨てる分）と
    // 合わせて改行が 2 つになり、`<pre>\ncode` の上に空の行が出ていた
    if (dropNewline && (t.type === 'text' || t.type === 'raw') && t.text.startsWith('\n')) {
      const rest = t.text.slice(1);
      dropNewline = false;
      if (!rest) continue;
      t.text = rest;
    }
    dropNewline = t.type === 'start' && DROPS_LEADING_NEWLINE.has(t.name);
    switch (t.type) {
      case 'doctype':
        if (!sawElement) doc.doctype = true;
        break;
      case 'comment':
      case 'bogus':
        break;
      case 'text':
        append({ type: 'text', text: t.text });
        break;
      case 'raw':
        append({ type: 'raw', text: t.text });
        break;
      case 'start': {
        sawElement = true;
        // 兄弟になる要素（li の後の li など）と、head の外の要素が来たときの head は閉じる
        while (stack.length > 1 && closesTop(top().tag, t.name)) stack.pop();
        if (top().tag === 'head' && !IN_HEAD.has(t.name)) stack.pop();
        const el: ElementNode = { type: 'element', tag: t.name, attrs: t.attrs, children: [] };
        append(el);
        // 自己終了（`<div/>`）は HTML では開始タグ扱い（閉じない）。void だけが中身を持たない
        if (VOID.has(t.name)) break;
        if (stack.length > MAX_DEPTH) {
          // 深すぎる入れ子。この要素から先は読まない（開いている要素は閉じていない扱いで落ちる）
          doc.truncated = `深さ ${MAX_DEPTH} を超える入れ子`;
          break;
        }
        stack.push(el);
        break;
      }
      case 'end': {
        if (VOID.has(t.name)) break;
        let idx = -1;
        for (let k = stack.length - 1; k >= 1; k--) {
          if (stack[k]!.tag === t.name) {
            idx = k;
            break;
          }
        }
        if (idx < 0) break; // 対応する開始タグが無い終了タグは無視
        closeAbove(idx);
        stack.pop();
        break;
      }
      case 'eof-in':
        doc.truncated = t.what;
        // 途中で切れたタグ・コメントの外側の要素は、閉じていない扱い（html・body などは除く）
        break;
    }
  }
  closeAbove(0);
  doc.children = root.children;
  return doc;
}
