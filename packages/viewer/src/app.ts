/**
 * Viewer: 1 つの graph を描画し、操作を受け付ける。
 * 状態は state.ts の ViewState に集め、見た目は computeVisuals() の結果を three.js / DOM に反映する。
 */
import type { Flow, Graph, GraphNode } from '@stack-atlas/schema';
import {
  describeChange,
  diffGraphs,
  diffMarks,
  diffPillText,
  diffPillTitle,
  type DiffMarks,
  type GraphDiff,
} from './graph/diff';
import type { GraphModel } from './graph/model';
import { resolveAssetUrl, type LoadResult } from './graph/load';
import { placeGhosts, plateWithGhosts } from './layout/ghosts';
import { computeSceneLayout, layerGapFor, sceneScaleFor } from './layout/plate';
import { CameraAnimator } from './scene/camera';
import {
  applyEdgeVisual,
  createSceneEdges,
  updateEdgeGeometry,
  type SceneEdge,
} from './scene/edges';
import {
  addDiffBadge,
  applyDiffMark,
  createGhosts,
  createRemovedEdges,
  refreshDashes,
  setGhostVisual,
  setRemovedEdgeVisual,
  type GhostSceneNode,
} from './scene/diff';
import { FlowAnimator } from './scene/flow';
import {
  anchor,
  createSceneNodes,
  positionNodes,
  setNodeObjectVisible,
  setNodeVisual,
  type SceneNode,
  type ScreenSceneNode,
} from './scene/nodes';
import { pickNode } from './scene/picking';
import { createPlates, positionPlates } from './scene/plates';
import { createSceneContext, type SceneContext } from './scene/renderer';
import {
  computeVisuals,
  highlightTarget,
  initialState,
  isNodeShown,
  type LabelMode,
  type ViewState,
} from './state';
import { h } from './ui/dom';
import { createFlowPill, type FlowPill } from './ui/flowPill';
import { createLayerChips } from './ui/layerChips';
import { alwaysLabelLayers, applyLabelDisplay, labelMode, makeNodeLabel } from './ui/labels';
import { createLegend } from './ui/legend';
import {
  downloadMemos,
  orphanIds,
  saveMemosToServer,
  UNSUPPORTED_SAVE_MESSAGE,
  type LocalShotStore,
  type SharedMemoStore,
} from './ui/memos';
import { OrphanList } from './ui/orphans';
import { Panel, type ScreenInfo } from './ui/panel';
import { createKindChips, createSearchBox, type SearchBox } from './ui/search';
import { createTopbar, type Topbar } from './ui/topbar';
import type * as THREE from 'three';

export interface ViewerOptions {
  root: HTMLElement;
  model: GraphModel;
  load: LoadResult;
  memos: SharedMemoStore;
  /** `GET /api/memos` が使えたときの API の URL（「サーバーに保存」を出す） */
  memoApiUrl?: string;
  shots: LocalShotStore;
  /** 差分表示の比較元（?prev= か「前回と比較…」） */
  prev?: Graph;
  onOpenFile(f: File): void;
  onOpenPrev(f: File): void;
}

const isTouch = () => window.matchMedia('(hover: none)').matches;

export class Viewer {
  readonly el: HTMLElement;
  private readonly model: GraphModel;
  private readonly state: ViewState;
  private readonly ctx: SceneContext;
  private readonly plates: THREE.Group[];
  private readonly nodes: Map<string, SceneNode>;
  private readonly screens: ScreenSceneNode[];
  private readonly edges: SceneEdge[];
  private readonly flow: FlowAnimator;
  private readonly cam: CameraAnimator;
  private readonly topbar: Topbar;
  private readonly panel: Panel;
  private readonly pill: FlowPill;
  private readonly orphans: OrphanList;
  private readonly diff: GraphDiff | null;
  private readonly marks: DiffMarks | null;
  private readonly prevNodes: ReadonlyMap<string, GraphNode>;
  private readonly ghosts: Map<string, GhostSceneNode> = new Map();
  private removedEdges: SceneEdge[] = [];
  private memoApiUrl: string | undefined;
  private readonly search: SearchBox;
  private readonly layerGap: number;
  private readonly sceneScale: number;
  private readonly alwaysLabel: ReadonlySet<number>;
  private lastLod = 0;
  private readonly plateSize: { width: number; depth: number };
  private explode = 1;
  private screenKey = '';
  private raf = 0;
  private disposed = false;
  private readonly cleanups: (() => void)[] = [];

