/**
 * 資産（CSS・フォント・画像）の写し（docs/18 §3.3）。
 *
 * - 写すのは同じ出所の参照だけ: 相対パスと `/` で始まるパス（basePath・assetPrefix を外す）、assetPrefix が URL ならその URL の下
 * - 読む元は export のディレクトリと public のディレクトリ（realpath）の中だけ。シンボリックリンクは辿らない（fsafe.ts）
 * - 拡張子は許可リスト: CSS は `<link rel=stylesheet>` だけ、画像は img・srcset・poster・background・CSS の url()、
 *   フォントは CSS の url()
 * - SVG はファイルとして写さず、参照している所（画像として読む所だけ）に `data:image/svg+xml;base64,…` で埋め込む
 *   （上限 256 KB。超えたら写さずに oversized に数える）。ファイルの SVG は、応答ヘッダの無い配信（素の S3 など）で
 *   タブで直接開くと中の script がビューアと同じ origin で動きうる。画像として読む SVG は script を動かさない
 * - 書き出す名前は内容のハッシュ（`screens/_assets/<hash>.<ext>`）。CSS は消毒（css.ts）してから中の url() を写した名前に書き換え、
 *   書き換えた後の内容でハッシュを取る。書き出す拡張子は WRITTEN_EXT だけ（svg は無い）
 */
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { sanitizeStylesheet } from './css.js';
import { findSiteFile, readNoFollowResult, type SafeOutput } from './fsafe.js';
import { emptyStats, type SanitizeStats, type UrlKind, type UrlVerdict } from './sanitize.js';
import { classifyUrl, dataAllowed } from './urls.js';

export type AssetKind = Exclude<UrlKind, 'link'>;

/** ファイルとして写す画像（svg は入れない。INLINE_EXT） */
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico'];
const FONT_EXT = ['woff', 'woff2', 'ttf', 'otf'];
/** ファイルにせず data: URL で埋め込む画像（拡張子 → MIME） */
export const INLINE_EXT: ReadonlyMap<string, string> = new Map([['svg', 'image/svg+xml']]);
/** 参照の種類ごとに読んでよい拡張子 */
export const ASSET_EXT: Record<AssetKind, ReadonlySet<string>> = {
  style: new Set(['css']),
  image: new Set([...IMAGE_EXT, ...INLINE_EXT.keys()]),
  font: new Set(FONT_EXT),
  'image-or-font': new Set([...IMAGE_EXT, ...INLINE_EXT.keys(), ...FONT_EXT]),
};
/** `_assets/` にファイルとして書き出してよい拡張子（svg は無い） */
export const WRITTEN_EXT: ReadonlySet<string> = new Set(['css', ...IMAGE_EXT, ...FONT_EXT]);

export const ASSETS_DIR = '_assets';
/** 大きさの上限（バイト）。svg は data: URL にして参照ごとに埋め込むので小さく */
export const DEFAULT_LIMITS = { css: 5 * 1024 * 1024, asset: 20 * 1024 * 1024, svg: 256 * 1024 };

/**
 * URL の相対パス（判定済み。scheme も `//` も無い。`\` は `/` にしてある）→ サイトの中のパス（`a/b.css`）。
 * `/` で始まるものは prefixes（basePath・assetPrefix のパス）の最初に合ったものを外す。
 * 相対のものは docDir（文書のディレクトリ）から。`%xx` は段ごとに解き、`..` で根の上に出る・壊れたエンコード・
 * 段の中の `/` `\` NUL は undefined
 */
