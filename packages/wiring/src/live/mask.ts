/**
 * 通信の中身・パス・問い合わせの文字列を、値を伏せた形にする（docs/27 §5.3、D233）。道具の側で掛けてから、ライブの画面へ渡す。
 * 見るのは、通信の上の形だけ（内容の種類と、中身の文字）。対象の作りは問わない
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
  /** パスの 1 つの部分が、これより長ければ、値とみなして伏せる */
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

const unique = (names: Iterable<string>): string[] =>
  [...new Set([...names].map((n) => clip(n, MASK_LIMITS.name)))].slice(0, MASK_LIMITS.keys);

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

  if (text !== undefined && /[/+]json$/.test(type)) {
    try {
      return withValue({ kind: 'tree', shape: shapeOf(JSON.parse(text) as unknown, 0) });
    } catch {
      // 種類はキーと値の形だが、読めない中身。種類と大きさだけを出す
    }
  } else if (text !== undefined && type === 'application/x-www-form-urlencoded') {
    return withValue({ kind: 'form', keys: unique(new URLSearchParams(text).keys()) });
  } else if (text !== undefined && type === 'multipart/form-data') {
    // 欄の名前だけを拾う。ファイルの中身が入りうるので、値は付けない
    const names = [...text.matchAll(/\bname="([^"\r\n]*)"/g)].map((m) => m[1]!);
    return { kind: 'form', keys: unique(names) };
  }
  const other: MaskedBody = { kind: 'other', type, bytes };
  return /^text\/|[/+](json|xml)$/.test(type) ? withValue(other) : other;
}

/**
 * パスの、値に見える部分（数字を含む・長い）を伏せる。図の受け口と合った通信は、こちらではなく、図の書き方を出す
 */
export function maskPath(pathname: string): string {
  const masked = (pathname.split(/[?#]/)[0] ?? '')
    .split('/')
    .map((s) => (s !== '' && (/\d/.test(s) || s.length > MASK_LIMITS.segment) ? MASKED : s))
    .join('/');
  return clip(masked, MASK_LIMITS.path);
}

/** 問い合わせの文字列の、キーの名前（重複なし） */
export function queryKeys(search: string): string[] {
  return unique(new URLSearchParams(search.replace(/^\?/, '')).keys());
}
