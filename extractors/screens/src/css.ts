/**
 * CSS の字句解析と消毒（CSS Syntax Level 3 に寄せた自前の実装。依存は足さない。D63）。
 *
 * 字句（エスケープを解いた値）から書き直す。元の文字列は写さない。
 * - `@import`・`@charset`・`@namespace`・知らない at-rule は落とす
 * - `url()`・`src()` は呼び出し側の判定（相対パス → 写した資産、data: の画像・フォント）を通ったものだけ残し、
 *   通らなければその宣言（at-rule の前置き・セレクタなら規則ごと）を落とす。`u\72l(` のようなエスケープは解いてから判定する
 * - `image-set()`・`-webkit-image-set()`・`image()`・`element()`・`expression()` を含む宣言、`behavior`・`-moz-binding` は落とす
 * - 書き出す CSS には `<` を含めない（`\3c `）。`<style>` の中で `</style` が作れないようにするため
 */

export type CssToken =
  | { t: 'ws' }
  | { t: 'ident'; v: string }
  | { t: 'function'; v: string }
  | { t: 'at'; v: string }
  | { t: 'hash'; v: string }
  | { t: 'string'; v: string }
  | { t: 'bad-string' }
  | { t: 'url'; v: string }
  | { t: 'bad-url' }
  | { t: 'delim'; v: string }
  | { t: 'number'; repr: string }
  | { t: 'percentage'; repr: string }
  | { t: 'dimension'; repr: string; unit: string }
  | { t: 'cdo' }
  | { t: 'cdc' }
  | { t: 'comment' }
  | { t: ':' }
  | { t: ';' }
  | { t: ',' }
  | { t: '[' }
  | { t: ']' }
  | { t: '(' }
  | { t: ')' }
  | { t: '{' }
  | { t: '}' };

const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';
const isHex = (c: string | undefined) => c !== undefined && /[0-9a-fA-F]/.test(c);
const isNameStart = (c: string | undefined) =>
  c !== undefined && (/[A-Za-z_]/.test(c) || c.charCodeAt(0) >= 0x80);
const isName = (c: string | undefined) => isNameStart(c) || isDigit(c) || c === '-';
const isWs = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n';
const isNonPrintable = (c: string | undefined) => {
  if (c === undefined) return false;
  const x = c.charCodeAt(0);
  return x <= 0x08 || x === 0x0b || (x >= 0x0e && x <= 0x1f) || x === 0x7f;
};

