// 配線図（graph.json v2）のアプリ。索引・レイアウト・たどる規則は @stack-atlas/wiring、ここは描画と入力だけ（D44）。
// SVG は場面（描く索引・配置・差分とメモの印）ごとに 1 回だけ作り（setScene）、選択・分岐・view は class の付け替え（paint）で
// 映す（docs/18 §11.3、D114）。配置を握る部品（画面の層・canvas・Player・分岐の表）は今の場面から読む。
// 部品: sceneView（場面の DOM。render = markup、paint = 塗りの計画）、interaction（クリック・hover・Esc）、
// balls（球と再生バー）・flash（項目の点滅）、variantTable（分岐の表）、canvas（無限の平面）、
// screenLayer（画面の箱の中のビルド成果物の HTML。SVG の下の iframe の層。docs/18 §3.3）、
// viewsMenu・memoCard・issuesLink（views のメニュー、メモの札、検証の一覧のリンク。docs/18 §3.4）、drawPlan（差分を足した描く graph と配置）
import type { GraphV2, ValidationIssue } from '@stack-atlas/schema';
import {
  defaultState,
  findView,
  indexGraph,
  layoutWiring,
  select,
  variantKey,
  type GraphIndex,
  type LitSelection,
  type Schedule,
  type Selection,
  type VariantState,
  type WiringLayout,
} from '@stack-atlas/wiring';
import { createAltLink, type AltLink } from '../graph/altLink';
import { h } from '../ui/dom';
import type { SharedMemoStore } from '../ui/memos';
import { layoutFlow, Player, type BallPosition, type FlowRules } from './balls';
import { createCanvas, type Canvas } from './canvas';
import { planDraw } from './drawPlan';
import { Flasher, itemTargets, pinVisible } from './flash';
import { installInteraction, TABLE } from './interaction';
import { createIssuesLink } from './issuesLink';
import { WiringMemos } from './memoCard';
import { inactiveOf, type Inactive } from './paint';
import { SceneView, type Paint, type Scene } from './sceneView';
import { ScreenLayer, type ScreenDebug } from './screenLayer';
import { renderRegions } from './screens';
import { VariantTable } from './variantTable';
import { openingFocus } from './view';
import { createViewsMenu, selectionFocus, ViewChoice, viewPick } from './viewsMenu';
import './style.css';

/** e2e・デバッグ用（window.__stackAtlas.wiring） */
export interface WiringDebug {
  readonly selection: Selection | null;
  /** 光っているもの（選択が無ければ null） */
  readonly lit: { boxes: string[]; items: string[]; wires: string[]; links: string[] } | null;
  /** 球の時刻（流れない選択なら null） */
  readonly schedule: {
    cycle: number;
    end: number;
    balls: {
      key: string;
      kind: 'wire' | 'link';
      from: string;
      to: string;
      t0: number;
      dur: number;
    }[];
  } | null;
  readonly state: VariantState;
  readonly paused: boolean;
  readonly time: number;
  readonly size: { width: number; height: number };
  readonly view: { k: number; tx: number; ty: number };
  /** 画面の層（生かしている iframe・状態・測った領域・描く領域） */
  readonly screens: ScreenDebug;
  /** views のメニューで選んでいる view の id（docs/18 §3.4） */
  readonly viewId: string | null;
  /**
   * 図の全体を作った回数（場面を当てた回数。開いた直後は 1 回。?view= で開いても 1 回）。選択・分岐・view では増えない
   * （docs/18 §11.3、D114）。メモの印が変わったとき（角を折る箱が増減）と rebuild で増える
   */
  readonly renders: number;
  /** class を付け替えた回数（選択・解除・分岐・view） */
  readonly paints: number;
  /** 待っている・走っている項目の点滅の数（解除・選び直しで 0 になる） */
  readonly flashing: { timers: number; running: number };
  /** 右下の角を折った箱（メモのある箱） */
  readonly memoBoxes: string[];
  /** 差分の印（?prev= が v2 のとき。幽霊・今だけ・型の変わった項目） */
  readonly diff: {
    ghost: { nodes: string[]; items: string[]; wires: string[] };
    added: { nodes: string[]; items: string[]; wires: string[] };
    changed: string[];
  } | null;
  select(sel: Selection | null): void;
  setVariant(nodeId: string, variantId: string, value: boolean): void;
  seek(t: number): void;
  setPaused(paused: boolean): void;
  ballPositions(): BallPosition[];
  /** 今の g.view の markup（球の層の中身は除く）。付け替えたあとと作り直したあとの等価を確かめる */
  viewHtml(): string;
  /**
   * 今の状態で場面を当て直す（全体を作り直す。選択・分岐・視点はそのまま、球は続きから）。配置の違う場面を当てる口の
   * 確かめ（折りたたみ = Q19 が使う継ぎ目）に、boxWidth で箱の幅を変えた配置、omit でその箱（と両端の線）を抜いた配置を
   * 当てられる。どちらかを渡すと元の配置から作り直す（`omit: []` で抜いた箱が戻る）
   */
  rebuild(opts?: { boxWidth?: number; omit?: string[] }): void;
}

