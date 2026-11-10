import { describe, expect, it } from 'vitest';
import { buildModel } from './graph/model';
import { loadSampleGraph } from './graph/testSample';
import {
  computeVisuals,
  defaultLabelMode,
  edgeBaseStyle,
  initialState,
  isNodeShown,
} from './state';

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

describe('差分の優先順位', () => {
  const diff = {
    added: new Set(['comp:ResultTable']),
    changed: new Map([['type:Race', ['name']]]),
  };
  it('通常時は追加・変更の印とゴーストを出す', () => {
    const v = computeVisuals(model, initialState(4), diff);
    expect(v.nodes.get('comp:ResultTable')!.diff).toBe('added');
    expect(v.nodes.get('type:Race')!.diff).toBe('changed');
    expect(v.nodes.get('infra:cloudfront')!.diff).toBeNull();
    expect(v.ghostOpacity).toBe(0.25);
  });
  it('ハイライト・フロー・キャッシュが差分より優先', () => {
    for (const s of [
      { ...initialState(4), hoverId: 'type:Race' },
      { ...initialState(4), flowId: 'miss' },
      { ...initialState(4), cacheOn: true },
    ]) {
      const v = computeVisuals(model, s, diff);
      expect(v.nodes.get('comp:ResultTable')!.diff).toBeNull();
      expect(v.ghostOpacity).toBeGreaterThan(0);
      expect(v.ghostOpacity).toBeLessThan(0.25);
    }
  });
  it('差分オフ・差分なしなら何も出さない', () => {
    const off = computeVisuals(model, { ...initialState(4), diffOn: false }, diff);
    expect(off.nodes.get('comp:ResultTable')!.diff).toBeNull();
    expect(off.ghostOpacity).toBe(0);
    expect(computeVisuals(model, initialState(4)).ghostOpacity).toBe(0);
  });
});

describe('検索と kind の表示', () => {
  it('検索の一致は sel、ホバー中の関連は down / up、それ以外は dim（検索 ＞ ホバー）', () => {
    const s = {
      ...initialState(4),
      searchMatches: new Set(['type:Race', 'infra:cloudfront']),
      hoverId: 'comp:ResultTable',
    };
    const v = computeVisuals(model, s);
    expect(v.nodes.get('type:Race')!.visual).toBe('sel');
    expect(v.nodes.get('infra:cloudfront')!.visual).toBe('sel');
    expect(v.nodes.get('comp:ResultTable')!.visual).toBe('down');
    expect(v.nodes.get('type:RaceResult')!.visual).toBe('down');
    expect(v.nodes.get('route:/races/[id]')!.visual).toBe('up');
    expect(v.nodes.get('infra:lambdaNext')!.visual).toBe('up');
  });
  it('検索中（ホバーなし）は一致同士の線だけ通常、ほかは薄く。0 件なら全部 dim', () => {
    const v = computeVisuals(model, {
      ...initialState(4),
      searchMatches: new Set(['comp:ResultTable', 'type:RaceResult']),
    });
    expect(v.edges[edgeIndex('comp:ResultTable', 'type:RaceResult')]!.opacity).toBeGreaterThan(0.3);
    expect(v.edges[edgeIndex('infra:lambdaNext', 'route:/')]!.opacity).toBe(0.05);
    const none = computeVisuals(model, { ...initialState(4), searchMatches: new Set() });
    for (const n of none.nodes.values()) expect(n.visual).toBe('dim');
  });
  it('kind チップで隠すと、そのノードと両端のエッジが非表示（層チップと同じ扱い）', () => {
    const v = computeVisuals(model, { ...initialState(4), kindVisible: { type: false } });
    expect(v.nodes.get('type:Race')!.visible).toBe(false);
    expect(v.nodes.get('comp:ResultTable')!.visible).toBe(true);
    expect(v.edges[edgeIndex('comp:ResultTable', 'type:RaceResult')]!.visible).toBe(false);
    expect(v.edges[edgeIndex('infra:lambdaNext', 'route:/')]!.visible).toBe(true);
    expect(
      isNodeShown(
        { ...initialState(4), kindVisible: { type: false } },
        model.byId.get('type:Race')!,
      ),
    ).toBe(false);
    expect(
      isNodeShown(
        { ...initialState(4), layerVisible: [true, true, true, false] },
        model.byId.get('type:Race')!,
      ),
    ).toBe(false);
  });
  it('ラベルの既定: 80 ノード以下は all、超えたら related', () => {
    expect(initialState(4, 80).labelMode).toBe('all');
    expect(initialState(4, 81).labelMode).toBe('related');
    expect(defaultLabelMode(250)).toBe('related');
  });
});