  constructor(private readonly opts: ViewerOptions) {
    const { model, load } = opts;
    this.model = model;
    this.state = initialState(model.layers.length, model.nodes.length);
    this.alwaysLabel = alwaysLabelLayers(model.nodes);
    this.diff = opts.prev ? diffGraphs(opts.prev, model.graph) : null;
    this.marks = this.diff ? diffMarks(this.diff) : null;
    this.prevNodes = new Map((opts.prev?.nodes ?? []).map((n) => [n.id, n]));
    this.memoApiUrl = opts.memoApiUrl;

    const stage = h('div', { class: 'stage' });
    const labels = h('div', { class: 'labels' });
    this.search = createSearchBox({
      nodes: model.nodes.map((n) => ({ id: n.id, name: n.node.name, file: n.node.file })),
      onMatches: (ids) => {
        this.state.searchMatches = ids ? new Set(ids) : null;
        this.applyState();
      },
      onJump: (id) => this.select(id, true),
    });
    this.topbar = createTopbar({
      labelMode: this.state.labelMode,
      onLabelMode: (m) => this.setLabelMode(m),
      search: this.search.el,
      ...(model.graph.project?.name ? { projectName: model.graph.project.name } : {}),
      ...(model.graph.project?.sources ? { sources: model.graph.project.sources } : {}),
      flows: model.flows,
      onExplode: (v) => (this.state.explodeTarget = v),
      onFlow: (id) => this.setFlow(id),
      onCache: (on) => {
        this.state.cacheOn = on;
        this.el.classList.toggle('cache-on', on);
        this.applyState();
      },
      onReset: () => this.cam.reset(this.ctx.home()),
      onOpenFile: (f) => opts.onOpenFile(f),
      onOpenPrev: (f) => opts.onOpenPrev(f),
      ...(this.diff
        ? { diff: { text: diffPillText(this.diff), title: diffPillTitle(this.diff) } }
        : {}),
      onDiffToggle: (on) => {
        this.state.diffOn = on;
        this.el.classList.toggle('diff-on', on);
        this.applyState();
        if (this.panel.openId) this.updatePanelDiff(this.panel.openId);
      },
      onOrphans: () => this.toggleOrphans(),
    });
    this.pill = createFlowPill();
    this.panel = new Panel(model, {
      onClose: () => this.clearSelection(),
      onJump: (id) => this.select(id, true),
      onFocus: (id) => this.focusOn(id),
      onMemo: (id, text) => {
        opts.memos.set(id, text);
        this.panel.setMemoStatus(opts.memos.status(id));
        this.panel.setSaveMessage('');
        this.refreshMemoBadges();
      },
      onExportMemos: () => downloadMemos(opts.memos.all()),
      onSaveMemos: () => void this.saveMemos(),
      onShot: (id, f) => this.replaceShot(id, f),
      onShotReset: (id) => this.resetShot(id),
    });
    this.panel.setCanSave(!!this.memoApiUrl);
    this.orphans = new OrphanList(
      model.nodes.map((n) => ({ id: n.id, name: n.node.name })),
      {
        onDelete: (id) => {
          opts.memos.set(id, '');
          this.refreshMemoBadges();
        },
        onMove: (from, to) => {
          opts.memos.move(from, to);
          this.refreshMemoBadges();
          if (this.panel.openId === to) this.select(to);
        },
        onExport: () => downloadMemos(opts.memos.all()),
        onClose: () => this.orphans.hide(),
      },
    );
    this.el = h(
      'div',
      { class: `viewer${this.diff ? ' diff-on' : ''}` },
      stage,
      labels,
      this.topbar.el,
      h(
        'div',
        { class: 'left' },
        createLayerChips(model.layers, (i, v) => {
          this.state.layerVisible[i] = v;
          const p = this.plates[i];
          if (p) p.visible = v;
          this.applyState();
        }),
        createKindChips(model.nodes, (kind, v) => {
          this.state.kindVisible[kind] = v;
          this.applyState();
        }),
      ),
      createLegend(model.layers),
      this.pill.el,
      this.panel.el,
      this.orphans.el,
    );
    opts.root.append(this.el);

    // ---- シーン ----
    const layout = computeSceneLayout(model);
    const ghostPlaces =
      this.diff && opts.prev
        ? placeGhosts(model, layout.positions, opts.prev, this.diff.removedNodes)
        : new Map<string, { x: number; z: number; layerIndex: number }>();
    layout.plate = plateWithGhosts(layout.plate, ghostPlaces.values());
    this.layerGap = layerGapFor(layout.plate.depth);
    this.sceneScale = sceneScaleFor(layout.plate, model.layers.length, this.layerGap);
    this.ctx = createSceneContext(
      stage,
      labels,
      this.sceneScale,
      layout.plate.width / layout.plate.depth,
    );
    this.plateSize = layout.plate;
    this.plates = createPlates(this.ctx.scene, model.layers, layout.plate);
    this.nodes = createSceneNodes(model.nodes, {
      scene: this.ctx.scene,
      maxAnisotropy: this.ctx.maxAnisotropy,
      positions: layout.positions,
      screenshotUrl: (n) => resolveAssetUrl(n.screen?.screenshot, load.baseUrl),
      nameOf: (id) => model.byId.get(id)?.node.name ?? id,
      makeLabel: (n) => {
        const l = makeNodeLabel(n);
        this.bindLabel(l.el, n.id);
        return l;
      },
    });
    this.screens = [...this.nodes.values()].filter(
      (n): n is ScreenSceneNode => n.type === 'screen',
    );
    this.edges = createSceneEdges(model, this.nodes, this.ctx.scene);
    if (this.diff) {
      for (const [id, g] of createGhosts(this.ctx.scene, this.prevNodes, ghostPlaces))
        this.ghosts.set(id, g);
      this.removedEdges = createRemovedEdges(
        this.diff.removedEdges,
        (id) => this.nodes.get(id) ?? this.ghosts.get(id),
        this.ctx.scene,
      );
      for (const id of this.diff.addedNodes) {
        const sn = this.nodes.get(id);
        if (sn) addDiffBadge(sn, 'added');
      }
      for (const c of this.diff.changedNodes) {
        const sn = this.nodes.get(c.id);
        if (sn) addDiffBadge(sn, 'changed', c.fields);
      }
    }
    this.flow = new FlowAnimator(this.ctx.scene, this.nodes, (f, step) =>
      this.showFlowStep(f, step),
    );
    this.cam = new CameraAnimator(this.ctx.camera, this.ctx.controls);

    this.bindPointer();
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      const typing =
        t instanceof HTMLTextAreaElement ||
        t instanceof HTMLInputElement ||
        (t instanceof HTMLElement && t.isContentEditable);
      if (typing) return;
      if (e.key === 'Escape') {
        if (this.search.matches) this.search.clear();
        this.clearSelection();
      } else if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        this.search.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    this.cleanups.push(() => window.removeEventListener('keydown', onKey));

    this.restoreShots();
    this.refreshMemoBadges();
    this.layout();
    this.applyState();
    this.updateLabelLod(true);
    // スクショは初回描画のあとに読み込む（遅延読み込み）
    window.setTimeout(() => this.screens.forEach((s) => s.screen.load()), 0);
    void document.fonts?.ready.then(() => {
      if (!this.disposed) this.screens.forEach((s) => s.screen.redraw());
    });
    this.raf = requestAnimationFrame(this.loop);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.cleanups.forEach((f) => f());
    this.ctx.dispose();
    this.el.remove();
  }