/** 字句に分ける（CSS Syntax §4。前処理: CR・FF → LF、NUL → U+FFFD） */
export function tokenizeCss(input: string): CssToken[] {
  const s = input.replace(/\r\n?|\f/g, '\n').replace(/\0/g, '\uFFFD');
  const n = s.length;
  const out: CssToken[] = [];
  let i = 0;

  const validEscape = (at: number) => s[at] === '\\' && s[at + 1] !== '\n' && at + 1 <= n;
  const startsIdent = (at: number) => {
    const c = s[at];
    if (c === '-') return isNameStart(s[at + 1]) || s[at + 1] === '-' || validEscape(at + 1);
    if (isNameStart(c)) return true;
    return c === '\\' && validEscape(at);
  };
  const startsNumber = (at: number) => {
    const c = s[at];
    if (c === '+' || c === '-')
      return isDigit(s[at + 1]) || (s[at + 1] === '.' && isDigit(s[at + 2]));
    if (c === '.') return isDigit(s[at + 1]);
    return isDigit(c);
  };
  /** `\` の次（i）からエスケープを 1 つ読む */
  const consumeEscape = (): string => {
    if (i >= n) return '\uFFFD';
    const c = s[i]!;
    if (isHex(c)) {
      let hex = '';
      while (hex.length < 6 && isHex(s[i])) hex += s[i++];
      if (isWs(s[i])) i++;
      const cp = parseInt(hex, 16);
      if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '\uFFFD';
      return String.fromCodePoint(cp);
    }
    i++;
    return c;
  };
  const consumeName = (): string => {
    let r = '';
    for (;;) {
      const c = s[i];
      if (isName(c)) {
        r += c;
        i++;
      } else if (c === '\\' && validEscape(i)) {
        i++;
        r += consumeEscape();
      } else return r;
    }
  };
  const consumeNumberRepr = (): string => {
    let r = '';
    if (s[i] === '+' || s[i] === '-') r += s[i++];
    while (isDigit(s[i])) r += s[i++];
    if (s[i] === '.' && isDigit(s[i + 1])) {
      r += s[i++];
      while (isDigit(s[i])) r += s[i++];
    }
    if (
      (s[i] === 'e' || s[i] === 'E') &&
      (isDigit(s[i + 1]) || ((s[i + 1] === '+' || s[i + 1] === '-') && isDigit(s[i + 2])))
    ) {
      r += s[i++];
      if (s[i] === '+' || s[i] === '-') r += s[i++];
      while (isDigit(s[i])) r += s[i++];
    }
    return r;
  };
  const consumeNumeric = (): CssToken => {
    const repr = consumeNumberRepr();
    if (startsIdent(i)) return { t: 'dimension', repr, unit: consumeName() };
    if (s[i] === '%') {
      i++;
      return { t: 'percentage', repr };
    }
    return { t: 'number', repr };
  };
  const consumeBadUrlRemnants = () => {
    while (i < n) {
      const c = s[i]!;
      if (c === ')') {
        i++;
        return;
      }
      if (c === '\\' && validEscape(i)) {
        i++;
        consumeEscape();
      } else i++;
    }
  };
  const consumeUrl = (): CssToken => {
    let v = '';
    while (isWs(s[i])) i++;
    for (;;) {
      if (i >= n) return { t: 'url', v };
      const c = s[i]!;
      if (c === ')') {
        i++;
        return { t: 'url', v };
      }
      if (isWs(c)) {
        while (isWs(s[i])) i++;
        if (s[i] === ')' || i >= n) {
          if (i < n) i++;
          return { t: 'url', v };
        }
        consumeBadUrlRemnants();
        return { t: 'bad-url' };
      }
      if (c === '"' || c === "'" || c === '(' || isNonPrintable(c)) {
        consumeBadUrlRemnants();
        return { t: 'bad-url' };
      }
      if (c === '\\') {
        if (validEscape(i)) {
          i++;
          v += consumeEscape();
          continue;
        }
        consumeBadUrlRemnants();
        return { t: 'bad-url' };
      }
      v += c;
      i++;
    }
  };
  const consumeIdentLike = (): CssToken => {
    const name = consumeName();
    if (name.toLowerCase() === 'url' && s[i] === '(') {
      i++;
      let j = i;
      while (isWs(s[j]) && isWs(s[j + 1])) j++;
      const q = isWs(s[j]) ? s[j + 1] : s[j];
      if (q === '"' || q === "'") {
        // url( の後が引用符なら関数（引数は文字列の字句）
        i = j;
        return { t: 'function', v: name };
      }
      return consumeUrl();
    }
    if (s[i] === '(') {
      i++;
      return { t: 'function', v: name };
    }
    return { t: 'ident', v: name };
  };
  const consumeString = (q: string): CssToken => {
    let v = '';
    for (;;) {
      if (i >= n) return { t: 'string', v };
      const c = s[i]!;
      if (c === q) {
        i++;
        return { t: 'string', v };
      }
      if (c === '\n') return { t: 'bad-string' };
      if (c === '\\') {
        if (i + 1 >= n) {
          i++;
          continue;
        }
        if (s[i + 1] === '\n') {
          i += 2;
          continue;
        }
        i++;
        v += consumeEscape();
        continue;
      }
      v += c;
      i++;
    }
  };

  while (i < n) {
    const c = s[i]!;
    if (c === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      out.push({ t: 'comment' });
      continue;
    }
    if (isWs(c)) {
      while (isWs(s[i])) i++;
      out.push({ t: 'ws' });
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      out.push(consumeString(c));
      continue;
    }
    if (c === '#') {
      if (isName(s[i + 1]) || validEscape(i + 1)) {
        i++;
        out.push({ t: 'hash', v: consumeName() });
      } else {
        i++;
        out.push({ t: 'delim', v: '#' });
      }
      continue;
    }
    if ('(),:;[]{}'.includes(c)) {
      i++;
      out.push({ t: c as '(' });
      continue;
    }
    if (c === '+' || c === '.') {
      if (startsNumber(i)) out.push(consumeNumeric());
      else {
        i++;
        out.push({ t: 'delim', v: c });
      }
      continue;
    }
    if (c === '-') {
      if (startsNumber(i)) out.push(consumeNumeric());
      else if (s[i + 1] === '-' && s[i + 2] === '>') {
        i += 3;
        out.push({ t: 'cdc' });
      } else if (startsIdent(i)) out.push(consumeIdentLike());
      else {
        i++;
        out.push({ t: 'delim', v: '-' });
      }
      continue;
    }
    if (c === '<') {
      if (s.startsWith('<!--', i)) {
        i += 4;
        out.push({ t: 'cdo' });
      } else {
        i++;
        out.push({ t: 'delim', v: '<' });
      }
      continue;
    }
    if (c === '@') {
      if (startsIdent(i + 1)) {
        i++;
        out.push({ t: 'at', v: consumeName() });
      } else {
        i++;
        out.push({ t: 'delim', v: '@' });
      }
      continue;
    }
    if (c === '\\') {
      if (validEscape(i)) out.push(consumeIdentLike());
      else {
        i++;
        out.push({ t: 'delim', v: '\\' });
      }
      continue;
    }
    if (isDigit(c)) {
      out.push(consumeNumeric());
      continue;
    }
    if (isNameStart(c)) {
      out.push(consumeIdentLike());
      continue;
    }
    i++;
    out.push({ t: 'delim', v: c });
  }
  return out;
}

