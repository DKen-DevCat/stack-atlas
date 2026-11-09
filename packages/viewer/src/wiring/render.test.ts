// 配線図の SVG（文字列）: 層の順（光るものが手前）、沈める、分岐で薄く残す、切れている線、文字の収め方、エスケープ
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { GraphV2 } from '@stack-atlas/schema';
import {
  defaultState,
  indexGraph,
  layoutWiring,
  select,
  variantKey,
  type VariantState,
} from '@stack-atlas/wiring';
import { withScreenHtml } from '../../../wiring/src/__tests__/fixture';
import { SAMPLE_V2_PATH } from '../graph/testSample';
import { clipText, fitLabel, frameWithHole, renderScene, SCREEN_CUT_ID, textWidth } from './render';

const graph = JSON.parse(readFileSync(SAMPLE_V2_PATH, 'utf8')) as GraphV2;
const index = indexGraph(graph);
const layout = layoutWiring(index);
const state0 = defaultState(index);

const scene = (lit: ReturnType<typeof select>, state: VariantState = state0) =>
  renderScene({ index, layout, state, lit });
/**
 * 層（g.class）の中身を取り出す（層の印 `<g class="名前">` は 1 つずつしか無い）。
 * 2026-11-09 変更（8-3b）: 光る箱と球の間に部品の領域の枠の層（regions）が入った
 */
const ORDER = [
  'lanes',
  'base-wires',
  'hosts',
  'base-boxes',
  'lit-wires',
  'lit-boxes',
  'regions',
  'balls',
];
const layer = (svg: string, name: string) => {
  const i = ORDER.indexOf(name);
  const start = svg.indexOf(`<g class="${name}">`) + `<g class="${name}">`.length;
  const next = ORDER[i + 1];
  const end = next ? svg.indexOf(`<g class="${next}">`) : svg.length;
  return svg.slice(start, end).replace(/<\/g>$/, ''); // 層の閉じタグを外す
};
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