  // ---------------------------------------------------------------- state

  private applyState(): void {
    const v = computeVisuals(this.model, this.state, this.marks);
    for (const [id, nv] of v.nodes) {
      const sn = this.nodes.get(id);
      if (!sn) continue;
      setNodeObjectVisible(sn, nv.visible);
      setNodeVisual(sn, nv.visual);
      if (this.marks) applyDiffMark(sn, nv.diff);
      if (sn.ring) {
        sn.ring.visible = nv.ringVisible;
        sn.ring.material.opacity = nv.ringOpacity;
      }
    }
    for (const se of this.edges) {
      const ev = v.edges[se.index];
      if (ev) applyEdgeVisual(se, ev);
    }
    const layerOn = (i: number) => this.state.layerVisible[i] ?? true;
    for (const g of this.ghosts.values())
      setGhostVisual(g, v.ghostOpacity, layerOn(g.m.layerIndex));
    for (const se of this.removedEdges) {
      setRemovedEdgeVisual(se, v.ghostOpacity, (n) => layerOn(n.m.layerIndex));
    }
    // 画面テクスチャはハイライト対象（と層・kind の表示）が変わったときだけ描き直す
    const kinds = Object.entries(this.state.kindVisible)
      .filter(([, on]) => !on)
      .map(([k]) => k)
      .join(',');
    const key = `${v.hl.a ?? ''}|${this.state.layerVisible.join(',')}|${kinds}`;
    if (key !== this.screenKey) {
      this.screenKey = key;
      const isVisible = (id: string) => this.isNodeVisible(id);
      for (const s of this.screens) s.screen.render({ hl: v.hl, isVisible });
    }
    this.lastVisuals = v;
    this.updateLabelLod(true);
  }

