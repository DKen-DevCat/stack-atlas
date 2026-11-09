// 配線図の SVG のメモの印と差分の印（docs/18 §3.4。Phase 8-3c）: 右下の角を折る（形だけ）、幽霊（灰の点線・クリックを受けない）、
// 今だけ・型の変わった項目（緑の縁）。幽霊は光らない
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { GraphV2 } from '@stack-atlas/schema';
import { defaultState, diffOverlayV2, indexGraph, layoutWiring, select } from '@stack-atlas/wiring';
import { PREV_EDITS as E, prevOfToday } from '../../../wiring/src/__tests__/diff-fixture';
import { SAMPLE_V2_PATH } from '../graph/testSample';
import { memoBoxIds } from './memoRules';
import { renderScene } from './render';

const graph = JSON.parse(readFileSync(SAMPLE_V2_PATH, 'utf8')) as GraphV2;
const index = indexGraph(graph);
const layout = layoutWiring(index);
const state = defaultState(index);

/** 箱の g（`<g class="box…" data-box="id"` から次の箱の手前まで） */
const boxG = (svg: string, id: string, attr = 'data-box') => {
  const start = svg.indexOf(`${attr}="${id}"`);
  if (start < 0) return '';
  const from = svg.lastIndexOf('<g class="box', start);
  const next = svg.indexOf('<g class="box', start);
  const rest = svg.slice(start);
  const m = /<\/g><g class="(?:hosts|base-boxes|lit-wires|lit-boxes|regions|balls)">/.exec(rest);
  const layerEnd = m ? start + m.index : -1;
  const end = Math.min(...[next, layerEnd].filter((x) => x > 0));
  return svg.slice(from, end);
};
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

describe('メモの印（右下の角を折る）', () => {
  const memos = memoBoxIds(index, { 'route:/': 'a', 'endpoint:GET /today': 'b' });
  const svg = renderScene({ index, layout, state, lit: null, memos });
  const plain = renderScene({ index, layout, state, lit: null });

  it('メモのある箱だけ、角を切る clipPath（箱ごと）と折り返しを描く。文字の印は付けない', () => {
    expect(count(svg, /<clipPath id="wv-memo-\d+"/g)).toBe(2);
    expect(count(svg, /class="memo-fold"/g)).toBe(2);
    for (const id of ['route:/', 'endpoint:GET /today']) {
      const g = boxG(svg, id);
      expect(g, id).toMatch(/<rect class="shape"[^>]*clip-path="url\(#wv-memo-\d+\)"/);
      expect(g, id).toContain('class="memo-fold"');
      // 文字（text）の数はメモが無いときと同じ
      expect(count(g, /<text/g), id).toBe(count(boxG(plain, id), /<text/g));
    }
    // endpoint の二重の枠（deco）も同じ角で切る
    expect(boxG(svg, 'endpoint:GET /today')).toMatch(/<rect class="deco"[^>]*clip-path=/);
    expect(boxG(svg, 'comp:TodayIsland')).not.toContain('memo-fold');
    expect(plain).not.toContain('wv-memo-');
  });

  it('箱の座標は変わらない（印は描くだけ）', () => {
    const rects = (s: string) =>
      [
        ...s.matchAll(
          /<rect class="shape" x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/g,
        ),
      ].map((m) => m.slice(1).join(','));
    expect(rects(svg)).toEqual(rects(plain));
  });
});

describe('差分の印（?prev= が v2）', () => {
  const ov = diffOverlayV2(prevOfToday(graph), graph);
  const ui = indexGraph(ov.graph);
  const ul = layoutWiring(ui);
  const svg = renderScene({ index: ui, layout: ul, state, lit: null, diff: ov });

  it('幽霊の箱: data-box を付けない（クリック・hover を受けない）。項目の行は data-item・data-type を付けない', () => {
    for (const id of ov.ghost.nodes) {
      if (ui.hosts.has(id)) continue;
      expect(svg).not.toContain(`data-box="${id}"`);
      const g = boxG(svg, id, 'data-ghost');
      expect(g, id).toMatch(/^<g class="box ghost"/);
      expect(g, id).not.toContain('data-item=');
      expect(g, id).not.toContain('data-type=');
    }
    expect(count(svg, /data-box="/g)).toBe(index.nodes.size - index.hosts.size);
  });

  it('今もある箱の消えた項目は灰の行（data-ghost-item）、今だけの箱は緑の縁、型の変わった項目は緑の縁', () => {
    const getToday = boxG(svg, 'fn:getToday');
    expect(getToday).toContain(`<g class="item ghost" data-ghost-item="${E.removedItem}">`);
    expect(getToday).toMatch(new RegExp(`<g class="item added" data-item="${E.changedItem}">`));
    expect(boxG(svg, 'lib:fetcher')).toContain(`data-ghost-item="${E.removedPortItem}"`);
    expect(boxG(svg, E.addedNode)).toMatch(/^<g class="box added"/);
    expect(boxG(svg, E.addedNode)).toContain('class="dmark"');
    expect(boxG(svg, 'route:/')).not.toContain('dmark');
  });

  it('前にしか無い線は灰の点線（data-ghost-wire。data-key・data-ends を付けない）、今だけの線は緑', () => {
    expect(count(svg, /data-ghost-wire="/g)).toBe(ov.ghost.wires.size);
    for (const k of ov.ghost.wires) {
      expect(svg).toContain(`class="wire thin ghost" data-ghost-wire="${k}"`);
      expect(svg).not.toContain(`data-key="${k}"`);
    }
    for (const k of ov.added.wires)
      expect(svg).toMatch(new RegExp(`class="wire thin[^"]* added[^"]*" data-key="${k}"`));
  });

  it('選択（今の索引）: 幽霊は光らず沈む。光る層に幽霊の箱・線は入らない（光る箱の中の消えた項目は灰の行のまま）', () => {
    const lit = select(index, state, { kind: 'box', id: 'fn:toTodayView' })!;
    const s = renderScene({ index: ui, layout: ul, state, lit, diff: ov });
    const litLayer = s.slice(s.indexOf('<g class="lit-wires">'), s.indexOf('<g class="regions">'));
    expect(litLayer).not.toContain('data-ghost=');
    expect(litLayer).not.toContain('data-ghost-wire=');
    expect(litLayer).toContain(`<g class="item ghost" data-ghost-item="${E.removedItem}">`);
    expect(boxG(s, E.ghostNode, 'data-ghost')).toMatch(/^<g class="box ghost dim"/);
    expect(s).toContain('class="wire thin ghost dimmed"');
  });
});
