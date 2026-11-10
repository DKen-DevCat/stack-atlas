// 場面の DOM（docs/18 §11.3、D114〜D116）。SVG を作るのは場面（描く索引・配置・差分とメモの印）ごとに 1 回（setScene）。
// 選択・分岐が変わったら、前の塗りの計画との差だけ class を付け替える（paint）。要素は作ったときに 1 回だけ Map に入れ、
// 付け替え・hover・点滅は querySelector を使わない。DOM を持つのはここだけで、規則は paint.ts（計画）と render.ts（markup）
import type { GraphIndex, WiringLayout } from '@stack-atlas/wiring';
import type { FlowRules } from './balls';
import {
  baseClass,
  paintedClass,
  paintPlan,
  planDiff,
  type DiffMarks,
  type Inactive,
  type PaintKind,
  type PaintLit,
  type PaintPlan,
} from './paint';
import { renderScene } from './render';

/**
 * 場面: 1 回の「全体を作る」の入力。配置を握る部品（画面の層・canvas・Player・分岐の表）は今の場面から読む。
 * 折りたたみ（Q19）は配置と描く索引の違う場面を当て直す
 */
export interface Scene {
  /** 描く索引（差分があれば幽霊を足した graph の索引） */
  readonly index: GraphIndex;
  readonly layout: WiringLayout;
  /** 差分の印（無ければ null） */
  readonly diff: DiffMarks | null;
  /** メモのある箱（右下の角を折る）。無ければ null */
  readonly memos: ReadonlySet<string> | null;
  /** 球の規則（線の時間と描く球）。省くと配置の経路（balls.ts の layoutFlow）。折りたたみが差し替える（docs/21 §2.3） */
  readonly flow?: FlowRules;
}

/**
 * 付け替えで変わるもの。どちらも描く索引の語彙の値（選ぶ・分岐を解くのは呼ぶ側。選ぶ索引は描く索引と違ってよい）:
 * 光るものと、今の分岐に無い線・項目
 */
export interface Paint {
  readonly lit: PaintLit | null;
  readonly inactive: Inactive;
}

/** 付け替える要素と、選択・分岐に依らない class */
interface Painted {
  readonly el: Element;
  readonly base: string;
}

type Els = Record<PaintKind, Map<string, Painted[]>>;

const emptyEls = (): Els => ({
  boxes: new Map(),
  hosts: new Map(),
  items: new Map(),
  wires: new Map(),
  broken: new Map(),
});

export class SceneView {
  /** 全体を作った回数（setScene） */
  renders = 0;
  /** 付け替えた回数（paint） */
  paints = 0;
  private scene: Scene | null = null;
  private plan: PaintPlan | null = null;
  private regions = '';
  private els: Els = emptyEls();
  /** 箱 id → その箱に出入りする基の線（hover で一緒に明るくする） */
  private wiresByBox = new Map<string, Element[]>();
  private hover: { id: string; els: Element[] } | null = null;
  private viewEl: SVGGElement | null = null;
  private baseLayer: Element | null = null;
  private litLayer: Element | null = null;
  private regionsLayer: Element | null = null;
  private ballsLayer: SVGGElement | null = null;

  constructor(private readonly svg: SVGSVGElement) {}

  /** `<g class="view">`（canvas の変換を当てる。分岐の表を置く） */
  get view(): SVGGElement | null {
    return this.viewEl;
  }
  /** 光る線の層（分岐の表の橋はこの直前に入れる） */
  get lit(): Element | null {
    return this.litLayer;
  }
  /** 球の層 */
  get balls(): SVGGElement | null {
    return this.ballsLayer;
  }

  /**
   * 場面を当てる = 全体を作る。何度でも呼べる（違う配置・索引でも）。要素の Map と前の計画は必ず作り直す。
   * hover は消える（呼ぶ側が出し直す）。視点（g.view の transform）は呼ぶ側が当て直す
   */
  setScene(scene: Scene, paint: Paint, regions: string): void {
    this.renders++;
    const plan = paintPlan({ ...scene, ...paint });
    this.svg.innerHTML = `<g class="view">${renderScene({
      index: scene.index,
      layout: scene.layout,
      regions,
      plan,
      ...(scene.memos ? { memos: scene.memos } : {}),
      ...(scene.diff ? { diff: scene.diff } : {}),
    })}</g>`;
    this.scene = scene;
    this.plan = plan;
    this.regions = regions;
    this.hover = null;
    this.collect(scene, plan);
  }

  /**
   * 付け替える: 前の計画との差だけ class を当て、光る線の層を作り直し、切れた線を層の間で移す。
   * 最初に hover を外す（選択中は hover が効かない。呼ぶ側が、選択が無ければ出し直す）
   */
  paint(paint: Paint, regions: string): void {
    const scene = this.scene;
    const prev = this.plan;
    if (!scene || !prev) return;
    this.paints++;
    this.setHover(null);
    const next = paintPlan({ ...scene, ...paint });
    for (const op of planDiff(prev, next))
      for (const p of this.els[op.kind].get(op.id) ?? [])
        p.el.setAttribute('class', paintedClass(p.base, op.cls));
    this.relayer(scene, prev, next);
    this.plan = next;
    this.setRegions(regions);
  }

  /** 部品の領域の枠（層の中身だけ。変わったときだけ作り直す） */
  setRegions(regions: string): void {
    if (regions === this.regions) return;
    this.regions = regions;
    if (this.regionsLayer) this.regionsLayer.innerHTML = regions;
  }

