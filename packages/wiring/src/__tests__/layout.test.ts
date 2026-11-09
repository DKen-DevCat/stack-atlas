// 配線図のレイアウト（docs/15 §3.6、モック第 6 版の近似の移植）: 重ならない・直交・決定的・枠が囲む・線が重ならない
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { GraphV2 } from '@stack-atlas/schema';
import { indexGraph } from '../graph-index.js';
import {
  innerRoute,
  layoutWiring,
  pointAt,
  routeLength,
  segmentRoute,
  BROKEN_CUT,
  type Rect,
  type WiringLayout,
} from '../layout.js';
import { select } from '../select.js';
import { defaultState } from '../variants.js';
import { todayGraph } from './fixture.js';

const examplePath = fileURLToPath(
  new URL('../../../../examples/fixture-poly.today.v2.json', import.meta.url),
);
const example = () => JSON.parse(readFileSync(examplePath, 'utf8')) as GraphV2;

const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Map を含む結果を比べられる形にする */
const plain = (l: WiringLayout) =>
  JSON.stringify(l, (_k, v: unknown) => (v instanceof Map ? [...v.entries()] : v));

const graphs: [string, () => GraphV2][] = [
  ['examples/fixture-poly.today.v2.json', example],
  ['モックを縮めた合成グラフ（todayGraph）', todayGraph],
];

