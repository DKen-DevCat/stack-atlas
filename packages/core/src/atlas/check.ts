/**
 * `.stack-atlas/` の図の検査（docs/25 §3.4 の「形・参照・挙動」。根拠・未読・古さは、まだ無い）。
 * どれも、契約と、図の中の参照だけを見る。対象のコードは読まない（言語を知らずにできる検査だけ）。
 *
 * - 形: ファイルの形（load.ts）と、箱・線・型の中身（契約のスキーマ）
 * - 参照: 箱・口・項目・線が解けるか（契約の検証器）。部品の箱と画面があるか
 * - 挙動: 段の線がすべて図にあるか／段がつながっているか／始まりの部品が最初の段の出る箱か／分岐のキーは箱が宣言したものか
 */
import { parseItemRef, parseWhenKey, validateGraphV2 } from '@stack-atlas/schema';
import { isPlainObject } from '../util.js';
import { loadAtlas } from './load.js';
import {
  ATLAS_BEHAVIORS_FILE,
  ATLAS_DIR,
  ATLAS_GRAPH_DIR,
  ATLAS_PARTS_FILE,
  type AtlasIssue,
  type AtlasReport,
  type Behavior,
  type BehaviorStep,
  type LoadedAtlas,
  type WireRef,
} from './types.js';

const GRAPH = `${ATLAS_DIR}/${ATLAS_GRAPH_DIR}`;
const PARTS = `${ATLAS_DIR}/${ATLAS_PARTS_FILE}`;
const BEHAVIORS = `${ATLAS_DIR}/${ATLAS_BEHAVIORS_FILE}`;
const wireKey = (w: WireRef) => `${w.from}\u0000${w.to}`;
const arrow = (w: WireRef) => `"${w.from}" → "${w.to}"`;

interface Index {
  /** 箱 id → 種類と、宣言した分岐 */
  nodes: Map<string, { kind: string | undefined; variants: Set<string> }>;
  /** 線（両端の組）→ 戻りの線か */
  wires: Map<string, { reply: boolean }>;
}

/** 検証を通っていない生の値からも作れるように、形を確かめながら索引を作る */
function indexOf(atlas: LoadedAtlas): Index {
  const nodes: Index['nodes'] = new Map();
  for (const n of atlas.nodes as unknown[]) {
    if (!isPlainObject(n) || typeof n.id !== 'string') continue;
    const variants = new Set<string>();
    if (Array.isArray(n.variants))
      for (const v of n.variants)
        if (isPlainObject(v) && typeof v.id === 'string') variants.add(v.id);
    nodes.set(n.id, { kind: typeof n.kind === 'string' ? n.kind : undefined, variants });
  }
  const wires: Index['wires'] = new Map();
  for (const w of atlas.wires as unknown[]) {
    if (!isPlainObject(w) || typeof w.from !== 'string' || typeof w.to !== 'string') continue;
    wires.set(wireKey({ from: w.from, to: w.to }), { reply: w.reply === true });
  }
  return { nodes, wires };
}

/** `/nodes/3/ports/0` のような検証器の場所を、「どのファイルの、どの箱・線か」に直す */
function locate(atlas: LoadedAtlas, path: string): { file: string; path: string } {
  const m = /^\/(nodes|wires)\/(\d+)(.*)$/.exec(path);
  if (!m) return { file: GRAPH, path };
  const i = Number(m[2]);
  const raw = (m[1] === 'nodes' ? atlas.nodes : atlas.wires)[i] as unknown;
  const file = (m[1] === 'nodes' ? atlas.nodeFiles : atlas.wireFiles)[i] ?? GRAPH;
  let what = `${m[1] === 'nodes' ? '箱' : '線'} ${i + 1} 番め`;
  if (isPlainObject(raw)) {
    if (m[1] === 'nodes' && typeof raw.id === 'string') what = `箱 "${raw.id}"`;
    if (m[1] === 'wires' && typeof raw.from === 'string' && typeof raw.to === 'string')
      what = `線 ${arrow({ from: raw.from, to: raw.to })}`;
  }
  return { file, path: `${what}${m[3] ?? ''}` };
}

