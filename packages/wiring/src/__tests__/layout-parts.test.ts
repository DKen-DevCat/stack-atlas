// 配線図のレイアウトの手順（docs/18 §3.1）を 1 つずつ: 層・層を決める線・列の割り方・通過点・束・列の中の並び・
// 箱ごとの幅・PAVA・交差の数え方。基準の graph（fixtures/poly-82a.v2.json）で見つかったことも固定する
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { GraphV2 } from '@stack-atlas/schema';
import { indexGraph } from '../graph-index.js';
import { layoutWiring } from '../layout/index.js';
import { assignLayers } from '../layout/layers.js';
import { isForward, isReference } from '../layout/model.js';
import { inversions, pava } from '../layout/place.js';
import { I, N, P, W } from './fixture.js';

const baseline = () =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL('./fixtures/poly-82a.v2.json', import.meta.url)), 'utf8'),
  ) as GraphV2;

describe('assignLayers（最長経路・閉路・入ってくる線の無い箱）', () => {
  const decl = (s: string) => s.charCodeAt(0);
  it('鎖は 0, 1, 2。閉路は DFS の後退辺を外して切る', () => {
    const l = assignLayers(
      ['a', 'b', 'c'],
      [
        ['a', 'b'],
        ['b', 'c'],
        ['c', 'a'],
      ],
      [],
      decl,
    );
    expect([l.get('a'), l.get('b'), l.get('c')]).toEqual([0, 1, 2]);
  });
  it('入ってくる線の無い箱は、後続の層の最小値のすぐ左（列 0 に集めない）', () => {
    // a → b → c → d、s → d。s は d のすぐ左（層 2）で、a と同じ層 0 にはしない
    const l = assignLayers(
      ['a', 'b', 'c', 'd', 's'],
      [
        ['a', 'b'],
        ['b', 'c'],
        ['c', 'd'],
        ['s', 'd'],
      ],
      [],
      decl,
    );
    expect(l.get('s')).toBe(2);
    expect(l.get('d')).toBe(3);
  });
  it('どちらの線も無い箱は、層を決めない線（参照・戻り）で呼ぶ箱の次。何も無ければ 0。空いた層は詰める', () => {
    const l = assignLayers(['a', 'b', 'k', 'z'], [['a', 'b']], [['b', 'k']], decl);
    expect(l.get('k')).toBe(2);
    expect(l.get('z')).toBe(0);
    expect(new Set(l.values())).toEqual(new Set([0, 1, 2]));
  });
});

describe('層を決める線（docs/18 §3.1 の 3）', () => {
  const index = indexGraph(baseline());
  const wire = (from: string, to: string) =>
    index.wires.find((w) => w.wire.from === from && w.wire.to === to)!;
  it('呼び出しでない参照の `_` の線（項目の単位になった箱の out/_）は除く。箱の単位の Go と endpoint の req/_ は呼び出し', () => {
    expect(isReference(wire('comp:PushToggle#out/_', 'lib:consts#in/_'))).toBe(true);
    expect(isReference(wire('lib:fetcher#out/_', 'lib:consts#in/_'))).toBe(true);
    expect(isReference(wire('endpoint:GET /today#req/_', 'handler:internal/api#in/_'))).toBe(false);
    expect(isReference(wire('handler:cmd/api#out/_', 'handler:internal/api#in/_'))).toBe(false);
    expect(isReference(wire('actor:user#out/_', 'endpoint:GET /today#in/_'))).toBe(false);
    // 見つかったこと: 基準の graph で参照と判定されるのは定数の import の 2 本だけ（戻りの 2 本は reply で除く）
    expect(index.wires.filter(isReference).map((w) => w.key)).toEqual(['w0', 'w2']);
  });
  it('戻り（reply・return・deliver）は除き、呼び出し・render・http・sql・event は数える', () => {
    for (const w of index.wires) {
      if (w.reply || w.wire.via === 'return' || w.wire.via === 'deliver')
        expect(isForward(w)).toBe(false);
      else if (!isReference(w)) expect(isForward(w)).toBe(true);
    }
  });
});

