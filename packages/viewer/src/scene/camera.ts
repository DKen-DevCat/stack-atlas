/** カメラの寄せ・リセット（700ms のイーズアウト） */
import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

interface CamAnim {
  t0: number;
  fromT: THREE.Vector3;
  toT: THREE.Vector3;
  fromC: THREE.Vector3;
  toC: THREE.Vector3;
}

export const CAMERA_ANIM_MS = 700;

export class CameraAnimator {
  private anim: CamAnim | null = null;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly controls: OrbitControls,
  ) {}

  /** target を注視点にし、今の向きのまま distance まで寄る */
  focus(target: THREE.Vector3, distance: number): void {
    const off = this.camera.position.clone().sub(this.controls.target).setLength(distance);
    this.start(target, target.clone().add(off));
  }

  reset(home: THREE.Vector3): void {
    this.start(new THREE.Vector3(), home);
  }

  /** 寄せ・リセットの途中か（止まっている間は描かない。docs/20 §5.1 #10） */
  get active(): boolean {
    return this.anim !== null;
  }

  update(now: number): void {
    const a = this.anim;
    if (!a) return;
    const k = Math.min(1, (now - a.t0) / CAMERA_ANIM_MS);
    const e = 1 - Math.pow(1 - k, 3);
    this.controls.target.lerpVectors(a.fromT, a.toT, e);
    this.camera.position.lerpVectors(a.fromC, a.toC, e);
    if (k >= 1) this.anim = null;
  }

  private start(toT: THREE.Vector3, toC: THREE.Vector3): void {
    this.anim = {
      t0: performance.now(),
      fromT: this.controls.target.clone(),
      toT,
      fromC: this.camera.position.clone(),
      toC,
    };
  }
}