/** 球の時刻の正（Phase 8-6、D106）。2 面のとき 3D の地図はこれを写して同じ時刻に球を動かす */
export interface WiringClock {
  /** 今の選択の球の時刻（流れない選択なら null） */
  readonly schedule: Schedule | null;
  /** 今の時刻（1 周回の中。止めていれば止めた時刻） */
  tau(now: number): number;
  /** 球が動いている（止めてもバーを動かしてもいない） */
  readonly playing: boolean;
}

export interface WiringApp {
  readonly index: GraphIndex;
  /** 今の場面の配置（場面を差し替えると変わる） */
  readonly layout: WiringLayout;
  readonly debug: WiringDebug;
  /** 今の選択と光っているもの */
  readonly selection: Selection | null;
  readonly lit: LitSelection | null;
  /** 球の時刻の正（D106） */
  readonly clock: WiringClock;
  /** 選ぶ（null で解く）。onSelectionChange を呼ぶ */
  select(sel: Selection | null): void;
  /**
   * 左上の題名の横に、隣の graph（build の graph.v1.json = 3D の地図）か、2 面の狭い画面でもう片方の面を開く小さなリンクを出す。
   * null で消す。凡例やバッジは置かない（docs/15 §3.6 の表示の規則）。文字のリンク 1 つだけ
   */
  setAltLink(link: AltLink | null): void;
  /** 選択の始点が面の外なら、倍率はそのままで始点を面の真ん中へ動かす（2 面で地図から選んだとき。docs/20 §5.1 #7） */
  reveal(): void;
  /** 面を隠す・出す（2 面の狭い画面。隠れている間は球を描かない。時刻は進む。docs/20 §5.1 #9） */
  setHidden(hidden: boolean): void;
  dispose(): void;
}

export interface WiringOptions {
  root: HTMLElement;
  graph: GraphV2;
  /** 出どころ（上端の帯に出す） */
  source: string;
  /** graph.json の URL（screen.html を解く。ファイルで開いたときは無く、画面はプレースホルダ） */
  baseUrl?: string;
  /** 検証の一覧（題名の横の「警告 N 件」から開く。D64） */
  issues?: readonly ValidationIssue[];
  /**
   * 共有メモ（memos.json ＋ このブラウザの編集）と、`serve` の API の URL。2 面のときは store を 3D の地図と共有し、
   * extraTargets（地図のノード）を孤立メモの判定と「移す…」の候補に足す（docs/20 §5.1 #12）
   */
  memos?: {
    store: SharedMemoStore;
    apiUrl?: string;
    extraTargets?: readonly { id: string; name: string }[];
  };
  /** 前回の graph（?prev=）。v2 なら差分を描き、v1 なら題名の横に「前の graph が v1 です」 */
  prev?: { v2: GraphV2 } | { v1: true };
  /** 開いた直後に当てる view の id（?view=）。開いた直後の表示はその始点のあたり */
  view?: string;
  /**
   * 開いた直後の選択（2 面の ?sel=。docs/20 §5.1 #16）。開いた直後の表示はその始点のあたり。view があれば view が勝つ。
   * 解けない選択は無視する
   */
  select?: Selection;
  /**
   * views のメニューで view を選んだ・外れた（main.ts が URL の ?view= を書き換える）。
   * opts.view が graph に無いときも、警告を出したあと null で呼ぶ（URL から外す）
   */
  onViewChange?: (id: string | null) => void;
  /**
   * 選択が変わった（クリック・Esc・views・分岐・select のどれでも）。2 面のとき 3D の地図に選択を写す（docs/20 §5.1 #6）。
   * 付け替えた後に 1 回だけ呼ぶ
   */
  onSelectionChange?: (selection: Selection | null, lit: LitSelection | null) => void;
  /** 球の時刻の基準が変わった（新しい schedule・シーク・一時停止・再生・速さ）。2 面の地図が写し直す（D106） */
  onClock?: () => void;
  /** キー（Esc・F）を受けるか。2 面のときは最後に触った面だけ（docs/20 §5.1 #8）。省略時は常に受ける */
  keys?: () => boolean;
}

