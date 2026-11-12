/**
 * 根拠と未読の検査（Phase 10-1b。docs/28 §9.1 の D255〜D266）。どれも、対象のコードの意味は読まず、
 * 文字列とパスだけを見る（言語を選ばない）。検査が言えるのは「その場所を見た」まで。
 *
 * - 根拠: 箱と線の `evidence`（ファイル・行の範囲・そこにそのまま書いてある文字列）が、本当にそこにあるか
 * - 未読: 対象の repo が追跡しているファイルのうち、どの根拠にも、`reading.yaml` の申告にも出てこないもの（知らせだけ）
 * - repo の表: `atlas.yaml`（人の持ち物）の `repo` / `repos`
 *
 * 守り（docs/28 §5・D259・D262・D263。§11 のレビューで強めた）:
 * - 読むのは repo の中の、追跡している普通のファイルだけ（リンク・ハードリンク・`.git`・図の置き場・秘密らしいものは読まない）
 * - `atlas.yaml` で宣言した repo は、git の作業ツリーの中にあること。図の置き場の祖先・ホーム・ファイルシステムの根は取らない。
 *   git の作業ツリーの中なのに一覧を得られないときは、根拠を読まない（閉じる側に倒す）
 * - 出力に、ファイルの中身を写さない（エージェントが書いた文字列と、行の番号だけ。制御文字は伏せる）
 */
import type { EvidenceV2 } from '@stack-atlas/schema';
import { lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { trackedRegularFiles } from '../git.js';
import { parseLocalYaml, readLocalFile, whyText } from '../local-files.js';
import { isSecretFile, repoPathProblem } from '../secrets.js';
import { isPlainObject, pathWithin } from '../util.js';
import { ATLAS_DIR, type AtlasIssue, type LoadedAtlas } from './types.js';

export const ATLAS_CONFIG_FILE = 'atlas.yaml';
export const ATLAS_READING_FILE = 'reading.yaml';
export const EVIDENCE_LIMITS = {
  /** 根拠の文字列の長さ（空白を寄せたあと、文字の数） */
  textMin: 8,
  textMax: 200,
  /** 書いた行の範囲の前後、何行まで探すか */
  slack: 3,
  /** これを超える範囲は「広すぎる」 */
  wideLines: 200,
  /** この数以上ファイルに出る文字列は「ありふれた文字列」 */
  common: 3,
  /** 読むファイルの大きさの上限 */
  bytes: 1024 * 1024,
  /** 未読のファイルの名前を、JSON に出す数の上限 */
  unreadNames: 500,
  /** 申告の `*` の数の上限 */
  stars: 5,
} as const;

/** 図の置き場から見た、1 つの repo */
export interface AtlasRepo {
  /** `repos` の名前（`repo` か、表が無いときは undefined） */
  name?: string;
  /** 根拠のパスに付く接頭辞（`<name>/`。名前が無ければ空） */
  prefix: string;
  /** repo のディレクトリ（realpath） */
  dir: string;
  /** `atlas.yaml` で宣言した repo か（図の置き場そのものなら false） */
  declared: boolean;
  /** 根拠を読まない理由（git の作業ツリーの中なのに、一覧を得られない、など）。あれば、この repo の根拠は読まない */
  closed?: string;
}

export interface EvidenceSummary {
  /** 根拠のある箱・線の数と、数える箱・線の数（コードに無い箱は `meta.why` を書けば、数えない） */
  nodes: { with: number; total: number };
  wires: { with: number; total: number };
  /** 根拠の項目の数と、そのうち確かめられたもの */
  entries: number;
  found: number;
}

export interface UnreadDir {
  /** 最上位のディレクトリ（直下のファイルは `.`） */
  dir: string;
  total: number;
  unread: number;
}

export interface UnreadRepo {
  name?: string;
  /** git の repo で、追跡しているファイルを数えられたか */
  git: boolean;
  /** 数えられなかった理由 */
  why?: string;
  /** 追跡している普通のファイル（図の置き場の中を除く） */
  total: number;
  /** 根拠に出てくるもの・申告で除いたもの・秘密らしいもの（読まない約束）・未読 */
  evidenced: number;
  declared: number;
  secret: number;
  unread: number;
  /** 数えないもの（リンク・submodule・手元で消したもの） */
  others: number;
  dirs: UnreadDir[];
  /** 未読のファイルの名前（上限まで） */
  files: string[];
}

export interface EvidenceResult {
  repos: AtlasRepo[];
  evidence: EvidenceSummary;
  unread: UnreadRepo[];
}

type Add = (
  level: AtlasIssue['level'],
  check: AtlasIssue['check'],
  file: string,
  message: string,
  path?: string,
) => void;

const ATLAS_CONFIG_PATH = `${ATLAS_DIR}/${ATLAS_CONFIG_FILE}`;
const ATLAS_READING_PATH = `${ATLAS_DIR}/${ATLAS_READING_FILE}`;
const REPO_NAME = /^[A-Za-z0-9_-]+$/;
const realOf = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
};
/** lstat（途中の段がファイルなどで、例外になるときも undefined） */
const lstatOf = (p: string) => {
  try {
    return lstatSync(p, { throwIfNoEntry: false });
  } catch {
    return undefined;
  }
};
/** 出力に出す文字（エージェントが書いたもの）の、制御文字を伏せる */
const shown = (s: string) =>
  [...s].map((c) => (c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f ? '?' : c)).join('');
