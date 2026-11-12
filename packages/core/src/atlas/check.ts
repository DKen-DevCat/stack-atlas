/**
 * `.stack-atlas/` の図の検査（docs/25 §3.4 の「形・参照・挙動」、docs/26 §5。根拠・未読・古さは、まだ無い）。
 * どれも、契約と、図の中の参照だけを見る。対象のコードは読まない（言語を知らずにできる検査だけ）。
 *
 * - 形: ファイルと要素の形（load.ts。形の違う要素は、その要素だけ捨てる）
 * - 参照: 箱・口・項目・線が解けるか（契約の検証器を、形の合った要素の全部に掛ける）。部品の箱と画面があるか
 * - 挙動: 段の線がすべて図にあるか／段がつながっているか／始まりの部品が最初の段の出る箱か／分岐のキーは箱が宣言したものか
 */
import { parseItemRef, parseWhenKey, validateGraphV2 } from '@stack-atlas/schema';
import { loadAtlas } from './load.js';
import {
  ATLAS_PATHS,
  type AtlasIssue,
  type AtlasReport,
  type Behavior,
  type BehaviorStep,
  type LoadedAtlas,
  type WireRef,
} from './types.js';

const { graph: GRAPH, parts: PARTS, behaviors: BEHAVIORS } = ATLAS_PATHS;
const wireKey = (w: WireRef) => `${w.from}\u0000${w.to}`;
const arrow = (w: WireRef) => `"${w.from}" → "${w.to}"`;

/** `/nodes/3/ports/0` のような検証器の場所を、「どのファイルの、どの箱・線・型か」に直す */
function locate(atlas: LoadedAtlas, path: string): { file: string; path: string; wire?: number } {
  const m = /^\/(nodes|wires|types)\/(\d+)(.*)$/.exec(path);
  if (!m) return { file: GRAPH, path };
  const i = Number(m[2]);
  const rest = m[3] ?? '';
  if (m[1] === 'nodes') {
    const n = atlas.nodes[i];
    return {
      file: atlas.nodeFiles[i] ?? GRAPH,
      path: `${n ? `箱 "${n.id}"` : `箱 ${i + 1} 番め`}${rest}`,
    };
  }
  if (m[1] === 'wires') {
    const w = atlas.wires[i];
    return {
      file: atlas.wireFiles[i] ?? GRAPH,
      path: `${w ? `線 ${arrow(w)}` : `線 ${i + 1} 番め`}${rest}`,
      wire: i,
    };
  }
  const t = atlas.types[i];
  return {
    file: atlas.typeFiles[i] ?? GRAPH,
    path: `${t ? `型 "${t.id}"` : `型 ${i + 1} 番め`}${rest}`,
  };
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

  // 1. 参照（契約の検証器。形の合った要素を、全部のファイルを合わせてから掛ける）
  const graph: Record<string, unknown> = { version: 2, nodes: atlas.nodes, wires: atlas.wires };
  if (atlas.types.length) graph.types = atlas.types;
  const v = validateGraphV2(graph);
  /** 検証器が誤りにした線（端が解けない・重複）。挙動からは「図に無い線」として扱う */
  const badWires = new Set<number>();
  for (const e of v.errors) {
    const at = locate(atlas, e.path);
    if (at.wire !== undefined) badWires.add(at.wire);
    add('error', v.graph ? 'ref' : 'form', at.file, e.message, at.path);
  }
  for (const w of v.warnings) {
    const at = locate(atlas, w.path);
    add('warning', 'ref', at.file, w.message, at.path);
  }

  /** 箱 id → 種類と、宣言した分岐（同じ id が 2 つあれば、先のもの。重複は検証器が誤りにする） */
  const nodes = new Map<string, { kind: string; variants: Set<string> }>();
  for (const n of atlas.nodes)
    if (!nodes.has(n.id))
      nodes.set(n.id, { kind: n.kind, variants: new Set((n.variants ?? []).map((x) => x.id)) });
  /** 線（両端の組）→ 戻りの線か。検証器が誤りにした線は入れない */
  const wires = new Map<string, { reply: boolean }>();
  for (const [i, w] of atlas.wires.entries())
    if (!badWires.has(i)) wires.set(wireKey(w), { reply: w.reply === true });
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
      else if (!nodes.has(nodeId))
        add('error', 'behavior', file, `when のキー "${key}" の箱 "${nodeId}" がありません`, path);
      else if (!nodes.get(nodeId)!.variants.has(variantId))
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
    const n = nodes.get(id);
    if (!n) add('error', 'ref', file, `${who}の screen "${id}" の箱がありません`, path);
    else if (n.kind !== 'screen')
      add(
        'error',
        'ref',
        file,
        `${who}の screen "${id}" は、画面の箱（kind: screen）ではありません（${n.kind}）`,
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
    if (!nodes.has(p.box))
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
        const hit = wires.get(wireKey(w));
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
   *
   * 段が解けなかった・つながらなかったあとは null にして、その挙動（その列）の残りでは、つながりを問わない。
   * 1 つの誤りで、後ろの正しい段に指摘を重ねないため（誤りを直して、もう一度 check する）
   */
  const advance = (stack: string[] | null, step: BehaviorStep, where: string): string[] | null => {
    const r = resolveStep(step, where); // つながりを問わないときも、線があるかは確かめる
    if (!r || !stack) return null;
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
      return null;
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