describe('レーンを列に割る・通過点・束（基準の graph）', () => {
  const index = indexGraph(baseline());
  const layout = layoutWiring(index);
  const col = (id: string) => layout.boxes.get(id)!.col;
  const lane = (id: string) => layout.lanes[layout.boxes.get(id)!.lane]!.id;

  it('箱の多いレーン（ブラウザ・サーバー）だけを列に割り、ほかは 1 列', () => {
    const n = Object.fromEntries(layout.lanes.map((l) => [l.id, l.columns.length]));
    expect(n.browser).toBeGreaterThanOrEqual(2);
    expect(n.server).toBeGreaterThanOrEqual(2);
    expect(n.user).toBe(1);
    expect(n.edge).toBe(1);
    expect(n.data).toBe(1);
  });

  it('列は呼び出しの深さの順: 画面 → 部品 → 関数、endpoint → ハンドラ。getEntries は画面と同じ列に並ばない', () => {
    expect(lane('route:/')).toBe('browser');
    expect(col('route:/')).toBeLessThanOrEqual(col('comp:TodayIsland'));
    expect(col('comp:TodayIsland')).toBeLessThan(col('fn:getToday'));
    expect(col('endpoint:GET /today')).toBeLessThan(col('handler:internal/api'));
    expect(col('fn:getEntries')).not.toBe(col('route:/'));
  });

  it('通過点: 右へ 2 列以上またぐ線は間の列ごとに 1 つ、戻る線は送る側の列から受ける側の列まで 1 つずつ', () => {
    for (const w of index.wires) {
      const ca = col(w.fromNode.id);
      const cb = col(w.toNode.id);
      const p = layout.plans.get(w.key)!;
      expect(p.ys.length, w.key).toBe(cb > ca ? cb - ca - 1 : ca - cb + 1);
      expect(p.chans.length).toBe(p.ys.length + 1);
    }
  });

  it('往復する 2 箱の間の呼び出しと戻りは、間の列で同じ束を通る（戻りは呼び出しの隣を逆向きに）', () => {
    let pairs = 0;
    for (const call of index.wires) {
      if (call.reply) continue;
      const ca = col(call.fromNode.id);
      const cb = col(call.toNode.id);
      if (cb - ca < 2) continue;
      const reply = index.wires.find(
        (w) => w.reply && w.fromNode === call.toNode && w.toNode === call.fromNode,
      );
      if (!reply) continue;
      const cp = layout.plans.get(call.key)!;
      const rp = layout.plans.get(reply.key)!;
      const bundleAt = (p: typeof cp, k: number) =>
        p.gaps
          .find((g) => Number(g.split(':')[0]) === k)!
          .split(':')
          .slice(0, 2)
          .join(':');
      for (let k = ca + 1; k < cb; k++) {
        expect(bundleAt(cp, k), `${call.key} と ${reply.key} の列 ${k}`).toBe(bundleAt(rp, k));
        const dy = Math.abs(
          cp.ys[cp.gaps.findIndex((g) => Number(g.split(':')[0]) === k)]! -
            rp.ys[rp.gaps.findIndex((g) => Number(g.split(':')[0]) === k)]!,
        );
        // 束の中の段は間隔 8px
        expect(Math.abs(dy / 8 - Math.round(dy / 8))).toBeLessThan(1e-6);
        expect(dy).toBeGreaterThan(0);
      }
      pairs++;
    }
    // 見つかったこと: 基準の graph で 2 列以上またぐ往復は fetch の関数 → endpoint の 5 組など
    expect(pairs).toBeGreaterThan(3);
  });

  it('1 つの出口から広がる線（利用者 → 9 つの endpoint・ハンドラ）は、分かれるまで同じ束を並んで走る', () => {
    const fan = index.wires.filter(
      (w) => w.wire.from === 'actor:user#out/_' && w.toNode.node.runtime === 'server',
    );
    expect(fan).toHaveLength(9);
    const k = col('actor:user') + 1;
    const bundles = new Set(
      fan.map((w) =>
        layout.plans
          .get(w.key)!
          .gaps.find((g) => Number(g.split(':')[0]) === k)!
          .split(':')
          .slice(0, 2)
          .join(':'),
      ),
    );
    expect(bundles.size).toBe(1);
  });

  it('列の中では、同じ group（無ければ file のディレクトリ）と同じ host の箱が隣り合う', () => {
    const groupOf = (id: string) => {
      const n = index.nodes.get(id)!.node;
      if (n.host) return `h:${n.host}`;
      const f = n.file ?? '';
      return n.group ?? (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : `#${id}`);
    };
    for (const c of layout.columns) {
      const inCol = [...layout.boxes.values()]
        .filter((b) => b.col === c.index)
        .sort((a, b) => a.y - b.y)
        .map((b) => groupOf(b.id));
      const seen = new Set<string>();
      inCol.forEach((g, i) => {
        if (i > 0 && inCol[i - 1] !== g) expect(seen.has(g), `列 ${c.index} の ${g}`).toBe(false);
        seen.add(g);
      });
    }
  });

  it('2 列以上にまたがる host の塊は、塊だけの列に置く（外の箱は入らない）', () => {
    let spanning = 0;
    for (const h of layout.hosts.values()) {
      const cols = new Set(h.members.map((id) => col(id)));
      if (cols.size < 2) continue;
      spanning++;
      for (const b of layout.boxes.values())
        if (cols.has(b.col)) expect(h.members, `${h.id} の列に ${b.id}`).toContain(b.id);
    }
    // 見つかったこと: 基準の graph では Lambda（api）の塊が cmd/api と internal/api・auth の 2 列になる
    expect(spanning).toBe(1);
    expect(new Set(layout.hosts.get('infra:lambda_api/api')!.members.map(col)).size).toBe(2);
  });

  it('host の枠は中の箱を囲み、外の箱と重ならない', () => {
    for (const h of layout.hosts.values())
      for (const id of h.members) {
        const b = layout.boxes.get(id)!;
        expect(b.x > h.x && b.y > h.y && b.x + b.w < h.x + h.w && b.y + b.h < h.y + h.h).toBe(true);
      }
  });
});

