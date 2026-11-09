/**
 * ファイルの読み書きの安全な入口（docs/18 §3.3）。
 *
 * 読む側: 解析対象の repo（の中の export / public）は信用しない。読む元は realpath にした root の中に限り、
 * 途中のどの段がシンボリックリンクでも読まない（辿らない）。最後は O_NOFOLLOW で開き、普通のファイルで大きさの上限の中だけ読む。
 * 書く側: 書き出し先（build の出力先）の中だけに書く。途中の段・書く先がシンボリックリンクなら書かない（例外）。
 * 既にあるファイルは消してから O_EXCL で作る（ハードリンクの先を書き換えない）。
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
import { isAbsolute, join, relative, sep } from 'node:path';

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

/** child が root の中（allowSame なら root そのものも可）か */
export function within(root: string, child: string, allowSame = false): boolean {
  const rel = relative(root, child);
  if (rel === '') return allowSame;
  return !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

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

/** シンボリックリンクを辿らずに開いて読む。普通のファイルでない・maxBytes を超えるなら undefined */
export function readNoFollow(file: string, maxBytes: number): Buffer | undefined {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return undefined;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > maxBytes) return undefined;
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

const SEGMENT = /^[A-Za-z0-9_.][A-Za-z0-9._-]*$/;

/** 書き出し先の中だけに書く */
export class SafeOutput {
  constructor(readonly outDir: string) {}

  /** outDir/<segments...> に書く。段の名前は英数字と `._-` だけ（`.` `..` は不可） */
  write(segments: readonly string[], data: string | Buffer): string {
    if (!segments.length) throw new Error('書き出し先のパスが空です');
    for (const s of segments) {
      if (!SEGMENT.test(s) || s === '.' || s === '..')
        throw new Error(`書き出し先の名前が不正です: ${segments.join('/')}`);
    }
    mkdirSync(this.outDir, { recursive: true });
    let cur = this.outDir;
    for (const seg of segments.slice(0, -1)) {
      cur = join(cur, seg);
      const st = lstatSync(cur, { throwIfNoEntry: false });
      if (!st) mkdirSync(cur);
      else if (st.isSymbolicLink() || !st.isDirectory())
        throw new Error(`書き出し先 ${cur} がシンボリックリンクかディレクトリでないので書きません`);
    }
    const file = join(cur, segments[segments.length - 1]!);
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
}
