/**
 * Viewer: 1 つの graph を描画し、操作を受け付ける。
 * 状態は state.ts の ViewState に集め、見た目は computeVisuals() の結果を three.js / DOM に反映する。
 */
import type { Flow } from '@stack-atlas/schema';
import type { GraphModel } from './graph/model';
import { resolveAssetUrl, type LoadResult } from './graph/load';
import { computeSceneLayout } from './layout/plate';
import { CameraAnimator } from './scene/camera';
import {
  applyEdgeVisual,
  createSceneEdges,
  updateEdgeGeometry,
  type SceneEdge,
} from './scene/edges';
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
import { computeVisuals, highlightTarget, initialState, type ViewState } from './state';
import { h } from './ui/dom';
import { createFlowPill, type FlowPill } from './ui/flowPill';
import { createLayerChips } from './ui/layerChips';
import { makeNodeLabel } from './ui/labels';
import { createLegend } from './ui/legend';
import type { LocalShotStore, MemoStore } from './ui/memos';
import { Panel, type ScreenInfo } from './ui/panel';
import { createTopbar, type Topbar } from './ui/topbar';
import type * as THREE from 'three';

export interface ViewerOptions {
  root: HTMLElement;
  model: GraphModel;
  load: LoadResult;
  memos: MemoStore;
  shots: LocalShotStore;
  onOpenFile(f: File): void;
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
  private explode = 1;
  private screenKey = '';
  private raf = 0;
  private disposed = false;
  private readonly cleanups: (() => void)[] = [];

  constructor(private readonly opts: ViewerOptions) {
    const { model, load } = opts;
    this.model = model;
    this.state = initialState(model.layers.length);

    const stage = h('div', { class: 'stage' });
    const labels = h('div', { class: 'labels' });
    this.topbar = createTopbar({
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
    });
    this.pill = createFlowPill();
    this.panel = new Panel(model, {
      onClose: () => this.clearSelection(),
      onJump: (id) => this.select(id, true),
      onFocus: (id) => this.focusOn(id),
      onMemo: (id, text) => {
        opts.memos.set(id, text);
        this.refreshMemoBadges();
      },
      onShot: (id, f) => this.replaceShot(id, f),
      onShotReset: (id) => this.resetShot(id),
    });
    this.el = h(
      'div',
      { class: 'viewer' },
      stage,
      labels,
      this.topbar.el,
      createLayerChips(model.layers, (i, v) => {
        this.state.layerVisible[i] = v;
        const p = this.plates[i];
        if (p) p.visible = v;
        this.applyState();
      }),
      createLegend(model.layers),
      this.pill.el,
      this.panel.el,
    );
    opts.root.append(this.el);

    // ---- シーン ----
    const layout = computeSceneLayout(model);
    const span = Math.max(1, model.layers.length - 1) * 7.5;
    const sceneScale = Math.max(1, layout.plate.width / 41, layout.plate.depth / 20, span / 22.5);
    this.ctx = createSceneContext(stage, labels, sceneScale);
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
    this.flow = new FlowAnimator(this.ctx.scene, this.nodes, (f, step) =>
      this.showFlowStep(f, step),
    );
    this.cam = new CameraAnimator(this.ctx.camera, this.ctx.controls);

    this.bindPointer();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target instanceof HTMLTextAreaElement)) this.clearSelection();
    };
    window.addEventListener('keydown', onKey);
    this.cleanups.push(() => window.removeEventListener('keydown', onKey));

    this.restoreShots();
    this.refreshMemoBadges();
    this.layout();
    this.applyState();
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
    const v = computeVisuals(this.model, this.state);
    for (const [id, nv] of v.nodes) {
      const sn = this.nodes.get(id);
      if (!sn) continue;
      setNodeObjectVisible(sn, nv.visible);
      setNodeVisual(sn, nv.visual);
      if (sn.ring) {
        sn.ring.visible = nv.ringVisible;
        sn.ring.material.opacity = nv.ringOpacity;
      }
    }
    for (const se of this.edges) {
      const ev = v.edges[se.index];
      if (ev) applyEdgeVisual(se, ev);
    }
    // 画面テクスチャはハイライト対象（と層の表示）が変わったときだけ描き直す
    const key = `${v.hl.a ?? ''}|${this.state.layerVisible.join(',')}`;
    if (key !== this.screenKey) {
      this.screenKey = key;
      const isVisible = (id: string) => this.isNodeVisible(id);
      for (const s of this.screens) s.screen.render({ hl: v.hl, isVisible });
    }
  }

  private isNodeVisible(id: string): boolean {
    const n = this.model.byId.get(id);
    return !!n && (this.state.layerVisible[n.layerIndex] ?? true);
  }

  private layout(): void {
    positionPlates(this.plates, this.explode);
    positionNodes(this.nodes.values(), this.model.layers.length, this.explode);
    this.ctx.scene.updateMatrixWorld(true);
    updateEdgeGeometry(this.edges);
    this.flow.rebuild();
  }

  private setHover(id: string | null): void {
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
    el.addEventListener('mouseenter', () => !isTouch() && this.setHover(id));
    el.addEventListener('mouseleave', () => !isTouch() && this.setHover(null));
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
      this.setHover(id);
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
    if (this.state.cacheOn) {
      const s = 1 + 0.05 * Math.sin(now / 300);
      for (const n of this.nodes.values()) n.ring?.scale.set(s, 1, s);
    }
    this.flow.tick(now);
    this.ctx.controls.update();
    this.ctx.render();
  };

  /** テスト・デバッグ用の情報 */
  get debugInfo(): { nodes: number; edges: number; screens: number; highlight: string | null } {
    return {
      nodes: this.nodes.size,
      edges: this.edges.length,
      screens: this.screens.length,
      highlight: highlightTarget(this.state),
    };
  }
}
