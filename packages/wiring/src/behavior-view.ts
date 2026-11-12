/**
 * 挙動（graph.json v2 の behaviors。Phase 10、docs/26 §4）を、見せるための形にする: 段ごとに、どの箱からどの箱へ、何を送り、何が返るか。
 * ビューア（挙動の経路を上から下へ並べる面。docs/25 §3.5）が使う。純粋な計算で、DOM も、対象のコードも見ない。
 *
 * 検査を通った graph を前提にする（解けない線の段は、飛ばさずに、分かる範囲で出す）。
 * 段のたどり方と、経路の進め方は、検査（@stack-atlas/schema の checkBehaviors）と同じ関数を使う（決まりを 2 か所に書かない）
 */
import {
  WIRE_VIAS,
  advancePath,
  behaviorStartBox,
  parseItemRef,
  walkBehavior,
  wireKey,
  wireRefBoxes,
  type BehaviorV2,
  type GraphV2,
  type ItemV2,
  type NodeV2,
  type PartV2,
  type TriggerAction,
  type When,
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
  /** 送る線の運び方（重複なし。契約の語彙の順）。1 つの段の線は、ふつうは同じ運び方。解けない線は数えない */
  vias: WireVia[];
  /** 送るもの・返るものの名前（項目の name を、親から `.` でつないだもの） */
  send: string[];
  back: string[];
  say?: string;
  /** この段が通るときの分岐（キーは `<箱 id>#<分岐 id>`） */
  when?: When;
  /**
   * 画面の側（runtime: browser）から、受け口（meta.route のある箱）へ、通信（via: http）で出る段なら、そのメソッドとパス。
   * ライブ（docs/25 D206）は、この段だけを「実際に見える段」として、ブラウザから出た通信と照らす。
   * 照らすためだけの値で、道具がこの値で通信を送ることはない
   */
  request?: { method: string; path: string };
}

export interface BehaviorView {
  id: string;
  name: string;
  /** 挙動の画面の箱。始まりの部品と、変わる部品は、別の画面の部品のこともある（部品の screen を見る。docs/26 §4） */
  screen: string;
  trigger: { action: TriggerAction; part?: PartV2 };
  steps: StepView[];
  result?: { say?: string; part?: PartV2 };
  /** この挙動が起こせるときの分岐（キーは `<箱 id>#<分岐 id>`） */
  when?: When;
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

/**
 * 箱の meta.route を、メソッドとパスに分ける。書き方は 2 つ（`"POST /items"` と `{ method: "POST", path: "/items" }`）。
 * メソッドの無いもの・読めないものは、照らす相手にしない（undefined）
 */
export function nodeRoute(n: NodeV2 | undefined): { method: string; path: string } | undefined {
  const route: unknown = n?.meta?.route;
  if (typeof route === 'string') {
    const m = /^([A-Za-z]+)\s+(\S.*)$/.exec(route.trim());
    return m ? { method: m[1]!.toUpperCase(), path: m[2]! } : undefined;
  }
  if (typeof route !== 'object' || route === null) return undefined;
  const { method, path } = route as { method?: unknown; path?: unknown };
  if (typeof method !== 'string' || typeof path !== 'string') return undefined;
  const m = /^[A-Za-z]+$/.exec(method.trim());
  return m && path.trim() ? { method: m[0].toUpperCase(), path: path.trim() } : undefined;
}

/**
 * 挙動を、見せるための段の列にする。graph に、その id の挙動が無ければ undefined
 */
export function behaviorView(graph: GraphV2, behaviorId: string): BehaviorView | undefined {
  const b: BehaviorV2 | undefined = graph.behaviors?.find((x) => x.id === behaviorId);
  if (!b) return undefined;
  const nodes = new Map(graph.nodes.map((n) => [n.id, n] as const));
  const viaOf = new Map(graph.wires.map((w) => [wireKey(w), w.via] as const));
  const parts = new Map((graph.parts ?? []).map((p) => [p.id, p] as const));

  const steps: StepView[] = [];
  const start = behaviorStartBox(b, (id) => parts.get(id)?.box) ?? b.screen;
  walkBehavior<readonly string[]>(b, [start], (path, step, place) => {
    // 検査を通った graph では、送る線は 1 つの箱から 1 つの箱へ出る。そうでない段は、先に書かれた箱で出す
    const ends = wireRefBoxes(step.send);
    const fromId = [...ends.froms][0] ?? '';
    const toId = [...ends.tos][0] ?? '';
    // 出る箱が経路に無い段（検査が誤りにする段）は、経路を捨てずに、いちばん先に足す
    const next = advancePath(path, fromId, toId) ?? [...path, toId];
    const from = nodes.get(fromId);
    const to = nodes.get(toId);
    const used = new Set(step.send.map((w) => viaOf.get(wireKey(w))));
    const vias = WIRE_VIAS.filter((v) => used.has(v));
    const view: StepView = {
      index: steps.length,
      depth: next.length - 2,
      from: boxView(from, fromId),
      to: boxView(to, toId),
      vias,
      send: step.send.map((w) => itemLabel(nodes, w.from)),
      back: (step.back ?? []).map((w) => itemLabel(nodes, w.from)),
    };
    if (place.parallel) view.parallel = place.parallel;
    if (step.say !== undefined) view.say = step.say;
    if (step.when !== undefined) view.when = { ...step.when };
    const route = vias.includes('http') && from?.runtime === 'browser' ? nodeRoute(to) : undefined;
    if (route) view.request = route;
    steps.push(view);
    return next;
  });

  const triggerPart = b.trigger.part === undefined ? undefined : parts.get(b.trigger.part);
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
  if (b.when !== undefined) view.when = { ...b.when };
  return view;
}