export function toSitePath(
  value: string,
  docDir: string,
  prefixes: readonly string[] = [],
): string | undefined {
  let path = value.split(/[?#]/)[0]!;
  let segs: string[];
  if (path.startsWith('/')) {
    for (const p of [...prefixes].filter(Boolean).sort((a, b) => b.length - a.length)) {
      if (path === p || path.startsWith(`${p}/`)) {
        path = path.slice(p.length) || '/';
        break;
      }
    }
    segs = path.split('/');
  } else {
    segs = [...(docDir ? docDir.split('/') : []), ...path.split('/')];
  }
  const out: string[] = [];
  for (const raw of segs) {
    let seg: string;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      return undefined;
    }
    if (/[/\\\0]/.test(seg)) return undefined;
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (!out.length) return undefined;
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.length ? out.join('/') : undefined;
}

/** basePath・assetPrefix（next.config）を正規化する: 末尾の `/` を外す。assetPrefix は URL（`https://` `//`）かパス */
export function normalizePrefix(p: string | undefined): string | undefined {
  if (!p) return undefined;
  const v = p.replace(/\/+$/, '');
  return v || undefined;
}

export interface AssetStoreOptions {
  /** 読む元（realpath 済み。先にあるほうを優先）: export のディレクトリ、public のディレクトリ */
  roots: string[];
  out: SafeOutput;
  /** 書き出し先の中のディレクトリ（既定 `screens`） */
  dir?: string;
  basePath?: string;
  assetPrefix?: string;
  limits?: Partial<typeof DEFAULT_LIMITS>;
}

/** 写した資産: ファイルの名前（`_assets/` の中）か、埋め込む data: URL */
type Copied = { name: string } | { dataUrl: string };

/** 写した資産の名前と数。同じファイルは 1 回だけ写す */
export class AssetStore {
  private readonly copied = new Map<string, Copied | null>();
  private readonly prefixes: string[];
  private readonly urlPrefix?: string;
  private readonly limits: typeof DEFAULT_LIMITS;
  /** 写したファイルの数（重複なし） */
  written = 0;
  /** data: URL にした SVG の数（ファイルごとに 1 つ） */
  inlined = 0;
  /** 写した CSS ファイル（サイトの中のパス → 書き出した名前と、消毒で落としたものの数）。issues.json にファイルごとに出す */
  readonly cssFiles = new Map<string, { name: string; stats: SanitizeStats }>();
  /** data: URL の上限を超えたので写さなかった SVG（サイトの中のパス → バイト数）。issues.json に出す */
  readonly oversized = new Map<string, number>();

  constructor(private readonly opts: AssetStoreOptions) {
    const base = normalizePrefix(opts.basePath);
    const asset = normalizePrefix(opts.assetPrefix);
    this.prefixes = [
      base,
      asset && asset.startsWith('/') && !asset.startsWith('//') ? asset : undefined,
    ].filter((x): x is string => !!x);
    if (asset && !this.prefixes.includes(asset)) this.urlPrefix = asset;
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits };
  }

  /**
   * URL を判定する（docSitePath は参照している文書のサイトの中のパス。refPrefix は書き出す参照の前に付けるもの:
   * 画面の HTML からは `../_assets/`、写した CSS からは ``）
   */
  verdict(raw: string, kind: UrlKind, docSitePath: string, refPrefix: string): UrlVerdict {
    let c = classifyUrl(raw);
    // assetPrefix が URL（https://cdn… や //cdn…）なら、その下は同じ出所の `/` で始まるパスとして読む
    if (c.type === 'external' && this.urlPrefix) {
      const v = c.value;
      const p = this.urlPrefix;
      if (
        v.toLowerCase().startsWith(p.toLowerCase()) &&
        (v.length === p.length || /[/?#]/.test(v[p.length]!))
      ) {
        const rest = v.slice(p.length);
        c = classifyUrl(rest.startsWith('/') ? rest : `/${rest}`);
      }
    }
    switch (c.type) {
      case 'empty':
        return { ok: false, why: 'empty' };
      case 'unsafe':
        return { ok: false, why: 'unsafe' };
      case 'external':
        return { ok: false, why: 'external' };
      case 'data':
        return kind !== 'link' && kind !== 'style' && dataAllowed(c.mime, kind)
          ? { ok: true, url: c.value }
          : { ok: false, why: 'unsafe' };
      case 'fragment':
        // CSS の url(#id)（同じ文書の SVG のフィルタなど）とリンクの #id は読み込まない
        return kind === 'link' || kind === 'image-or-font'
          ? { ok: true, url: c.value }
          : { ok: false, why: 'missing' };
      case 'relative': {
        if (kind === 'link') return { ok: true, url: c.value };
        const copied = this.copy(c.value, kind, docSitePath);
        if (!copied) return { ok: false, why: 'missing' };
        const fragment = kind === 'style' ? '' : (/#[A-Za-z0-9_.:-]*$/.exec(c.value)?.[0] ?? '');
        const url = 'dataUrl' in copied ? copied.dataUrl : `${refPrefix}${copied.name}`;
        return { ok: true, url: `${url}${fragment}` };
      }
    }
  }

  /** 相対 URL の先のファイルを写す。写せなければ undefined */
  private copy(value: string, kind: AssetKind, docSitePath: string): Copied | undefined {
    const sitePath = toSitePath(
      value,
      posix.dirname(docSitePath).replace(/^\.$/, ''),
      this.prefixes,
    );
    if (!sitePath) return undefined;
    const ext = posix.extname(sitePath).slice(1).toLowerCase();
    if (!ASSET_EXT[kind].has(ext)) return undefined;
    const found = findSiteFile(this.opts.roots, sitePath);
    if (!('file' in found)) return undefined;
    const key = `${found.file}\0${ext === 'css' ? 'css' : 'bin'}`;
    const hit = this.copied.get(key);
    if (hit !== undefined) return hit ?? undefined;
    this.copied.set(key, null); // 読みかけ（CSS の中から自分を参照しても回らない）
    const mime = INLINE_EXT.get(ext);
    const read = readNoFollowResult(
      found.file,
      ext === 'css' ? this.limits.css : mime ? this.limits.svg : this.limits.asset,
    );
    if (!('data' in read)) {
      if (mime && read.why === 'too-large') this.oversized.set(sitePath, read.size);
      return undefined;
    }
    const buf = read.data;
    let result: Copied;
    if (mime) {
      // ファイルにしない（直接開ける SVG を出力先に置かない）。画像として読む所にだけ埋め込む
      result = { dataUrl: `data:${mime};base64,${buf.toString('base64')}` };
      this.inlined++;
    } else if (ext === 'css') {
      const stats = emptyStats();
      const css = sanitizeStylesheet(buf.toString('utf8'), {
        url: (raw) => {
          const v = this.verdict(raw, 'image-or-font', sitePath, '');
          if (v.ok) return { ok: true, url: v.url };
          if (v.why === 'external') stats.external++;
          else if (v.why === 'unsafe') stats.unsafe++;
          else if (v.why === 'missing') stats.missing++;
          return { ok: false };
        },
      });
      stats.css = css.stats;
      const data = `${css.css}\n`;
      const name = `${hash(data)}.css`;
      result = { name };
      this.write(name, data);
      this.cssFiles.set(sitePath, { name, stats });
    } else {
      const name = `${hash(buf)}.${ext}`;
      result = { name };
      this.write(name, buf);
    }
    this.copied.set(key, result);
    return result;
  }

  private readonly names = new Set<string>();
  private write(name: string, data: string | Buffer) {
    const ext = posix.extname(name).slice(1);
    if (!WRITTEN_EXT.has(ext)) throw new Error(`_assets/ に書かない拡張子です: ${name}`);
    if (this.names.has(name)) return;
    this.names.add(name);
    this.opts.out.write([this.opts.dir ?? 'screens', ASSETS_DIR, name], data);
    this.written++;
  }
}

function hash(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex').slice(0, 20);
}
