/**
 * `stack-atlas init --skill [<dir>] [--update]`（docs/19 §3.6）
 *
 * `<dir>`（既定はカレント）に skill（ワークスペースの `harness/skill/`）を `.claude/skills/stack-atlas/` へ写し、雛形
 * （`stack-atlas.config.yaml`・`stack-atlas.overrides.yaml`・`.stack-atlas/views.yaml`・`.stack-atlas/DECISIONS.md`）が
 * 無ければ置く。ネットワークは使わない（コピー元は CLI から import.meta.url で解く。ビューアの dist と同じ。paths.ts）。
 *
 * 安全（対象のディレクトリは解析対象の repo で、信用しない）:
 * - `<dir>` が home か `/` なら断る
 * - `.claude`・`.claude/skills`・`stack-atlas/`・その中のディレクトリとファイルの**どの段**がシンボリックリンクでも、何も書かずに
 *   断る（書く前にまとめて確かめる。書くときも core の SafeOutput が段ごとに確かめる）。雛形は、置き場の `.stack-atlas` が
 *   リンクなら断り、ファイルが既にあれば（リンクでも）書かない
 * - ファイルは O_EXCL で作る（既存は上書きしない）。`--update` だけが、manifest のハッシュと一致する（手で変えていない）
 *   ファイルを置き換え、変えられたファイルは隣に `.new` を書く
 * - コピーに `VERSION` とファイルのハッシュの `manifest.json` を置く（SKILL.md の最初の手順で `stack-atlas --version` と比べる）
 */
import { readNoFollow, SafeOutput, CONFIG_FILES, type Logger } from '@stack-atlas/core';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { HARNESS_SKILL } from '../paths.js';

export interface InitSkillOptions {
  /** 対象のディレクトリ（既定はカレント） */
  dir?: string;
  /** 手で変えていないファイルを置き換え、変えたものは .new に出す */
  update?: boolean;
  /** コピー元（テスト用。既定はワークスペースの harness/skill/） */
  source?: string;
  /** home（テスト用。既定は os.homedir()） */
  home?: string;
  log?: Pick<Logger, 'info' | 'error'>;
}

/** skill の置き場（対象のディレクトリからの段） */
export const SKILL_DEST = ['.claude', 'skills', 'stack-atlas'] as const;
export const MANIFEST = 'manifest.json';
/** 写すファイルの大きさの上限（skill の中も、手で変えたか比べるときに読む対象のファイルも） */
const MAX_FILE = 1024 * 1024;

/** 雛形（コピー元の templates/<名前>）→ 対象の中の置き場と、あれば置かない別名 */
export const TEMPLATES: Record<string, { dest: string[]; alt?: string[][] }> = {
  'stack-atlas.config.yaml': {
    dest: ['stack-atlas.config.yaml'],
    alt: CONFIG_FILES.map((f) => [f]),
  },
  'stack-atlas.overrides.yaml': {
    dest: ['stack-atlas.overrides.yaml'],
    alt: [['stack-atlas.overrides.yml']],
  },
  'views.yaml': { dest: ['.stack-atlas', 'views.yaml'], alt: [['.stack-atlas', 'views.yml']] },
  'DECISIONS.md': { dest: ['.stack-atlas', 'DECISIONS.md'] },
};

const sha = (b: Buffer | string) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

/** コピー元の全部のファイル（`/` 区切りの相対パス → 中身）。シンボリックリンクは写さない */
export function readSkillSource(root: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (dir: string) => {
    for (const d of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const p = join(dir, d.name);
      if (d.isSymbolicLink()) continue;
      if (d.isDirectory()) walk(p);
      else if (d.isFile()) out.set(relative(root, p).split(sep).join('/'), readFileSync(p));
    }
  };
  walk(root);
  return out;
}

interface Manifest {
  version: string;
  files: Record<string, string>;
}

export interface InitSkillReport {
  created: string[];
  unchanged: string[];
  updated: string[];
  /** 手で変えてあったので、隣に .new を書いたもの */
  conflicts: string[];
  /** 既にある（--update が無いので触らない）もの */
  skipped: string[];
}

/** root/<segs> の途中のディレクトリの段（最後を除く）にシンボリックリンクかディレクトリでないものがあれば、そのパス */
function linkOnDirs(root: string, segs: readonly string[]): string | undefined {
  let cur = root;
  for (const seg of segs.slice(0, -1)) {
    cur = join(cur, seg);
    const st = lstatSync(cur, { throwIfNoEntry: false });
    if (!st) return undefined;
    if (st.isSymbolicLink() || !st.isDirectory()) return cur;
  }
  return undefined;
}

export function runInitSkill(opts: InitSkillOptions = {}): number {
  return initSkill(opts).code;
}

