// 【8-6 のモック（Q20）】左の面（mock-map.html の iframe）の中の 3D の地図。親（split.ts）が window.__mapFrame.mount を呼ぶ。
// 3D の Viewer は窓の大きさで描くので、面の大きさは iframe で与える（Viewer は変えない。docs/20 §5.1 #11 の改修は本実装で）。
// three.js のオブジェクト（始点の白い輪）はこの窓の three で作る（親の窓の three と混ぜない）
import '../style.css';
import './mock.css';
import * as THREE from 'three';
import type { Graph } from '@stack-atlas/schema';
import type { MapLit } from '@stack-atlas/wiring';
import { Viewer } from '../app';
import type { AltLink } from '../graph/altLink';
import { buildModel } from '../graph/model';
import type { SceneNode } from '../scene/nodes';
import { h } from '../ui/dom';
import { LocalShotStore, type SharedMemoStore } from '../ui/memos';
import { proposedVisuals } from './visuals';

/** 地図の規則: current = 今の 3D の地図（赤と橙の閉包、hover が効く）、proposed = 配線図の規則（D31） */
export type Rules = 'current' | 'proposed';

/** 親から受け取る口（値は呼ばれたときに読む） */
export interface MapLinkIn {
  rules(): Rules;
  /** 配線図の選択を地図に写したもの（選択が無ければ null） */
  lit(): MapLit | null;
  /** どちらかの面で選んでいる（提案の規則では hover を止める） */
  selected(): boolean;
  onSelect(id: string | null): void;
  onRules(r: Rules): void;
  /** 狭い画面で「配線図」のリンクを押した */
  onSwitchPane(): void;
}

export interface MapMountOptions {
  graph: Graph;
  source: string;
  baseUrl?: string;
  memos: SharedMemoStore;
  scope: string;
  link: MapLinkIn;
}

export interface MapFrameHandle {
  readonly viewer: Viewer;
  /** 規則の切り替えを見た目に反映する（題名の横のリンクとクラス） */
  syncRules(): void;
  /** 狭い画面の「配線図」リンクを出す・消す */
  showPaneLink(show: boolean): void;
}

declare global {
  interface Window {
    __mapFrame?: { mount(o: MapMountOptions): MapFrameHandle };
  }
}

const WHITE = 0xffffff;

/** 始点の白い輪（箱は箱の下に輪、画面は枠を白に）。提案の規則で選んでいるときだけ */
function markStarts(nodes: ReadonlyMap<string, SceneNode>, starts: ReadonlySet<string>) {
  for (const [id, sn] of nodes) {
    const on = starts.has(id);
    // ラベルの枠も白く（箱の下の輪は小さくて見えにくいので）
    sn.label.classList.toggle('mock-start', on);
    if (sn.type === 'screen') {
      if (on) sn.frameMat.color.set(WHITE);
      continue;
    }
    let ring = sn.hit.getObjectByName('mock-start') as THREE.Mesh | undefined;
    if (!ring && on) {
      const [sx, , sz] = sn.m.kind.size;
      const r = Math.max(sx, sz) * 0.62;
      ring = new THREE.Mesh(
        new THREE.RingGeometry(r, r + 0.14, 48).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({
          color: WHITE,
          transparent: true,
          opacity: 0.95,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      ring.name = 'mock-start';
      ring.position.set(0, -sn.half + 0.02, 0);
      sn.hit.add(ring);
    }
    if (ring) ring.visible = on;
  }
}

function mount(o: MapMountOptions): MapFrameHandle {
  const app = document.querySelector<HTMLDivElement>('#app')!;
  const { link } = o;
  const proposed = () => link.rules() === 'proposed';
  const viewer = new Viewer({
    root: app,
    model: buildModel(o.graph),
    load: {
      graph: o.graph,
      issues: [],
      source: o.source,
      ...(o.baseUrl ? { baseUrl: o.baseUrl } : {}),
    },
    memos: o.memos,
    shots: new LocalShotStore(o.scope),
    onOpenFile: () => {},
    onOpenPrev: () => {},
    mock: {
      visuals: (model, state, marks) =>
        proposed() ? proposedVisuals(model, state, marks, link.lit()) : null,
      afterApply: (nodes) => markStarts(nodes, (proposed() && link.lit()?.starts) || new Set()),
      hoverLocked: () => proposed() && link.selected(),
      noPanel: proposed,
      onSelect: (id) => link.onSelect(id),
    },
  });

  // 面が正方形に近いと板の横がはみ出すので、視点リセットの位置を引く（Viewer の private を触るのはモックだけ。
  // 本実装は docs/20 §5.1 #11 の改修で、Viewer が面の大きさから決める）
  const ctx = (
    viewer as unknown as { ctx: { home(): THREE.Vector3; camera: THREE.PerspectiveCamera } }
  ).ctx;
  const home0 = ctx.home;
  ctx.home = () => home0().multiplyScalar(Math.max(1, 1.5 / ctx.camera.aspect));
  ctx.camera.position.copy(ctx.home());

  // 題名の横: 規則の切り替え（文字のリンク 2 つ。今の規則は太字で、押せない）
  const cur = h(
    'a',
    { class: 'alt-link', attrs: { href: '#current', 'data-rules': 'current' } },
    '今の地図',
  );
  const pro = h(
    'a',
    { class: 'alt-link', attrs: { href: '#proposed', 'data-rules': 'proposed' } },
    '提案の規則',
  );
  const rulesEl = h('span', { class: 'mock-rules' }, cur, pro);
  for (const a of [cur, pro])
    a.addEventListener('click', (e) => {
      e.preventDefault();
      link.onRules(a.dataset.rules as Rules);
    });
  const h1 = viewer.el.querySelector('.top h1');
  h1?.querySelector('a[data-alt]')?.after(rulesEl);

  const altA = viewer.el.querySelector<HTMLAnchorElement>('a[data-alt]');
  altA?.addEventListener('click', (e) => {
    e.preventDefault();
    link.onSwitchPane();
  });

  const syncRules = () => {
    const p = proposed();
    viewer.el.classList.toggle('mock-proposed', p);
    cur.classList.toggle('on', !p);
    pro.classList.toggle('on', p);
  };
  syncRules();
  return {
    viewer,
    syncRules,
    showPaneLink(show) {
      const l: AltLink | null = show ? { href: '#wiring', label: '配線図' } : null;
      viewer.setAltLink(l);
    },
  };
}

window.__mapFrame = { mount };
