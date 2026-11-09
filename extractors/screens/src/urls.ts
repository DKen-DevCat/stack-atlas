/**
 * URL の判定（docs/18 §3.3）。値は文字参照・CSS のエスケープを解いた後のもの。
 *
 * 1. 前後の空白と C0 制御文字を落とし、途中のタブ・改行を消す（URL の仕様と同じ）。途中にほかの制御文字があれば危険
 * 2. `\` は `/` として読む（`/\evil.example` は `//evil.example`）
 * 3. scheme（`[a-z][a-z0-9+.-]*:`）があれば: data: は画像・フォントの種類だけ通し、http(s) などは外部、それ以外は危険
 * 4. `//` で始まれば外部（scheme を省いた URL）
 * 5. 残りは相対（`/a`・`a/b`・`?q`・`#f`）
 */

export type UrlClass =
  | { type: 'empty' }
  | { type: 'fragment'; value: string }
  | { type: 'relative'; value: string }
  | { type: 'data'; value: string; mime: string }
  | { type: 'external'; value: string }
  | { type: 'unsafe'; value: string };

/** 外部（ブラウザが外へ出る・別のアプリを開く）とみなす scheme。それ以外の scheme は危険 */
const EXTERNAL_SCHEMES = new Set(['http', 'https', 'ftp', 'ws', 'wss', 'mailto', 'tel', 'sms']);

export const IMAGE_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/svg+xml',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/bmp',
]);

export const FONT_MIME = new Set([
  'font/woff',
  'font/woff2',
  'font/ttf',
  'font/otf',
  'font/sfnt',
  'font/collection',
  'application/font-woff',
  'application/font-woff2',
  'application/x-font-woff',
  'application/x-font-ttf',
  'application/x-font-otf',
  'application/x-font-opentype',
  'application/font-sfnt',
  'application/vnd.ms-fontobject',
]);

/** C0 制御文字か空白（U+0000〜U+0020。URL の仕様で前後から外すもの） */
const isC0OrSpace = (code: number) => code <= 0x20;

/**
 * 前後の C0 制御文字と空白を外す。ループで端から数える（2026-11-09（8-3b のレビュー）: 正規表現の
 * `/^[\u0000- ]+|[\u0000- ]+$/g` は途中の空白の並びの位置ごとに末尾まで試して 2 乗だった。空白 40k で 3.7 秒）
 */
export function trimC0(raw: string): string {
  let a = 0;
  let b = raw.length;
  while (a < b && isC0OrSpace(raw.charCodeAt(a))) a++;
  while (b > a && isC0OrSpace(raw.charCodeAt(b - 1))) b--;
  return raw.slice(a, b);
}

/** 判定の前の正規化（前後の空白・C0 を落とし、タブ・改行を消し、`\` を `/` にする）。危険な制御文字があれば undefined */
export function normalizeUrl(raw: string): string | undefined {
  let v = trimC0(raw).replace(/[\t\n\r]/g, '');
  // eslint-disable-next-line no-control-regex -- 途中に残った制御文字は危険とみなす
  if (/[\u0000-\u001f\u007f]/.test(v)) return undefined;
  v = v.replace(/\\/g, '/');
  return v;
}

export function classifyUrl(raw: string): UrlClass {
  const v = normalizeUrl(raw);
  if (v === undefined) return { type: 'unsafe', value: raw };
  if (v === '') return { type: 'empty' };
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(v)?.[1]?.toLowerCase();
  if (scheme !== undefined) {
    if (scheme === 'data') {
      const comma = v.indexOf(',');
      const mime = (comma < 0 ? '' : v.slice(5, comma))
        .split(';')[0]!
        .replace(/\s+/g, '')
        .toLowerCase();
      return comma < 0 ? { type: 'unsafe', value: v } : { type: 'data', value: v, mime };
    }
    return EXTERNAL_SCHEMES.has(scheme)
      ? { type: 'external', value: v }
      : { type: 'unsafe', value: v };
  }
  if (v.startsWith('//')) return { type: 'external', value: v };
  if (v.startsWith('#')) return { type: 'fragment', value: v };
  return { type: 'relative', value: v };
}

/** data: URL が画像（kind image）・フォント（font）・どちらか（image-or-font）として通るか */
export function dataAllowed(mime: string, kind: 'image' | 'font' | 'image-or-font'): boolean {
  if (kind === 'image') return IMAGE_MIME.has(mime);
  if (kind === 'font') return FONT_MIME.has(mime);
  return IMAGE_MIME.has(mime) || FONT_MIME.has(mime);
}

export interface SrcsetCandidate {
  url: string;
  descriptor?: string;
}

/** srcset を候補に分ける（HTML の仕様の手順を簡略化。URL の中のカンマは残し、末尾のカンマで区切る） */
export function parseSrcset(value: string): SrcsetCandidate[] {
  const out: SrcsetCandidate[] = [];
  const s = value;
  const n = s.length;
  let i = 0;
  const isWs = (c: string | undefined) => c !== undefined && /[\t\n\f\r ]/.test(c);
  for (;;) {
    while (i < n && (isWs(s[i]) || s[i] === ',')) i++;
    if (i >= n) return out;
    let j = i;
    while (j < n && !isWs(s[j])) j++;
    let url = s.slice(i, j);
    i = j;
    let descriptor = '';
    if (url.endsWith(',')) {
      // 末尾のカンマを端から数えて外す（`/,+$/` は途中のカンマの並びで 2 乗だった。8-3b のレビュー）
      let e = url.length;
      while (e > 0 && url.charCodeAt(e - 1) === 0x2c) e--;
      url = url.slice(0, e);
    } else {
      // 記述子: カンマ（括弧の外）まで
      let depth = 0;
      let d = '';
      while (i < n) {
        const c = s[i]!;
        if (c === '(') depth++;
        if (c === ')') depth = Math.max(0, depth - 1);
        if (c === ',' && depth === 0) {
          i++;
          break;
        }
        d += c;
        i++;
      }
      descriptor = d.trim();
    }
    out.push(descriptor ? { url, descriptor } : { url });
  }
}

/** 記述子として書き出してよいもの（`1x` `1.5x` `640w` `2h` の並び） */
export function validDescriptor(d: string): boolean {
  return d.split(/\s+/).every((p) => /^\d+(\.\d+)?x$|^\d+w$|^\d+h$/.test(p));
}
