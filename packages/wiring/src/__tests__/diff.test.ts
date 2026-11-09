// 差分（docs/18 §3.4）: core から移した diffGraphsV2（結果は移す前と同じ）と、配線図に描く graph（前にしか無いものを足す）
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { GraphV2, NodeV2 } from '@stack-atlas/schema';
import { diffGraphsV2, diffOverlayV2, isEmptyDiffV2 } from '../diff.js';
import { indexGraph } from '../graph-index.js';
import { layoutWiring } from '../layout/index.js';
import { select } from '../select.js';
import { defaultState } from '../variants.js';
import { PREV_EDITS as E, prevOfToday } from './diff-fixture.js';

const examplePath = fileURLToPath(
  new URL('../../../../examples/fixture-poly.today.v2.json', import.meta.url),
);
const read = () => JSON.parse(readFileSync(examplePath, 'utf8')) as GraphV2;

describe('diffGraphsV2（core から移した。結果は移す前と同じ）', () => {
  it('口の無い箱（検証していない graph）でも落ちない', () => {
    const a = read();
    const b = structuredClone(a);
    delete (b.nodes[0] as Partial<NodeV2>).ports;
    const d = diffGraphsV2(a, b);
    expect(d.removedItems).toEqual(['actor:user#out/open']);
  });

  it('同じなら空。箱・線・型・項目の増減と、箱・線の変更を出す', () => {
    const a = read();
    expect(isEmptyDiffV2(diffGraphsV2(a, a))).toBe(true);
    const b = structuredClone(a);
    b.nodes = b.nodes.filter((n) => n.id !== 'comp:TotalCard');
    b.wires = b.wires.filter((w) => !w.to.startsWith('comp:TotalCard#'));
    b.nodes.find((n) => n.id === 'route:/')!.name = 'Home';
    b.nodes
      .find((n) => n.id === 'route:/')!
      .ports[0]!.items.push({ id: 'date', name: 'date', type: 'string' });
    b.wires.find((w) => w.from === 'route:/#out/render_1')!.label = 'props';
    b.types = b.types!.filter((t) => t.id !== 'type:TodayView');
    const d = diffGraphsV2(a, b);
    expect(d.removedNodes).toEqual(['comp:TotalCard']);
    expect(d.addedNodes).toEqual([]);
    expect(d.changedNodes).toEqual([{ id: 'route:/', fields: ['name'] }]);
    expect(d.addedItems).toEqual(['route:/#in/date']);
    expect(d.removedItems).toEqual([]);
    expect(d.removedWires).toEqual([
      { from: 'comp:TodayIsland#out/render_1.view', to: 'comp:TotalCard#in/view', via: 'render' },
    ]);
    expect(d.changedWires).toEqual([
      {
        from: 'route:/#out/render_1',
        to: 'comp:TodayIsland#in/props',
        via: 'render',
        fields: ['label'],
      },
    ]);
    expect(d.removedTypes).toEqual(['type:TodayView']);
    expect(isEmptyDiffV2(d)).toBe(false);
  });
});

