/**
 * 通信の中身・パス・問い合わせの文字列を、値を伏せた形にする（docs/27 §5.3、D233）。道具の側で掛けてから、ライブの画面へ渡す。
 * 見るのは、通信の上の形だけ（内容の種類と、中身の文字）。対象の作りは問わない。
 *
 * 決まり: **名前として出すのは、名前だと分かるものだけ。** 名前か値か分からないもの（`=` の無い欄・名前らしくない字を含むもの）は、
 * 伏せた印にする。値を、名前と取り違えて出さないため
 */
import type { LiveShape, MaskedBody } from './events.js';

export const MASK_LIMITS = {
  /** 1 つの入れ物から出す、キーの名前の数 */
  keys: 20,
  /** キーの名前・種類の名前の長さ */
  name: 60,
  /** 入れ子の深さ */
  depth: 6,
  /** 「値を見る」で渡す値の長さ */
  value: 4000,
  /** パスの長さ */
  path: 200,
  /** パスの 1 つの部分・値の無い欄の名前が、これより長ければ、値とみなして伏せる */
  segment: 24,
} as const;

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}…` : s);
/** 伏せた所に出す印 */
export const MASKED = '…';

function shapeOf(v: unknown, depth: number): LiveShape {
  if (v === null) return { t: 'null' };
  if (typeof v === 'string') return { t: 'string' };
  if (typeof v === 'number') return { t: 'number' };
  if (typeof v === 'boolean') return { t: 'boolean' };
  if (Array.isArray(v)) {
    const shape: LiveShape = { t: 'array', length: v.length };
    if (v.length > 0 && depth < MASK_LIMITS.depth) shape.item = shapeOf(v[0], depth + 1);
    return shape;
  }
  const entries = Object.entries(v as Record<string, unknown>);
  if (depth >= MASK_LIMITS.depth) return { t: 'object', keys: [], more: entries.length };
  const shape: LiveShape = {
    t: 'object',
    keys: entries
      .slice(0, MASK_LIMITS.keys)
      .map(([k, x]) => [clip(k, MASK_LIMITS.name), shapeOf(x, depth + 1)]),
  };
  if (entries.length > MASK_LIMITS.keys) shape.more = entries.length - MASK_LIMITS.keys;
  return shape;
}

/** キーと値の形の文字なら、その形。読めなければ undefined */
function treeOf(text: string): LiveShape | undefined {
  try {
    return shapeOf(JSON.parse(text) as unknown, 0);
  } catch {
    return undefined;
  }
}

/** 欄の名前らしい形（文字・数字と、名前によく使う記号だけ） */
const NAME = /^[\w$.\-[\]:]+$/;
/** 値に見える形: 数字を含む・長い・大文字と小文字が混ざる（値の無い欄が、名前なのか、値なのかを決めるのに使う） */
const looksLikeValue = (s: string): boolean =>
  /\d/.test(s) || s.length > MASK_LIMITS.segment || (/[a-z]/.test(s) && /[A-Z]/.test(s));

/** 名前の列を、重複なし・数の上限つきにする。伏せたものがあれば、印を 1 つ足す */
function nameList(names: readonly string[], hidden: boolean): string[] {
  const out = [...new Set(names)].slice(0, MASK_LIMITS.keys);
  if (hidden) out.push(MASKED);
  return out;
}

/**
 * 名前と値の並び（`a=1&b=2`）から、名前だけを拾う。次のものは、名前として出さない（伏せた印にまとめる）:
 * `=` の無い欄・名前らしくない字を含むもの・長すぎるもの・値が無くて、値に見えるもの（符号のうしろに `=` が付いた形）
 */
function fieldNames(text: string): string[] {
  const names: string[] = [];
  let hidden = false;
  for (const field of text.split('&')) {
    if (field === '') continue;
    const eq = field.indexOf('=');
    let name = eq < 0 ? '' : field.slice(0, eq).replace(/\+/g, ' ');
    try {
      name = decodeURIComponent(name);
    } catch {
      name = '';
    }
    const empty = eq >= 0 && /^=*$/.test(field.slice(eq + 1));
    if (!NAME.test(name) || name.length > MASK_LIMITS.name || (empty && looksLikeValue(name)))
      hidden = true;
    else names.push(name);
  }
  return nameList(names, hidden);
}

/**
 * ファイルを運ぶ形の中身から、欄の名前を拾う。読むのは、区切りの行のすぐあとの見出しの塊だけ
 * （欄の値や、ファイルの中身は読まない）。区切りが分からなければ undefined
 */
function partNames(contentType: string, text: string): string[] | undefined {
  const m = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = m?.[1] ?? m?.[2];
  if (!boundary) return undefined;
  const names: string[] = [];
  let hidden = false;
  for (const part of text.split(`--${boundary}`).slice(1)) {
    if (part.startsWith('--')) break; // 終わりの印
    const head = part.split(/\r?\n\r?\n/, 1)[0] ?? '';
    const line = head.split(/\r?\n/).find((l) => /^\s*content-disposition\s*:/i.test(l));
    const name = line === undefined ? undefined : /[;\s]name="([^"]*)"/i.exec(line)?.[1];
    if (name !== undefined && NAME.test(name) && name.length <= MASK_LIMITS.name) names.push(name);
    else hidden = true;
  }
  return nameList(names, hidden);
}

/** 内容の種類から、`種類/細かい種類` だけを取り出す（うしろの付け足しは捨てる）。読めなければ unknown */
function mediaType(contentType: string | undefined): string {
  const type = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  return /^[\w.+-]+\/[\w.+-]+$/.test(type) && type.length <= MASK_LIMITS.name ? type : 'unknown';
}

/**
 * 通信の中身を、値を伏せた形にする。中身が無ければ undefined。
 * @param text 中身を文字として読めたとき、その文字（読めなかった・読まなかったときは undefined）
 * @param bytes 中身の大きさ
 * @param reveal 「値を見る」が入っているとき true。ファイルを運ぶ形の中身は、入っていても値を付けない
 */
export function maskBody(
  contentType: string | undefined,
  text: string | undefined,
  bytes: number,
  reveal = false,
): MaskedBody | undefined {
  if (bytes <= 0 && !text) return undefined;
  const type = mediaType(contentType);
  const value = reveal && text !== undefined ? clip(text, MASK_LIMITS.value) : undefined;
  const withValue = <T extends MaskedBody>(body: T): T =>
    value === undefined ? body : { ...body, value };

  if (text !== undefined) {
    const form = type === 'application/x-www-form-urlencoded';
    // キーと値の形の文字を、フォームの種類で送る通信がある。中身の形を先に見る
    if (/[/+]json$/.test(type) || (form && /^\s*[{[]/.test(text))) {
      const shape = treeOf(text);
      if (shape) return withValue({ kind: 'tree', shape });
    }
    if (form) return withValue({ kind: 'form', keys: fieldNames(text) });
    if (type === 'multipart/form-data') {
      // ファイルの中身が入りうるので、値は付けない
      const keys = partNames(contentType ?? '', text);
      if (keys) return { kind: 'form', keys };
      return { kind: 'other', type, bytes };
    }
  }
  const other: MaskedBody = { kind: 'other', type, bytes };
  return /^text\/|[/+](json|xml)$/.test(type) || type === 'application/x-www-form-urlencoded'
    ? withValue(other)
    : other;
}

/**
 * パスの、値に見える部分を伏せる。残すのは、英字と `. _ ~ -` だけの、短い部分（数字・符号化された字・長いものは伏せる）。
 * 図の受け口と合った通信は、こちらではなく、図の書き方を出す。
 * @param pathname アドレスのパスの部分だけ（符号化されたまま。接続先の名前や、問い合わせの文字列は渡さない）
 */
export function maskPath(pathname: string): string {
  const keep = new RegExp(`^[A-Za-z._~-]{1,${MASK_LIMITS.segment}}$`);
  const masked = (pathname.split(/[?#]/)[0] ?? '')
    .split('/')
    .map((s) => (s === '' || keep.test(s) ? s : MASKED))
    .join('/');
  return clip(masked, MASK_LIMITS.path);
}

/**
 * 問い合わせの文字列の、キーの名前（重複なし）。名前だと分からないものは、伏せた印にまとめる
 * @param search アドレスの `?` より後ろ（`?` が付いていてもよい）
 */
export function queryKeys(search: string): string[] {
  const at = search.indexOf('?');
  return fieldNames((at < 0 ? search : search.slice(at + 1)).split('#')[0] ?? '');
}