describe('renderScene', () => {
  it('選択なし: 箱・枠・線は全部下の層、線は細く薄く、切れている線は赤 2 件・黄 1 件（lit）', () => {
    const svg = scene(null);
    expect(count(svg, /data-box="/g)).toBe(layout.boxes.size);
    expect(count(svg, /data-host="/g)).toBe(2);
    expect(count(layer(svg, 'base-wires'), /class="wire thin/g)).toBe(graph.wires.length);
    expect(count(svg, /data-broken="/g)).toBe(3);
    // 2026-11-09 変更（D46）: 例の POST /transactions の amount（number → integer）を error から warn にしたので、
    // 赤（error）は 3 件から 2 件になり、黄（warn）が 1 件になった
    expect(count(svg, /class="wire broken error lit"/g)).toBe(2);
    expect(count(svg, /class="wire broken warn lit"/g)).toBe(1);
    expect(layer(svg, 'lit-boxes')).toBe('');
    expect(svg).not.toContain(' dim"');
    // 箱の種類は外側の左上（y が箱の上端より上）
    const b = layout.boxes.get('route:/')!;
    expect(svg).toContain(`<text class="kind" x="${b.x}" y="${b.y - 4}">screen</text>`);
  });

  it('画面を選ぶ: 光る箱と線は手前の層、光らない箱は dim（ラベルは CSS で消す）、始点は start', () => {
    const lit = select(index, state0, { kind: 'box', id: 'route:/' });
    const svg = scene(lit);
    const front = layer(svg, 'lit-boxes');
    const back = layer(svg, 'base-boxes');
    expect(front).toContain('data-box="fn:internal/api.handleToday"');
    expect(front).toContain('class="box lit start" data-box="route:/"');
    expect(back).toContain('class="box dim" data-box="endpoint:POST /transactions"');
    expect(back).not.toContain('data-box="route:/"');
    // 層の順: 枠 → 沈んだ箱 → 光る線 → 光る箱 → 球
    const at = ORDER.map((n) => svg.indexOf(`<g class="${n}">`));
    expect(at.every((x, i) => x >= 0 && (i === 0 || x > at[i - 1]!))).toBe(true);
    // 光る線は via の太さと当たり判定を持つ。キャッシュの箱の中の対応線を描く
    expect(count(layer(svg, 'lit-wires'), /class="wire hitarea"/g)).toBeGreaterThan(5);
    expect(layer(svg, 'lit-wires')).toContain('class="wire lit inner"');
    // 光っている線は下の層から外れる
    expect(count(layer(svg, 'base-wires'), /class="wire thin/g)).toBeLessThan(graph.wires.length);
    // POST の経路の切れている線は沈む（光っていない箱から出る）
    expect(svg).toContain('class="wire broken error dimmed"');
  });

  it('型を選ぶ: 横断面。光る線は描かず、始点の項目は start にしない', () => {
    const lit = select(index, state0, { kind: 'type', typeRef: 'type:Entry' });
    const svg = scene(lit);
    expect(layer(svg, 'lit-wires')).not.toContain('class="wire lit ');
    expect(svg).toContain('class="item on child"');
    expect(svg).not.toMatch(/class="item on start/);
  });

  it('分岐: CloudFront HIT では S3 が沈み、画面の下流は光ったまま', () => {
    const hit = { ...state0, [variantKey('infra:static_site/this', 'hit')]: true };
    const svg = scene(select(index, hit, { kind: 'box', id: 'route:/' }), hit);
    expect(layer(svg, 'base-boxes')).toContain('class="box dim" data-box="infra:static_site/site"');
    expect(layer(svg, 'lit-boxes')).toContain('data-box="comp:TodayIsland"');
  });

  it('文字は箱の幅に収め、削ったときだけ元の文字を title に入れる', () => {
    const svg = scene(null);
    // createTransaction の fetcher('/transactions', …) は長いので削られる
    expect(svg).toMatch(/<title>fetcher\('\/transactions'/);
    expect(svg).toContain('…');
  });

  it('graph の文字はエスケープする', () => {
    const g = structuredClone(graph);
    g.nodes.find((n) => n.id === 'route:/')!.name = '<img src=x onerror=alert(1)>';
    g.nodes.find((n) => n.id === 'route:/')!.ports[0]!.items[0]!.type = '"><script>';
    const idx = indexGraph(g);
    const svg = renderScene({ index: idx, layout: layoutWiring(idx), state: state0, lit: null });
    expect(svg).not.toContain('<img');
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;img');
  });
});

describe('文字の幅', () => {
  it('等幅の英数は 0.6em、全角は 1em で見積もる', () => {
    expect(textWidth('abcd', 10)).toBeCloseTo(24);
    expect(textWidth('戻り', 10)).toBe(20);
  });
  it('clipText は幅に収まらなければ末尾を … にする', () => {
    expect(clipText('short', 100, 10)).toBe('short');
    const c = clipText('a'.repeat(40), 60, 10);
    expect(c.endsWith('…')).toBe(true);
    expect(textWidth(c, 10)).toBeLessThanOrEqual(60);
  });
  it('fitLabel は型を先に削り、名前を残す', () => {
    const r = fitLabel('entries', 'Array<VeryLongGenericTypeName<Entry>>', 120);
    expect(r.cut).toBe(true);
    expect(r.name).toBe('entries');
    expect(r.type.endsWith('…')).toBe(true);
    expect(fitLabel('id', 'string', 120)).toEqual({ name: 'id', type: 'string', cut: false });
  });
});

describe('配置は graph ごとに 1 回（docs/18 §3.1・§4「動かない」）', () => {
  const BASELINE = new URL(
    '../../../wiring/src/__tests__/fixtures/poly-82a.v2.json',
    import.meta.url,
  );
  /**
   * 箱と host の枠の矩形（id ごと）。選択で層が変わっても座標は同じはず。
   * 2026-11-09 変更（8-3b）: 画面の領域を持つ箱は、枠の rect の前に画面の塗り（screen-bg）とプレースホルダ（screen-ph）がある
   */
  const rects = (svg: string) => {
    const out: string[] = [];
    for (const m of svg.matchAll(
      /data-box="([^"]+)"[^>]*>(?:<path class="screen-bg"[^>]*\/>)?(?:<g class="screen-ph"[^>]*>.*?<\/g>)?<rect class="shape" x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/g,
    ))
      out.push(m.slice(1).join(' '));
    for (const m of svg.matchAll(
      /data-host="([^"]+)"><rect class="frame" x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/g,
    ))
      out.push(`host ${m.slice(1).join(' ')}`);
    return out.sort();
  };

  it.each([
    ['基準の graph（poly-82a）', () => JSON.parse(readFileSync(BASELINE, 'utf8')) as GraphV2],
    ['/today の例', () => graph],
    [
      '基準の graph に画面の HTML（8-3b）',
      () => withScreenHtml(JSON.parse(readFileSync(BASELINE, 'utf8')) as GraphV2),
    ],
  ])(
    '%s: 分岐を全部切り替えても、選択・選択の解除をしても、どの箱と枠の座標も変わらない',
    (_n, make) => {
      const g = make();
      const idx = indexGraph(g);
      const lay = layoutWiring(idx);
      const s0 = defaultState(idx);
      const base = rects(renderScene({ index: idx, layout: lay, state: s0, lit: null }));
      expect(base.length).toBe(lay.boxes.size + lay.hosts.size);
      // 分岐: 1 つずつ反転、全部反転
      const states: VariantState[] = [s0];
      const all: VariantState = { ...s0 };
      for (const n of g.nodes)
        for (const v of n.variants ?? []) {
          const k = variantKey(n.id, v.id);
          states.push({ ...s0, [k]: !s0[k] });
          all[k] = !s0[k];
        }
      states.push(all);
      expect(states.length).toBeGreaterThan(2);
      // 始点: 画面・共有の箱・下流だけ・項目・型・線・枠・選択の解除
      const screen = g.nodes.find((n) => n.kind === 'screen')!.id;
      const w0 = idx.wires[0]!;
      const item = idx.wires.find((w) => w.from.id !== '_')?.from.ref ?? w0.from.ref;
      const type = [...idx.byTypeRef.keys()][0];
      const host = [...lay.hosts.keys()][0]!;
      const sels = [
        { kind: 'box' as const, id: screen },
        { kind: 'box' as const, id: screen, downOnly: true },
        { kind: 'box' as const, id: w0.toNode.id },
        { kind: 'item' as const, ref: item },
        ...(type ? [{ kind: 'type' as const, typeRef: type }] : []),
        { kind: 'wire' as const, from: w0.wire.from, to: w0.wire.to },
        { kind: 'host' as const, id: host },
      ];
      for (const state of states) {
        expect(rects(renderScene({ index: idx, layout: lay, state, lit: null }))).toEqual(base);
        for (const sel of sels) {
          const lit = select(idx, state, sel);
          expect(
            rects(renderScene({ index: idx, layout: lay, state, lit })),
            JSON.stringify(sel),
          ).toEqual(base);
        }
      }
      // 配置をし直しても同じ（入力は索引だけ）
      expect(
        rects(renderScene({ index: idx, layout: layoutWiring(idx), state: all, lit: null })),
      ).toEqual(base);
    },
  );
});

describe('画面の箱（画面の HTML を持つ箱。docs/18 §3.3）', () => {
  const g = withScreenHtml(graph);
  const idx = indexGraph(g);
  const lay = layoutWiring(idx);
  const b = lay.boxes.get('route:/')!;
  const scr = b.screen!;
  /** 箱 1 つ分の SVG（次の箱の手前まで） */
  const box = (svg: string, id: string) => {
    const i = svg.indexOf(`data-box="${id}"`);
    const j = svg.indexOf('data-box="', i + 1);
    return svg.slice(i, j < 0 ? undefined : j);
  };

  it('画面の領域だけ塗らず（穴の空いた塗り）、枠の rect は透明の塗りでクリックを受ける。プレースホルダの文言は空で描く', () => {
    const svg = renderScene({ index: idx, layout: lay, state: defaultState(idx), lit: null });
    const s = box(svg, 'route:/');
    expect(svg).toContain('class="box scr" data-box="route:/"');
    expect(s).toContain(
      `<path class="screen-bg" d="${frameWithHole(b, 4, scr)}" fill="#4f8cff1a" fill-rule="evenodd"/>`,
    );
    expect(s).toContain('<g class="screen-ph" data-screen-ph="route:/">');
    expect(s).toMatch(/<rect class="shape"[^>]*fill="transparent"/);
    expect(s).toMatch(/<text x="[\d.]+" y="[\d.]+" text-anchor="middle"><\/text><\/g>/);
    // 層の順: 塗り → プレースホルダ → 枠 → 名前（枠の線と名前が画面の上）
    const at = ['screen-bg', 'screen-ph', 'class="shape"', 'class="name"'].map((k) => s.indexOf(k));
    expect(at.every((x, i) => x >= 0 && (i === 0 || x > at[i - 1]!))).toBe(true);
    // 画面でない箱は今までどおり
    expect(box(svg, 'comp:TodayIsland')).not.toContain('screen-bg');
    expect(box(svg, 'comp:TodayIsland')).toMatch(/<rect class="shape"[^>]*fill="#a78bfa1a"/);
  });

  it('レーンの背景は画面の領域を抜く（clip-path の穴）。画面が無い graph には付けない', () => {
    const svg = renderScene({ index: idx, layout: lay, state: defaultState(idx), lit: null });
    expect(svg).toContain(`<g class="lanes" clip-path="url(#${SCREEN_CUT_ID})">`);
    expect(svg).toContain(
      `M${scr.x},${scr.y} h${scr.w} v${Math.round(scr.h * 10) / 10} h${-scr.w} Z`,
    );
    expect(scene(null)).not.toContain('clip-path');
  });

  it('部品の領域の枠は光る箱の上・球の下の層（regions）に入る', () => {
    const lit = select(idx, defaultState(idx), { kind: 'box', id: 'route:/' });
    const svg = renderScene({
      index: idx,
      layout: lay,
      state: defaultState(idx),
      lit,
      regions: '<rect class="region"/>',
    });
    expect(svg).toContain('<g class="regions"><rect class="region"/></g><g class="balls">');
  });

  it('frameWithHole: 外周（角の丸み）と内側の穴の 2 つの部分パス', () => {
    const d = frameWithHole({ x: 0, y: 0, w: 100, h: 50 }, 4, { x: 1, y: 26, w: 98, h: 23 });
    expect(d.match(/M/g)).toHaveLength(2);
    expect(d).toContain('A4,4 0 0 1 100,4');
    expect(d.endsWith('M1,26 h98 v23 h-98 Z')).toBe(true);
    // 丸みは箱の半分を超えない
    expect(frameWithHole({ x: 0, y: 0, w: 10, h: 6 }, 999, { x: 0, y: 0, w: 1, h: 1 })).toContain(
      'A3,3',
    );
  });
});
