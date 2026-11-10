/**
 * ノードの 3D オブジェクト。
 * - ボックスノード: kind の大きさの Box
 * - 画面ノード: 下端を軸にした pivot ＋ フレーム ＋ CanvasTexture を貼った板（explode で起き上がる）
 * - キャッシュの輪
 *
 * three.js のオブジェクトは graph のデータには載せず、SceneNode として id で引く。
 */
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { TONE_COLORS } from '../graph/kinds';
import type { ModelNode } from '../graph/model';
import { LAYER_GAP, layerY, SCREEN_H, SCREEN_W } from '../layout/plate';
import { ScreenCanvas } from '../screen/texture';
import type { NodeVisual } from '../state';

const COL = {
  red: new THREE.Color('#ff3b3b'),
  coral: new THREE.Color('#ff8a5c'),
  white: new THREE.Color('#ffffff'),
};

interface SceneNodeBase {
  m: ModelNode;
  x: number;
  z: number;
  /** ラベル（CSS2D）。クラスで見た目を切り替える */
  label: HTMLDivElement;
  memoBadge: HTMLSpanElement;
  /** レイキャストの対象 */
  hit: THREE.Mesh;
  ring?: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
}

export interface BoxSceneNode extends SceneNodeBase {
  type: 'box';
  material: THREE.MeshLambertMaterial;
  half: number;
}

export interface ScreenSceneNode extends SceneNodeBase {
  type: 'screen';
  pivot: THREE.Group;
  frameMat: THREE.MeshBasicMaterial;
  screenMat: THREE.MeshBasicMaterial;
  texture: THREE.CanvasTexture;
  screen: ScreenCanvas;
}

export type SceneNode = BoxSceneNode | ScreenSceneNode;

export interface CreateNodesOptions {
  scene: THREE.Scene;
  maxAnisotropy: number;
  positions: ReadonlyMap<string, { x: number; z: number }>;
  screenshotUrl(n: ModelNode): string | undefined;
  nameOf(id: string): string;
  makeLabel(n: ModelNode): { el: HTMLDivElement; memoBadge: HTMLSpanElement };
  /** 画面のテクスチャが変わった（スクショを読んだ・描き直した。止まっている間は描かないので描き直しを頼む） */
  onTextureUpdate?: () => void;
}

export function createSceneNodes(
  nodes: readonly ModelNode[],
  opts: CreateNodesOptions,
): Map<string, SceneNode> {
  const out = new Map<string, SceneNode>();
  for (const m of nodes) {
    const pos = opts.positions.get(m.id) ?? { x: 0, z: 0 };
    const { el, memoBadge } = opts.makeLabel(m);
    let sn: SceneNode;
    if (m.isScreen) {
      const pivot = new THREE.Group();
      const frameMat = new THREE.MeshBasicMaterial({
        color: 0x2b3240,
        transparent: true,
        side: THREE.DoubleSide,
      });
      const frame = new THREE.Mesh(
        new THREE.PlaneGeometry(SCREEN_W + 0.22, SCREEN_H + 0.22).translate(0, SCREEN_H / 2, -0.01),
        frameMat,
      );
      let texture: THREE.CanvasTexture | null = null;
      const screenUrl = opts.screenshotUrl(m);
      const screen = new ScreenCanvas(m, {
        ...(screenUrl ? { screenshotUrl: screenUrl } : {}),
        nameOf: opts.nameOf,
        onUpdate: () => {
          if (texture) texture.needsUpdate = true;
          opts.onTextureUpdate?.();
        },
      });
      texture = new THREE.CanvasTexture(screen.canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = opts.maxAnisotropy;
      const screenMat = new THREE.MeshBasicMaterial({ map: texture, transparent: true });
      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(SCREEN_W, SCREEN_H).translate(0, SCREEN_H / 2, 0),
        screenMat,
      );
      plane.userData.id = m.id;
      pivot.add(frame, plane);
      const lo = new CSS2DObject(el);
      lo.position.set(0, SCREEN_H + 0.15, 0);
      pivot.add(lo);
      opts.scene.add(pivot);
      sn = {
        type: 'screen',
        m,
        x: pos.x,
        z: pos.z,
        label: el,
        memoBadge,
        hit: plane,
        pivot,
        frameMat,
        screenMat,
        texture,
        screen,
      };
    } else {
      const material = new THREE.MeshLambertMaterial({ color: m.kind.color, transparent: true });
      const [sx, sy, sz] = m.kind.size;
      const hit = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), material);
      hit.userData.id = m.id;
      const half = sy / 2;
      const lo = new CSS2DObject(el);
      lo.position.set(0, half, 0);
      hit.add(lo);
      opts.scene.add(hit);
      sn = { type: 'box', m, x: pos.x, z: pos.z, label: el, memoBadge, hit, material, half };
    }
    const cache = m.node.cache;
    if (cache) {
      const r = m.isScreen ? 3.4 : 1.7;
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(r, r + 0.22, 64).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({
          color: TONE_COLORS[cache.tone] ?? TONE_COLORS.info,
          transparent: true,
          opacity: 0.85,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      ring.visible = false;
      opts.scene.add(ring);
      sn.ring = ring;
    }
    out.set(m.id, sn);
  }
  return out;
}

