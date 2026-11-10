/**
 * ファイルの読み書きの安全な入口（docs/18 §3.3。8-4 で screens 抽出器から core へ移した。docs/19 §3.6）。
 *
 * 読む側: 解析対象の repo（の中の export / public・.stack-atlas/ の補いのファイル）は信用しない。読む元は realpath にした
 * root の中に限り、途中のどの段がシンボリックリンクでも読まない（辿らない）。最後は O_NOFOLLOW で開き、普通のファイルで
 * 大きさの上限の中だけ読む。
 * 書く側: 書き出し先（build の出力先・init の対象）の中だけに書く。途中の段・書く先がシンボリックリンクなら書かない（例外）。
 * write は既にあるファイルを消してから O_EXCL で作る（ハードリンクの先を書き換えない）。create は既にあれば書かない。
 */
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathWithin } from './util.js';

/** root が base（realpath）の中にあるディレクトリなら、その realpath。無い・外・ディレクトリでなければ理由 */
export function confineDir(
  base: string,
  rel: string,
): { dir: string } | { why: 'missing' | 'outside' } {
  const abs = isAbsolute(rel) ? rel : join(base, rel);
  let real: string;
  let realBase: string;
  try {
    real = realpathSync(abs);
    realBase = realpathSync(base);
  } catch {
    return { why: 'missing' };
  }
  if (!within(realBase, real, true)) return { why: 'outside' };
  if (!lstatSync(real).isDirectory()) return { why: 'missing' };
  return { dir: real };
}

/** child が root の中（allowSame なら root そのものも可）か。util の pathWithin と同じもの（8-3b のレビューで一本にした） */
export const within = pathWithin;

export type FindResult =
  { file: string; root: string } | { why: 'missing' | 'symlink' | 'outside' };

/**
 * サイトの中のパス（`_next/static/css/a.css`。検証済みの `/` 区切り）を、roots（realpath 済み）の順に探す。
 * 途中の段も最後もシンボリックリンクなら辿らずに symlink。普通のファイルでなければ次の root へ
 */
export function findSiteFile(roots: readonly string[], sitePath: string): FindResult {
  const segs = sitePath.split('/');
  for (const root of roots) {
    let cur = root;
    let ok = true;
    for (let k = 0; k < segs.length; k++) {
      cur = join(cur, segs[k]!);
      const st = lstatSync(cur, { throwIfNoEntry: false });
      if (!st) {
        ok = false;
        break;
      }
      if (st.isSymbolicLink()) return { why: 'symlink' };
      const last = k === segs.length - 1;
      if ((!last && !st.isDirectory()) || (last && !st.isFile())) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    let real: string;
    try {
      real = realpathSync(cur);
    } catch {
      continue;
    }
    if (!within(root, real)) return { why: 'outside' };
    return { file: real, root };
  }
  return { why: 'missing' };
}

export type ReadResult =
  { data: Buffer } | { why: 'unreadable' } | { why: 'too-large'; size: number };

/**
 * シンボリックリンクを辿らずに開いて読む。開けない・普通のファイルでないなら unreadable、
 * maxBytes を超えるなら too-large（大きさ付き。読まない）
 */
export function readNoFollowResult(file: string, maxBytes: number): ReadResult {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return { why: 'unreadable' };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { why: 'unreadable' };
    if (st.size > maxBytes) return { why: 'too-large', size: st.size };
    return { data: readFileSync(fd) };
  } finally {
    closeSync(fd);
  }
}

/** シンボリックリンクを辿らずに開いて読む。普通のファイルでない・maxBytes を超えるなら undefined */
export function readNoFollow(file: string, maxBytes: number): Buffer | undefined {
  const r = readNoFollowResult(file, maxBytes);
  return 'data' in r ? r.data : undefined;
}

const SEGMENT = /^[A-Za-z0-9_.][A-Za-z0-9._-]*$/;

/** 書き出し先の中だけに書く */
export class SafeOutput {
  constructor(readonly outDir: string) {}

  /** 段の名前を確かめる。英数字と `._-` だけ（`.` `..` は不可） */
  private check(segments: readonly string[]) {
    if (!segments.length) throw new Error('書き出し先のパスが空です');
    for (const s of segments) {
      if (!SEGMENT.test(s) || s === '.' || s === '..')
        throw new Error(`書き出し先の名前が不正です: ${segments.join('/')}`);
    }
  }

  /** 途中のディレクトリを作る（どの段もシンボリックリンクなら例外）。書く先のファイルのパスを返す */
  private prepare(segments: readonly string[]): string {
    this.check(segments);
    mkdirSync(this.outDir, { recursive: true });
    let cur = this.outDir;
    for (const seg of segments.slice(0, -1)) {
      cur = join(cur, seg);
      const st = lstatSync(cur, { throwIfNoEntry: false });
      if (!st) mkdirSync(cur);
      else if (st.isSymbolicLink() || !st.isDirectory())
        throw new Error(`書き出し先 ${cur} がシンボリックリンクかディレクトリでないので書きません`);
    }
    return join(cur, segments[segments.length - 1]!);
  }

  /**
   * outDir/<segments...> の途中の段と書く先に、シンボリックリンク・ディレクトリでないもの（途中）・普通のファイルでないもの
   * （書く先）があれば、そのパス。無ければ undefined（何も作らない。書く前にまとめて確かめるため）
   */
  unsafe(segments: readonly string[]): string | undefined {
    this.check(segments);
    let cur = this.outDir;
    for (const [k, seg] of segments.entries()) {
      cur = join(cur, seg);
      const st = lstatSync(cur, { throwIfNoEntry: false });
      if (!st) return undefined;
      const last = k === segments.length - 1;
      if (st.isSymbolicLink() || (!last && !st.isDirectory()) || (last && !st.isFile())) return cur;
    }
    return undefined;
  }

  /** outDir/<segments...> に書く（既にあれば消してから作り直す） */
  write(segments: readonly string[], data: string | Buffer): string {
    const file = this.prepare(segments);
    const st = lstatSync(file, { throwIfNoEntry: false });
    if (st) {
      if (st.isSymbolicLink() || !st.isFile())
        throw new Error(
          `書き出し先 ${file} がシンボリックリンクか普通のファイルでないので書きません`,
        );
      unlinkSync(file);
    }
    writeFileSync(file, data, { flag: 'wx' });
    return file;
  }

  /**
   * outDir/<segments...> を新しく作る。既にあれば書かずに exists（上書きしない。O_EXCL なので、確かめてから作るまでの間に
   * 置かれたファイルやリンクも書き換えない）
   */
  create(segments: readonly string[], data: string | Buffer): { file: string; created: boolean } {
    const file = this.prepare(segments);
    try {
      writeFileSync(file, data, { flag: 'wx' });
    } catch (e) {
      if ((e as { code?: string }).code === 'EEXIST') return { file, created: false };
      throw e;
    }
    return { file, created: true };
  }
}