// ─── 部品（ブロック・関数）に組む ───

type Leaf = Exclude<CssToken, { t: '{' | '}' | '(' | ')' | '[' | ']' | 'function' }>;
export type Component =
  | Leaf
  | { t: 'block'; open: '{' | '(' | '['; items: Component[] }
  | { t: 'func'; name: string; items: Component[] };

const CLOSE: Record<string, string> = { '{': '}', '(': ')', '[': ']' };

/** 括弧の入れ子の上限。超えた CSS は全部落とす（深い入れ子で再帰が溢れないように） */
export const MAX_CSS_DEPTH = 128;

class TooDeep extends Error {}

/** 字句を、対応する括弧のブロックと関数に組む（閉じていなければ入力の終わりで閉じる。CSS の仕様） */
export function toComponents(tokens: CssToken[]): Component[] {
  let i = 0;
  let depth = 0;
  const list = (close?: string): Component[] => {
    if (++depth > MAX_CSS_DEPTH) throw new TooDeep();
    const items: Component[] = [];
    while (i < tokens.length) {
      const tk = tokens[i++]!;
      if (close && tk.t === close) {
        depth--;
        return items;
      }
      if (tk.t === '{' || tk.t === '(' || tk.t === '[') {
        items.push({ t: 'block', open: tk.t, items: list(CLOSE[tk.t]) });
      } else if (tk.t === 'function') {
        items.push({ t: 'func', name: tk.v, items: list(')') });
      } else if (tk.t === '}' || tk.t === ')' || tk.t === ']') {
        // 対応しない閉じ括弧は区切り（delim）として残す。消毒では規則・宣言を壊すので、含む宣言ごと落ちる
        items.push({ t: 'delim', v: tk.t });
      } else items.push(tk);
    }
    depth--;
    return items;
  };
  return list();
}

/** toComponents。入れ子が深すぎれば undefined */
function components(css: string): Component[] | undefined {
  try {
    return toComponents(tokenizeCss(css));
  } catch (e) {
    if (e instanceof TooDeep) return undefined;
    throw e;
  }
}

// ─── 消毒 ───

