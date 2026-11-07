import { describe, expect, it } from 'vitest';
import { buildModel } from './graph/model';
import { loadSampleGraph } from './graph/testSample';
import { computeVisuals, edgeBaseStyle, initialState } from './state';

const model = buildModel(loadSampleGraph());
const edgeIndex = (from: string, to: string) =>
  model.edges.findIndex((e) => e.from === from && e.to === to);

describe('edgeBaseStyle', () => {
  it('層またぎは上の層の色、層内は kind 別', () => {
    expect(edgeBaseStyle(model, model.edges[edgeIndex('infra:lambdaNext', 'route:/')]!)).toEqual({
      color: '#ff9f43',
      opacity: 0.55,
    });
    expect(edgeBaseStyle(model, model.edges[edgeIndex('comp:RaceCard', 'type:Race')]!).color).toBe(
      '#a78bfa',
    );
    expect(
      edgeBaseStyle(model, model.edges[edgeIndex('hook:useRaces', 'lib:apiClient')]!).color,
    ).toBe('#9ca3af');
  });
});

describe('computeVisuals', () => {
  it('ハイライトはフロー・キャッシュより優先', () => {
    const s = { ...initialState(4), hoverId: 'comp:ResultTable', flowId: 'miss', cacheOn: true };
    const v = computeVisuals(model, s);
    expect(v.nodes.get('comp:ResultTable')!.visual).toBe('sel');
    expect(v.nodes.get('type:RaceResult')!.visual).toBe('down');
    expect(v.nodes.get('route:/races/[id]')!.visual).toBe('up');
    expect(v.nodes.get('infra:cloudfront')!.visual).toBe('dim');
    expect(v.edges[edgeIndex('comp:ResultTable', 'type:RaceResult')]!.color).toBe('#ff3b3b');
  });

  it('ホバーがなければ選択中が対象', () => {
    const v = computeVisuals(model, { ...initialState(4), selectedId: 'type:Race' });
    expect(v.hl.a).toBe('type:Race');
    expect(v.nodes.get('infra:lambdaApi')!.visual).toBe('up');
  });

  it('フロー表示中は経路上がシアン、それ以外は薄く', () => {
    const v = computeVisuals(model, { ...initialState(4), flowId: 'hit', cacheOn: true });
    expect(v.nodes.get('infra:cloudfront')!.visual).toBe('flow');
    expect(v.nodes.get('type:Race')!.visual).toBe('dim');
  });

  it('キャッシュモードは cache のないノードを soft にし、輪を出す', () => {
    const v = computeVisuals(model, { ...initialState(4), cacheOn: true });
    expect(v.nodes.get('infra:cloudfront')!).toMatchObject({ visual: 'normal', ringVisible: true });
    expect(v.nodes.get('type:Race')!).toMatchObject({ visual: 'soft', ringVisible: false });
  });

  it('層を隠すとノードとその層に触れる線が消える', () => {
    const s = initialState(4);
    s.layerVisible[0] = false;
    const v = computeVisuals(model, s);
    expect(v.nodes.get('infra:cloudfront')!.visible).toBe(false);
    expect(v.edges[edgeIndex('infra:lambdaNext', 'route:/')]!.visible).toBe(false);
    expect(v.edges[edgeIndex('comp:RaceCard', 'type:Race')]!.visible).toBe(true);
  });
});