/** ディレクトリか、その祖先に `.git` があるか（git の作業ツリーの中か。git を呼ばずに見る） */
function underGit(dir: string): boolean {
  for (let d = dir; ; d = dirname(d)) {
    if (lstatOf(join(d, '.git'))) return true;
    if (dirname(d) === d) return false;
  }
}

function readYaml(root: string, name: string, add: Add, file: string): unknown {
  const read = readLocalFile(root, [ATLAS_DIR, name], EVIDENCE_LIMITS.bytes);
  if ('why' in read) {
    if (read.why !== 'missing') add('error', 'form', file, `${file} が${whyText(read.why)}`);
    return undefined;
  }
  const parsed = parseLocalYaml(read.text);
  if ('error' in parsed) {
    add('error', 'form', file, `YAML として読めません: ${parsed.error}`);
    return undefined;
  }
  return parsed.value ?? undefined;
}

/** `atlas.yaml` の repo の表を読む（D262）。broken: 表に誤りがあった（根拠・申告ごとの誤りは重ねない） */
export function loadRepos(root: string, add: Add): { repos: AtlasRepo[]; broken: boolean } {
  const rootReal = realOf(root) ?? resolve(root);
  const raw = readYaml(root, ATLAS_CONFIG_FILE, add, ATLAS_CONFIG_PATH);
  const self = { repos: [{ prefix: '', dir: rootReal, declared: false }], broken: false };
  if (raw === undefined) return self;
  if (!isPlainObject(raw)) {
    add(
      'error',
      'form',
      ATLAS_CONFIG_PATH,
      'atlas.yaml のトップレベルは { repo: ... } か { repos: [...] } にしてください',
    );
    return { ...self, broken: true };
  }
  const unknown = Object.keys(raw).filter((k) => !['repo', 'repos', 'screens'].includes(k));
  if (unknown.length)
    add(
      'error',
      'form',
      ATLAS_CONFIG_PATH,
      `atlas.yaml に、知らないキー ${unknown.join(', ')} があります（書けるのは repo, repos, screens）`,
    );
  if (raw.repo !== undefined && raw.repos !== undefined) {
    add('error', 'form', ATLAS_CONFIG_PATH, 'repo と repos は、どちらか 1 つだけ書いてください');
    return { repos: [], broken: true };
  }
  if (raw.repo === undefined && raw.repos === undefined) return self;
  let broken = false;
  const fail = (message: string, where: string, check: AtlasIssue['check'] = 'form') => {
    broken = true;
    add('error', check, ATLAS_CONFIG_PATH, message, where);
  };
  const home = realOf(homedir()) ?? homedir();
  /** 置き場からの相対パスを、repo のディレクトリに解く。誤りなら指摘して undefined */
  const dirOf = (path: unknown, where: string): string | undefined => {
    if (typeof path !== 'string' || !path.trim()) {
      fail(`${where} の path がありません（置き場からの相対パス）`, where);
      return undefined;
    }
    if (isAbsolute(path) || path.startsWith('~') || /^[A-Za-z]:[\\/]/.test(path)) {
      fail(`${where} の path は、置き場からの相対パスにしてください（"${shown(path)}"）`, where);
      return undefined;
    }
    const abs = resolve(rootReal, path);
    const st = lstatOf(abs);
    if (!st || st.isSymbolicLink() || !st.isDirectory()) {
      fail(
        `${where} の repo "${shown(path)}" が、${!st ? 'ありません' : st.isSymbolicLink() ? 'シンボリックリンクです' : 'ディレクトリではありません'}（この repo の根拠は確かめません）`,
        where,
        'evidence',
      );
      return undefined;
    }
    const real = realOf(abs) ?? abs;
    // 図の置き場の祖先・ホーム・ファイルシステムの根は、repo に取らない（根拠の検査が、どこでも読める道にならないように）
    if (pathWithin(real, rootReal, true) || real === home || real === parse(real).root) {
      fail(
        `${where} の repo "${shown(path)}" は、図の置き場を含むディレクトリか、ホームか、ファイルシステムの根です。repo そのもののディレクトリを書いてください`,
        where,
      );
      return undefined;
    }
    return real;
  };
  if (raw.repo !== undefined) {
    if (!isPlainObject(raw.repo)) {
      fail('repo は { path: "<置き場からの相対パス>" } で書いてください', 'repo');
      return { repos: [], broken };
    }
    const dir = dirOf(raw.repo.path, 'repo');
    return { repos: dir ? [{ prefix: '', dir, declared: true }] : [], broken };
  }
  if (!Array.isArray(raw.repos) || raw.repos.length === 0) {
    fail('repos は [{ name, path }, ...] で書いてください', 'repos');
    return { repos: [], broken };
  }
  const out: AtlasRepo[] = [];
  for (const [i, r] of raw.repos.entries()) {
    const where = `repos ${i + 1} 番め`;
    if (!isPlainObject(r) || typeof r.name !== 'string' || !REPO_NAME.test(r.name)) {
      fail(`${where}: name は英字・数字・_・- で書いてください`, where);
      continue;
    }
    if (out.some((x) => x.name === r.name)) {
      fail(`${where}: repo の名前 "${r.name}" が重複しています`, where);
      continue;
    }
    const dir = dirOf(r.path, `repo "${r.name}"`);
    if (!dir) continue;
    const nested = out.find((x) => pathWithin(x.dir, dir, true) || pathWithin(dir, x.dir, true));
    if (nested) {
      fail(`repo "${r.name}" と repo "${nested.name}" が、入れ子か同じ場所です`, where);
      continue;
    }
    out.push({ name: r.name, prefix: `${r.name}/`, dir, declared: true });
  }
  return { repos: out, broken };
}