/** URL の判定の結果。ok なら書き出す URL（写した資産への相対パスか data:）、ok でなければ落とす */
export type CssUrlResult = { ok: true; url: string } | { ok: false };

export interface CssSanitizeOptions {
  /** `url()` / `src()` の値（エスケープを解いた後）を判定する */
  url(raw: string): CssUrlResult;
}

export interface CssStats {
  /** 落とした @import */
  imports: number;
  /** image-set() などを含むので落とした宣言 */
  imageSets: number;
  /** URL が通らないので落とした宣言・規則（外部・危険・見つからない。数え分けは url() の呼び出し側） */
  urlDrops: number;
  /** 落とした at-rule（@import 以外）・規則・宣言（壊れた字句、behavior など） */
  other: number;
}

export const emptyCssStats = (): CssStats => ({ imports: 0, imageSets: 0, urlDrops: 0, other: 0 });

/** 中に条件付きの規則（規則のリスト）を持つ at-rule */
const GROUP_AT = new Set(['media', 'supports', 'layer', 'container', 'scope', 'starting-style']);
/** 中に宣言のリストを持つ at-rule */
const DECL_AT = new Set([
  'font-face',
  'page',
  'property',
  'counter-style',
  'font-palette-values',
  'view-transition',
  'position-try',
]);
const KEYFRAMES_AT = new Set(['keyframes', '-webkit-keyframes', '-moz-keyframes']);
/** 含む宣言を落とす関数（文字列を URL として読む・外の要素を描くもの・IE の式） */
const BLOCKED_FUNCTIONS = new Set([
  'image-set',
  '-webkit-image-set',
  'image',
  'element',
  '-moz-element',
  'expression',
]);
/** 落とす宣言（IE・古い Firefox でスクリプトを読むもの） */
const BLOCKED_PROPERTIES = new Set(['behavior', '-moz-binding', '-ms-behavior']);

class Drop extends Error {
  constructor(public readonly kind: keyof CssStats) {
    super(kind);
  }
}

/** スタイルシート（`<style>` の中身・CSS ファイル）を消毒する */
export function sanitizeStylesheet(
  css: string,
  opts: CssSanitizeOptions,
): { css: string; stats: CssStats } {
  const stats = emptyCssStats();
  const items = components(css);
  if (!items) return { css: '', stats: { ...stats, other: 1 } };
  return { css: ruleList(items, opts, stats, 'top').join('\n'), stats };
}

/** 宣言のリスト（`style` 属性）を消毒する */
export function sanitizeDeclarations(
  css: string,
  opts: CssSanitizeOptions,
): { css: string; stats: CssStats } {
  const stats = emptyCssStats();
  const items = components(css);
  if (!items) return { css: '', stats: { ...stats, other: 1 } };
  return { css: blockContents(items, opts, stats, false).join(';'), stats };
}

const isSkippable = (c: Component) =>
  c.t === 'ws' || c.t === 'comment' || c.t === 'cdo' || c.t === 'cdc';

/** 規則のリスト（トップレベル・@media の中・@keyframes の中） */
function ruleList(
  items: Component[],
  opts: CssSanitizeOptions,
  stats: CssStats,
  ctx: 'top' | 'group' | 'keyframes',
): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < items.length) {
    const c = items[i]!;
    if (isSkippable(c) || c.t === ';') {
      i++;
      continue;
    }
    if (c.t === 'at') {
      const { prelude, block, next } = collectAtRule(items, i + 1);
      i = next;
      const r = atRule(c.v, prelude, block, opts, stats);
      if (r !== undefined) out.push(r);
      continue;
    }
    // 規則: 前置き（セレクタ）は `{}` のブロックまで
    const prelude: Component[] = [];
    let block: Component[] | undefined;
    while (i < items.length) {
      const x = items[i++]!;
      if (x.t === 'block' && x.open === '{') {
        block = x.items;
        break;
      }
      prelude.push(x);
    }
    if (!block) {
      stats.other++;
      continue;
    }
    try {
      const sel = serialize(checkPrelude(prelude, opts, stats)).trim();
      if (!sel) throw new Drop('other');
      const body =
        ctx === 'keyframes'
          ? declarationsOnly(block, opts, stats)
          : blockContents(block, opts, stats, true);
      out.push(`${sel}{${body.join(';')}}`);
    } catch (e) {
      if (!(e instanceof Drop)) throw e;
      stats[e.kind]++;
    }
  }
  return out;
}