/** explode に合わせてノードを置く */
export function positionNodes(
  nodes: Iterable<SceneNode>,
  layerCount: number,
  explode: number,
  gap = LAYER_GAP,
): void {
  for (const n of nodes) {
    const y = layerY(n.m.layerIndex, layerCount, explode, gap);
    if (n.type === 'screen') {
      n.pivot.position.set(n.x, y - 0.33, n.z + 1.5);
      n.pivot.rotation.x = -Math.PI / 2 + explode * 1.05;
    } else {
      n.hit.position.set(n.x, y + n.half - 0.37, n.z);
    }
    n.ring?.position.set(n.x, y - 0.34, n.z);
  }
}

/** 表示上の中心（画面ノードは上端・下端・中心を選べる） */
export function anchor(n: SceneNode, which: 'center' | 'top' | 'bottom' = 'center'): THREE.Vector3 {
  if (n.type === 'box') return n.hit.position.clone();
  const y = which === 'top' ? SCREEN_H : which === 'bottom' ? 0 : SCREEN_H / 2;
  return n.pivot.localToWorld(new THREE.Vector3(0, y, 0.03));
}

/** 線の端点: 画面ノードは、上の層とつながるなら上端、下の層とつながるなら下端の中央 */
export function anchorToward(n: SceneNode, other: SceneNode): THREE.Vector3 {
  if (n.type === 'box') return anchor(n);
  return anchor(n, other.m.layerIndex < n.m.layerIndex ? 'top' : 'bottom');
}

export function setNodeObjectVisible(n: SceneNode, visible: boolean): void {
  (n.type === 'screen' ? n.pivot : n.hit).visible = visible;
}

/** ラベルの見た目の class（NodeVisual の normal 以外） */
const VISUAL_CLASSES: readonly NodeVisual[] = ['sel', 'down', 'up', 'dim', 'flow', 'soft'];

export function setNodeVisual(n: SceneNode, st: NodeVisual): void {
  // ラベルは見た目の class だけを付け替える（LOD の lod-dot・lod-hide、差分の diff-*、始点の start は触らない。
  // 以前は className を丸ごと書き換えていて、2 面の地図の脈動（毎フレーム枠を戻す）でそれらが消えてちらついた。docs/20 §7.7）
  for (const c of VISUAL_CLASSES) {
    const on = c === st;
    if (n.label.classList.contains(c) !== on) n.label.classList.toggle(c, on);
  }
  if (n.type === 'screen') {
    n.frameMat.color.set(
      st === 'sel' || st === 'down'
        ? '#ff3b3b'
        : st === 'up'
          ? '#ff8a5c'
          : st === 'flow'
            ? '#22d3ee'
            : '#2b3240',
    );
    const op = st === 'dim' ? 0.12 : st === 'soft' ? 0.35 : 1;
    n.frameMat.opacity = op;
    n.screenMat.opacity = op;
  } else {
    const c = n.material.color;
    if (st === 'sel') c.copy(COL.red).lerp(COL.white, 0.25);
    else if (st === 'down') c.copy(COL.red);
    else if (st === 'up') c.copy(COL.coral);
    else c.set(n.m.kind.color);
    n.material.opacity = st === 'dim' ? 0.12 : st === 'soft' ? 0.3 : 1;
  }
}