describe('diffOverlayV2（今の graph ＋ 前にしか無い箱・項目・線）', () => {
  const next = read();
  const snapshot = JSON.stringify(next);
  const prev = prevOfToday(next);
  const ov = diffOverlayV2(prev, next);
  const ui = indexGraph(ov.graph);
  const ci = indexGraph(next);

  it('今の graph は変えない。今の線は同じ順で先頭（線のキーは今の索引と同じ）', () => {
    expect(JSON.stringify(next)).toBe(snapshot);
    expect(ov.graph.wires.slice(0, next.wires.length)).toEqual(next.wires);
    for (const w of ci.wires) expect(ui.wires[w.index]!.key).toBe(w.key);
    expect(ui.wires[0]!.wire).toBe(next.wires[0]);
  });

  it('幽霊: 前にしか無い箱、今もある箱の消えた項目（口ごと消えたものも）、両端が解ける前にしか無い線', () => {
    expect([...ov.ghost.nodes].sort()).toEqual(
      [E.ghostNode, E.ghostInHost, E.ghostBadHost, E.ghostScreen].sort(),
    );
    expect([...ov.ghost.items].sort()).toEqual([E.removedPortItem, E.removedItem].sort());
    for (const r of ov.ghost.items) expect(ui.items.get(r), r).toBeDefined();
    // 足した線: 今の項目どうし 1・幽霊の箱へ 1・幽霊の箱から 1・消えた項目から 1。解けない線（nope:gone）は足さない
    const ghosts = ui.wires.filter((w) => ov.ghost.wires.has(w.key));
    expect(ghosts.map((w) => `${w.wire.from} → ${w.wire.to}`)).toEqual([
      `${E.ghostWire.from} → ${E.ghostWire.to}`,
      `fn:toTodayView#out/return → ${E.ghostNode}#in/x`,
      `${E.ghostNode}#out/return → comp:EntryList#in/entries`,
      `${E.removedItem} → ${E.ghostNode}#in/x`,
    ]);
    expect(ghosts.every((w) => w.index >= next.wires.length)).toBe(true);
    // 切れた線は今の graph の事実だけ描く（前の broken は外す）
    expect(ghosts.every((w) => w.wire.broken === undefined)).toBe(true);
    expect(ov.graph.wires).toHaveLength(next.wires.length + 4);
  });

  it('幽霊の箱: 画面の HTML を外し、host は今の枠か幽霊の箱を指すときだけ残す', () => {
    const node = (id: string) => ov.graph.nodes.find((n) => n.id === id)!;
    expect(node(E.ghostScreen).screen).toEqual({ width: 1280, height: 800 });
    expect(node(E.ghostInHost).host).toBe('infra:lambda_api/api');
    expect(node(E.ghostBadHost).host).toBeUndefined();
    // 今の箱（EntryList）は枠に変わらない
    expect(ui.hosts.has('comp:EntryList')).toBe(false);
    expect(ui.hosts.get('infra:lambda_api/api')!.map((n) => n.id)).toContain(E.ghostInHost);
  });

  it('今だけ（緑）: 足された箱・項目・線、type / wireType が変わった項目', () => {
    expect([...ov.added.nodes]).toEqual([E.addedNode]);
    expect([...ov.added.items]).toEqual([]);
    const added = [...ov.added.wires].map((k) => ci.wires.find((w) => w.key === k)!.wire);
    expect(added.map((w) => `${w.from} → ${w.to}`).sort()).toEqual(
      [
        `${E.addedWire.from} → ${E.addedWire.to}`,
        'comp:TodayIsland#out/render_1.view → comp:TotalCard#in/view',
      ].sort(),
    );
    expect([...ov.changed]).toEqual([E.changedItem]);
  });

  it('1 回で配置できる: 幽霊の箱・項目のピン・線の経路があり、画面の HTML の無い幽霊は画面の領域を持たない', () => {
    const layout = layoutWiring(ui);
    for (const id of ov.ghost.nodes) expect(layout.boxes.has(id), id).toBe(true);
    for (const r of ov.ghost.items) expect(layout.pins.has(r), r).toBe(true);
    for (const k of ov.ghost.wires) expect(layout.routes.has(k), k).toBe(true);
    expect(layout.boxes.get(E.ghostScreen)!.screen).toBeFalsy();
  });

  it('選ぶ・たどるは今の索引で行うので幽霊は光らない。光るものは足した graph でも同じ線・項目', () => {
    const lit = select(ci, defaultState(ci), { kind: 'box', id: 'fn:toTodayView' })!;
    for (const id of ov.ghost.nodes) expect(lit.boxes.has(id)).toBe(false);
    for (const r of ov.ghost.items) expect(lit.items.has(r)).toBe(false);
    for (const s of lit.segs) {
      if (!s.wire) continue;
      expect(ov.ghost.wires.has(s.wire.key)).toBe(false);
      expect(ui.wires[s.wire.index]!.wire).toBe(s.wire.wire);
    }
    // 幽霊の箱は今の索引に無いので選べない
    expect(select(ci, defaultState(ci), { kind: 'box', id: E.ghostNode })).toBeNull();
  });

  it('同じ graph なら印は空で、graph は今の graph と同じ', () => {
    const same = diffOverlayV2(next, next);
    expect(same.graph).toEqual(next);
    expect(same.ghost.nodes.size + same.ghost.items.size + same.ghost.wires.size).toBe(0);
    expect(same.added.nodes.size + same.added.items.size + same.added.wires.size).toBe(0);
    expect(same.changed.size).toBe(0);
  });
});