describe.each(graphs)('layoutWiring: %s', (_name, make) => {
  const index = indexGraph(make());
  const layout = layoutWiring(index);
  const boxes = [...layout.boxes.values()];

  it('箱どうしが重ならない', () => {
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++)
        expect(overlaps(boxes[i]!, boxes[j]!), `${boxes[i]!.id} と ${boxes[j]!.id}`).toBe(false);
  });

  it('host に指された箱は箱ではなく枠になり、枠は中の箱を囲み、外の箱とは重ならない', () => {
    expect(layout.hosts.size).toBeGreaterThan(0);
    for (const h of layout.hosts.values()) {
      expect(layout.boxes.has(h.id)).toBe(false);
      expect(h.members.length).toBeGreaterThan(0);
      for (const id of h.members) {
        const b = layout.boxes.get(id)!;
        expect(b.x).toBeGreaterThan(h.x);
        expect(b.y).toBeGreaterThan(h.y);
        expect(b.x + b.w).toBeLessThan(h.x + h.w);
        expect(b.y + b.h).toBeLessThan(h.y + h.h);
      }
      for (const b of boxes)
        if (!h.members.includes(b.id)) expect(overlaps(h, b), `${h.id} と ${b.id}`).toBe(false);
    }
  });

  it('項目は常に全部開く: 全項目にピン、子は親の直後、口の区切りは null、口の順は固定', () => {
    for (const n of index.nodes.values()) {
      const b = layout.boxes.get(n.id);
      if (!b) continue;
      for (const it of n.items) {
        const p = layout.pins.get(it.ref)!;
        expect(p, it.ref).toBeDefined();
        expect(p.x).toBe(it.dir === 'in' ? b.x : b.x + b.w);
        expect(p.y).toBeGreaterThan(b.y);
        expect(p.y).toBeLessThan(b.y + b.h);
      }
      for (const col of [b.ins, b.outs]) {
        const refs = col.filter((r): r is string => r !== null);
        // 子は親の直後（深さ優先）
        refs.forEach((r, i) => {
          const it = index.items.get(r)!;
          if (it.parent) {
            const pi = refs.indexOf(it.parent.ref);
            expect(pi).toBeGreaterThanOrEqual(0);
            expect(pi).toBeLessThan(i);
            for (const between of refs.slice(pi + 1, i))
              expect(between.startsWith(it.parent.ref + '.'), between).toBe(true);
          }
        });
        // 口の順（宣言順）は保たれ、口が変わる所に null
        const portOrder = n.node.ports.map((p) => p.id);
        const ports = col.map((r) => (r === null ? null : index.items.get(r)!.port.id));
        let last = -1;
        ports.forEach((p, i) => {
          if (p === null) {
            expect(ports[i - 1]).not.toBe(ports[i + 1]);
            return;
          }
          const k = portOrder.indexOf(p);
          expect(k).toBeGreaterThanOrEqual(last);
          if (k !== last && last !== -1) expect(ports[i - 1]).toBeNull();
          last = k;
        });
      }
      // 行は縦に重ならない
      const ys = [...b.ins, ...b.outs]
        .filter((r): r is string => r !== null)
        .map((r) => layout.pins.get(r)!);
      for (const side of ['in', 'out'] as const) {
        const s = ys.filter((p) => p.side === side).map((p) => p.y);
        expect(new Set(s).size).toBe(s.length);
      }
    }
  });

  it('線の経路は直交の折れ線で、送る側のピンから受ける側のピンへ。長さは区間の和', () => {
    for (const w of index.wires) {
      const r = layout.routes.get(w.key)!;
      expect(r, w.key).toBeDefined();
      const pts = r.points;
      expect(pts[0]).toEqual({
        x: layout.pins.get(w.from.ref)!.x,
        y: layout.pins.get(w.from.ref)!.y,
      });
      expect(pts[pts.length - 1]).toEqual({
        x: layout.pins.get(w.to.ref)!.x,
        y: layout.pins.get(w.to.ref)!.y,
      });
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1]!;
        const b = pts[i]!;
        expect(a.x === b.x || a.y === b.y, `${w.key} の ${i} 番目`).toBe(true);
      }
      expect(r.length).toBeCloseTo(routeLength(pts));
      // 出口は右へ、入口へは左から入る
      expect(pts[1]!.x).toBeGreaterThan(pts[0]!.x);
      expect(pts[pts.length - 2]!.x).toBeLessThan(pts[pts.length - 1]!.x);
    }
  });

  it('同じ通り道・同じ隙間を通る線は x / y を共有しない', () => {
    const chanX = new Map<number, number[]>();
    const gapY = new Map<string, number[]>();
    for (const p of layout.plans.values()) {
      p.chans.forEach((c, i) => chanX.set(c, [...(chanX.get(c) ?? []), p.xs[i]!]));
      p.gaps.forEach((g, i) => gapY.set(g, [...(gapY.get(g) ?? []), p.ys[i]!]));
    }
    expect(chanX.size).toBeGreaterThan(0);
    for (const [c, xs] of chanX) {
      expect(new Set(xs).size, `通り道 ${c}`).toBe(xs.length);
      const ch = layout.channels[c]!;
      for (const x of xs) {
        expect(x).toBeGreaterThan(ch.x);
        expect(x).toBeLessThan(ch.x + ch.w);
      }
    }
    for (const [g, ys] of gapY) expect(new Set(ys).size, `隙間 ${g}`).toBe(ys.length);
  });

  it('同じ入力から同じ出力（決定的）', () => {
    expect(plain(layoutWiring(indexGraph(make())))).toBe(plain(layout));
  });

  it('レーンは箱のあるものだけを固定の順に並べ、背景の帯は隙間なく続く', () => {
    const order = ['user', 'browser', 'edge', 'build', 'server', 'data', 'external'];
    const ids = layout.lanes.map((l) => l.id);
    expect(ids).toEqual(order.filter((id) => ids.includes(id)));
    layout.lanes.forEach((l, i) => {
      expect(l.index).toBe(i);
      if (i > 0) expect(l.x0).toBe(layout.lanes[i - 1]!.x1);
      for (const b of boxes) if (b.lane === i) expect(b.x).toBe(l.x);
    });
    expect(layout.lanes[0]!.x0).toBe(0);
    expect(layout.lanes[layout.lanes.length - 1]!.x1).toBe(layout.width);
    for (const b of boxes) expect(b.y + b.h).toBeLessThan(layout.height);
  });

  it('切れている線: 送る側の項目から、受ける側の箱の手前で切れる', () => {
    for (const br of layout.broken) {
      const pts = br.route.points;
      const a = layout.pins.get(br.from)!;
      const t = layout.pins.get(br.to)!;
      const tb = layout.boxes.get(index.items.get(br.to)!.node.id)!;
      expect(pts[0]).toEqual({ x: a.x, y: a.y });
      expect(pts[pts.length - 1]).toEqual({ x: tb.x - BROKEN_CUT, y: t.y });
    }
  });
});

