// 切れている線（名前が相手に無い、wireType が互換でない、nullable → 必須）と、例の v2 グラフの再計算
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { GraphV2 } from '@stack-atlas/schema';
import { detectBroken } from '../broken.js';
import { indexGraph } from '../graph-index.js';
import { I, N, P, W, todayGraph } from './fixture.js';

const examplePath = fileURLToPath(
  new URL('../../../../examples/fixture-poly.today.v2.json', import.meta.url),
);

describe('detectBroken', () => {
  it('送る側の子が受ける側に無い（Go の occurredAt が OpenAPI の Entry に無い）', () => {
    const idx = indexGraph(todayGraph());
    const found = detectBroken(idx);
    const w = found.find((b) => b.wire.wire.from === 'fn:api.handleToday#out/resp')!;
    expect(w).toBeDefined();
    expect(w.broken).toEqual([
      { path: 'entries.occurredAt', level: 'error', reason: '受ける側（GET /today）に無い' },
    ]);
    // 見つかったこと: SQL の境界でも string → datetime（query.date → WHERE date）が規則どおり切れる。
    // それ以外の線は切れていない（int64 → integer、integer → number、datetime → string は互換）
    expect(found.map((b) => b.wire.wire.from).sort()).toEqual([
      'fn:api.handleToday#out/resp',
      'fn:store.ListEntries#out/query_date',
    ]);
    expect(
      found.find((b) => b.wire.wire.from === 'fn:store.ListEntries#out/query_date')!.broken,
    ).toEqual([{ path: '', level: 'error', reason: 'wireType が互換でない（string → datetime）' }]);
  });

  it('wireType が互換でない / nullable → 必須 / 受ける側だけの必須 / 子の無い側は不透明', () => {
    const g: GraphV2 = {
      version: 2,
      nodes: [
        N('fn:A', 'fn', 'server', [
          P('out', 'out', [
            I('x', 'number', { wireType: 'number' }),
            I('n', 'string', { wireType: 'string', nullable: true }),
            I('o', 'string', { wireType: 'string', optional: true }),
            I('dt', 'time.Time', { wireType: 'datetime' }),
            I('body', 'Entry', {
              wireType: 'object',
              children: [I('id', 'string', { wireType: 'string' })],
            }),
            I('opaque', 'any', { wireType: 'object' }),
          ]),
        ]),
        N('fn:B', 'fn', 'server', [
          P('in', 'in', [
            I('x', 'int', { wireType: 'integer' }),
            I('n', 'string', { wireType: 'string' }),
            I('o', 'string', { wireType: 'string' }),
            I('dt', 'string', { wireType: 'string' }),
            I('body', 'Transaction', {
              wireType: 'object',
              children: [
                I('id', 'string', { wireType: 'string' }),
                I('occurredAt', 'string', { wireType: 'datetime' }),
                I('memo', 'string', { optional: true }),
              ],
            }),
            I('opaque', 'Entry', { wireType: 'object', children: [I('id', 'string')] }),
          ]),
        ]),
      ],
      wires: [
        W('fn:A#out/x', 'fn:B#in/x', 'call'),
        W('fn:A#out/n', 'fn:B#in/n', 'call'),
        W('fn:A#out/o', 'fn:B#in/o', 'call'),
        W('fn:A#out/dt', 'fn:B#in/dt', 'call'),
        W('fn:A#out/body', 'fn:B#in/body', 'call'),
        W('fn:A#out/opaque', 'fn:B#in/opaque', 'call'),
      ],
    };
    const found = detectBroken(indexGraph(g));
    const by = (from: string) => found.find((b) => b.wire.wire.from === from)?.broken;
    expect(by('fn:A#out/x')).toEqual([
      { path: '', level: 'error', reason: 'wireType が互換でない（number → integer）' },
    ]);
    expect(by('fn:A#out/n')).toEqual([
      { path: '', level: 'warn', reason: '送る側が nullable、受ける側は必須' },
    ]);
    expect(by('fn:A#out/o')).toEqual([
      { path: '', level: 'warn', reason: '送る側が optional、受ける側は必須' },
    ]);
    expect(by('fn:A#out/dt')).toBeUndefined(); // datetime ⊂ string
    expect(by('fn:A#out/body')).toEqual([
      { path: 'occurredAt', level: 'error', reason: '送る側（A）に無い。受ける側（B）では必須' },
    ]);
    expect(by('fn:A#out/opaque')).toBeUndefined(); // 送る側に子が無い → 照合しない
  });

  it('examples/fixture-poly.today.v2.json: 書いてある broken と項目から計算した broken が一致する', () => {
    const g = JSON.parse(readFileSync(examplePath, 'utf8')) as GraphV2;
    const idx = indexGraph(g);
    const computed = new Map(
      detectBroken(idx).map((b) => [`${b.wire.wire.from} → ${b.wire.wire.to}`, b.broken]),
    );
    const declared = new Map(
      g.wires.filter((w) => w.broken?.length).map((w) => [`${w.from} → ${w.to}`, w.broken!]),
    );
    expect([...computed.keys()].sort()).toEqual([...declared.keys()].sort());
    for (const [k, v] of declared) {
      const c = computed.get(k)!;
      expect(c.map((b) => [b.path, b.level]).sort()).toEqual(
        v.map((b) => [b.path, b.level]).sort(),
      );
    }
    // 実際に見つかる 2 本: Go の応答が OpenAPI の Entry に無い occurredAt を返す / TS の body が OpenAPI の Transaction と合わない
    expect([...computed.keys()].sort()).toEqual([
      'fn:createTransaction#out/call_1.body → endpoint:POST /transactions#in/body',
      'fn:internal/api.handleToday#out/resp → endpoint:GET /today#res/body',
    ]);
    expect(
      computed
        .get('fn:internal/api.handleToday#out/resp → endpoint:GET /today#res/body')!
        .map((b) => b.path),
    ).toEqual(['entries.occurredAt']);
    expect(
      computed
        .get('fn:createTransaction#out/call_1.body → endpoint:POST /transactions#in/body')!
        .map((b) => b.path)
        .sort(),
    ).toEqual(['amount', 'occurredAt']);
  });
});
