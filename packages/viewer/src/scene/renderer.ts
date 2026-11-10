/**
 * WebGLRenderer / CSS2DRenderer / camera / OrbitControls / ライト / リサイズ。
 * 大きさは窓ではなく stage（描く面）から取る（ResizeObserver。0 の大きさは無視）。3D の地図だけのページでは stage が窓いっぱい、
 * 2 面（Phase 8-6）では左の面（docs/20 §5.1 #11）
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';

export const BG_COLOR = 0x0d0f14;

export function hasWebGL(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl2') ?? c.getContext('webgl')));
  } catch {
    return false;
  }
}

export interface SceneContext {
  renderer: THREE.WebGLRenderer;
  labelRenderer: CSS2DRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  maxAnisotropy: number;
  /** 視点リセットの位置（画面の縦横比と、シーンの大きさで決まる） */
  home(): THREE.Vector3;
  render(): void;
  dispose(): void;
}

/** プロトタイプの板の縦横比（41 : 20）。板がこれより横長なら視点リセット位置を正面寄りにする */
const BASE_PLATE_ASPECT = 41 / 20;

/**
 * 視点リセットの位置。プロトタイプの (24, 22, 42) をシーンの大きさで掛ける。
 * 横長の板（縦横比が 41:20 より大きい）では、x 成分を縦横比の分だけ縮めて正面寄り
 * （板の長辺が画面の横に沿う）にし、y 成分を √(比) だけ上げて見下ろす角度を付ける（段が重なって見えないように）
 */
export function homePosition(
  sceneScale: number,
  plateAspect: number,
  portrait: boolean,
): THREE.Vector3 {
  const base = portrait ? new THREE.Vector3(30, 32, 66) : new THREE.Vector3(24, 22, 42);
  const ratio = Math.max(1, plateAspect / BASE_PLATE_ASPECT);
  base.x /= ratio;
  base.y *= Math.min(1.6, Math.sqrt(ratio));
  return base.multiplyScalar(sceneScale);
}

/**
 * 2 面の地図（面が正方形に近い）で視点リセットの位置を引く倍率（板の横がはみ出さないように）。
 * 縦横比 1.5 以上（と縦長）は 1。3D の地図だけのページは使わない（今までの位置のまま）
 */
export function paneHomeFactor(aspect: number): number {
  if (!(aspect >= 1) || aspect >= 1.5) return 1;
  return 1.5 / aspect;
}

export interface SceneContextOptions {
  /** 2 面の地図（paneHomeFactor で視点リセットの位置を引く） */
  pane?: boolean;
  /** 描く面の大きさが変わった（0 の大きさは知らせない） */
  onResize?: (width: number, height: number) => void;
}

/**
 * @param sceneScale プロトタイプ（板 41 幅・4 層）を 1 としたシーンの大きさ。カメラの距離に掛ける
 * @param plateAspect 板の幅 ÷ 奥行き（視点リセット位置の向きに使う）
 */
export function createSceneContext(
  stage: HTMLElement,
  labels: HTMLElement,
  sceneScale: number,
  plateAspect = BASE_PLATE_ASPECT,
  opts: SceneContextOptions = {},
): SceneContext {
  // 描く面の大きさ（まだ配置されていなければ窓の大きさ）
  const size = {
    w: stage.clientWidth || window.innerWidth,
    h: stage.clientHeight || window.innerHeight,
  };
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(size.w, size.h);
  renderer.setClearColor(BG_COLOR);
  stage.appendChild(renderer.domElement);

  const labelRenderer = new CSS2DRenderer({ element: labels });
  labelRenderer.setSize(size.w, size.h);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(BG_COLOR, 80 * sceneScale, 150 * sceneScale);
  const camera = new THREE.PerspectiveCamera(38, size.w / size.h, 0.1, 500 * sceneScale);
  const home = () => {
    const aspect = size.w / size.h;
    const p = homePosition(sceneScale, plateAspect, aspect < 1);
    return opts.pane ? p.multiplyScalar(paneHomeFactor(aspect)) : p;
  };
  camera.position.copy(home());

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 0, 0);
  controls.maxDistance = 150 * sceneScale;
  controls.minDistance = 6;

  scene.add(new THREE.AmbientLight(0xffffff, 0.65));
  const dl = new THREE.DirectionalLight(0xffffff, 1.1);
  dl.position.set(10, 30, 20);
  scene.add(dl);

  const resize = (w: number, h: number) => {
    // 隠した面・まだ配置されていない面の 0 は無視する（camera の縦横比が NaN になる）
    if (!(w > 0) || !(h > 0) || (w === size.w && h === size.h)) return;
    size.w = w;
    size.h = h;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    labelRenderer.setSize(w, h);
    opts.onResize?.(w, h);
  };
  const ro =
    typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => resize(stage.clientWidth, stage.clientHeight));
  ro?.observe(stage);
  // ResizeObserver の無い環境は窓の resize で
  const onWindowResize = () => resize(stage.clientWidth, stage.clientHeight);
  if (!ro) window.addEventListener('resize', onWindowResize);

  return {
    renderer,
    labelRenderer,
    scene,
    camera,
    controls,
    maxAnisotropy: renderer.capabilities.getMaxAnisotropy(),
    home,
    render() {
      renderer.render(scene, camera);
      labelRenderer.render(scene, camera);
    },
    dispose() {
      ro?.disconnect();
      window.removeEventListener('resize', onWindowResize);
      controls.dispose();
      scene.traverse((o) => {
        const mesh = o as Partial<THREE.Mesh>;
        mesh.geometry?.dispose();
        const mat = mesh.material;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else if (mat) {
          (mat as THREE.MeshBasicMaterial).map?.dispose();
          mat.dispose();
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
      labels.replaceChildren();
    },
  };
}