  private lastVisuals: ReturnType<typeof computeVisuals> | null = null;

  /**
   * ラベルの LOD（ui/labels.ts の labelMode）。カメラからの距離で判定するので、
   * 描画ループから 200ms に 1 回、state が変わったときは即座に反映する
   */
  private updateLabelLod(force = false): void {
    const now = performance.now();
    if (!force && now - this.lastLod < 200) return;
    this.lastLod = now;
    const v = this.lastVisuals;
    if (!v) return;
    const n = this.nodes.size;
    const cam = this.ctx.camera.position;
    const mode = this.state.labelMode;
    for (const sn of this.nodes.values()) {
      const nv = v.nodes.get(sn.m.id);
      if (!nv) continue;
      const obj = sn.type === 'screen' ? sn.pivot : sn.hit;
      const d = mode === 'all' && n > 80 ? obj.position.distanceTo(cam) : 0;
      applyLabelDisplay(
        sn.label,
        labelMode(n, d, {
          mode,
          visual: nv.visual,
          alwaysLayer: this.alwaysLabel.has(sn.m.layerIndex),
          sceneScale: this.sceneScale,
        }),
      );
    }
  }

  private setLabelMode(m: LabelMode): void {
    this.state.labelMode = m;
    this.topbar.setLabelMode(m);
    this.updateLabelLod(true);
  }

  private isNodeVisible(id: string): boolean {
    const n = this.model.byId.get(id);
    return !!n && isNodeShown(this.state, n);
  }

  private layout(): void {
    positionPlates(this.plates, this.explode, this.layerGap);
    positionNodes(this.nodes.values(), this.model.layers.length, this.explode, this.layerGap);
    positionNodes(this.ghosts.values(), this.model.layers.length, this.explode, this.layerGap);
    this.ctx.scene.updateMatrixWorld(true);
    updateEdgeGeometry(this.edges);
    if (this.removedEdges.length) {
      updateEdgeGeometry(this.removedEdges);
      refreshDashes(this.removedEdges);
    }
    this.flow.rebuild();
  }

  /** ホバー対象を変える（ラベルの mouseenter／レイキャスト／e2e の計測から呼ぶ） */
  hover(id: string | null): void {
    if (id === this.state.hoverId) return;
    this.state.hoverId = id;
    this.applyState();
  }

  select(id: string, fly = false): void {
    const n = this.model.byId.get(id);
    if (!n) return;
    this.state.selectedId = id;
    this.state.hoverId = null;
    this.panel.open(n, this.opts.memos.get(id), this.screenInfo(id));
    this.panel.setMemoStatus(this.opts.memos.status(id));
    this.panel.setSaveMessage('');
    this.updatePanelDiff(id);
    if (fly) this.focusOn(id);
    this.applyState();
  }