export function checkAtlas(root: string): AtlasReport {
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

  // 1. 箱・線・型の中身と参照（契約の検証器。全部のファイルを合わせてから掛ける）
  const graph: Record<string, unknown> = { version: 2, nodes: atlas.nodes, wires: atlas.wires };
  if (atlas.types.length) graph.types = atlas.types;
  const v = validateGraphV2(graph);
  for (const e of v.errors) {
    const at = locate(atlas, e.path);
    add('error', v.graph ? 'ref' : 'form', at.file, e.message, at.path);
  }
  for (const w of v.warnings) {
    const at = locate(atlas, w.path);
    add('warning', 'ref', at.file, w.message, at.path);
  }

  const ix = indexOf(atlas);
  const boxOf = (ref: string) => parseItemRef(ref)?.nodeId;

  /** 分岐のキーは `<箱 id>#<分岐 id>`。箱があり、その分岐を宣言していること */
  const checkWhen = (when: Record<string, boolean> | undefined, file: string, path: string) => {
    for (const key of Object.keys(when ?? {})) {
      const { nodeId, variantId } = parseWhenKey(key);
      if (nodeId === undefined)
        add(
          'error',
          'behavior',
          file,
          `when のキー "${key}" は "<箱 id>#<分岐 id>" で書いてください`,
          path,
        );
      else if (!ix.nodes.has(nodeId))
        add('error', 'behavior', file, `when のキー "${key}" の箱 "${nodeId}" がありません`, path);
      else if (!ix.nodes.get(nodeId)!.variants.has(variantId))
        add(
          'error',
          'behavior',
          file,
          `when のキー "${key}": 箱 "${nodeId}" は分岐 "${variantId}" を宣言していません`,
          path,
        );
    }
  };
  const checkScreen = (id: string, file: string, path: string, who: string) => {
    const n = ix.nodes.get(id);
    if (!n) add('error', 'ref', file, `${who}の screen "${id}" の箱がありません`, path);
    else if (n.kind !== 'screen')
      add(
        'error',
        'ref',
        file,
        `${who}の screen "${id}" は、画面の箱（kind: screen）ではありません（${n.kind ?? '?'}）`,
        path,
      );
  };

  // 2. 部品
  const parts = new Map<string, { box: string; screen: string }>();
  for (const [i, p] of atlas.parts.entries()) {
    const path = `部品 "${p.id}"`;
    if (parts.has(p.id)) {
      add('error', 'ref', PARTS, `部品の id "${p.id}" が重複しています`, `/parts/${i}`);
      continue;
    }
    parts.set(p.id, { box: p.box, screen: p.screen });
    if (!ix.nodes.has(p.box))
      add('error', 'ref', PARTS, `部品 "${p.id}" の box "${p.box}" の箱がありません`, path);
    checkScreen(p.screen, PARTS, path, `部品 "${p.id}" `);
  }

  // 3. 挙動
  /** 1 段を解く。送る線は 1 つの箱から 1 つの箱へ、返る線はその逆向き。解けたら、出る箱と着く箱を返す */
  const resolveStep = (
    step: BehaviorStep,
    path: string,
  ): { from: string; to: string } | undefined => {
    let ok = true;
    const ends = (refs: WireRef[], side: 'send' | 'back') => {
      const froms = new Set<string>();
      const tos = new Set<string>();
      for (const w of refs) {
        const hit = ix.wires.get(wireKey(w));
        if (!hit) {
          add(
            'error',
            'behavior',
            BEHAVIORS,
            `${side} の線 ${arrow(w)} が、図（${GRAPH}/）にありません`,
            path,
          );
          ok = false;
          continue;
        }
        if (side === 'send' && hit.reply) {
          add(
            'error',
            'behavior',
            BEHAVIORS,
            `send に、戻りの線（reply: true）${arrow(w)} が書かれています。back に書いてください`,
            path,
          );
          ok = false;
        }
        if (side === 'back' && !hit.reply)
          add(
            'warning',
            'behavior',
            BEHAVIORS,
            `back の線 ${arrow(w)} に、図の側で reply: true が付いていません`,
            path,
          );
        const f = boxOf(w.from);
        const t = boxOf(w.to);
        if (f) froms.add(f);
        if (t) tos.add(t);
      }
      return { froms, tos };
    };
    const send = ends(step.send, 'send');
    if (ok && (send.froms.size !== 1 || send.tos.size !== 1)) {
      add(
        'error',
        'behavior',
        BEHAVIORS,
        `1 つの段の send は、1 つの箱から 1 つの箱への線だけにしてください（出る箱: ${[...send.froms].join(', ')}、着く箱: ${[...send.tos].join(', ')}）`,
        path,
      );
      ok = false;
    }
    const from = [...send.froms][0];
    const to = [...send.tos][0];
    if (step.back?.length) {
      const back = ends(step.back, 'back');
      if (
        ok &&
        from &&
        to &&
        (back.froms.size !== 1 || back.tos.size !== 1 || !back.froms.has(to) || !back.tos.has(from))
      ) {
        add(
          'error',
          'behavior',
          BEHAVIORS,
          `back は、send の逆向き（"${to}" から "${from}" へ）の線だけにしてください`,
          path,
        );
        ok = false;
      }
    }
    checkWhen(step.when, BEHAVIORS, path);
    return ok && from && to ? { from, to } : undefined;
  };

  /**
   * 段のつながり。stack は「いま通っている経路」（始まりの箱から、呼び出しが重なっていく順）。
   * 次の段は、この経路の上のどれかの箱から出る: いちばん先の箱から出れば「さらに奥を呼ぶ」、手前の箱から出れば「戻ってから次を呼ぶ」。
   * 解けなかった段のあとは null にして、つながりを問わない（指摘を重ねない）
   */
  const advance = (stack: string[] | null, step: BehaviorStep, where: string): string[] | null => {
    const r = resolveStep(step, where);
    if (!r) return null;
    if (!stack) return [r.from, r.to];
    const at = stack.lastIndexOf(r.from);
    if (at < 0) {
      add(
        'error',
        'behavior',
        BEHAVIORS,
        stack.length === 1
          ? `最初の段は、始まり（"${stack[0]}"）から出る線にしてください。この段は "${r.from}" から出ています`
          : `段がつながっていません: この段は "${r.from}" から出ていますが、ここまでの経路（${stack.join(' → ')}）に、その箱がありません`,
        where,
      );
      return [r.from, r.to];
    }
    return [...stack.slice(0, at + 1), r.to];
  };

  const checkBehavior = (b: Behavior, seen: Set<string>, index: number) => {
    const name = `挙動 "${b.id}"`;
    if (seen.has(b.id)) {
      add('error', 'ref', BEHAVIORS, `挙動の id "${b.id}" が重複しています`, `/behaviors/${index}`);
      return;
    }
    seen.add(b.id);
    checkScreen(b.screen, BEHAVIORS, name, `${name} `);
    checkWhen(b.when, BEHAVIORS, name);
    let stack: string[] | null = [b.screen]; // open: 画面を開くことが始まり
    if (b.trigger.part !== undefined) {
      const part = parts.get(b.trigger.part);
      if (!part) {
        add(
          'error',
          'ref',
          BEHAVIORS,
          `${name} の始まりの部品 "${b.trigger.part}" が、${PARTS} にありません`,
          name,
        );
        stack = null;
      } else stack = [part.box];
    }
    if (b.result?.part !== undefined && !parts.has(b.result.part))
      add(
        'error',
        'ref',
        BEHAVIORS,
        `${name} の result の部品 "${b.result.part}" が、${PARTS} にありません`,
        name,
      );

    for (const [i, entry] of b.steps.entries()) {
      const where = `${name} の段 ${i + 1}`;
      if ('parallel' in entry) {
        // 同時に呼ぶ: どの列も、分かれる前の経路から始まる。列が済んだら、分かれる前の経路に戻る
        for (const [li, lane] of entry.parallel.entries()) {
          let laneStack = stack ? [...stack] : null;
          for (const [si, step] of lane.entries())
            laneStack = advance(laneStack, step, `${where} の列 ${li + 1} の段 ${si + 1}`);
        }
      } else stack = advance(stack, entry, where);
    }
  };
  const seen = new Set<string>();
  for (const [i, b] of atlas.behaviors.entries()) checkBehavior(b, seen, i);
  if (
    atlas.files.includes(BEHAVIORS) &&
    atlas.behaviors.length === 0 &&
    !issues.some((x) => x.file === BEHAVIORS)
  )
    add('warning', 'behavior', BEHAVIORS, '挙動が 1 つもありません');
  if (!atlas.files.includes(BEHAVIORS))
    add(
      'warning',
      'behavior',
      BEHAVIORS,
      `${BEHAVIORS} がありません（挙動を書くと、経路を 1 本ずつ追えます）`,
    );

  const order = { error: 0, warning: 1 } as const;
  issues.sort((a, b) => order[a.level] - order[b.level] || a.file.localeCompare(b.file));
  const errors = issues.filter((i) => i.level === 'error').length;
  return {
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
}

const CHECK_NAME = { form: '形', ref: '参照', behavior: '挙動' } as const;

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
  return lines.join('\n');
}