/** init --skill の本体（終了コードと、書いたものの一覧） */
export function initSkill(opts: InitSkillOptions = {}): { code: number; report?: InitSkillReport } {
  const fail = (code: number) => ({ code });
  const log = opts.log ?? {
    info: (m: string) => console.log(m),
    error: (m: string) => console.error(m),
  };
  const target = resolve(opts.dir ?? process.cwd());
  let real: string;
  try {
    if (!statSync(target).isDirectory()) throw new Error('not a directory');
    real = realpathSync(target);
  } catch {
    log.error(`ディレクトリ ${target} がありません`);
    return fail(2);
  }
  const home = (() => {
    try {
      return realpathSync(opts.home ?? homedir());
    } catch {
      return resolve(opts.home ?? homedir());
    }
  })();
  if (real === '/' || real === resolve('/') || real === home) {
    log.error(
      `${real} には置きません（home と / は断ります。解析対象の repo のディレクトリを指定してください）`,
    );
    return fail(2);
  }
  const source = resolve(opts.source ?? HARNESS_SKILL);
  let files: Map<string, Buffer>;
  try {
    files = readSkillSource(source);
  } catch {
    log.error(
      `skill のコピー元 ${source} がありません（Stack Atlas のワークスペースから実行してください）`,
    );
    return fail(2);
  }
  if (!files.has('SKILL.md') || !files.has('VERSION')) {
    log.error(`skill のコピー元 ${source} に SKILL.md と VERSION がありません`);
    return fail(2);
  }
  const version = files.get('VERSION')!.toString('utf8').trim();
  const out = new SafeOutput(real);
  const skillSeg = (rel: string) => [...SKILL_DEST, ...rel.split('/')];
  const exists = (segs: readonly string[]) =>
    !!lstatSync(join(real, ...segs), { throwIfNoEntry: false });

  // 書く前にまとめて確かめる（どの段がリンクでも、何も書かない）
  const unsafe = new Set<string>();
  try {
    for (const rel of [...files.keys(), MANIFEST]) {
      const bad = out.unsafe(skillSeg(rel));
      if (bad) unsafe.add(bad);
      const nw = out.unsafe(skillSeg(`${rel}.new`));
      if (nw) unsafe.add(nw);
    }
    for (const [name, t] of Object.entries(TEMPLATES)) {
      if (!files.has(`templates/${name}`)) continue;
      const taken = [t.dest, ...(t.alt ?? [])].some(exists);
      // 既にある雛形は（リンクでも）触らない。置き場の段（.stack-atlas）のリンクは断る
      const bad = linkOnDirs(real, t.dest) ?? (taken ? undefined : out.unsafe(t.dest));
      if (bad) unsafe.add(bad);
    }
  } catch (e) {
    log.error(`書き出し先の名前が不正です: ${(e as Error).message}`);
    return fail(2);
  }
  if (unsafe.size) {
    log.error(
      `シンボリックリンク（か、ディレクトリ・普通のファイルでないもの）があるので何も書きません: ${[...unsafe].sort().join(', ')}`,
    );
    return fail(2);
  }

  const manifestPath = join(real, ...SKILL_DEST, MANIFEST);
  let manifest: Manifest | undefined;
  const mbuf = readNoFollow(manifestPath, MAX_FILE);
  if (mbuf) {
    try {
      const m = JSON.parse(mbuf.toString('utf8')) as Partial<Manifest>;
      if (m && typeof m.files === 'object' && m.files)
        manifest = { version: String(m.version ?? ''), files: { ...m.files } };
    } catch {
      manifest = undefined;
    }
  }
  const next: Manifest = { version, files: {} };
  const report: InitSkillReport = {
    created: [],
    unchanged: [],
    updated: [],
    conflicts: [],
    skipped: [],
  };
  const show = (rel: string) => [...SKILL_DEST, rel].join('/');
  try {
    for (const [rel, data] of files) {
      const segs = skillSeg(rel);
      const h = sha(data);
      if (!exists(segs)) {
        if (out.create(segs, data).created) report.created.push(show(rel));
        else report.skipped.push(show(rel));
        next.files[rel] = h;
        continue;
      }
      const cur = readNoFollow(join(real, ...segs), MAX_FILE);
      const curHash = cur ? sha(cur) : undefined;
      if (curHash === h) {
        report.unchanged.push(show(rel));
        next.files[rel] = h;
        continue;
      }
      const installed = manifest?.files[rel];
      if (!opts.update) {
        report.skipped.push(show(rel));
        if (installed) next.files[rel] = installed;
        continue;
      }
      if (installed && curHash === installed) {
        out.write(segs, data);
        report.updated.push(show(rel));
        next.files[rel] = h;
      } else {
        // 手で変えてある（か manifest に無い）: 置き換えず、隣に新しい版を出す
        out.write(skillSeg(`${rel}.new`), data);
        report.conflicts.push(show(rel));
        if (installed) next.files[rel] = installed;
      }
    }
    out.write([...SKILL_DEST, MANIFEST], `${JSON.stringify(next, null, 2)}\n`);
    for (const [name, t] of Object.entries(TEMPLATES)) {
      const data = files.get(`templates/${name}`);
      if (!data) continue;
      if ([t.dest, ...(t.alt ?? [])].some(exists)) {
        report.skipped.push(t.dest.join('/'));
        continue;
      }
      if (out.create(t.dest, data).created) report.created.push(t.dest.join('/'));
      else report.skipped.push(t.dest.join('/'));
    }
  } catch (e) {
    log.error(`書けませんでした: ${(e as Error).message}`);
    return fail(2);
  }
  const lines = [`skill（${version}）を ${join(real, ...SKILL_DEST)} に置きました`];
  const sec = (label: string, xs: string[]) => {
    if (xs.length) lines.push(`  ${label} ${xs.length}: ${xs.join(', ')}`);
  };
  sec('作った', report.created);
  sec('更新した', report.updated);
  sec('同じ', report.unchanged);
  sec(
    opts.update ? '既にある' : '既にある（--update で、手で変えていないものを更新）',
    report.skipped,
  );
  sec('手で変えてあるので .new に出した', report.conflicts);
  log.info(lines.join('\n'));
  return { code: 0, report };
}

/** `stack-atlas --version`（skill の VERSION。SKILL.md の最初の手順で比べる） */
export function harnessVersion(source = HARNESS_SKILL): string {
  try {
    return readFileSync(join(source, 'VERSION'), 'utf8').trim() || '0.0.0';
  } catch {
    return '0.0.0';
  }
}