  /** 箱とその線を少し明るくする（null で消す）。選択中に呼ばないのは呼ぶ側の責任 */
  setHover(id: string | null): void {
    if ((this.hover?.id ?? null) === id) return;
    if (this.hover) for (const el of this.hover.els) el.classList.remove('hov');
    this.hover = null;
    if (id === null) return;
    const box = this.els.boxes.get(id)?.[0]?.el;
    if (!box) return;
    const els = [box, ...(this.wiresByBox.get(id) ?? [])];
    for (const el of els) el.classList.add('hov');
    this.hover = { id, els };
  }

  /**
   * 付け替える要素を場面の外から引く（箱・host・項目・線・切れた線。id は描く索引の語彙。無ければ null）。
   * 現れた箱を 1 回光らせる、などに使う（querySelector を使わない）
   */
  el(kind: PaintKind, id: string): Element | null {
    return this.els[kind].get(id)?.[0]?.el ?? null;
  }

  /** 項目のピンと文字（点滅させる要素。ピンは行の最後の子、文字はその直前） */
  itemParts(ref: string): { pin: Element | null; text: Element | null } | null {
    const el = this.els.items.get(ref)?.[0]?.el;
    if (!el) return null;
    const pin = el.lastElementChild;
    return { pin, text: pin?.previousElementSibling ?? null };
  }

  /**
   * 今の g.view の markup（球の層の中身は除く。球は時刻で動く）。付け替えたあとと作り直したあとが同じことを
   * 確かめるための口（e2e・デバッグ）
   */
  viewHtml(): string {
    if (!this.viewEl) return '';
    const copy = this.viewEl.cloneNode(true) as Element;
    copy.querySelector(':scope > g.balls')?.replaceChildren();
    return copy.outerHTML;
  }

  /** 要素を 1 回だけ Map に入れる。base は markup の class から計画の class を除いたもの */
  private collect(scene: Scene, plan: PaintPlan): void {
    const view = this.svg.querySelector<SVGGElement>(':scope > g.view');
    const layer = (name: string) => view?.querySelector(`:scope > g.${name}`) ?? null;
    this.viewEl = view;
    this.baseLayer = layer('base-wires');
    this.litLayer = layer('lit-wires');
    this.regionsLayer = layer('regions');
    this.ballsLayer = layer('balls') as SVGGElement | null;
    const els = emptyEls();
    const add = (kind: PaintKind, id: string | undefined, el: Element) => {
      if (id === undefined) return;
      const base = baseClass(el.getAttribute('class') ?? '', plan, kind, id);
      const list = els[kind].get(id);
      if (list) list.push({ el, base });
      else els[kind].set(id, [{ el, base }]);
    };
    const each = (sel: string, fn: (el: SVGElement) => void) =>
      view?.querySelectorAll<SVGElement>(sel).forEach(fn);
    each(':scope > g.hosts > [data-host]', (el) => add('hosts', el.dataset.host, el));
    each(':scope > g.boxes > [data-box]', (el) => add('boxes', el.dataset.box, el));
    each(':scope > g.boxes > [data-box] > [data-item]', (el) => add('items', el.dataset.item, el));
    each(':scope > g.base-wires > [data-key]', (el) => add('wires', el.dataset.key, el));
    // 切れた線（線と、切れた端の印）は基の層か光る線の層にある
    each(':scope > g > [data-broken]', (el) => add('broken', el.dataset.broken, el));
    each(':scope > g > [data-cut]', (el) => add('broken', el.dataset.cut, el));
    this.els = els;

    const byBox = new Map<string, Element[]>();
    const link = (box: string, el: Element) => {
      const list = byBox.get(box);
      if (list) list.push(el);
      else byBox.set(box, [el]);
    };
    for (const w of scene.index.wires) {
      const el = els.wires.get(w.key)?.[0]?.el;
      if (!el) continue;
      link(w.fromNode.id, el);
      if (w.toNode.id !== w.fromNode.id) link(w.toNode.id, el);
    }
    this.wiresByBox = byBox;
  }

  /** 光る線の層に置く切れた線（選択中に lit のもの。配置の順） */
  private top(scene: Scene, plan: PaintPlan): string[] {
    if (!plan.hasSel) return [];
    return scene.layout.broken.filter((b) => plan.broken.has(b.key)).map((b) => b.key);
  }

  /**
   * 光る線の層を次の計画に合わせる。層の中身（光る区間・当たり判定）は文字列が変わったときだけ作り直す。
   * 切れた線は写しを作らず要素ごと移す（全体を作ったときと同じ順になるよう、基の層の分も配置の順に並べ直す）
   */
  private relayer(scene: Scene, prev: PaintPlan, next: PaintPlan): void {
    const base = this.baseLayer;
    const lit = this.litLayer;
    if (!base || !lit) return;
    const was = this.top(scene, prev);
    const now = this.top(scene, next);
    const sameTop = was.length === now.length && was.every((k, i) => k === now[i]);
    if (sameTop && prev.litWires === next.litWires) return;
    const elsOf = (key: string) => (this.els.broken.get(key) ?? []).map((p) => p.el);
    // innerHTML で消されないよう、光る線の層にいる切れた線を先に外す
    for (const key of was) for (const el of elsOf(key)) el.remove();
    if (prev.litWires !== next.litWires) lit.innerHTML = next.litWires;
    if (!sameTop) {
      const onTop = new Set(now);
      for (const b of scene.layout.broken)
        if (!onTop.has(b.key)) for (const el of elsOf(b.key)) base.append(el);
    }
    for (const key of now) for (const el of elsOf(key)) lit.append(el);
  }
}
