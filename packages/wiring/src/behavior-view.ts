/**
 * 挙動（graph.json v2 の behaviors。Phase 10、docs/26 §4）を、見せるための形にする: 段ごとに、どの箱からどの箱へ、何を送り、何が返るか。
 * ビューア（挙動の経路を上から下へ並べる面。docs/25 §3.5）が使う。純粋な計算で、DOM も、対象のコードも見ない。
 *
 * 検査を通った graph を前提にする（解けない線の段は、飛ばさずに、分かる範囲で出す）
 */
import {
  parseItemRef,
  type BehaviorStepV2,
  type BehaviorV2,
  type GraphV2,
  type ItemV2,
  type NodeV2,
  type PartV2,
  type TriggerAction,
  type WireRef,
  type WireVia,
} from '@stack-atlas/schema';

export interface BoxView {
  id: string;
  name: string;
  kind: string;
  runtime: string;
  /** 根拠（あれば） */
  file?: string;
  line?: number;
}

export interface StepView {
  /** 挙動の中の通し番号（0 から。並んだ列の段も、書かれた順に数える） */
  index: number;
  /** 並んだ列（同時に呼ぶ所）の中の段なら、その組と列の番号 */
  parallel?: { group: number; lane: number };
  /** 経路の深さ（0 = 始まりの箱から出る段）。「さらに奥を呼ぶ」と 1 つ深くなり、「戻ってから次を呼ぶ」と浅くなる */
  depth: number;
  from: BoxView;
  to: BoxView;
  via: WireVia | undefined;
  /** 送るもの・返るものの名前（項目の name を、親から `.` でつないだもの） */
  send: string[];
  back: string[];
  say?: string;
  /**
   * 画面の側（runtime: browser）から、受け口（meta.route のある箱）へ、通信（via: http）で出る段なら、そのメソッドとパス。
   * ライブ（docs/25 D206）は、この段だけを「実際に見える段」として、ブラウザから出た通信と照らす
   */
  request?: { method: string; path: string };
}

export interface BehaviorView {
  id: string;
  name: string;
  screen: string;
  trigger: { action: TriggerAction; part?: PartV2 };
  steps: StepView[];
  result?: { say?: string; part?: PartV2 };
}

const boxView = (n: NodeV2 | undefined, id: string): BoxView => {
  if (!n) return { id, name: id, kind: 'unknown', runtime: 'unknown' };
  const box: BoxView = { id: n.id, name: n.name, kind: n.kind, runtime: n.runtime };
  if (n.file !== undefined) box.file = n.file;
  if (n.line !== undefined) box.line = n.line;
  return box;
};

/** 項目の参照 `<箱>#<口>/<a>.<b>` の、項目の名前（`a の name`.`b の name`）。解けなければ、参照の項目の部分をそのまま返す */
function itemLabel(nodes: ReadonlyMap<string, NodeV2>, ref: string): string {
  const p = parseItemRef(ref);
  if (!p) return ref;
  let items: ItemV2[] | undefined = nodes
    .get(p.nodeId)
    ?.ports.find((x) => x.id === p.portId)?.items;
  const names: string[] = [];
  for (const id of p.path) {
    const it: ItemV2 | undefined = items?.find((x) => x.id === id);
    if (!it) return p.path.join('.');
    names.push(it.name);
    items = it.children;
  }
  return names.join('.');
}

/** `"POST /items"` の形の meta.route を、メソッドとパスに分ける */
function routeOf(n: NodeV2 | undefined): { method: string; path: string } | undefined {
  const route = n?.meta?.route;
  if (typeof route !== 'string') return undefined;
  const m = /^([A-Za-z]+)\s+(\S.*)$/.exec(route.trim());
  return m ? { method: m[1]!.toUpperCase(), path: m[2]! } : undefined;
}

/**
 * 挙動を、見せるための段の列にする。graph に、その id の挙動が無ければ undefined
 */
export function behaviorView(graph: GraphV2, behaviorId: string): BehaviorView | undefined {
  const b: BehaviorV2 | undefined = graph.behaviors?.find((x) => x.id === behaviorId);
  if (!b) return undefined;
  const nodes = new Map(graph.nodes.map((n) => [n.id, n] as const));
  const vias = new Map(graph.wires.map((w) => [`${w.from}\u0000${w.to}`, w.via] as const));
  const parts = new Map((graph.parts ?? []).map((p) => [p.id, p] as const));
  const boxOf = (w: WireRef | undefined, side: 'from' | 'to') =>
    (w && parseItemRef(w[side])?.nodeId) ?? '';

  const steps: StepView[] = [];
  /** 1 段を足して、進んだあとの経路（箱 id の列）を返す。つながりの決まりは、検査（checkBehaviors）と同じ */
  const push = (
    step: BehaviorStepV2,
    stack: string[],
    parallel?: { group: number; lane: number },
  ): string[] => {
    const first = step.send[0];
    const fromId = boxOf(first, 'from');
    const toId = boxOf(first, 'to');
    const at = stack.lastIndexOf(fromId);
    const kept = at < 0 ? stack : stack.slice(0, at + 1);
    const from = nodes.get(fromId);
    const to = nodes.get(toId);
    const via = first ? vias.get(`${first.from}\u0000${first.to}`) : undefined;
    const view: StepView = {
      index: steps.length,
      depth: Math.max(0, kept.length - 1),
      from: boxView(from, fromId),
      to: boxView(to, toId),
      via,
      send: step.send.map((w) => itemLabel(nodes, w.from)),
      back: (step.back ?? []).map((w) => itemLabel(nodes, w.from)),
    };
    if (parallel) view.parallel = parallel;
    if (step.say !== undefined) view.say = step.say;
    const route = via === 'http' && from?.runtime === 'browser' ? routeOf(to) : undefined;
    if (route) view.request = route;
    steps.push(view);
    return [...kept, toId];
  };

  const triggerPart = b.trigger.part === undefined ? undefined : parts.get(b.trigger.part);
  let stack: string[] = [triggerPart?.box ?? b.screen];
  let group = 0;
  for (const entry of b.steps) {
    if ('parallel' in entry) {
      // 同時に呼ぶ: どの列も、分かれる前の経路から始まる。列が済んだら、分かれる前の経路に戻る
      for (const [lane, laneSteps] of entry.parallel.entries()) {
        let laneStack = [...stack];
        for (const step of laneSteps) laneStack = push(step, laneStack, { group, lane });
      }
      group++;
    } else stack = push(entry, stack);
  }

  const view: BehaviorView = {
    id: b.id,
    name: b.name,
    screen: b.screen,
    trigger: triggerPart
      ? { action: b.trigger.action, part: triggerPart }
      : { action: b.trigger.action },
    steps,
  };
  if (b.result) {
    view.result = {};
    if (b.result.say !== undefined) view.result.say = b.result.say;
    const part = b.result.part === undefined ? undefined : parts.get(b.result.part);
    if (part) view.result.part = part;
  }
  return view;
}
