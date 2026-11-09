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
import { SAMPLE_V2_PATH } from '../graph/testSample';
import { clipText, fitLabel, renderScene, textWidth } from './render';

const graph = JSON.parse(readFileSync(SAMPLE_V2_PATH, 'utf8')) as GraphV2;
const index = indexGraph(graph);
const layout = layoutWiring(index);
const state0 = defaultState(index);

const scene = (lit: ReturnType<typeof select>, state: VariantState = state0) =>
  renderScene({ index, layout, state, lit });
/** 層（g.class）の中身を取り出す（層の印 `<g class="名前">` は 1 つずつしか無い） */
const ORDER = ['lanes', 'base-wires', 'hosts', 'base-boxes', 'lit-wires', 'lit-boxes', 'balls'];
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

  it('path が空の broken（役割ごとの欠け。docs/17 D59）は線そのものを赤で描き、title は理由だけ', () => {
    // 2026-11-09 追加（8-2b）: fixture-poly の PushToggle は必須の body を送らない（call_1 → in/body の線全体が赤）
    const g = structuredClone(graph);
    const w = g.wires.find((x) => x.from === 'fn:createTransaction#out/call_1.body')!;
    w.from = 'fn:createTransaction#out/call_1';
    w.broken = [{ path: '', level: 'error', reason: '送る側に無い（必須の body）' }];
    const idx = indexGraph(g);
    const svg = renderScene({ index: idx, layout: layoutWiring(idx), state: state0, lit: null });
    expect(svg).toContain('data-path="" d="');
    expect(svg).toContain('<title>送る側に無い（必須の body）</title>');
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
