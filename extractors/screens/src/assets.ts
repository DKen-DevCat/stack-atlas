/**
 * 資産（CSS・フォント・画像）の写し（docs/18 §3.3）。
 *
 * - 写すのは同じ出所の参照だけ: 相対パスと `/` で始まるパス（basePath・assetPrefix を外す）、assetPrefix が URL ならその URL の下
 * - 読む元は export のディレクトリと public のディレクトリ（realpath）の中だけ。シンボリックリンクは辿らない（fsafe.ts）
 * - 拡張子は許可リスト: CSS は `<link rel=stylesheet>` だけ、画像は img・srcset・poster・background・CSS の url()、
 *   フォントは CSS の url()。SVG はファイルとして写すが、参照は img と CSS からだけ（埋め込まない）
 * - 書き出す名前は内容のハッシュ（`screens/_assets/<hash>.<ext>`）。CSS は消毒（css.ts）してから中の url() を写した名前に書き換え、
 *   書き換えた後の内容でハッシュを取る
 */
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { sanitizeStylesheet } from './css.js';
import { findSiteFile, readNoFollow, type SafeOutput } from './fsafe.js';
import { emptyStats, type SanitizeStats, type UrlKind, type UrlVerdict } from './sanitize.js';
import { classifyUrl, dataAllowed } from './urls.js';

export type AssetKind = Exclude<UrlKind, 'link'>;

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico'];
const FONT_EXT = ['woff', 'woff2', 'ttf', 'otf'];
export const ASSET_EXT: Record<AssetKind, ReadonlySet<string>> = {
  style: new Set(['css']),
  image: new Set(IMAGE_EXT),
  font: new Set(FONT_EXT),
  'image-or-font': new Set([...IMAGE_EXT, ...FONT_EXT]),
};

export const ASSETS_DIR = '_assets';
export const DEFAULT_LIMITS = { css: 5 * 1024 * 1024, asset: 20 * 1024 * 1024 };

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
  limits?: { css: number; asset: number };
}

interface Copied {
  name: string;
  /** CSS ファイルを消毒したときの数 */
  stats?: SanitizeStats;
}

/** 写した資産の名前と数。同じファイルは 1 回だけ写す */
export class AssetStore {
  private readonly copied = new Map<string, Copied | null>();
  private readonly prefixes: string[];
  private readonly urlPrefix?: string;
  private readonly limits: { css: number; asset: number };
  /** 写したファイルの数（重複なし） */
  written = 0;
  /** 写した CSS ファイル（サイトの中のパス → 書き出した名前と、消毒で落としたものの数）。issues.json にファイルごとに出す */
  readonly cssFiles = new Map<string, { name: string; stats: SanitizeStats }>();

  constructor(private readonly opts: AssetStoreOptions) {
    const base = normalizePrefix(opts.basePath);
    const asset = normalizePrefix(opts.assetPrefix);
    this.prefixes = [
      base,
      asset && asset.startsWith('/') && !asset.startsWith('//') ? asset : undefined,
    ].filter((x): x is string => !!x);
    if (asset && !this.prefixes.includes(asset)) this.urlPrefix = asset;
    this.limits = opts.limits ?? DEFAULT_LIMITS;
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
        const fragment = /#[A-Za-z0-9_.:-]*$/.exec(c.value)?.[0] ?? '';
        return { ok: true, url: `${refPrefix}${copied.name}${kind === 'style' ? '' : fragment}` };
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
    const buf = readNoFollow(found.file, ext === 'css' ? this.limits.css : this.limits.asset);
    if (!buf) return undefined;
    let result: Copied;
    if (ext === 'css') {
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
      result = { name: `${hash(data)}.css`, stats };
      this.write(result.name, data);
      this.cssFiles.set(sitePath, { name: result.name, stats });
    } else {
      result = { name: `${hash(buf)}.${ext}` };
      this.write(result.name, buf);
    }
    this.copied.set(key, result);
    return result;
  }

  private readonly names = new Set<string>();
  private write(name: string, data: string | Buffer) {
    if (this.names.has(name)) return;
    this.names.add(name);
    this.opts.out.write([this.opts.dir ?? 'screens', ASSETS_DIR, name], data);
    this.written++;
  }
}

function hash(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex').slice(0, 20);
}