  private clearSelection(): void {
    this.state.selectedId = null;
    this.panel.close();
    this.applyState();
  }

  private focusOn(id: string): void {
    const sn = this.nodes.get(id);
    if (!sn) return;
    this.cam.focus(anchor(sn), sn.type === 'screen' ? 14 : 24);
  }

  private setFlow(id: string | null): void {
    const f = id ? (this.model.flows.find((x) => x.id === id) ?? null) : null;
    this.state.flowId = f?.id ?? null;
    this.flow.set(f, performance.now());
    if (!f) this.pill.hide();
    this.applyState();
  }

  private showFlowStep(f: Flow, step: number): void {
    const s = f.steps[step];
    this.pill.show(f, step, (s && this.model.byId.get(s.node)?.node.name) ?? '');
  }

  private refreshMemoBadges(): void {
    for (const sn of this.nodes.values()) {
      sn.memoBadge.textContent = this.opts.memos.get(sn.m.id) ? '📝' : '';
    }
    this.refreshOrphans();
  }

  // ---------------------------------------------------------------- memos (Phase 5)

  private orphanItems(): { id: string; text: string }[] {
    const all = this.opts.memos.all();
    return orphanIds(all, new Set(this.model.byId.keys())).map((id) => ({
      id,
      text: all[id] ?? '',
    }));
  }

  private refreshOrphans(): void {
    const items = this.orphanItems();
    this.topbar.setOrphanCount(items.length);
    if (!this.orphans.isOpen) return;
    if (items.length) this.orphans.render(items);
    else this.orphans.hide();
  }

  private toggleOrphans(): void {
    if (this.orphans.isOpen) this.orphans.hide();
    else this.orphans.show(this.orphanItems());
  }

  private async saveMemos(): Promise<void> {
    const url = this.memoApiUrl;
    if (!url) return;
    const memos = { ...this.opts.memos.all() };
    this.panel.setSaveMessage('保存中…');
    const r = await saveMemosToServer(url, memos);
    if (this.disposed) return;
    if (r.ok) {
      this.opts.memos.setShared(memos);
      this.panel.setSaveMessage(
        `サーバーに保存しました（${r.count} 件、リポジトリの .stack-atlas/memos.json）`,
        'ok',
      );
    } else {
      if (r.unsupported) {
        this.memoApiUrl = undefined;
        this.panel.setCanSave(false);
      }
      this.panel.setSaveMessage(r.unsupported ? UNSUPPORTED_SAVE_MESSAGE : r.message, 'error');
    }
    const id = this.panel.openId;
    if (id) this.panel.setMemoStatus(this.opts.memos.status(id));
  }

  private updatePanelDiff(id: string): void {
    if (!this.diff || !this.state.diffOn) return this.panel.setDiffInfo(null);
    if (this.marks?.added.has(id)) {
      return this.panel.setDiffInfo({
        mark: 'added',
        text: '追加: 前回の graph.json に無かったノード',
      });
    }
    const fields = this.marks?.changed.get(id);
    if (fields) {
      const next = this.model.byId.get(id)?.node;
      return this.panel.setDiffInfo({
        mark: 'changed',
        text: `変更: ${describeChange(this.prevNodes.get(id), next, fields)}`,
      });
    }
    this.panel.setDiffInfo(null);
  }

  // ---------------------------------------------------------------- screenshots

  private screenInfo(id: string): ScreenInfo | null {
    const sn = this.nodes.get(id);
    if (!sn || sn.type !== 'screen') return null;
    const path = sn.m.screen?.screenshot;
    return {
      ...(path ? { path } : {}),
      state: sn.screen.imageState,
      overridden: sn.screen.hasOverride,
      unresolved: !!path && !resolveAssetUrl(path, this.opts.load.baseUrl),
    };
  }

  private restoreShots(): void {
    for (const s of this.screens) {
      const data = this.opts.shots.get(s.m.id);
      if (!data) continue;
      const im = new Image();
      im.onload = () => !this.disposed && s.screen.setOverride(im);
      im.src = data;
    }
  }

