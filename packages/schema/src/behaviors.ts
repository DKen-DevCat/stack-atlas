/**
 * 部品（parts）と挙動（behaviors）の参照の検査（Phase 10。docs/26 §5）。graph.json v2 の検証（validate-v2）から呼ぶ。
 *
 * - 部品: id の重複、箱があるか、画面の箱（kind: screen）か
 * - 挙動: id の重複、画面の箱か、始まりの部品と変わる部品があるか、分岐のキーは箱が宣言したものか、
 *   段の線が wires にあるか、送る線と返る線の向き、段がつながっているか
 *
 * 契約と、graph の中の参照だけを見る（対象のコードは読まない）
 */
import type { ValidationIssue } from './validate.js';
import {
  parseItemRef,
  parseWhenKey,
  type BehaviorStepV2,
  type BehaviorV2,
  type GraphV2,
  type WireRef,
} from './v2.js';

/** どの検査の指摘か: ref（参照が解けない・重複）か、behavior（段の線・向き・つながり・分岐） */
export type BehaviorRule = NonNullable<ValidationIssue['rule']>;
export interface BehaviorIssue extends ValidationIssue {
  rule: BehaviorRule;
}

/** 線を、両端の組で引くためのキー（線に id は無い） */
export const wireKey = (w: WireRef): string => `${w.from}\u0000${w.to}`;
const arrow = (w: WireRef) => `"${w.from}" → "${w.to}"`;

/** 線の名指しの列の、出る箱と着く箱（解けない名指しは数えない） */
export function wireRefBoxes(refs: readonly WireRef[]): { froms: Set<string>; tos: Set<string> } {
  const froms = new Set<string>();
  const tos = new Set<string>();
  for (const w of refs) {
    const f = parseItemRef(w.from)?.nodeId;
    const t = parseItemRef(w.to)?.nodeId;
    if (f) froms.add(f);
    if (t) tos.add(t);
  }
  return { froms, tos };
}

/**
 * 段のつながり（docs/26 §4、D210）。path は「いま通っている経路」（始まりの箱から、呼び出しが重なっていく順）。
 * 次の段は、この経路の上のどれかの箱から出る: いちばん先の箱から出れば「さらに奥を呼ぶ」、手前の箱から出れば「戻ってから次を呼ぶ」。
 * 進んだあとの経路（出る箱より先を捨てて、着く箱を足したもの）を返す。出る箱が経路に無ければ undefined
 */
export function advancePath(
  path: readonly string[],
  from: string,
  to: string,
): string[] | undefined {
  const at = path.lastIndexOf(from);
  return at < 0 ? undefined : [...path.slice(0, at + 1), to];
}

/** 挙動の始まりの箱: open なら画面の箱、ほかは始まりの部品の箱（部品が無ければ undefined） */
export function behaviorStartBox(
  b: Pick<BehaviorV2, 'screen' | 'trigger'>,
  partBox: (partId: string) => string | undefined,
): string | undefined {
  if (b.trigger.action === 'open') return b.screen;
  return b.trigger.part === undefined ? undefined : partBox(b.trigger.part);
}

/** 段の場所: 挙動の中の JSON の場所（`/steps/2`・`/steps/2/parallel/0/1`）と、並んだ列の中なら、その組と列の番号 */
export interface StepPlace {
  path: string;
  parallel?: { group: number; lane: number };
}

/**
 * 挙動の段を、書かれた順にたどる（検査と、見せる形（@stack-atlas/wiring の behaviorView）が、同じたどり方をするための 1 つの道）。
 * state は、段から段へ渡す値（経路など）。同時に呼ぶ所は、どの列も、分かれる前の state から始まり、列が済んだら、分かれる前の state に戻る。
 * visit は、渡された state を書き換えずに、次の state を返すこと
 */