function collectAtRule(
  items: Component[],
  from: number,
): { prelude: Component[]; block?: Component[]; next: number } {
  const prelude: Component[] = [];
  let i = from;
  while (i < items.length) {
    const x = items[i++]!;
    if (x.t === ';') return { prelude, next: i };
    if (x.t === 'block' && x.open === '{') return { prelude, block: x.items, next: i };
    prelude.push(x);
  }
  return { prelude, next: i };
}

function atRule(
  rawName: string,
  prelude: Component[],
  block: Component[] | undefined,
  opts: CssSanitizeOptions,
  stats: CssStats,
  nested = false,
): string | undefined {
  const name = rawName.toLowerCase();
  if (name === 'import') {
    stats.imports++;
    return undefined;
  }
  if (name === 'charset' || name === 'namespace') return undefined;
  try {
    const head = `@${serializeIdent(name)}${serializePrelude(checkPrelude(prelude, opts, stats))}`;
    if (GROUP_AT.has(name)) {
      if (!block) {
        if (name === 'layer') return `${head};`;
        stats.other++;
        return undefined;
      }
      // スタイル規則の中の @media（入れ子）は、中が宣言と規則の混ざったもの
      const body = nested
        ? blockContents(block, opts, stats, true).join(';')
        : ruleList(block, opts, stats, 'group').join('\n');
      return `${head}{${body}}`;
    }
    if (DECL_AT.has(name) && block)
      return `${head}{${declarationsOnly(block, opts, stats).join(';')}}`;
    if (KEYFRAMES_AT.has(name) && block)
      return `${head}{${ruleList(block, opts, stats, 'keyframes').join('')}}`;
    stats.other++;
    return undefined;
  } catch (e) {
    if (!(e instanceof Drop)) throw e;
    stats[e.kind]++;
    return undefined;
  }
}

/** ブロックの中身（宣言と、入れ子の規則・at-rule）。allowRules が false なら規則は落とす（style 属性） */
function blockContents(
  items: Component[],
  opts: CssSanitizeOptions,
  stats: CssStats,
  allowRules: boolean,
): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < items.length) {
    const c = items[i]!;
    if (isSkippable(c) || c.t === ';') {
      i++;
      continue;
    }
    if (c.t === 'at') {
      const { prelude, block, next } = collectAtRule(items, i + 1);
      i = next;
      if (!allowRules) {
        stats.other++;
        continue;
      }
      const r = atRule(c.v, prelude, block, opts, stats, true);
      if (r !== undefined) out.push(r);
      continue;
    }
    const seg: Component[] = [];
    let block: Component[] | undefined;
    while (i < items.length) {
      const x = items[i]!;
      if (x.t === ';') {
        i++;
        break;
      }
      i++;
      if (x.t === 'block' && x.open === '{') {
        block = x.items;
        break;
      }
      seg.push(x);
    }
    try {
      if (block) {
        // 入れ子の規則（CSS Nesting）
        if (!allowRules) throw new Drop('other');
        const sel = serialize(checkPrelude(seg, opts, stats)).trim();
        if (!sel) throw new Drop('other');
        out.push(`${sel}{${blockContents(block, opts, stats, true).join(';')}}`);
      } else {
        const d = declaration(seg, opts, stats);
        if (d) out.push(d);
      }
    } catch (e) {
      if (!(e instanceof Drop)) throw e;
      stats[e.kind]++;
    }
  }
  return out;
}