describe('layoutWiring: 例の v2 グラフ', () => {
  const index = indexGraph(example());
  const layout = layoutWiring(index);

  it('Lambda と Aurora は枠。S3 の静的サイトはエッジのレーンの箱（D42 改訂）で、画面は枠を持たない', () => {
    expect([...layout.hosts.keys()].sort()).toEqual(['infra:aurora/this', 'infra:lambda_api/api']);
    expect(layout.hosts.get('infra:lambda_api/api')!.members.sort()).toEqual([
      'fn:internal/api.handleCreateTransaction',
      'fn:internal/api.handleToday',
      'fn:internal/store.InsertTransaction',
      'fn:internal/store.ListByDate',
    ]);
    const lane = (id: string) => layout.lanes[layout.boxes.get(id)!.lane]!.id;
    expect(lane('infra:static_site/site')).toBe('edge');
    expect(lane('infra:static_site/this')).toBe('edge');
    expect(lane('route:/')).toBe('browser');
    expect(lane('schema:transactions')).toBe('data');
    // 外部のレーンは箱が無いので出さない
    expect(layout.lanes.map((l) => l.id)).toEqual(['user', 'browser', 'edge', 'server', 'data']);
  });

  it('書かれた broken 3 件（2 本の線）を描く端に変える', () => {
    expect(layout.broken.map((b) => [b.from, b.to])).toEqual([
      [
        'fn:internal/api.handleToday#out/resp.entries.occurredAt',
        'endpoint:GET /today#res/body.entries',
      ],
      ['fn:createTransaction#out/call_1.body.amount', 'endpoint:POST /transactions#in/body.amount'],
      ['fn:createTransaction#out/call_1.body', 'endpoint:POST /transactions#in/body.occurredAt'],
    ]);
  });

  it('光る区間の経路: 子に写った区間は線の計画を子のピンで使い、球の長さはその経路の長さ', () => {
    const lit = select(index, defaultState(index), { kind: 'box', id: 'route:/' })!;
    let mapped = 0;
    for (const s of lit.segs) {
      const r = segmentRoute(layout, s)!;
      expect(r, s.key).not.toBeNull();
      const a = layout.pins.get(s.from.ref)!;
      const b = layout.pins.get(s.to.ref)!;
      expect(r.points[0]).toEqual({ x: a.x, y: a.y });
      expect(r.points[r.points.length - 1]).toEqual({ x: b.x, y: b.y });
      if (s.kind === 'wire' && s.wire && s.from !== s.wire.from) mapped++;
    }
    // 見つかったこと: 画面のクリックでは、親の単位の線を子からたどる区間が出る（handleToday の resp.entries など）
    expect(mapped).toBeGreaterThan(0);
  });
});

describe('経路の小道具', () => {
  it('pointAt は折れ線に沿って進み、端で止まる', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ];
    expect(routeLength(pts)).toBe(20);
    expect(pointAt(pts, 5)).toEqual({ x: 5, y: 0 });
    expect(pointAt(pts, 15)).toEqual({ x: 10, y: 5 });
    expect(pointAt(pts, 99)).toEqual({ x: 10, y: 10 });
    expect(pointAt(pts, -1)).toEqual({ x: 0, y: 0 });
  });
  it('innerRoute は左右のピンの中央で折れる', () => {
    expect(innerRoute({ x: 0, y: 0 }, { x: 100, y: 20 })).toEqual([
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 20 },
      { x: 100, y: 20 },
    ]);
  });
});