/** 根拠のパスを、repo と repo からの相対パスに分ける。分けられなければ undefined */
function locate(
  repos: readonly AtlasRepo[],
  file: string,
): { repo: AtlasRepo; rel: string } | undefined {
  if (repos.length === 1 && repos[0]!.prefix === '') return { repo: repos[0]!, rel: file };
  const repo = repos.find((r) => r.prefix && file.startsWith(r.prefix));
  return repo ? { repo, rel: file.slice(repo.prefix.length) } : undefined;
}

/** 空白の連なりを 1 つにし、前後の空白を落とす */
const squeeze = (s: string) => s.replace(/\s+/g, ' ').trim();
/** 秘密らしいファイル（今の判定に、手順書が開くなと言う `id_*` を足す） */
export const isEvidenceSecret = (rel: string): boolean =>
  isSecretFile(rel) || /^id_/i.test(rel.split('/').pop() ?? '');

/** ファイルの中身（行の列）を、空白を寄せた 1 つの文字列と、その中の位置 → 行の番号の表にする */
function indexLines(text: string) {
  const lines = text.split(/\r?\n/);
  const starts: number[] = [];
  const lineOf: number[] = [];
  let joined = '';
  for (const [i, line] of lines.entries()) {
    const s = squeeze(line);
    if (!s) continue;
    if (joined) joined += ' ';
    starts.push(joined.length);
    lineOf.push(i + 1);
    joined += s;
  }
  /** 寄せた文字列の中の位置が、何行めか */
  const at = (offset: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lineOf[lo] ?? 1;
  };
  // 最後が改行で終わるファイルは、その後ろの空の行を数えない
  const count =
    lines.length > 1 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
  return { count, joined, at };
}

