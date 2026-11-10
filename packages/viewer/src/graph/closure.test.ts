import { describe, expect, it } from 'vitest';
import type { Graph } from '@stack-atlas/schema';
import { closure, computeHighlight, edgeHighlight, NO_HIGHLIGHT } from './closure';
import { buildModel } from './model';
import { loadSampleGraph } from './testSample';

const model = buildModel(loadSampleGraph());
const sorted = (s: Iterable<string>) => [...s].sort();
const edge = (from: string, to: string) => {
  const e = model.edges.find((x) => x.from === from && x.to === to);
  if (!e) throw new Error(`edge ${from} -> ${to} not found`);
  return e;
};

const ROUTES = ['route:/', 'route:/races', 'route:/races/[id]', 'route:/admin/entry'];

describe('closure (sample)', () => {
  it('型 Race の影響範囲（up）は、それを使う部品・画面と Lambda まで推移的に光る', () => {
    const up = closure(model, 'type:Race', 'up');
    expect(sorted(up)).toEqual(
      sorted([
        'comp:RaceCard',
        'hook:useRaces',
        'lib:apiClient',
        'handler:getRaces',
        'handler:postResult',
        'type:RaceResult',
        'comp:ResultTable',
        ...ROUTES,
        'infra:lambdaNext',
        'infra:lambdaApi',
      ]),
    );
    // Race を使わない画面と、flow でしかつながらないインフラは含まない
    expect(up.has('route:/login')).toBe(false);
    expect(up.has('layout:/')).toBe(false);
    expect(up.has('infra:cloudfront')).toBe(false);
    expect(up.has('infra:apigw')).toBe(false);
  });

  it('型 Race の依存先（down）は空（型は何も使わない）', () => {
    expect(closure(model, 'type:Race', 'down').size).toBe(0);
  });

  it('ResultTable の down は使っている型（推移的）、up は使う画面とそれを載せる Lambda', () => {
    expect(sorted(closure(model, 'comp:ResultTable', 'down'))).toEqual([
      'type:Race',
      'type:RaceResult',
    ]);
    expect(sorted(closure(model, 'comp:ResultTable', 'up'))).toEqual(
      sorted(['route:/races/[id]', 'route:/admin/entry', 'infra:lambdaNext']),
    );
  });

  it('flow は 1 ホップだけ: CloudFront の down に Lambda は入るが、Lambda が deploy する画面は入らない', () => {
    const down = closure(model, 'infra:cloudfront', 'down');
    expect(sorted(down)).toEqual(sorted(['infra:edge', 'infra:s3', 'infra:lambdaNext']));
    expect(down.has('route:/races')).toBe(false);
    expect(down.has('infra:apigw')).toBe(false);
    expect(sorted(closure(model, 'infra:cloudfront', 'up'))).toEqual(['actor:user']);
  });

  it('Lambda: Next.js の down は flow 先（1 ホップ）と、deploy 先から推移的にたどれるすべて', () => {
    const down = closure(model, 'infra:lambdaNext', 'down');
    expect(down.has('infra:apigw')).toBe(true); // flow 1 ホップ
    expect(down.has('infra:lambdaApi')).toBe(false); // flow の 2 ホップ目は入らない
    for (const id of [...ROUTES, 'route:/login', 'layout:/', 'comp:Header', 'type:Session']) {
      expect(down.has(id)).toBe(true);
    }
    // http 経由でハンドラ、uses 経由で DB スキーマまで届く
    expect(down.has('handler:getRaces')).toBe(true);
    expect(down.has('schema:RaceItem')).toBe(true);
    expect(down.has('infra:lambdaNext')).toBe(false);
  });

  it('schema エッジは down だけたどる: DynamoDB の down に RaceItem、RaceItem の up に DynamoDB は入らない', () => {
    expect(sorted(closure(model, 'infra:dynamo', 'down'))).toEqual(['schema:RaceItem']);
    const up = closure(model, 'schema:RaceItem', 'up');
    expect(up.has('infra:dynamo')).toBe(false);
    expect(up.has('handler:getRaces')).toBe(true);
    expect(up.has('infra:lambdaApi')).toBe(true);
    expect(sorted(closure(model, 'infra:dynamo', 'up'))).toEqual(['infra:lambdaApi']);
  });

  it('存在しない ID は空集合', () => {
    expect(closure(model, 'nope', 'down').size).toBe(0);
    expect(computeHighlight(model, 'nope')).toBe(NO_HIGHLIGHT);
  });
});

