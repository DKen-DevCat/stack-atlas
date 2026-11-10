// 1 つのノードの見た目の道（paintNode。docs/20 §7.7）。2 面の地図の脈動（同じ単位の中の線）は、画面の枠を毎フレーム今の見た目に
// 戻してからシアンに寄せる。以前は setNodeVisual がラベルの className を丸ごと書き換えていて、毎フレーム LOD（lod-dot・lod-hide）・
// 差分（diff-*）の class が消え（LOD は 200ms ごとに付け直すのでちらつく）、戻す道も差分の枠の色を当て直さなかった
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { MapFlow } from '@stack-atlas/wiring';
import type { NodeVisual, NodeVisualState } from '../state';
import { DIFF_COLORS } from './diff';
import { MapFlowLayer } from './mapFlow';
import { setNodeVisual, type SceneNode, type ScreenSceneNode } from './nodes';
import { paintNode } from './paint';

/** DOM の無いテスト用のラベル（classList と className だけ） */
function fakeLabel(...classes: string[]): HTMLDivElement {
  const set = new Set(['nl', ...classes]);
  const classList = {
    contains: (c: string) => set.has(c),
    toggle: (c: string, force?: boolean) => {
      const on = force ?? !set.has(c);
      if (on) set.add(c);
      else set.delete(c);
      return on;
    },
  };
  return {
    classList,
    get className() {
      return [...set].join(' ');
    },
    set className(v: string) {
      set.clear();
      for (const c of v.split(/\s+/).filter(Boolean)) set.add(c);
    },
  } as unknown as HTMLDivElement;
}

const classes = (sn: SceneNode) => new Set(sn.label.className.split(' '));

function screenNode(id: string, label: HTMLDivElement): ScreenSceneNode {
  return {
    type: 'screen',
    m: { id, layerIndex: 0 } as unknown as ScreenSceneNode['m'],
    x: 0,
    z: 0,
    label,
    memoBadge: {} as HTMLSpanElement,
    hit: new THREE.Mesh(),
    pivot: new THREE.Group(),
    frameMat: new THREE.MeshBasicMaterial({ color: 0x2b3240, transparent: true }),
    screenMat: new THREE.MeshBasicMaterial({ transparent: true }),
    texture: {} as THREE.CanvasTexture,
    screen: {} as ScreenSceneNode['screen'],
  };
}

const nv = (visual: NodeVisual, diff: NodeVisualState['diff'] = null): NodeVisualState => ({
  visual,
  visible: true,
  ringVisible: false,
  ringOpacity: 0,
  diff,
});

const hex = (c: THREE.Color) => `#${c.getHexString()}`;

describe('setNodeVisual はラベルの見た目の class だけを付け替える', () => {
  it('LOD・差分・始点の class は残る（直す前は className を丸ごと書き換えて消えた）', () => {
    const sn = screenNode('route:/', fakeLabel('lod-dot', 'diff-changed', 'start'));
    setNodeVisual(sn, 'dim');
    expect(classes(sn)).toEqual(new Set(['nl', 'lod-dot', 'diff-changed', 'start', 'dim']));
    setNodeVisual(sn, 'sel');
    expect(classes(sn)).toEqual(new Set(['nl', 'lod-dot', 'diff-changed', 'start', 'sel']));
    setNodeVisual(sn, 'normal');
    expect(classes(sn)).toEqual(new Set(['nl', 'lod-dot', 'diff-changed', 'start']));
  });
});

describe('地図の脈動のあとも見た目が戻る（脈動の戻しは applyState と同じ paintNode）', () => {
  const flow: MapFlow = {
    balls: [],
    pulses: [{ node: 'route:/', t0: 0, t1: 1, wires: ['w0'] }],
    cycle: 2,
  };

  function setup(starts: ReadonlySet<string>) {
    const sn = screenNode('route:/', fakeLabel());
    const last = nv('normal', 'changed');
    const paint = () => paintNode(sn, last, { diff: true, starts });
    paint();
    // LOD は applyState のあとに付く（ui/labels.ts の applyLabelDisplay）
    sn.label.classList.toggle('lod-dot', true);
    const layer = new MapFlowLayer(
      new THREE.Scene(),
      new Map<string, SceneNode>([['route:/', sn]]),
      [],
      () => undefined,
      () => paint(),
    );
    return { sn, layer };
  }

  it('差分の枠の色・ラベルの LOD と差分の class が、脈動の間も終わったあとも残る', () => {
    const { sn, layer } = setup(new Set());
    for (const tau of [0.2, 0.5, 0.8]) {
      expect(layer.update(flow, tau).pulses).toBe(1);
      expect(classes(sn)).toEqual(new Set(['nl', 'diff-changed', 'lod-dot']));
      // 枠は差分の色からシアンへ寄せたもの（前のフレームの色に重ねない）
      const want = new THREE.Color(DIFF_COLORS.changed).lerp(
        new THREE.Color(0x22d3ee),
        Math.sin(Math.PI * tau),
      );
      expect(hex(sn.frameMat.color)).toBe(hex(want));
    }
    expect(layer.update(flow, 1.5).pulses).toBe(0);
    expect(hex(sn.frameMat.color)).toBe(DIFF_COLORS.changed);
    expect(classes(sn)).toEqual(new Set(['nl', 'diff-changed', 'lod-dot']));
  });

  it('始点の画面は、脈動が終わると白い枠と start の class に戻る', () => {
    const { sn, layer } = setup(new Set(['route:/']));
    layer.update(flow, 0.5);
    layer.update(flow, 1.5);
    expect(hex(sn.frameMat.color)).toBe('#ffffff');
    expect(classes(sn)).toEqual(new Set(['nl', 'diff-changed', 'start', 'lod-dot']));
  });
});
