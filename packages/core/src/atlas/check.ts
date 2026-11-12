/**
 * `.stack-atlas/` の図の検査（docs/25 §3.4 の「形・参照・挙動」、docs/26 §5。根拠・未読・古さは、まだ無い）。
 * どれも、契約と、図の中の参照だけを見る。対象のコードは読まない（言語を知らずにできる検査だけ）。
 *
 * - 形: ファイルと要素の形（load.ts。形の違う要素は、その要素だけ捨てる）
 * - 参照・挙動: 契約の検証器（@stack-atlas/schema の validateGraphV2）を、形の合った要素の全部に掛ける。
 *   検査の決まりは、契約の側に 1 つだけある（ビューアが図を読むときも、同じ決まりで確かめる）。
 *   ここでは、検証器の指摘の場所（`/behaviors/1/steps/2` など）を、「どのファイルの、どの箱・線・挙動の段か」に直す
 */
import { validateGraphV2, type GraphV2, type ValidationIssue } from '@stack-atlas/schema';
import { inspectEvidence } from './evidence.js';
import { loadAtlas } from './load.js';
import { ATLAS_PATHS, type AtlasIssue, type AtlasReport, type LoadedAtlas } from './types.js';

const { graph: GRAPH, parts: PARTS, behaviors: BEHAVIORS } = ATLAS_PATHS;

/** 読みこんだ図を、1 つの graph（契約の形）にまとめる。部品と挙動は、あるときだけ入れる */
export function toGraph(atlas: LoadedAtlas): GraphV2 {
  const graph: GraphV2 = { version: 2, nodes: atlas.nodes, wires: atlas.wires };
  if (atlas.types.length) graph.types = atlas.types;
  if (atlas.parts.length) graph.parts = atlas.parts;
  if (atlas.behaviors.length) graph.behaviors = atlas.behaviors;
  return graph;
}

/**
 * 検証器の場所（`/nodes/3/ports/0`・`/behaviors/1/steps/2/parallel/0/1` など）を、ファイルと、人が読む場所に直す。
 * 検証器の番号は、形の合った要素だけを並べた中の番号で、ファイルの中の番号とは限らない。番号のままでは出さず、id で名指しする
 */
function locate(atlas: LoadedAtlas, path: string): { file: string; path: string } {
  const m = /^\/(nodes|wires|types|parts|behaviors)\/(\d+)(.*)$/.exec(path);
  if (!m) return { file: GRAPH, path };
  const i = Number(m[2]);
  const rest = m[3] ?? '';
  switch (m[1]) {
    case 'nodes': {
      const n = atlas.nodes[i];
      return {
        file: atlas.nodeFiles[i] ?? GRAPH,
        path: `${n ? `箱 "${n.id}"` : `箱 ${i + 1} 番め`}${rest}`,
      };
    }
    case 'wires': {
      const w = atlas.wires[i];
      return {
        file: atlas.wireFiles[i] ?? GRAPH,
        path: `${w ? `線 "${w.from}" → "${w.to}"` : `線 ${i + 1} 番め`}${rest}`,
      };
    }
    case 'types': {
      const t = atlas.types[i];
      return {
        file: atlas.typeFiles[i] ?? GRAPH,
        path: `${t ? `型 "${t.id}"` : `型 ${i + 1} 番め`}${rest}`,
      };
    }
    case 'parts': {
      const p = atlas.parts[i];
      const name = p ? `部品 "${p.id}"` : `部品 ${nth(atlas.partAt, i)}`;
      // id の重複は、同じ名前が 2 つあるので、ファイルの中の何番めかも出す
      return {
        file: PARTS,
        path: rest === '/id' ? `${name}（${nth(atlas.partAt, i)}）` : `${name}${rest}`,
      };
    }
    default: {
      const b = atlas.behaviors[i];
      const name = b ? `挙動 "${b.id}"` : `挙動 ${nth(atlas.behaviorAt, i)}`;
      if (rest === '/id')
        return { file: BEHAVIORS, path: `${name}（${nth(atlas.behaviorAt, i)}）` };
      // /steps/<段>(/parallel/<列>/<段>)? を、「段 N（の列 M の段 K）」に直す
      const step = /^\/steps\/(\d+)(?:\/parallel\/(\d+)\/(\d+))?(.*)$/.exec(rest);
      if (step) {
        const lane =
          step[2] === undefined ? '' : ` の列 ${Number(step[2]) + 1} の段 ${Number(step[3]) + 1}`;
        return {
          file: BEHAVIORS,
          path: `${name} の段 ${Number(step[1]) + 1}${lane}${step[4] ?? ''}`,
        };
      }
      return { file: BEHAVIORS, path: `${name}${rest}` };
    }
  }
}

/** 並びの i 番めの要素が、ファイルの中で何番めか（人が数える 1 からの番号） */
const nth = (at: readonly number[], i: number) => `${(at[i] ?? i) + 1} 番め`;

/** 図を読んで検査する。読みこんだ図（形の合った分）も返す（bundle が使う） */
/**
 * @param opts.evidence 根拠と未読も見るか（既定は見る。bundle・live は見ない。docs/28 D261: コードを直すと根拠がずれ、
 *   ライブが開かなくなるため。git も動かさない）
 */