const sortedSets = (s: { nodes: Set<string>; items: Set<string>; wires: Set<string> }) => ({
  nodes: [...s.nodes].sort(),
  items: [...s.items].sort(),
  wires: [...s.wires].sort(),
});

/**
 * 箱を抜いた配置（デバッグの rebuild の omit 用。索引はそのままなので線のキーは変わらない）。抜いた箱と、そこに
 * つながる線・切れている線を配置から外す
 */
function withoutBoxes(index: GraphIndex, layout: WiringLayout, omit: ReadonlySet<string>) {
  if (omit.size === 0) return layout;
  const boxes = new Map([...layout.boxes].filter(([id]) => !omit.has(id)));
  const gone = new Set(
    index.wires
      .filter((w) => omit.has(w.fromNode.node.id) || omit.has(w.toNode.node.id))
      .map((w) => w.key),
  );
  const routes = new Map([...layout.routes].filter(([key]) => !gone.has(key)));
  const plans = new Map([...layout.plans].filter(([key]) => !gone.has(key)));
  const pins = new Map(
    [...layout.pins].filter(([ref]) => !omit.has(index.items.get(ref)?.node.id ?? '')),
  );
  const broken = layout.broken.filter((b) => !gone.has(b.wire));
  return { ...layout, boxes, pins, plans, routes, broken };
}