describe('edgeHighlight (sample)', () => {
  it('CloudFront を指すと、出ていく flow は赤、入ってくる flow は橙、その先の flow は対象外', () => {
    const hl = computeHighlight(model, 'infra:cloudfront');
    expect(edgeHighlight(hl, edge('infra:cloudfront', 'infra:lambdaNext'))).toBe('down');
    expect(edgeHighlight(hl, edge('actor:user', 'infra:cloudfront'))).toBe('up');
    expect(edgeHighlight(hl, edge('infra:lambdaNext', 'infra:apigw'))).toBeNull();
    expect(edgeHighlight(hl, edge('infra:lambdaNext', 'route:/races'))).toBeNull();
  });

  it('Race を指すと、使う側のエッジ連鎖が橙になり、関係ない枝は対象外', () => {
    const hl = computeHighlight(model, 'type:Race');
    expect(edgeHighlight(hl, edge('comp:RaceCard', 'type:Race'))).toBe('up');
    expect(edgeHighlight(hl, edge('route:/', 'comp:RaceCard'))).toBe('up');
    expect(edgeHighlight(hl, edge('infra:lambdaNext', 'route:/'))).toBe('up');
    expect(edgeHighlight(hl, edge('lib:apiClient', 'handler:getRaces'))).toBe('up');
    expect(edgeHighlight(hl, edge('infra:lambdaApi', 'handler:getRaces'))).toBe('up');
    // to が up に入っていない
    expect(edgeHighlight(hl, edge('lib:apiClient', 'type:EntryInput'))).toBeNull();
    expect(edgeHighlight(hl, edge('handler:getRaces', 'schema:RaceItem'))).toBeNull();
    expect(edgeHighlight(hl, edge('infra:lambdaNext', 'route:/login'))).toBeNull();
  });

  it('ResultTable を指すと、型へのエッジは赤、画面からのエッジは橙', () => {
    const hl = computeHighlight(model, 'comp:ResultTable');
    expect(edgeHighlight(hl, edge('comp:ResultTable', 'type:RaceResult'))).toBe('down');
    expect(edgeHighlight(hl, edge('type:RaceResult', 'type:Race'))).toBe('down');
    expect(edgeHighlight(hl, edge('route:/races/[id]', 'comp:ResultTable'))).toBe('up');
    expect(edgeHighlight(hl, edge('infra:lambdaNext', 'route:/races/[id]'))).toBe('up');
    expect(edgeHighlight(hl, edge('route:/races/[id]', 'lib:apiClient'))).toBeNull();
  });

  it('ハイライトなしなら常に null', () => {
    expect(edgeHighlight(NO_HIGHLIGHT, edge('comp:RaceCard', 'type:Race'))).toBeNull();
  });
});

describe('closure (synthetic)', () => {
  const g: Graph = {
    version: 1,
    layers: [{ id: 'l', name: 'L' }],
    nodes: ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, layer: 'l', kind: 'infra', name: id })),
    edges: [
      { from: 'a', to: 'b', kind: 'flow' },
      { from: 'b', to: 'c', kind: 'uses' },
      { from: 'a', to: 'd', kind: 'uses' },
      { from: 'd', to: 'b', kind: 'flow' },
      { from: 'd', to: 'e', kind: 'mystery' },
      { from: 'e', to: 'a', kind: 'uses' },
    ],
  };
  const m = buildModel(g);

  it('flow で加えたノードの先はたどらない。未知の kind もたどらない。循環でも止まる', () => {
    expect(sorted(closure(m, 'a', 'down'))).toEqual(['b', 'd']);
    expect(sorted(closure(m, 'a', 'up'))).toEqual(['e']);
  });

  it('down 集合どうしをつなぐ flow エッジは、from が a でなければ赤にしない', () => {
    const hl = computeHighlight(m, 'a');
    expect(edgeHighlight(hl, m.edges[0]!)).toBe('down'); // a -flow-> b
    expect(edgeHighlight(hl, m.edges[3]!)).toBeNull(); // d -flow-> b
    expect(edgeHighlight(hl, m.edges[5]!)).toBe('up'); // e -uses-> a
  });
});
