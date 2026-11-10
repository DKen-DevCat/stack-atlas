import { describe, expect, it } from 'vitest';
import { buildModel } from '../graph/model';
import { loadSampleGraph } from '../graph/testSample';
import { alwaysLabelLayers, LABEL_LOD_DISTANCE, labelMode, type LabelContext } from './labels';

const ctx = (over: Partial<LabelContext> = {}): LabelContext => ({
  mode: 'all',
  visual: 'normal',
  alwaysLayer: false,
  sceneScale: 1,
  ...over,
});

describe('labelMode', () => {
  it('80 ノード以下は「すべて」で距離によらず full', () => {
    expect(labelMode(40, 1000, ctx())).toBe('full');
    expect(labelMode(80, 1000, ctx())).toBe('full');
  });
  it('80 ノード超は遠いラベルを点にし、閾値はシーンの大きさに比例する', () => {
    expect(labelMode(250, LABEL_LOD_DISTANCE - 1, ctx())).toBe('full');
    expect(labelMode(250, LABEL_LOD_DISTANCE + 1, ctx())).toBe('dot');
    expect(labelMode(250, LABEL_LOD_DISTANCE * 3, ctx({ sceneScale: 4 }))).toBe('full');
    expect(labelMode(250, LABEL_LOD_DISTANCE * 4 + 1, ctx({ sceneScale: 4 }))).toBe('dot');
  });
  it('ハイライト中（sel / down / up / flow）とインフラ・画面の層は常に出す', () => {
    for (const visual of ['sel', 'down', 'up', 'flow'] as const) {
      expect(labelMode(250, 1e9, ctx({ visual }))).toBe('full');
      expect(labelMode(250, 1e9, ctx({ visual, mode: 'none' }))).toBe('full');
      expect(labelMode(250, 1e9, ctx({ visual, mode: 'related' }))).toBe('full');
    }
    expect(labelMode(250, 1e9, ctx({ alwaysLayer: true }))).toBe('full');
    expect(labelMode(250, 1e9, ctx({ alwaysLayer: true, mode: 'related' }))).toBe('full');
  });
  it('「関連のみ」はそれ以外を隠し、「なし」はインフラ・画面も隠す', () => {
    expect(labelMode(10, 0, ctx({ mode: 'related' }))).toBe('hidden');
    expect(labelMode(10, 0, ctx({ mode: 'related', visual: 'dim' }))).toBe('hidden');
    expect(labelMode(10, 0, ctx({ mode: 'none', alwaysLayer: true }))).toBe('hidden');
  });
});

describe('alwaysLabelLayers', () => {
  it('画面ノードのある層とその上', () => {
    const m = buildModel(loadSampleGraph());
    expect([...alwaysLabelLayers(m.nodes)]).toEqual([0, 1]);
    expect([...alwaysLabelLayers(m.nodes.filter((n) => !n.isScreen))]).toEqual([0]);
  });
});
