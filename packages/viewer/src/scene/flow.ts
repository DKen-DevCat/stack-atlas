/** データフローのアニメーション（CatmullRom 曲線 ＋ 粒子 7 個）と進行ステップの算出 */
import * as THREE from 'three';
import type { Flow } from '@stack-atlas/schema';
import { anchor, type SceneNode } from './nodes';

const CYAN = 0x22d3ee;
const YELLOW = 0xfbbf24;
const PARTICLES = 7;

export function flowColor(flow: Flow): number {
  return flow.tone === 'cache-hit' ? YELLOW : CYAN;
}

/** 1 ステップあたりの秒数（HIT は 1.6 秒） */
export function secondsPerStep(flow: Flow): number {
  return flow.tone === 'cache-hit' ? 1.6 : 1.15;
}

/**
 * 経過時間から進行度 u（0..1、末尾で 1 秒止まる間は 1 を超える）と、今のステップを出す。
 * getPoint(t) は区間ごとに等分されたパラメータなので round(t × (n−1)) が今のステップ。
 */
export function flowProgress(
  flow: Flow,
  elapsedMs: number,
): { u: number; step: number; total: number } {
  const n = flow.steps.length;
  const dur = Math.max(1, (n - 1) * secondsPerStep(flow) * 1000);
  const u = (elapsedMs % (dur + 1000)) / dur;
  const step = Math.min(n - 1, Math.max(0, Math.round(Math.min(u, 1) * (n - 1))));
  return { u, step, total: n };
}

export class FlowAnimator {
  private flow: Flow | null = null;
  private curve: THREE.CatmullRomCurve3 | null = null;
  private line: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial> | null = null;
  private readonly particles: THREE.Mesh[] = [];
  private readonly pMat = new THREE.MeshBasicMaterial({ color: CYAN });
  private t0 = 0;
  private lastStep = -1;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly nodes: ReadonlyMap<string, SceneNode>,
    private readonly onStep: (flow: Flow, step: number) => void,
  ) {
    for (let i = 0; i < PARTICLES; i++) {
      const s = new THREE.Mesh(new THREE.SphereGeometry(i === 0 ? 0.32 : 0.2, 16, 12), this.pMat);
      s.visible = false;
      scene.add(s);
      this.particles.push(s);
    }
  }

  get current(): Flow | null {
    return this.flow;
  }

  set(flow: Flow | null, now: number): void {
    this.flow = flow;
    this.lastStep = -1;
    this.t0 = now;
    if (!flow) {
      if (this.line) this.line.visible = false;
      this.particles.forEach((p) => (p.visible = false));
      return;
    }
    this.pMat.color.set(flowColor(flow));
    this.rebuild();
  }

  /** 層の explode が変わったら作り直す */
  rebuild(): void {
    const flow = this.flow;
    if (!flow) return;
    const steps = flow.steps;
    const pts: THREE.Vector3[] = [];
    steps.forEach((s, i) => {
      const n = this.nodes.get(s.node);
      if (!n) return;
      const p = anchor(n);
      p.y += n.type === 'screen' ? 0.4 : n.half + 0.25;
      if (i === steps.length - 1 && s.node === steps[0]?.node) p.z += 1.4;
      pts.push(p);
    });
    if (pts.length < 2) return;
    this.curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.15);
    const geo = new THREE.BufferGeometry().setFromPoints(this.curve.getPoints(400));
    if (this.line) {
      this.line.geometry.dispose();
      this.line.geometry = geo;
    } else {
      this.line = new THREE.Line(
        geo,
        new THREE.LineBasicMaterial({ color: CYAN, transparent: true, opacity: 0.7 }),
      );
      this.scene.add(this.line);
    }
    this.line.material.color.set(flowColor(flow));
    this.line.visible = true;
  }

  tick(now: number): void {
    const flow = this.flow;
    const curve = this.curve;
    if (!flow || !curve) return;
    const { u, step } = flowProgress(flow, now - this.t0);
    this.particles.forEach((p, i) => {
      const t = u - i * 0.018;
      if (t < 0 || t > 1) {
        p.visible = false;
        return;
      }
      p.visible = true;
      p.position.copy(curve.getPoint(t));
    });
    if (step !== this.lastStep) {
      this.lastStep = step;
      this.onStep(flow, step);
    }
  }
}