/** 宣言だけのブロック（@font-face・@keyframes の各段）。規則・at-rule は落とす */
function declarationsOnly(items: Component[], opts: CssSanitizeOptions, stats: CssStats): string[] {
  const out: string[] = [];
  let seg: Component[] = [];
  const flush = () => {
    if (seg.some((x) => !isSkippable(x))) {
      try {
        const d = declaration(seg, opts, stats);
        if (d) out.push(d);
      } catch (e) {
        if (!(e instanceof Drop)) throw e;
        stats[e.kind]++;
      }
    }
    seg = [];
  };
  for (const x of items) {
    if (x.t === ';') flush();
    else if (x.t === 'at' || (x.t === 'block' && x.open === '{')) {
      // 宣言の中の at-rule・規則は扱わない（その段ごと落とす）
      seg.push({ t: 'bad-string' });
    } else seg.push(x);
  }
  flush();
  return out;
}

/** `名前: 値` を消毒して書き出す。形が違えば Drop */
function declaration(
  seg: Component[],
  opts: CssSanitizeOptions,
  stats: CssStats,
): string | undefined {
  let i = 0;
  while (i < seg.length && isSkippable(seg[i]!)) i++;
  const nameTok = seg[i];
  if (!nameTok || nameTok.t !== 'ident') throw new Drop('other');
  i++;
  while (i < seg.length && isSkippable(seg[i]!)) i++;
  if (seg[i]?.t !== ':') throw new Drop('other');
  i++;
  const prop = nameTok.v.startsWith('--') ? nameTok.v : nameTok.v.toLowerCase();
  if (BLOCKED_PROPERTIES.has(prop)) throw new Drop('other');
  const value = checkValue(seg.slice(i), opts, stats);
  const v = serialize(value).trim();
  if (!v && !prop.startsWith('--')) throw new Drop('other');
  return `${serializeIdent(prop)}:${v}`;
}

/** 値の部品を確かめ、url() を書き換えたものを返す。通らなければ Drop */
function checkValue(items: Component[], opts: CssSanitizeOptions, stats: CssStats): Component[] {
  return items.map((c) => checkComponent(c, opts, stats));
}

function checkComponent(c: Component, opts: CssSanitizeOptions, stats: CssStats): Component {
  switch (c.t) {
    case 'bad-string':
    case 'bad-url':
      throw new Drop('other');
    case 'cdo':
    case 'cdc':
      return { t: 'ws' };
    case 'delim':
      // `<`（`</style` を作れる）と `\`（改行の前の不正なエスケープ）、対応しない閉じ括弧は書き出せない
      if (c.v === '<' || c.v === '\\' || c.v === '}' || c.v === ')' || c.v === ']')
        throw new Drop('other');
      return c;
    case 'at':
    case 'block':
      if (c.t === 'at') throw new Drop('other');
      return { ...c, items: checkValue(c.items, opts, stats) };
    case 'url': {
      const r = opts.url(c.v);
      if (!r.ok) throw new Drop('urlDrops');
      return { t: 'url', v: r.url };
    }
    case 'func': {
      const name = c.name.toLowerCase();
      if (BLOCKED_FUNCTIONS.has(name)) throw new Drop('imageSets');
      if (name === 'url' || name === 'src') {
        // 引数は文字列 1 つだけ（`src(var(--x))` のように後で決まるものは判定できないので落とす）
        const args = c.items.filter((x) => !isSkippable(x));
        if (args.length !== 1 || args[0]!.t !== 'string') throw new Drop('urlDrops');
        const r = opts.url(args[0]!.v);
        if (!r.ok) throw new Drop('urlDrops');
        return { t: 'url', v: r.url };
      }
      return { ...c, items: checkValue(c.items, opts, stats) };
    }
    default:
      return c;
  }
}

/** セレクタ・at-rule の前置き。URL も関数の危ないものも置けない（あれば規則ごと落とす） */
function checkPrelude(items: Component[], opts: CssSanitizeOptions, stats: CssStats): Component[] {
  const walk = (list: Component[]) => {
    for (const c of list) {
      if (c.t === 'url') throw new Drop('urlDrops');
      if (c.t === 'func') {
        const name = c.name.toLowerCase();
        if (name === 'url' || name === 'src') throw new Drop('urlDrops');
        if (BLOCKED_FUNCTIONS.has(name)) throw new Drop('imageSets');
        walk(c.items);
      }
      if (c.t === 'block') walk(c.items);
    }
  };
  walk(items);
  return checkValue(items, opts, stats);
}