describe('箱ごとの幅（docs/18 §3.1 の 8）', () => {
  const g: GraphV2 = {
    version: 2,
    nodes: [
      N('route:/', 'screen', 'browser', [P('out', 'out', [I('render_1', 'R')])]),
      N('comp:A', 'component', 'browser', [P('in', 'in', [I('props', 'P')])]),
      N('fn:f', 'fn', 'server', [P('in', 'in', [I('x', 'int')])]),
    ],
    wires: [
      W('route:/#out/render_1', 'comp:A#in/props', 'render'),
      W('route:/#out/render_1', 'fn:f#in/x', 'http'),
    ],
  };
  it('画面の箱は通常の 2 倍。列の幅はいちばん広い箱、箱は列の左に揃える', () => {
    const l = layoutWiring(indexGraph(g));
    const s = l.boxes.get('route:/')!;
    const a = l.boxes.get('comp:A')!;
    expect(s.w).toBe(600);
    expect(a.w).toBe(300);
    expect(l.columns[s.col]!.w).toBe(
      Math.max(...[...l.boxes.values()].filter((b) => b.col === s.col).map((b) => b.w)),
    );
    expect(s.x).toBe(l.columns[s.col]!.x);
    // out のピンは箱の右辺
    expect(l.pins.get('route:/#out/render_1')!.x).toBe(s.x + 600);
  });
  it('widthOf で箱ごとの幅を変えられる（8-3b で画面の HTML の大きさに使う）', () => {
    const l = layoutWiring(indexGraph(g), {
      widthOf: (n, w) => (n.node.kind === 'fn' ? w + 100 : w),
    });
    expect(l.boxes.get('route:/')!.w).toBe(300);
    expect(l.boxes.get('fn:f')!.w).toBe(400);
  });
});

describe('PAVA と交差の数え方', () => {
  it('pava: 順序と間隔を保ったまま、目標からの二乗の和を最小に（ぶつかる所は平均）。いちばん上は下限で切る', () => {
    // 3 つの要素（高さ＋隙間で間隔 10）。目標 0, 0, 100 → 先の 2 つが平均 -5 / 5（下限 0 で 0 / 10）
    expect(pava([0, 0, 100], [1, 1, 1], [0, 10, 20], -100)).toEqual([-5, 5, 100]);
    expect(pava([0, 0, 100], [1, 1, 1], [0, 10, 20], 0)).toEqual([0, 10, 100]);
    // 重みの大きいものは動きにくい（10 と 0 - 10 の重み 3:1 の平均 5）
    expect(pava([10, 0], [3, 1], [0, 10], -100)).toEqual([5, 15]);
  });
  it('inversions: a の順と b の順が食い違う組を数える。a が同じ組は数えない', () => {
    expect(inversions([0, 1, 2], [0, 1, 2])).toBe(0);
    expect(inversions([0, 1, 2], [2, 1, 0])).toBe(3);
    expect(inversions([0, 0, 1], [5, 1, 0])).toBe(2);
    expect(inversions([0, 1], [3, 3])).toBe(0);
  });
});