/** graph v2 を配線図として root に描く。参照が解けない graph は indexGraph が例外を投げる */
export function mountWiring(opts: WiringOptions): WiringApp {
  const index = indexGraph(opts.graph);
  const issues: ValidationIssue[] = [...(opts.issues ?? [])];
  // 差分（docs/18 §3.4）: 前が v2 なら、今の graph に前にしか無い箱・項目・線を足した graph を 1 回だけ配置して描く。
  // 選ぶ・たどる・分岐は今の graph の索引（index）で行うので、幽霊は光らない。
  // 比べられない・足した graph を配置できないときは差分を外して描き、警告の一覧に足す（drawPlan.ts）
  const plan = planDraw(
    index,
    opts.graph,
    opts.prev && 'v2' in opts.prev ? opts.prev.v2 : undefined,
  );
  const { overlay, drawIndex } = plan;
  if (plan.issue) issues.push(plan.issue);
  let state: VariantState = defaultState(index);
  let selection: Selection | null = null;
  let lit: LitSelection | null = null;
  const initialView = opts.view ? findView(opts.graph.views, opts.view) : undefined;
  if (opts.view && !initialView)
    issues.push({
      level: 'warning',
      path: '?view',
      message: `view "${opts.view}" は graph.json の views にありません`,
    });

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'wv-svg');
  const stage = h('div', { class: 'wv-stage' });
  stage.append(svg);
  const play = h(
    'button',
    { class: 'tl', attrs: { type: 'button', 'aria-label': '一時停止' } },
    '❚❚',
  );
  const seek = h('input', {
    class: 'tl seek',
    attrs: {
      type: 'range',
      min: '0',
      max: '1',
      step: '0.01',
      value: '0',
      'aria-label': '再生位置',
    },
  });
  const speed = h('input', {
    class: 'speed-in',
    attrs: {
      type: 'range',
      min: '0.25',
      max: '4',
      step: '0.05',
      value: '1',
      'aria-label': '球の速さ',
    },
  });
  const speedLabel = h('span', { class: 'speed-v' }, '×1.0');
  play.hidden = true;
  seek.hidden = true;
  const name = opts.graph.project?.name ?? opts.source;
  const alt = createAltLink();
  const views = createViewsMenu(opts.graph.views, (id) => pickView(id));
  // 選んでいる view。ほかを選ぶ・分岐を変えると外れ、メニューは空の選択に、URL の ?view= は消える
  const choice = new ViewChoice(opts.graph.views, (id) => {
    views.set(id);
    opts.onViewChange?.(id);
  });
  const issuesLink = createIssuesLink(issues);
  const memoUi = opts.memos
    ? new WiringMemos({
        index,
        store: opts.memos.store,
        ...(opts.memos.apiUrl ? { apiUrl: opts.memos.apiUrl } : {}),
        ...(opts.memos.extraTargets ? { extraTargets: opts.memos.extraTargets } : {}),
        // 角を折る箱が増減したときだけ場面を当て直す（空 ↔ 書いた。打つたびではない）。球は続きから
        onMarksChange: () => setScene({ ...scene, memos: memoBoxes() }),
      })
    : null;
  const memoBoxes = () => memoUi?.boxIds() ?? null;
  // 今の場面（docs/18 §11.3）。8-7 では開いたときの 1 つと、メモの印が変わったときの作り直しだけ
  let scene: Scene = { index: drawIndex, layout: plan.layout, diff: overlay, memos: memoBoxes() };
  const prevNote =
    opts.prev && 'v1' in opts.prev
      ? h('span', { class: 'wv-note' }, '前の graph が v1 です')
      : null;
  const root = h(
    'div',
    { class: 'wv' },
    h(
      'div',
      { class: 'wv-top' },
      h('span', { class: 'wv-title' }, 'Stack Atlas — 配線図'),
      views.el,
      alt.el,
      issuesLink.link,
      memoUi?.orphanLink,
      prevNote,
      h('small', {}, name),
    ),
    stage,
    h('div', { class: 'wv-speed' }, play, seek, speed, speedLabel),
    memoUi?.card,
    memoUi?.orphans.el,
    issuesLink.panel,
  );
  opts.root.replaceChildren(root);

  const view = new SceneView(svg);
  const viewG = () => view.view;
  const regionsSvg = () => renderRegions(screens.specs, screens.regions(), lit);
  const screens = new ScreenLayer({
    stage,
    svg,
    index,
    layout: scene.layout,
    baseUrl: opts.baseUrl,
    // 測り終えた（か読めなかった）画面の領域の枠だけ描き直す（球と経路はそのまま）
    onRegions: () => view.setRegions(regionsSvg()),
  });
  stage.prepend(screens.el);
  const canvas: Canvas = createCanvas({
    stage,
    target: viewG,
    size: () => ({ w: scene.layout.width, h: scene.layout.height }),
    ignore: (t) => t instanceof Element && !!t.closest(TABLE),
    onApply: (v) => screens.setView(v),
  });
  // 項目の点滅: 要素は場面の Map から引き、画面に見えている項目だけ（配置の座標と canvas の表示範囲から。DOM を測らない）
  const flasher = new Flasher<Element>({
    targets: (ref) => itemTargets(view.itemParts(ref)),
    visible: (ref) => pinVisible(scene.layout.pins.get(ref), canvas.view, canvas.stageSize()),
  });
  // 球の規則（線の時間と描く球）は場面から読む。場面が決めていなければ配置の経路（配置ごとに 1 回作る）
  let flowOf: { layout: WiringLayout; rules: FlowRules } | null = null;
  const flow = (): FlowRules => {
    if (scene.flow) return scene.flow;
    if (flowOf?.layout !== scene.layout)
      flowOf = { layout: scene.layout, rules: layoutFlow(scene.layout) };
    return flowOf.rules;
  };
  const player = new Player(
    { layout: () => scene.layout, flow, balls: () => view.balls, flasher },
    { play, seek, speed, speedLabel },
    () => opts.onClock?.(),
  );
  const table = new VariantTable({
    index,
    layout: () => scene.layout,
    target: viewG,
    before: () => view.lit,
    state: () => state,
    onChange: (nodeId, vid, value) => setVariant(nodeId, vid, value),
  });

  // ポインタが最後に入った箱（選択中は明るくしない。解除したらこの箱の hover を出し直す）
  let overBox: string | null = null;
  // 全体を作ったあと・付け替えたあとに共通の後始末。塗りの計画の外に状態を残さない（docs/18 §11.3）:
  // 根の has-sel（沈める側はこれで決まる）、画面の iframe、球（前の選択の点滅は取り消す）、分岐の表、hover
  const finish = (restart: boolean) => {
    root.classList.toggle('has-sel', !!lit);
    screens.setLit(lit);
    player.setup(lit, restart);
    table.refresh();
    view.setHover(lit ? null : overBox);
  };
  // 塗りに渡す値（描く索引の語彙）: 光るものと、今の分岐に無い線・項目。選ぶのは今の graph の索引（index）で、描くのは
  // 場面の索引（差分があれば幽霊を足した索引）。id は同じなので光るものはそのまま渡す（畳んだ場面は写して渡す。docs/21 §2.3）
  let inactiveMemo: { index: GraphIndex; state: VariantState; value: Inactive } | null = null;
  const inactiveNow = (): Inactive => {
    if (inactiveMemo?.index !== scene.index || inactiveMemo.state !== state)
      inactiveMemo = { index: scene.index, state, value: inactiveOf(scene.index, state) };
    return inactiveMemo.value;
  };
  const painted = (): Paint => ({ lit, inactive: inactiveNow() });
  /**
   * 場面を当てる = 全体を作る。違う配置・索引で何度でも呼べる。今の選択と分岐を当て直し、球は周回の中の同じ割合の位置から
   * 続ける（restart なら 0 秒から）。視点は動かさない（どこを映すかは呼ぶ側が決める）
   */
  const setScene = (next: Scene, restart = false) => {
    const moved = next.layout !== scene.layout;
    scene = next;
    if (moved) screens.setLayout(scene.layout);
    view.setScene(scene, painted(), regionsSvg());
    screens.decorate();
    canvas.apply();
    finish(restart);
  };
  // 選択・分岐・view が変わった: class の付け替えだけ（要素は作り直さない）。球は 0 秒から
  const paint = () => {
    view.paint(painted(), regionsSvg());
    finish(true);
  };
  // 選択を変える（付け替えは呼ぶ側。開いた直後の ?view= は作る前に当てる）
  const applySelection = (next: Selection | null, fromView: boolean) => {
    selection = next;
    lit = next ? select(index, state, next) : null;
    if (!lit) selection = null;
    if (!fromView) choice.clear();
    memoUi?.show(selection);
  };
  const doSelect = (next: Selection | null, fromView = false) => {
    // 何も選んでいないときの解除（Esc・空白のクリック）は何も変わらないので付け替えない
    if (!next && !selection && !lit && choice.id === null) return;
    applySelection(next, fromView);
    paint();
    opts.onSelectionChange?.(selection, lit);
  };
  // 経路を計算し直して 0 秒から
  const setVariant = (nodeId: string, variantId: string, value: boolean) => {
    state = { ...state, [variantKey(nodeId, variantId)]: value };
    lit = selection ? select(index, state, selection) : null;
    choice.clear();
    paint();
    opts.onSelectionChange?.(selection, lit);
  };
  // view を選ぶ: 分岐を既定に戻して variants を当て、start から選ぶ。空の選択肢は分岐を既定に戻して選択の解除
  // （前の view の分岐を残さない）
  const applyPick = (id: string | null) => {
    const a = viewPick(index, choice.pick(id));
    state = a.state;
    applySelection(a.selection, true);
  };
  const pickView = (id: string | null) => {
    applyPick(id);
    paint();
    opts.onSelectionChange?.(selection, lit);
  };

  const wireByKey = new Map(index.wires.map((w) => [w.key, w]));
  const offInteraction = installInteraction({
    svg,
    selected: () => !!lit,
    isLitBox: (id) => !!lit && lit.boxes.has(id),
    wireEnds: (key) => {
      const w = wireByKey.get(key);
      return w ? { from: w.wire.from, to: w.wire.to } : null;
    },
    select: doSelect,
    hover: (id) => {
      overBox = id;
      if (!lit) view.setHover(id);
    },
    consumeDrag: () => canvas.consumeDrag(),
    hasVariants: (id) => !!index.nodes.get(id)?.node.variants?.length,
    tableNode: () => table.nodeId,
    showTable: (id) => table.show(id),
    hideTable: () => table.hide(),
    fitAll: () => canvas.fit(),
    ...(opts.keys ? { keys: opts.keys } : {}),
  });

  // ?view= は作る前に当て（開いた直後に全体を作るのは 1 回だけ）、その始点のあたりを映す（無ければ最初の画面の箱のあたり）。
  // graph に無い id は警告を出して URL から外す
  if (initialView) applyPick(initialView.id);
  else if (opts.view) opts.onViewChange?.(null);
  if (!initialView && opts.select) applySelection(opts.select, false);
  // 配置は graph ごとにここで 1 回だけ（選択・分岐の切り替えは付け替えるだけで、箱を動かさない。docs/18 §3.1）
  setScene(scene, true);
  canvas.open(
    (selection && selectionFocus(index, scene.layout, selection)) ||
      openingFocus(index, scene.layout),
  );

  const debug: WiringDebug = {
    get selection() {
      return selection;
    },
    get lit() {
      if (!lit) return null;
      return {
        boxes: [...lit.boxes].sort(),
        items: [...lit.items].sort(),
        wires: [...new Set([...lit.wires.values()].map((s) => s.wire!.key))].sort(),
        links: [...lit.links.keys()].sort(),
      };
    },
    get schedule() {
      const s = player.schedule;
      if (!s) return null;
      return {
        cycle: s.cycle,
        end: s.end,
        balls: s.balls.map((b) => ({
          key: b.seg.key,
          kind: b.seg.kind,
          from: b.seg.from.ref,
          to: b.seg.to.ref,
          t0: b.t0,
          dur: b.dur,
        })),
      };
    },
    get state() {
      return { ...state };
    },
    get paused() {
      return player.isPaused;
    },
    get time() {
      return player.tau(performance.now());
    },
    get size() {
      return { width: scene.layout.width, height: scene.layout.height };
    },
    get view() {
      return { ...canvas.view };
    },
    get screens() {
      return screens.debug;
    },
    get viewId() {
      return choice.id;
    },
    get renders() {
      return view.renders;
    },
    get paints() {
      return view.paints;
    },
    get flashing() {
      return flasher.pending;
    },
    get memoBoxes() {
      return memoUi ? [...memoUi.boxIds()].sort() : [];
    },
    get diff() {
      if (!overlay) return null;
      return {
        ghost: sortedSets(overlay.ghost),
        added: sortedSets(overlay.added),
        changed: [...overlay.changed].sort(),
      };
    },
    select: (sel) => doSelect(sel),
    setVariant,
    seek: (t) => player.seek(t),
    setPaused: (p) => player.setPaused(p),
    ballPositions: () => player.positions(),
    viewHtml: () => view.viewHtml(),
    rebuild: (o) => {
      if (!o?.boxWidth && !o?.omit) return setScene({ ...scene });
      const layout = o.boxWidth
        ? layoutWiring(scene.index, {
            ...(overlay ? { ghostItems: overlay.ghost.items } : {}),
            boxWidth: o.boxWidth,
          })
        : plan.layout;
      setScene({ ...scene, layout: withoutBoxes(scene.index, layout, new Set(o.omit ?? [])) });
    },
  };

  const clock: WiringClock = {
    get schedule() {
      return player.schedule;
    },
    tau: (now) => player.tau(now),
    get playing() {
      return player.isPlaying;
    },
  };

  return {
    index,
    get layout() {
      return scene.layout;
    },
    debug,
    get selection() {
      return selection;
    },
    get lit() {
      return lit;
    },
    clock,
    select: (sel) => doSelect(sel),
    setAltLink: (link) => alt.set(link),
    setHidden: (v) => player.setHidden(v),
    reveal() {
      const r = selectionFocus(index, scene.layout, selection);
      const st = stage.getBoundingClientRect();
      if (!r || st.width <= 0 || st.height <= 0) return;
      const v = canvas.view;
      const x0 = r.x * v.k + v.tx;
      const y0 = r.y * v.k + v.ty;
      const inside =
        x0 >= 0 && y0 >= 44 && x0 + r.w * v.k <= st.width && y0 + r.h * v.k <= st.height;
      if (inside) return;
      v.tx = st.width / 2 - (r.x + Math.min(r.w, st.width / v.k) / 2) * v.k;
      v.ty = Math.max(44, st.height / 2 - (r.h * v.k) / 2) - r.y * v.k;
      canvas.apply();
    },
    dispose() {
      offInteraction();
      issuesLink.dispose();
      memoUi?.dispose();
      player.dispose();
      canvas.dispose();
      screens.dispose();
      root.remove();
    },
  };
}