// ─── 書き出し ───

const hexEscape = (ch: string) => `\\${ch.codePointAt(0)!.toString(16)} `;

/** 識別子を書き出す（CSSOM の serialize an identifier。`<` は `\3c `） */
export function serializeIdent(v: string): string {
  let r = '';
  const chars = [...v];
  if (chars.length === 1 && chars[0] === '-') return '\\-';
  chars.forEach((ch, k) => {
    const x = ch.codePointAt(0)!;
    if (x === 0) r += '\uFFFD';
    else if ((x >= 1 && x <= 0x1f) || x === 0x7f) r += hexEscape(ch);
    else if (k === 0 && isDigit(ch)) r += hexEscape(ch);
    else if (k === 1 && isDigit(ch) && chars[0] === '-') r += hexEscape(ch);
    else if (ch === '<') r += hexEscape(ch);
    else if (x >= 0x80 || /[A-Za-z0-9_-]/.test(ch)) r += ch;
    else r += `\\${ch}`;
  });
  return r;
}

/** hash の名前（先頭の数字は許される） */
function serializeName(v: string): string {
  let r = '';
  for (const ch of v) {
    const x = ch.codePointAt(0)!;
    if (x === 0) r += '\uFFFD';
    else if ((x >= 1 && x <= 0x1f) || x === 0x7f || ch === '<') r += hexEscape(ch);
    else if (x >= 0x80 || /[A-Za-z0-9_-]/.test(ch)) r += ch;
    else r += `\\${ch}`;
  }
  return r;
}

/** 文字列を `"…"` で書き出す（`"` `\` 改行・制御文字・`<` はエスケープ） */
export function serializeString(v: string): string {
  let r = '"';
  for (const ch of v) {
    const x = ch.codePointAt(0)!;
    if (x === 0) r += '\uFFFD';
    else if ((x >= 1 && x <= 0x1f) || x === 0x7f || ch === '<') r += hexEscape(ch);
    else if (ch === '"' || ch === '\\') r += `\\${ch}`;
    else r += ch;
  }
  return `${r}"`;
}

/** 単位: `e3` のように数字の指数に読めるものは先頭をエスケープする */
function serializeUnit(unit: string): string {
  const u = serializeIdent(unit);
  return /^[eE][+-]?\d/.test(unit) ? hexEscape(unit[0]!) + u.slice(1) : u;
}

function serializePrelude(items: Component[]): string {
  const s = serialize(items).trim();
  return s ? ` ${s}` : '';
}

export function serialize(items: Component[]): string {
  let r = '';
  for (const c of items) r += serializeOne(c);
  return r;
}

function serializeOne(c: Component): string {
  switch (c.t) {
    case 'ws':
      return ' ';
    case 'comment':
      // 字句の境目を保つ（`a/**/b` を `ab` にしない）
      return '/**/';
    case 'ident':
      return serializeIdent(c.v);
    case 'at':
      return `@${serializeIdent(c.v)}`;
    case 'hash':
      return `#${serializeName(c.v)}`;
    case 'string':
      return serializeString(c.v);
    case 'url':
      return `url(${serializeString(c.v)})`;
    case 'number':
      return c.repr;
    case 'percentage':
      return `${c.repr}%`;
    case 'dimension':
      return c.repr + serializeUnit(c.unit);
    case 'delim':
      return c.v === '<' ? '' : c.v;
    case ':':
    case ';':
    case ',':
      return c.t;
    case 'block':
      return c.open + serialize(c.items) + CLOSE[c.open];
    case 'func':
      return `${serializeIdent(c.name)}(${serialize(c.items)})`;
    case 'cdo':
    case 'cdc':
    case 'bad-string':
    case 'bad-url':
      return '';
  }
}