export function walkBehavior<S>(
  b: Pick<BehaviorV2, 'steps'>,
  start: S,
  visit: (state: S, step: BehaviorStepV2, place: StepPlace) => S,
): void {
  let state = start;
  let group = 0;
  for (const [i, entry] of b.steps.entries()) {
    if ('parallel' in entry) {
      for (const [lane, steps] of entry.parallel.entries()) {
        let laneState = state;
        for (const [si, step] of steps.entries())
          laneState = visit(laneState, step, {
            path: `/steps/${i}/parallel/${lane}/${si}`,
            parallel: { group, lane },
          });
      }
      group++;
    } else state = visit(state, entry, { path: `/steps/${i}` });
  }
}

/**
 * @param badWires 検証器が誤りにした線（端が解けない・重複）の番号。挙動からは「無い線」として扱う
 */
export function checkBehaviors(
  g: Pick<GraphV2, 'nodes' | 'wires' | 'parts' | 'behaviors'>,
  badWires: ReadonlySet<number> = new Set(),
): BehaviorIssue[] {
  const issues: BehaviorIssue[] = [];
  const add = (level: BehaviorIssue['level'], rule: BehaviorRule, path: string, message: string) =>
    issues.push({ level, rule, path, message });

  /** 箱 id → 種類と、宣言した分岐（同じ id が 2 つあれば、先のもの。重複は validate-v2 が誤りにする） */
  const nodes = new Map<string, { kind: string; variants: Set<string> }>();
  for (const n of g.nodes)
    if (!nodes.has(n.id))
      nodes.set(n.id, { kind: n.kind, variants: new Set((n.variants ?? []).map((x) => x.id)) });
  /** 線（両端の組）→ 戻りの線か */
  const wires = new Map<string, { reply: boolean }>();
  for (const [i, w] of g.wires.entries())
    if (!badWires.has(i)) wires.set(wireKey(w), { reply: w.reply === true });

  /** 分岐のキーは `<箱 id>#<分岐 id>`。箱があり、その分岐を宣言していること */
  const checkWhen = (when: Record<string, boolean> | undefined, path: string) => {
    for (const key of Object.keys(when ?? {})) {
      const { nodeId, variantId } = parseWhenKey(key);
      if (nodeId === undefined)
        add(
          'error',
          'behavior',
          path,
          `when のキー "${key}" は "<箱 id>#<分岐 id>" で書いてください`,
        );
      else if (!nodes.has(nodeId))
        add('error', 'behavior', path, `when のキー "${key}" の箱 "${nodeId}" がありません`);
      else if (!nodes.get(nodeId)!.variants.has(variantId))
        add(
          'error',
          'behavior',
          path,
          `when のキー "${key}": 箱 "${nodeId}" は分岐 "${variantId}" を宣言していません`,
        );
    }
  };
  const checkScreen = (id: string, path: string, who: string) => {
    const n = nodes.get(id);
    if (!n) add('error', 'ref', path, `${who}の screen "${id}" の箱がありません`);
    else if (n.kind !== 'screen')
      add(
        'error',
        'ref',
        path,
        `${who}の screen "${id}" は、画面の箱（kind: screen）ではありません（${n.kind}）`,
      );
  };

  // 部品
  const parts = new Map<string, { box: string }>();
  for (const [i, p] of (g.parts ?? []).entries()) {
    const path = `/parts/${i}`;
    if (parts.has(p.id)) {
      add('error', 'ref', `${path}/id`, `部品の id "${p.id}" が重複しています`);
      continue;
    }
    parts.set(p.id, { box: p.box });
    if (!nodes.has(p.box))
      add('error', 'ref', path, `部品 "${p.id}" の box "${p.box}" の箱がありません`);
    checkScreen(p.screen, path, `部品 "${p.id}" `);
  }

  /** 1 段を解く。送る線は 1 つの箱から 1 つの箱へ、返る線はその逆向き。解けたら、出る箱と着く箱を返す */
  const resolveStep = (
    step: BehaviorStepV2,
    path: string,
  ): { from: string; to: string } | undefined => {
    let ok = true;
    const ends = (refs: WireRef[], side: 'send' | 'back') => {
      const found: WireRef[] = [];
      for (const w of refs) {
        const hit = wires.get(wireKey(w));
        if (!hit) {
          add(
            'error',
            'behavior',
            path,
            `${side} の線 ${arrow(w)} が、図の線（wires）にありません`,
          );
          ok = false;
          continue;
        }
        found.push(w);
        if (side === 'send' && hit.reply) {
          add(
            'error',
            'behavior',
            path,
            `send に、戻りの線（reply: true）${arrow(w)} が書かれています。back に書いてください`,
          );
          ok = false;
        }
        if (side === 'back' && !hit.reply)
          add(
            'warning',
            'behavior',
            path,
            `back の線 ${arrow(w)} に、図の側で reply: true が付いていません`,
          );
      }
      return wireRefBoxes(found);
    };
    const send = ends(step.send, 'send');
    if (ok && (send.froms.size !== 1 || send.tos.size !== 1)) {
      add(
        'error',
        'behavior',
        path,
        `1 つの段の send は、1 つの箱から 1 つの箱への線だけにしてください（出る箱: ${[...send.froms].join(', ')}、着く箱: ${[...send.tos].join(', ')}）`,
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
          path,
          `back は、send の逆向き（"${to}" から "${from}" へ）の線だけにしてください`,
        );
        ok = false;
      }
    }
    checkWhen(step.when, path);
    return ok && from && to ? { from, to } : undefined;
  };

  /**
   * 段のつながり（advancePath）を確かめて、進んだあとの経路を返す。
   *
   * 段が解けなかった・つながらなかったあとは null にして、その挙動（その列）の残りでは、つながりを問わない。
   * 1 つの誤りで、後ろの正しい段に指摘を重ねないため
   */
  const advance = (stack: string[] | null, step: BehaviorStepV2, path: string): string[] | null => {
    const r = resolveStep(step, path); // つながりを問わないときも、線があるかは確かめる
    if (!r || !stack) return null;
    const next = advancePath(stack, r.from, r.to);
    if (!next)
      add(
        'error',
        'behavior',
        path,
        stack.length === 1
          ? `最初の段は、始まり（"${stack[0]}"）から出る線にしてください。この段は "${r.from}" から出ています`
          : `段がつながっていません: この段は "${r.from}" から出ていますが、ここまでの経路（${stack.join(' → ')}）に、その箱がありません`,
      );
    return next ?? null;
  };

  const checkBehavior = (b: BehaviorV2, index: number) => {
    const path = `/behaviors/${index}`;
    const name = `挙動 "${b.id}"`;
    checkScreen(b.screen, path, `${name} `);
    checkWhen(b.when, path);
    if (b.trigger.action === 'open') {
      if (b.trigger.part !== undefined)
        add(
          'error',
          'behavior',
          `${path}/trigger`,
          'action が open のとき、part は書きません（画面を開くことが始まりです）',
        );
    } else if (b.trigger.part === undefined)
      add(
        'error',
        'behavior',
        `${path}/trigger`,
        `action が ${b.trigger.action} のとき、part（部品の id）が要ります`,
      );
    else if (!parts.has(b.trigger.part))
      add(
        'error',
        'ref',
        path,
        `${name} の始まりの部品 "${b.trigger.part}" が、部品（parts）にありません`,
      );
    // 始まりの箱が決まらない（部品が無い・部品の箱が無い）ときは、つながりを問わない。もとの誤りは、もう指摘してある
    const start = behaviorStartBox(b, (id) => parts.get(id)?.box);
    const stack: string[] | null = start !== undefined && nodes.has(start) ? [start] : null;
    if (b.result?.part !== undefined && !parts.has(b.result.part))
      add(
        'error',
        'ref',
        path,
        `${name} の result の部品 "${b.result.part}" が、部品（parts）にありません`,
      );

    walkBehavior(b, stack, (at, step, place) => advance(at, step, `${path}${place.path}`));
  };
  const seen = new Set<string>();
  for (const [i, b] of (g.behaviors ?? []).entries()) {
    if (seen.has(b.id)) {
      add('error', 'ref', `/behaviors/${i}/id`, `挙動の id "${b.id}" が重複しています`);
      continue;
    }
    seen.add(b.id);
    checkBehavior(b, i);
  }
  return issues;
}