export function inspectAtlas(
  root: string,
  opts: { evidence?: boolean } = {},
): { atlas: LoadedAtlas; report: AtlasReport } {
  const { atlas, issues } = loadAtlas(root);
  const add = (
    level: AtlasIssue['level'],
    check: AtlasIssue['check'],
    file: string,
    message: string,
    path?: string,
  ) =>
    issues.push(
      path === undefined ? { level, check, file, message } : { level, check, file, path, message },
    );

  // 参照と挙動（契約の検証器。形の合った要素を、全部のファイルを合わせてから掛ける）
  const v = validateGraphV2(toGraph(atlas));
  const note = (e: ValidationIssue) => {
    const at = locate(atlas, e.path);
    // 形の検査は load.ts で済んでいる。ここでスキーマに合わないのは、合わせたあとにだけ起きる誤り
    const check = v.graph ? (e.rule ?? 'ref') : 'form';
    add(e.level, check, at.file, e.message, at.path);
  };
  v.errors.forEach(note);
  v.warnings.forEach(note);

  // 無いファイルの案内（「あるが読めない」ときは、読めない理由だけを出す）
  if (atlas.status.behaviors === 'missing')
    add(
      'warning',
      'behavior',
      BEHAVIORS,
      `${BEHAVIORS} がありません（挙動を書くと、経路を 1 本ずつ追えます）`,
    );
  else if (
    atlas.status.behaviors === 'ok' &&
    atlas.behaviors.length === 0 &&
    !issues.some((x) => x.file === BEHAVIORS)
  )
    add('warning', 'behavior', BEHAVIORS, '挙動が 1 つもありません');
  if (atlas.status.parts === 'missing')
    add(
      'warning',
      'ref',
      PARTS,
      `${PARTS} がありません（画面の部品を書くと、挙動の始まりを指せます）`,
    );

  // 根拠と未読（docs/28）
  const ev = opts.evidence === false ? undefined : inspectEvidence(atlas, root, add);

  const order = { error: 0, warning: 1 } as const;
  issues.sort((a, b) => order[a.level] - order[b.level] || a.file.localeCompare(b.file));
  const errors = issues.filter((i) => i.level === 'error').length;
  const report: AtlasReport = {
    root,
    files: atlas.files,
    counts: {
      nodes: atlas.nodes.length,
      wires: atlas.wires.length,
      behaviors: atlas.behaviors.length,
      parts: atlas.parts.length,
      errors,
      warnings: issues.length - errors,
    },
    issues,
  };
  if (ev) {
    const declared = ev.repos.filter((r) => r.declared);
    if (declared.length)
      report.repos = declared.map((r) => (r.name ? { name: r.name, dir: r.dir } : { dir: r.dir }));
    report.evidence = ev.evidence;
    report.unread = ev.unread;
  }
  return { atlas, report };
}

export const checkAtlas = (root: string): AtlasReport => inspectAtlas(root).report;

const CHECK_NAME = {
  form: '形',
  ref: '参照',
  behavior: '挙動',
  evidence: '根拠',
  unread: '未読',
} as const;
const pct = (n: number, total: number) => (total ? `${((n / total) * 100).toFixed(1)}%` : '—');

/** 人が読む形 */
export function formatAtlasReport(r: AtlasReport): string {
  const lines = [
    `図: 箱 ${r.counts.nodes}・線 ${r.counts.wires}・部品 ${r.counts.parts}・挙動 ${r.counts.behaviors}（${r.files.length} ファイル）`,
    `検査（形・参照・挙動）: エラー ${r.counts.errors} 件、警告 ${r.counts.warnings} 件`,
  ];
  for (const i of r.issues)
    lines.push(
      `  [${i.level === 'error' ? 'エラー' : '警告'}・${CHECK_NAME[i.check]}] ${i.file}${i.path ? `（${i.path}）` : ''}: ${i.message}`,
    );
  for (const repo of r.repos ?? [])
    lines.push(`repo${repo.name ? ` "${repo.name}"` : ''}: ${repo.dir}`);
  if (r.evidence) {
    const e = r.evidence;
    lines.push(
      `根拠: 根拠のある箱 ${e.nodes.with} / ${e.nodes.total}・線 ${e.wires.with} / ${e.wires.total}（根拠 ${e.entries} 件のうち、書いた範囲で見つかったもの ${e.found} 件）`,
    );
  }
  for (const u of r.unread ?? []) {
    const name = u.name ? `repo "${u.name}" ` : '';
    if (!u.git) {
      lines.push(`未読: ${name}数えられません（${u.why ?? 'git の repo ではない'}）`);
      continue;
    }
    const dirs = u.dirs
      .filter((d) => d.unread > 0)
      .slice(0, 8)
      .map((d) => `${d.dir} ${d.unread} / ${d.total}`)
      .join('、');
    lines.push(
      `未読: ${name}${u.unread} / ${u.total}（${pct(u.unread, u.total)}。根拠に出てくる ${u.evidenced}・申告で除いた ${u.declared}・秘密らしいので読まない ${u.secret}）${dirs ? ` — ${dirs}` : ''}`,
    );
  }
  return lines.join('\n');
}
