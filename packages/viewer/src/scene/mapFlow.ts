/**
 * 2 面の地図の球と脈動（D106、Phase 8-6）。時刻と中身は @stack-atlas/wiring の mapFlow / mapFlowAt（配線図の Player を写したもの）。
 * - 球: 束の線（SceneEdge の折れ線）の上を、束の向き（戻りは逆）に動くシアンの球。球が乗っている線もシアン（docs/15 §3.6「いま流れている場所」）
 * - 脈動: 同じ単位の中の線。箱は自分の色をシアンで明るく（emissive）、画面は枠をシアンに寄せる
 * - 始点（白い輪）: 選択の始点のノードの下に白い輪、ラベルの枠も白く
 */
import * as THREE from 'three';
import { edgeKey, mapFlowAt, type MapFlow } from '@stack-atlas/wiring';
import type { EdgeVisualState } from '../state';
import { applyEdgeVisual, EDGE_POINTS, type SceneEdge } from './edges';
import type { SceneNode } from './nodes';

const CYAN = 0x22d3ee;
const WHITE = 0xffffff;
/** 球の半径（シーンの大きさ 1 のとき）。大きな graph はカメラが遠いので、シーンの大きさを掛ける */
const BALL_RADIUS = 0.42;
const BLACK = new THREE.Color(0x000000);
const CYAN_C = new THREE.Color(CYAN);

/** 折れ線（SceneEdge の頂点）の上の位置。along は 0〜1（束の向き） */
export function pointOnEdge(se: SceneEdge, along: number, out = new THREE.Vector3()) {
  const arr = (se.line.geometry.attributes.position as THREE.BufferAttribute).array as Float32Array;
  const seg = EDGE_POINTS - 1;
  const x = Math.min(seg, Math.max(0, along * seg));
  const i = Math.min(seg - 1, Math.floor(x));
  const t = x - i;
  out.set(
    arr[i * 3]! + (arr[(i + 1) * 3]! - arr[i * 3]!) * t,
    arr[i * 3 + 1]! + (arr[(i + 1) * 3 + 1]! - arr[i * 3 + 1]!) * t,
    arr[i * 3 + 2]! + (arr[(i + 1) * 3 + 2]! - arr[i * 3 + 2]!) * t,
  );
  return out;
}

export interface MapFlowFrame {
  /** 見えている球の数 */
  balls: number;
  /** 脈動しているノードの数 */
  pulses: number;
  /** 球の乗っている束（edgeKey） */
  edges: string[];
}

export class MapFlowLayer {
  private readonly pool: THREE.Mesh[] = [];
  private readonly mat = new THREE.MeshBasicMaterial({ color: CYAN, depthWrite: false });
  private readonly geo: THREE.SphereGeometry;
  private readonly byKey = new Map<string, SceneEdge>();
  private activeEdges = new Set<SceneEdge>();
  private pulsing = new Set<string>();
  private last: MapFlowFrame = { balls: 0, pulses: 0, edges: [] };

  constructor(
    private readonly scene: THREE.Scene,
    private readonly nodes: ReadonlyMap<string, SceneNode>,
    edges: readonly SceneEdge[],
    /** 束の今の見た目（球が離れた線を戻す） */
    private readonly edgeVisual: (se: SceneEdge) => EdgeVisualState | undefined,
    /** 脈動の終わった画面のノードの見た目を戻す（Viewer の 1 つのノードの見た目の道 = scene/paint.ts の paintNode） */
    private readonly restoreNode: (id: string) => void,
    sceneScale = 1,
  ) {
    this.geo = new THREE.SphereGeometry(BALL_RADIUS * Math.max(1, sceneScale), 16, 12);
    for (const se of edges) this.byKey.set(edgeKey(se.edge.from, se.edge.to), se);
  }

  /** 最後に描いたフレーム（テスト・デバッグ用） */
  get frame(): MapFlowFrame {
    return this.last;
  }

  /** 時刻 tau の球と脈動を置く。flow が null なら全部消す */
  update(flow: MapFlow | null, tau: number): MapFlowFrame {
    const at = flow ? mapFlowAt(flow, tau) : { balls: [], pulses: [] };
    let n = 0;
    const active = new Set<SceneEdge>();
    for (const b of at.balls) {
      const se = this.byKey.get(b.ball.edge);
      if (!se || !se.line.visible) continue;
      const mesh = this.pool[n] ?? this.addBall();
      pointOnEdge(se, b.along, mesh.position);
      mesh.visible = true;
      n++;
      active.add(se);
    }
    for (let i = n; i < this.pool.length; i++) this.pool[i]!.visible = false;
    // 球が乗っている線はシアン。離れた線は今の見た目に戻す
    for (const se of this.activeEdges) {
      if (active.has(se)) continue;
      const ev = this.edgeVisual(se);
      if (ev) applyEdgeVisual(se, ev);
    }
    for (const se of active) {
      se.line.material.color.set(CYAN);
      se.line.material.opacity = 1;
    }
    this.activeEdges = active;

    const now = new Set<string>();
    for (const q of at.pulses) {
      const sn = this.nodes.get(q.pulse.node);
      if (!sn) continue;
      now.add(sn.m.id);
      if (sn.type === 'box') sn.material.emissive.copy(CYAN_C).multiplyScalar(0.7 * q.intensity);
      else {
        // 枠の色を今の見た目に戻してから寄せる（前のフレームの色に重ねない）
        this.restoreNode(sn.m.id);
        sn.frameMat.color.lerp(CYAN_C, q.intensity);
      }
    }
    for (const id of this.pulsing) {
      if (now.has(id)) continue;
      const sn = this.nodes.get(id);
      if (sn?.type === 'box') sn.material.emissive.copy(BLACK);
      else this.restoreNode(id);
    }
    this.pulsing = now;
    this.last = {
      balls: n,
      pulses: now.size,
      edges: [...active].map((se) => edgeKey(se.edge.from, se.edge.to)),
    };
    return this.last;
  }

  dispose(): void {
    for (const m of this.pool) this.scene.remove(m);
    this.geo.dispose();
    this.mat.dispose();
  }

  private addBall(): THREE.Mesh {
    const m = new THREE.Mesh(this.geo, this.mat);
    m.renderOrder = 10;
    m.visible = false;
    this.scene.add(m);
    this.pool.push(m);
    return m;
  }
}

/**
 * 始点（白い輪）: 選択の始点のノードの下に白い輪（画面は枠を白く）、ラベルの枠も白く（docs/15 §3.6）。
 * 輪は初めて要るときに作り、外すときは隠す。画面の枠の白は、見た目（setNodeVisual）で枠の色を決めたあとに当てる
 * （scene/paint.ts の paintNode の順）
 */
export function markStart(sn: SceneNode, on: boolean): void {
  sn.label.classList.toggle('start', on);
  if (sn.type === 'screen') {
    if (on) sn.frameMat.color.set(WHITE);
    return;
  }
  let ring = sn.hit.getObjectByName('start-ring') as THREE.Mesh | undefined;
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
    ring.name = 'start-ring';
    ring.position.set(0, -sn.half + 0.02, 0);
    sn.hit.add(ring);
  }
  if (ring) ring.visible = on;
}
