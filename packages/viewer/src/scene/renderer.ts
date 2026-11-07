/** WebGLRenderer / CSS2DRenderer / camera / OrbitControls / ライト / リサイズ */
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

/**
 * @param sceneScale プロトタイプ（板 41 幅・4 層）を 1 としたシーンの大きさ。カメラの距離に掛ける
 */
export function createSceneContext(
  stage: HTMLElement,
  labels: HTMLElement,
  sceneScale: number,
): SceneContext {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(BG_COLOR);
  stage.appendChild(renderer.domElement);

  const labelRenderer = new CSS2DRenderer({ element: labels });
  labelRenderer.setSize(window.innerWidth, window.innerHeight);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(BG_COLOR, 80 * sceneScale, 150 * sceneScale);
  const camera = new THREE.PerspectiveCamera(
    38,
    window.innerWidth / window.innerHeight,
    0.1,
    500 * sceneScale,
  );
  const home = () =>
    (window.innerWidth / window.innerHeight < 1
      ? new THREE.Vector3(30, 32, 66)
      : new THREE.Vector3(24, 22, 42)
    ).multiplyScalar(sceneScale);
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

  const onResize = () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    labelRenderer.setSize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener('resize', onResize);

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
      window.removeEventListener('resize', onResize);
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