  private replaceShot(id: string, f: File): void {
    const sn = this.nodes.get(id);
    if (!sn || sn.type !== 'screen') return;
    const url = URL.createObjectURL(f);
    const im = new Image();
    im.onload = () => {
      // localStorage に入るよう 1280px に縮めて JPEG にする（プロトタイプと同じ）
      const s = Math.min(1, 1280 / im.width);
      const tc = document.createElement('canvas');
      tc.width = Math.round(im.width * s);
      tc.height = Math.round(im.height * s);
      tc.getContext('2d')?.drawImage(im, 0, 0, tc.width, tc.height);
      const data = tc.toDataURL('image/jpeg', 0.82);
      URL.revokeObjectURL(url);
      this.opts.shots.set(id, data);
      const im2 = new Image();
      im2.onload = () => {
        sn.screen.setOverride(im2);
        this.updatePanelScreenInfo(id);
      };
      im2.src = data;
    };
    im.src = url;
  }

  private resetShot(id: string): void {
    const sn = this.nodes.get(id);
    if (!sn || sn.type !== 'screen') return;
    this.opts.shots.remove(id);
    sn.screen.setOverride(null);
    this.updatePanelScreenInfo(id);
  }

  private updatePanelScreenInfo(id: string): void {
    const info = this.screenInfo(id);
    if (info && this.panel.openId === id) this.panel.updateScreenInfo(info);
  }

  // ---------------------------------------------------------------- input

  private bindLabel(el: HTMLElement, id: string): void {
    el.addEventListener('mouseenter', () => !isTouch() && this.hover(id));
    el.addEventListener('mouseleave', () => !isTouch() && this.hover(null));
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.select(id);
    });
  }

  private bindPointer(): void {
    const dom = this.ctx.renderer.domElement;
    const pick = (e: PointerEvent) =>
      pickNode(e.clientX, e.clientY, dom, this.ctx.camera, this.nodes, (id) =>
        this.isNodeVisible(id),
      );
    let downPos: [number, number] | null = null;
    const onDown = (e: PointerEvent) => (downPos = [e.clientX, e.clientY]);
    const onUp = (e: PointerEvent) => {
      if (!downPos) return;
      const moved = Math.hypot(e.clientX - downPos[0], e.clientY - downPos[1]);
      downPos = null;
      if (moved > 6) return;
      const id = pick(e);
      if (id) this.select(id);
      else this.clearSelection();
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || e.buttons) return;
      const id = pick(e);
      dom.style.cursor = id ? 'pointer' : '';
      this.hover(id);
    };
    dom.addEventListener('pointerdown', onDown);
    dom.addEventListener('pointerup', onUp);
    dom.addEventListener('pointermove', onMove);
  }

  // ---------------------------------------------------------------- loop

  private readonly loop = (now: number) => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const target = this.state.explodeTarget;
    if (Math.abs(this.explode - target) > 0.001) {
      this.explode += (target - this.explode) * 0.12;
      if (Math.abs(this.explode - target) <= 0.001) this.explode = target;
      this.layout();
    }
    this.cam.update(now);
    this.updateLabelLod();
    if (this.state.cacheOn) {
      const s = 1 + 0.05 * Math.sin(now / 300);
      for (const n of this.nodes.values()) n.ring?.scale.set(s, 1, s);
    }
    this.flow.tick(now);
    this.ctx.controls.update();
    this.ctx.render();
  };

  /** テスト・デバッグ用の情報 */
  get debugInfo(): {
    nodes: number;
    edges: number;
    screens: number;
    highlight: string | null;
    ghosts: number;
    removedEdges: number;
    orphans: number;
    plate: { width: number; depth: number };
    layerGap: number;
    sceneScale: number;
    labelMode: LabelMode;
    searchMatches: number | null;
  } {
    return {
      plate: this.plateSize,
      layerGap: this.layerGap,
      sceneScale: this.sceneScale,
      labelMode: this.state.labelMode,
      searchMatches: this.state.searchMatches ? this.state.searchMatches.size : null,
      nodes: this.nodes.size,
      edges: this.edges.length,
      screens: this.screens.length,
      highlight: highlightTarget(this.state),
      ghosts: this.ghosts.size,
      removedEdges: this.removedEdges.length,
      orphans: this.orphanItems().length,
    };
  }
}
