// 配線図のレイアウト（docs/15 §3.6、docs/18 §3.1）: 重ならない・直交・決定的・枠が囲む・線が重ならない。
// 数値の受け入れ条件（縦横比・高さ・交差など。docs/18 §4）は layout-accept.test.ts
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
} from '../layout/index.js';
import { select } from '../select.js';
import { defaultState } from '../variants.js';
import { I, N, P, todayGraph, W } from './fixture.js';

const examplePath = fileURLToPath(
  new URL('../../../../examples/fixture-poly.today.v2.json', import.meta.url),
);
const example = () => JSON.parse(readFileSync(examplePath, 'utf8')) as GraphV2;

const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** 全部の経路（線と切れている線）の点 */
const allRoutes = (l: WiringLayout) => [
  ...[...l.routes.entries()].map(([k, r]) => [k, r.points] as const),
  ...l.broken.map((b) => [b.key, b.route.points] as const),
];

/** 直交の折れ線の区間が箱の内側を通るか（箱の辺に触れるだけ＝ピンの出入りは通らない扱い） */
const crossesBox = (pts: readonly { x: number; y: number }[], r: Rect) => {
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const x0 = Math.min(a.x, b.x);
    const x1 = Math.max(a.x, b.x);
    const y0 = Math.min(a.y, b.y);
    const y1 = Math.max(a.y, b.y);
    if (a.y === b.y && a.y > r.y && a.y < r.y + r.h && x1 > r.x && x0 < r.x + r.w) return true;
    if (a.x === b.x && a.x > r.x && a.x < r.x + r.w && y1 > r.y && y0 < r.y + r.h) return true;
  }
  return false;
};

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

  // 2026-11-09 変更（8-3a）: 線は通り道ごとに「縦の区間」を持ち、区間はトラックに左詰めで割り当てる（docs/18 §3.1 の 8）。
  // 縦の区間が重ならない線は同じ x を分け合うので、「同じ通り道の線は x を共有しない」から「縦の区間が重なる線は x を
  // 共有しない」に変えた。隙間（gaps）は通過点の束の段になり、段は線ごとに 1 つなので y は必ず違う
  it('同じ通り道で縦の区間が重なる線は x を共有せず、x は通り道の中。同じ束の段は y を共有しない', () => {
    const segs = new Map<number, { x: number; lo: number; hi: number; key: string }[]>();
    const all = [
      ...index.wires.map(
        (w) => [w.key, layout.pins.get(w.from.ref)!, layout.pins.get(w.to.ref)!] as const,
      ),
    ];
    for (const [key, a, b] of all) {
      const p = layout.plans.get(key)!;
      const ys = [a.y, ...p.ys, b.y];
      p.chans.forEach((c, i) => {
        const lo = Math.min(ys[i]!, ys[i + 1]!);
        const hi = Math.max(ys[i]!, ys[i + 1]!);
        const ch = layout.channels[c]!;
        expect(p.xs[i]!, key).toBeGreaterThan(ch.x);
        expect(p.xs[i]!, key).toBeLessThan(ch.x + ch.w);
        if (hi > lo) segs.set(c, [...(segs.get(c) ?? []), { x: p.xs[i]!, lo, hi, key }]);
      });
    }
    expect(segs.size).toBeGreaterThan(0);
    for (const [c, list] of segs)
      for (let i = 0; i < list.length; i++)
        for (let j = i + 1; j < list.length; j++) {
          const s1 = list[i]!;
          const s2 = list[j]!;
          if (s1.lo < s2.hi && s2.lo < s1.hi)
            expect(s1.x, `通り道 ${c}: ${s1.key} と ${s2.key}`).not.toBe(s2.x);
        }
    const gapY = new Map<string, number[]>();
    for (const p of layout.plans.values())
      p.gaps.forEach((g, i) => {
        const bundle = g.split(':').slice(0, 2).join(':');
        gapY.set(bundle, [...(gapY.get(bundle) ?? []), p.ys[i]!]);
      });
    for (const [g, ys] of gapY) expect(new Set(ys).size, `束 ${g}`).toBe(ys.length);
  });

  it('同じ入力から同じ出力（決定的）', () => {
    expect(plain(layoutWiring(indexGraph(make())))).toBe(plain(layout));
  });

  // 2026-11-09 変更（8-3a）: レーンは箱の多いときに複数の列に割る（docs/18 §3.1 の 4）。箱の x はレーンの x ではなく
  // 自分の列の x（列の中では左に揃える）。レーンの背景は自分の列を全部含む
  it('レーンは箱のあるものだけを固定の順に並べ、列はレーンの順に左から。背景の帯は自分の列を全部含み、隙間なく続く', () => {
    const order = ['user', 'browser', 'edge', 'build', 'server', 'data', 'external'];
    const ids = layout.lanes.map((l) => l.id);
    expect(ids).toEqual(order.filter((id) => ids.includes(id)));
    expect(layout.columns.map((c) => c.lane)).toEqual(
      [...layout.columns.map((c) => c.lane)].sort((a, b) => a - b),
    );
    layout.lanes.forEach((l, i) => {
      expect(l.index).toBe(i);
      if (i > 0) expect(l.x0).toBe(layout.lanes[i - 1]!.x1);
      expect(l.columns.length).toBeGreaterThan(0);
      for (const c of l.columns) {
        const col = layout.columns[c]!;
        expect(col.lane).toBe(i);
        expect(col.x).toBeGreaterThan(l.x0);
        expect(col.x + col.w).toBeLessThan(l.x1);
      }
      for (const b of boxes)
        if (b.lane === i) {
          expect(l.columns).toContain(b.col);
          expect(b.x).toBe(layout.columns[b.col]!.x);
          expect(b.w).toBeLessThanOrEqual(layout.columns[b.col]!.w);
        }
    });
    expect(layout.lanes[0]!.x0).toBe(0);
    expect(layout.lanes[layout.lanes.length - 1]!.x1).toBe(layout.width);
    for (const b of boxes) expect(b.y + b.h).toBeLessThan(layout.height);
  });

  it('経路の点は全部、図の幅と高さの中（レーンの帯の中）にある', () => {
    for (const [key, pts] of allRoutes(layout)) {
      for (const p of pts) {
        expect(p.x, key).toBeGreaterThanOrEqual(0);
        expect(p.x, key).toBeLessThanOrEqual(layout.width);
        expect(p.y, key).toBeGreaterThan(0);
        expect(p.y, key).toBeLessThan(layout.height);
        expect(
          layout.lanes.some((l) => l.x0 <= p.x && p.x <= l.x1),
          key,
        ).toBe(true);
      }
    }
  });

  it('線は箱の内側を通らない（途中のレーン・受ける側のレーンの箱を横の区間で横切らない）', () => {
    for (const [key, pts] of allRoutes(layout))
      for (const b of boxes) expect(crossesBox(pts, b), `${key} が ${b.id} を横切る`).toBe(false);
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
    // 2026-11-09 変更（8-2b）: InsertTransaction は cmd/api と cmd/gmail-webhook の両方の入口から届くので、規則
    // （docs/17 §7 #11。複数の入口から使う関数は host を空にして meta.hosts）に合わせて例の host を外した。枠の中から抜ける
    expect(layout.hosts.get('infra:lambda_api/api')!.members.sort()).toEqual([
      'fn:internal/api.handleCreateTransaction',
      'fn:internal/api.handleToday',
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

describe('layoutWiring: 隙間と高さと迂回（2026-11-09 のレビュー指摘）', () => {
  const box = (l: WiringLayout, id: string) => l.boxes.get(id)!;

  // 2026-11-09 変更（8-3a）: 自分を呼ぶ線は、箱と同じ列の通過点（折り返し）を通る。通過点は 1 つの束で、箱の下に付く
  // （以前は「レーンのいちばん上の隙間」を通った）。線どうしが間隔 8px で重ならないこと、箱を横切らないこと、
  // 線がレーンの名前より下で図の中に収まることは同じ
  it('自分を呼ぶ 7 本: 箱と同じ列の 1 つの束を通り、間隔 8px で重ならず、箱を横切らない', () => {
    // 自分を呼ぶ箱（out の 7 項目 → in の 7 項目）
    const ins = Array.from({ length: 7 }, (_, j) => I(`i${j}`, 'int'));
    const outs = Array.from({ length: 7 }, (_, j) => I(`o${j}`, 'int'));
    const g: GraphV2 = {
      version: 2,
      nodes: [N('fn:self', 'fn', 'server', [P('in', 'in', ins), P('out', 'out', outs)])],
      wires: outs.map((_, j) => W(`fn:self#out/o${j}`, `fn:self#in/i${j}`, 'call')),
    };
    const l = layoutWiring(indexGraph(g));
    const b = box(l, 'fn:self');
    const ys: number[] = [];
    const bundles = new Set<string>();
    for (const p of l.plans.values()) {
      expect(p.gaps).toHaveLength(1);
      bundles.add(p.gaps[0]!.split(':').slice(0, 2).join(':'));
      ys.push(p.ys[0]!);
    }
    expect(bundles.size).toBe(1);
    expect(ys).toHaveLength(7);
    for (const y of ys) {
      expect(y).toBeGreaterThan(l.titleY + 8);
      expect(y < b.y || y > b.y + b.h).toBe(true);
      expect(y).toBeLessThan(l.height);
    }
    const sorted = [...ys].sort((a, c) => a - c);
    for (let i = 1; i < sorted.length; i++)
      expect(sorted[i]! - sorted[i - 1]!).toBeGreaterThanOrEqual(8);
    for (const [key, pts] of allRoutes(l)) expect(crossesBox(pts, b), key).toBe(false);
  });

  it('いちばん下の箱の下の隙間を通る線も、図の高さの中に収まる', () => {
    // サーバーの箱 B（背が高い）からブラウザの箱 A へ戻る 6 本は、B の下の隙間を通る
    const outs = Array.from({ length: 6 }, (_, j) => I(`o${j}`, 'int'));
    const g: GraphV2 = {
      version: 2,
      nodes: [
        N('comp:A', 'component', 'browser', [
          P(
            'in',
            'in',
            outs.map((_, j) => I(`i${j}`, 'int')),
          ),
        ]),
        N('fn:B', 'fn', 'server', [
          P(
            'in',
            'in',
            Array.from({ length: 10 }, (_, j) => I(`x${j}`, 'int')),
          ),
          P('out', 'out', outs),
        ]),
      ],
      wires: outs.map((_, j) => W(`fn:B#out/o${j}`, `comp:A#in/i${j}`, 'return', true)),
    };
    const l = layoutWiring(indexGraph(g));
    const b = box(l, 'fn:B');
    expect(b.y + b.h).toBeGreaterThan(box(l, 'comp:A').y + box(l, 'comp:A').h);
    let maxY = 0;
    for (const [, pts] of allRoutes(l)) for (const p of pts) maxY = Math.max(maxY, p.y);
    expect(maxY).toBeGreaterThan(b.y + b.h);
    expect(maxY).toBeLessThan(l.height);
    for (const [key, pts] of allRoutes(l)) {
      for (const p of pts) {
        expect(p.y, key).toBeLessThan(l.height);
        expect(
          l.lanes.some((ln) => ln.x0 <= p.x && p.x <= ln.x1),
          key,
        ).toBe(true);
      }
    }
  });

  it('レーン 0 → 3 の線が途中のレーン 1・2 の箱に塞がれるとき、横の区間はどちらの箱も横切らない', () => {
    // S（利用者）の最後の項目 → T（サーバー）。途中のブラウザに A1（小）と B1（大）、エッジに B2（もっと大きい）。
    // T の入口の高さは B1 と B2 の両方に塞がれ、B1 の上の隙間は B2 が塞ぐ
    const many = (p: string, n: number) =>
      Array.from({ length: n }, (_, j) => I(`${p}${j}`, 'int'));
    const g: GraphV2 = {
      version: 2,
      nodes: [
        N('actor:S', 'actor', 'user', [P('out', 'out', many('o', 15))]),
        N('comp:A1', 'component', 'browser', [P('in', 'in', many('a', 1))]),
        N('comp:B1', 'component', 'browser', [P('in', 'in', many('b', 10))]),
        N('cache:B2', 'cache', 'edge', [P('in', 'in', many('c', 22))]),
        N('fn:T', 'fn', 'server', [P('in', 'in', many('t', 1))]),
      ],
      wires: [W('actor:S#out/o14', 'fn:T#in/t0', 'http')],
    };
    const l = layoutWiring(indexGraph(g));
    // 2026-11-09 変更（8-3a）: 途中の列には通過点を置くので、T の入口の高さが途中の箱に塞がれる配置にはならない
    // （以前は「T の入口の高さが B1 と B2 の両方に塞がれている」ことを前提に確かめた）。途中の列ごとに通過点を通り、
    // どの箱も横切らないことを確かめる
    const plan = l.plans.get('w0')!;
    const cols = (id: string) => box(l, id).col;
    expect(plan.ys).toHaveLength(cols('fn:T') - cols('actor:S') - 1);
    expect(cols('comp:B1')).toBeGreaterThan(cols('actor:S'));
    expect(cols('cache:B2')).toBeLessThan(cols('fn:T'));
    const pts = l.routes.get('w0')!.points;
    for (const b of l.boxes.values()) expect(crossesBox(pts, b), b.id).toBe(false);
  });

  it('左のレーンへ戻る線: 送る側の箱の下の隙間が途中の箱に塞がれるなら、横切らない隙間を通る', () => {
    // F（サーバー）→ A（ブラウザ）の戻り。F の下の隙間の高さには、途中のエッジの背の高い箱 M がある
    const many = (p: string, n: number) =>
      Array.from({ length: n }, (_, j) => I(`${p}${j}`, 'int'));
    const g: GraphV2 = {
      version: 2,
      nodes: [
        N('comp:A', 'component', 'browser', [P('in', 'in', many('i', 1))]),
        N('cache:M', 'cache', 'edge', [P('in', 'in', many('m', 20))]),
        N('fn:F', 'fn', 'server', [P('out', 'out', many('o', 1))]),
      ],
      wires: [W('fn:F#out/o0', 'comp:A#in/i0', 'return', true)],
    };
    const l = layoutWiring(indexGraph(g));
    const f = box(l, 'fn:F');
    const m = box(l, 'cache:M');
    // 前提: F の下端は M の高さの中
    expect(f.y + f.h).toBeGreaterThan(m.y);
    expect(f.y + f.h).toBeLessThan(m.y + m.h);
    const pts = l.routes.get('w0')!.points;
    for (const b of l.boxes.values()) expect(crossesBox(pts, b), b.id).toBe(false);
  });
});