/** 根拠の検査（D257〜D260）。図の箱と線の根拠を確かめ、指摘を足す */
export function checkEvidence(
  atlas: LoadedAtlas,
  root: string,
  repos: readonly AtlasRepo[],
  tracked: ReadonlyMap<AtlasRepo, ReadonlySet<string> | undefined>,
  add: Add,
  opts: { reposBroken?: boolean } = {},
): { summary: EvidenceSummary; files: Map<AtlasRepo, Set<string>> } {
  const rootReal = realOf(root) ?? resolve(root);
  // 図の置き場の中は、根拠に書けない。大文字と小文字を区別しないファイルシステムでも外れないよう、小文字にそろえて比べる
  const atlasDir = join(rootReal, ATLAS_DIR).toLowerCase();
  const files = new Map<AtlasRepo, Set<string>>(repos.map((r) => [r, new Set<string>()]));
  const summary: EvidenceSummary = {
    nodes: { with: 0, total: 0 },
    wires: { with: 0, total: 0 },
    entries: 0,
    found: 0,
  };
  const cache = new Map<
    string,
    ReturnType<typeof indexLines> | { why: string; level: 'error' | 'warning' }
  >();

  const readIndexed = (repo: AtlasRepo, rel: string) => {
    const key = `${repo.dir}\u0000${rel}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const fail = (why: string, level: 'error' | 'warning' = 'error') => {
      const v = { why, level };
      cache.set(key, v);
      return v;
    };
    const problem = repoPathProblem(rel);
    if (problem)
      return fail(
        problem === 'absolute'
          ? '絶対パスは書けません（repo からの相対パス）'
          : 'repo の外（..）は書けません',
      );
    const segs = rel.split(/[\\/]/);
    if (segs.some((s) => s === '' || s === '.')) return fail('パスの書き方が正しくありません');
    if (segs.some((s) => s.toLowerCase() === '.git')) return fail('.git の中は、根拠に書けません');
    if (isEvidenceSecret(rel)) return fail('秘密らしいファイルなので、読みません');
    const abs = join(repo.dir, ...segs);
    if (pathWithin(atlasDir, abs.toLowerCase(), true))
      return fail('図の置き場（.stack-atlas/）の中は、根拠に書けません');
    const set = tracked.get(repo);
    if (set && !set.has(rel))
      return fail('git が追跡していないファイルです（追跡しているファイルだけを、根拠に書けます）');
    const read = readLocalFile(repo.dir, segs, EVIDENCE_LIMITS.bytes);
    if ('why' in read)
      return read.why === 'too-large'
        ? fail(
            `大きすぎる（${EVIDENCE_LIMITS.bytes / 1024 / 1024}MB を超える）ので、確かめられません`,
            'warning',
          )
        : fail(`ファイルが${whyText(read.why)}`);
    // 読めたあとで、ハードリンクかを確かめる（途中の段がファイルなどで lstat が例外になる所は、上の読みで断っている）
    if ((lstatOf(abs)?.nlink ?? 1) > 1) return fail('ハードリンクなので、読みません');
    const v = indexLines(read.text);
    cache.set(key, v);
    return v;
  };

  const checkOne = (ev: EvidenceV2, file: string, where: string) => {
    summary.entries++;
    const text = squeeze(ev.text);
    const chars = [...text].length;
    if (
      chars < EVIDENCE_LIMITS.textMin ||
      chars > EVIDENCE_LIMITS.textMax ||
      !/[\p{L}\p{N}]/u.test(text)
    ) {
      add(
        'error',
        'evidence',
        file,
        `根拠の文字列 "${shown(text.slice(0, 80))}" は、${EVIDENCE_LIMITS.textMin}〜${EVIDENCE_LIMITS.textMax} 字で、文字か数字を含めてください（短い字句・記号だけは、どこにでもあるので、見た証になりません）`,
        where,
      );
      return;
    }
    const [from, to] = ev.lines;
    if (from > to) {
      add(
        'error',
        'evidence',
        file,
        `根拠の行の範囲 [${from}, ${to}] の始めが、終わりより後です`,
        where,
      );
      return;
    }
    const loc = locate(repos, ev.file);
    if (!loc) {
      // repo の表に誤りがあるときは、そちらを 1 件だけ出す（根拠ごとに重ねない。D262）
      if (!opts.reposBroken)
        add(
          'error',
          'evidence',
          file,
          `根拠のファイル "${shown(ev.file)}" の repo が、atlas.yaml の表にありません（"<repo の名前>/…" で書いてください）`,
          where,
        );
      return;
    }
    if (loc.repo.closed) return; // この repo の根拠は読まない（repo ごとに 1 件、別に出している）
    const idx = readIndexed(loc.repo, loc.rel);
    if ('why' in idx) {
      add(idx.level, 'evidence', file, `根拠のファイル "${shown(ev.file)}": ${idx.why}`, where);
      return;
    }
    files.get(loc.repo)!.add(loc.rel);
    if (to > idx.count) {
      add(
        'error',
        'evidence',
        file,
        `根拠の行の範囲 [${from}, ${to}] が、ファイルの行の数（${idx.count}）を超えています`,
        where,
      );
      return;
    }
    const hits: number[] = [];
    for (
      let at = idx.joined.indexOf(text);
      at >= 0;
      at = idx.joined.indexOf(text, at + text.length)
    )
      hits.push(idx.at(at));
    if (hits.length === 0) {
      add(
        'error',
        'evidence',
        file,
        `根拠の文字列 "${shown(text)}" が、"${shown(ev.file)}" にありません`,
        where,
      );
      return;
    }
    const near = hits.some(
      (l) => l >= from - EVIDENCE_LIMITS.slack && l <= to + EVIDENCE_LIMITS.slack,
    );
    if (!near) {
      add(
        'warning',
        'evidence',
        file,
        `根拠の文字列 "${shown(text)}" が、書いた行の範囲 [${from}, ${to}] にありません（${hits[0]} 行めのあたりにあります）`,
        where,
      );
      return;
    }
    summary.found++;
    if (hits.length >= EVIDENCE_LIMITS.common)
      add(
        'warning',
        'evidence',
        file,
        `根拠の文字列 "${shown(text)}" は、"${shown(ev.file)}" に ${hits.length} か所あります（ありふれた文字列は、見た証になりにくい）`,
        where,
      );
    if (to - from + 1 > EVIDENCE_LIMITS.wideLines)
      add(
        'warning',
        'evidence',
        file,
        `根拠の行の範囲 [${from}, ${to}] が広すぎます（${EVIDENCE_LIMITS.wideLines} 行まで）`,
        where,
      );
  };

  const exempt = (meta: Record<string, unknown> | undefined) =>
    typeof meta?.why === 'string' && meta.why.trim().length > 0;
  for (const [i, n] of atlas.nodes.entries()) {
    const list = n.evidence ?? [];
    if (!exempt(n.meta)) {
      summary.nodes.total++;
      if (list.length) summary.nodes.with++;
    }
    list.forEach((ev, k) =>
      checkOne(ev, atlas.nodeFiles[i] ?? ATLAS_DIR, `箱 "${n.id}" の根拠 ${k + 1}`),
    );
    // 箱の `file` も、根拠に出てくるファイルとして数える（未読から除く）
    const loc = n.file ? locate(repos, n.file) : undefined;
    if (loc && !repoPathProblem(loc.rel) && !isEvidenceSecret(loc.rel))
      files.get(loc.repo)!.add(loc.rel);
  }
  for (const [i, w] of atlas.wires.entries()) {
    const list = w.evidence ?? [];
    if (!exempt(w.meta)) {
      summary.wires.total++;
      if (list.length) summary.wires.with++;
    }
    list.forEach((ev, k) =>
      checkOne(ev, atlas.wireFiles[i] ?? ATLAS_DIR, `線 "${w.from}" → "${w.to}" の根拠 ${k + 1}`),
    );
  }
  return { summary, files };
}

/** `reading.yaml` の申告 1 つ */
interface Declaration {
  kind: 'read' | 'skipped';
  path: string;
  repo: AtlasRepo;
  test: (rel: string) => boolean;
  where: string;
}

/** `reading.yaml` を読む（D265）。形の誤りは指摘して、その申告を捨てる */
export function loadReading(
  root: string,
  repos: readonly AtlasRepo[],
  add: Add,
  opts: { reposBroken?: boolean } = {},
): Declaration[] {
  const raw = readYaml(root, ATLAS_READING_FILE, add, ATLAS_READING_PATH);
  if (raw === undefined) return [];
  if (!isPlainObject(raw)) {
    add(
      'error',
      'form',
      ATLAS_READING_PATH,
      'reading.yaml のトップレベルは { read: [...], skipped: [...] } にしてください',
    );
    return [];
  }
  const unknown = Object.keys(raw).filter((k) => k !== 'read' && k !== 'skipped');
  if (unknown.length)
    add(
      'error',
      'form',
      ATLAS_READING_PATH,
      `reading.yaml に、知らないキー ${unknown.join(', ')} があります（書けるのは read, skipped）`,
    );
  const out: Declaration[] = [];
  for (const kind of ['read', 'skipped'] as const) {
    const list = raw[kind];
    if (list === undefined || list === null) continue;
    if (!Array.isArray(list)) {
      add('error', 'form', ATLAS_READING_PATH, `${kind} は [{ path, why }, ...] で書いてください`);
      continue;
    }
    for (const [i, d] of list.entries()) {
      const where = `${kind} ${i + 1} 番め`;
      const bad = (message: string) => add('error', 'form', ATLAS_READING_PATH, message, where);
      if (!isPlainObject(d) || typeof d.path !== 'string') {
        bad('申告は { path: "<パス>", why: "<理由>" } で書いてください');
        continue;
      }
      const extra = Object.keys(d).filter((k) => k !== 'path' && k !== 'why');
      if (extra.length)
        bad(`申告に、知らないキー ${extra.join(', ')} があります（書けるのは path, why）`);
      if (typeof d.why !== 'string' || !d.why.trim()) {
        bad(`申告 "${d.path}" に、理由（why）がありません`);
        continue;
      }
      const loc = locate(repos, d.path);
      if (!loc) {
        if (!opts.reposBroken)
          bad(
            `申告 "${shown(d.path)}" の repo が、atlas.yaml の表にありません（"<repo の名前>/…" で書いてください）`,
          );
        continue;
      }
      const rel = loc.rel;
      const dir = rel.endsWith('/');
      const body = dir ? rel.slice(0, -1) : rel;
      const segs = body.split('/');
      if (
        !body ||
        ['*', '.', '..'].includes(body) ||
        segs.every((s) => s === '*') ||
        repoPathProblem(body) ||
        segs.some((s) => s === '' || s === '.' || s === '..' || s === '**')
      ) {
        bad(
          `申告 "${d.path}" は、全部か、それに近い所を指しています（ファイル・ディレクトリ・1 段の中の * で書いてください）`,
        );
        continue;
      }
      if (kind === 'read' && (dir || body.includes('*'))) {
        bad(
          `read の申告 "${d.path}" は、ファイル 1 つにしてください（読んだファイルを、1 つずつ申告する）`,
        );
        continue;
      }
      if ((body.match(/\*/g) ?? []).length > EVIDENCE_LIMITS.stars) {
        bad(`申告 "${d.path}" の * が多すぎます（${EVIDENCE_LIMITS.stars} まで）`);
        continue;
      }
      const re = new RegExp(
        `^${segs
          .map((s) =>
            s
              .split('*')
              .map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
              .join('[^/]*'),
          )
          .join('/')}${dir ? '/' : '$'}`,
      );
      out.push({ kind, path: shown(d.path), repo: loc.repo, test: (p) => re.test(p), where });
    }
  }
  return out;
}

/** 最上位のディレクトリ（直下のファイルは `.`） */
const topDir = (rel: string) => (rel.includes('/') ? `${rel.split('/')[0]}/` : '.');

/** 未読の要約（D263・D264）。知らせだけで、指摘にはしない（申告の形の警告を除く） */
export function computeUnread(
  root: string,
  repos: readonly AtlasRepo[],
  trackedAll: ReadonlyMap<AtlasRepo, { files: string[]; others: number } | { why: string }>,
  evidenced: ReadonlyMap<AtlasRepo, ReadonlySet<string>>,
  declarations: readonly Declaration[],
  add: Add,
): UnreadRepo[] {
  const rootReal = realOf(root) ?? resolve(root);
  const atlasDir = join(rootReal, ATLAS_DIR);
  const out: UnreadRepo[] = [];
  const hits = new Map<Declaration, number>();
  const evHits = new Map<Declaration, string[]>();
  for (const repo of repos) {
    const base: UnreadRepo = {
      ...(repo.name ? { name: repo.name } : {}),
      git: false,
      total: 0,
      evidenced: 0,
      declared: 0,
      secret: 0,
      unread: 0,
      others: 0,
      dirs: [],
      files: [],
    };
    const t = trackedAll.get(repo);
    if (!t || 'why' in t) {
      out.push({ ...base, why: t && 'why' in t ? t.why : '数えられない' });
      continue;
    }
    // 図の置き場の中のファイルは、数えない
    const atlasRel = pathWithin(repo.dir, atlasDir, true)
      ? relative(repo.dir, atlasDir).split(sep).join('/')
      : undefined;
    const files = t.files.filter(
      (f) => !(atlasRel !== undefined && (f === atlasRel || f.startsWith(`${atlasRel}/`))),
    );
    const ev = evidenced.get(repo) ?? new Set<string>();
    const mine = declarations.filter((d) => d.repo === repo);
    const dirs = new Map<string, UnreadDir>();
    const r: UnreadRepo = { ...base, git: true, total: files.length, others: t.others };
    for (const f of files) {
      const d = dirs.get(topDir(f)) ?? { dir: topDir(f), total: 0, unread: 0 };
      dirs.set(d.dir, d);
      d.total++;
      // 1 つのファイルに、申告ごとに 1 回だけ当てる
      const matched = mine.filter((x) => x.test(f));
      for (const x of matched) hits.set(x, (hits.get(x) ?? 0) + 1);
      if (ev.has(f)) {
        r.evidenced++;
        for (const x of matched) evHits.set(x, [...(evHits.get(x) ?? []), f]);
        continue;
      }
      if (matched.length) {
        r.declared++;
        continue;
      }
      if (isEvidenceSecret(f)) {
        r.secret++;
        continue;
      }
      r.unread++;
      d.unread++;
      if (r.files.length < EVIDENCE_LIMITS.unreadNames) r.files.push(f);
    }
    r.dirs = [...dirs.values()].sort((a, b) => b.unread - a.unread || a.dir.localeCompare(b.dir));
    // 申告の当たり方（D265）
    for (const d of mine) {
      const n = hits.get(d) ?? 0;
      if (n === 0)
        add(
          'warning',
          'unread',
          ATLAS_READING_PATH,
          `申告 "${d.path}" は、追跡しているファイルのどれにも当たりません`,
          d.where,
        );
      else if (files.length >= 10 && n > files.length / 2)
        add(
          'warning',
          'unread',
          ATLAS_READING_PATH,
          `申告 "${d.path}" は、追跡しているファイルの半分を超える ${n} 件に当たります（読まなかった所は、狭く申告してください）`,
          d.where,
        );
      const both = evHits.get(d) ?? [];
      if (d.kind === 'skipped' && both.length)
        add(
          'warning',
          'unread',
          ATLAS_READING_PATH,
          `skipped の申告 "${d.path}" に、根拠に出てくるファイル（${both.slice(0, 3).join(', ')}）が入っています`,
          d.where,
        );
    }
    out.push(r);
  }
  return out;
}

/** 根拠と未読をまとめて見る（check から呼ぶ。bundle・live は呼ばない。D261） */
export function inspectEvidence(atlas: LoadedAtlas, root: string, add: Add): EvidenceResult {
  const { repos, broken } = loadRepos(root, add);
  const trackedAll = new Map<AtlasRepo, { files: string[]; others: number } | { why: string }>();
  const trackedSets = new Map<AtlasRepo, ReadonlySet<string> | undefined>();
  for (const repo of repos) {
    const t = trackedRegularFiles(repo.dir);
    trackedAll.set(repo, t);
    trackedSets.set(repo, 'why' in t ? undefined : new Set(t.files));
    // 閉じる側に倒す（2026-11-13 のレビュー）: atlas.yaml で宣言した repo は、git の作業ツリーの中であること。
    // git の作業ツリーの中なのに一覧を得られない（git が見つからない・断られた・時間切れ）ときも、根拠を読まない
    // （追跡していないファイルの中身を確かめる口にしない）
    if ('why' in t && (repo.declared || underGit(repo.dir))) {
      repo.closed = t.why;
      add(
        'error',
        'evidence',
        repo.declared ? ATLAS_CONFIG_PATH : ATLAS_DIR,
        `${repo.name ? `repo "${repo.name}"` : 'repo'} の、git が追跡しているファイルの一覧を得られないので、根拠を読みません（${t.why}）`,
      );
    }
  }
  const { summary, files } = checkEvidence(atlas, root, repos, trackedSets, add, {
    reposBroken: broken,
  });
  const declarations = loadReading(root, repos, add, { reposBroken: broken });
  const unread = computeUnread(root, repos, trackedAll, files, declarations, add);
  return { repos, evidence: summary, unread };
}
