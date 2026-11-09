import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { detectGraphVersion, validateAnyGraph, validateGraphV2 } from './validate-v2.js';
import type { GraphV2 } from './v2.js';

const samplePath = fileURLToPath(
  new URL('../../../examples/fixture-poly.today.v2.json', import.meta.url),
);
const sample = JSON.parse(readFileSync(samplePath, 'utf8')) as GraphV2;

/** サンプルを複製して壊す */
function broken(mutate: (g: GraphV2) => void): GraphV2 {
  const g = structuredClone(sample);
  mutate(g);
  return g;
}
const node = (g: GraphV2, id: string) => g.nodes.find((n) => n.id === id)!;
const errorsOf = (json: unknown) => validateGraphV2(json).errors;
const messages = (json: unknown) => errorsOf(json).map((e) => e.message);

describe('validateGraphV2', () => {
  it('fixture-poly の /today の v2 はエラー 0 件。警告は fetcher の戻り（unknown）の 1 件だけ', () => {
    const r = validateGraphV2(sample);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.graph).toBeDefined();
    expect(r.warnings.map((w) => w.message)).toEqual([
      '項目 "lib:fetcher#out/return" の wireType が unknown です',
    ]);
  });

  it('スキーマ違反（version 1、項目 id に .、未知の kind）は graph を返さない', () => {
    const r1 = validateGraphV2({ ...sample, version: 1 });
    expect(r1.ok).toBe(false);
    expect(r1.graph).toBeUndefined();
    const r2 = validateGraphV2(
      broken((g) => {
        node(g, 'actor:user').ports[0]!.items[0]!.id = 'open.today';
      }),
    );
    expect(r2.ok).toBe(false);
    expect(r2.errors.some((e) => e.path.endsWith('/id'))).toBe(true);
    const r3 = validateGraphV2(
      broken((g) => {
        (node(g, 'actor:user') as { kind: string }).kind = 'page';
      }),
    );
    expect(r3.ok).toBe(false);
  });

  it('線の参照が解けない / 向きが違う（in → in、out → out）', () => {
    expect(messages(broken((g) => (g.wires[0]!.to = 'screen:/#in/path')))).toContainEqual(
      expect.stringContaining('線の終点 "screen:/#in/path" がありません'),
    );
    // in → in（D42 改訂で利用者の in は無くなったので、画面の in/html を使う）
    expect(messages(broken((g) => (g.wires[0]!.from = 'route:/#in/html')))).toContainEqual(
      expect.stringContaining('dir out の口の項目ではありません'),
    );
    // out → out
    expect(
      messages(broken((g) => (g.wires[0]!.to = 'infra:static_site/this#out/key'))),
    ).toContainEqual(expect.stringContaining('dir in の口の項目ではありません'));
  });

  it('同じ (from, to) の線は重複エラー', () => {
    const msgs = messages(broken((g) => g.wires.push({ ...g.wires[0]! })));
    expect(msgs).toContainEqual(expect.stringContaining('が重複しています'));
  });

  it('項目 id の衝突、口 id の衝突、ノード id の衝突', () => {
    expect(
      messages(
        broken((g) => {
          const p = node(g, 'infra:static_site/this').ports[0]!;
          p.items.push({ ...p.items[0]! });
        }),
      ),
    ).toContainEqual(expect.stringContaining('項目 "key" が重複しています'));
    expect(
      messages(
        broken((g) => {
          const n = node(g, 'infra:static_site/this');
          n.ports.push({ ...n.ports[0]!, items: [] });
        }),
      ),
    ).toContainEqual(expect.stringContaining('口 "in" が重複しています'));
    expect(messages(broken((g) => g.nodes.push({ ...g.nodes[0]! })))).toContainEqual(
      expect.stringContaining('ノード ID "actor:user" が重複しています'),
    );
  });

  it('kind cache は hit の分岐が必須', () => {
    expect(
      messages(broken((g) => delete node(g, 'infra:static_site/this').variants)),
    ).toContainEqual(expect.stringContaining('分岐 "hit" を宣言する必要があります'));
  });

  it('when のキー: 宣言が無い / 両端が宣言していて無修飾 / 修飾先が無い', () => {
    expect(messages(broken((g) => (g.wires[0]!.when = { nope: true })))).toContainEqual(
      expect.stringContaining('when のキー "nope" を宣言している箱がありません'),
    );
    expect(
      messages(
        broken((g) => {
          // S3 にも hit を宣言すると、CloudFront → S3 の線の when は曖昧（D42 改訂で wires[1] は CloudFront → S3）
          node(g, 'infra:static_site/site').variants = [{ id: 'hit', name: 'x' }];
          g.wires[1]!.when = { hit: false };
        }),
      ),
    ).toContainEqual(expect.stringContaining('で修飾してください'));
    expect(messages(broken((g) => (g.wires[0]!.when = { 'fn:nope#hit': true })))).toContainEqual(
      expect.stringContaining('箱 "fn:nope" がありません'),
    );
    expect(messages(broken((g) => (g.wires[0]!.when = { 'route:/#hit': true })))).toContainEqual(
      expect.stringContaining('分岐 "hit" を宣言していません'),
    );
  });

  it('host は kind infra の箱を指す', () => {
    expect(messages(broken((g) => (node(g, 'route:/').host = 'infra:nope')))).toContainEqual(
      expect.stringContaining('host "infra:nope" がありません'),
    );
    expect(messages(broken((g) => (node(g, 'route:/').host = 'comp:TodayIsland')))).toContainEqual(
      expect.stringContaining('kind infra ではありません'),
    );
  });

  it('links の参照と向き', () => {
    expect(
      messages(broken((g) => (node(g, 'route:/').links![0]!.from = 'in/nope'))),
    ).toContainEqual(expect.stringContaining('links の from "in/nope" がありません'));
    expect(
      // D42 改訂で画面の out は render_1 だけ
      messages(broken((g) => (node(g, 'route:/').links![0]!.from = 'out/render_1'))),
    ).toContainEqual(expect.stringContaining('dir in の口ではありません'));
  });

  it('views の start と variants', () => {
    expect(messages(broken((g) => (g.views![0]!.start = 'screen:/nope')))).toContainEqual(
      expect.stringContaining('start "screen:/nope" がありません'),
    );
    expect(errorsOf(broken((g) => (g.views![0]!.start = 'comp:TodayIsland#in/props')))).toEqual([]);
    expect(
      errorsOf(
        broken((g) => (g.views![0]!.start = { from: g.wires[0]!.from, to: g.wires[0]!.to })),
      ),
    ).toEqual([]);
    expect(
      messages(broken((g) => (g.views![0]!.variants = { 'route:/#login': true }))),
    ).toContainEqual(expect.stringContaining('"login" を宣言していません'));
  });

  it('broken の path は線のどちらかの端で解ける', () => {
    const w = sample.wires.findIndex((x) => x.broken?.length);
    expect(messages(broken((g) => (g.wires[w]!.broken![0]!.path = 'nope.x')))).toContainEqual(
      expect.stringContaining('線のどちらの端にもありません'),
    );
  });

  it('警告: typeRef が無い、口の単位（_）、不透明な箱', () => {
    const warnings = (g: GraphV2) => validateGraphV2(g).warnings.map((w) => w.message);
    expect(
      warnings(
        broken((g) => (node(g, 'comp:TotalCard').ports[0]!.items[0]!.typeRef = 'type:Nope')),
      ),
    ).toContainEqual(expect.stringContaining('typeRef "type:Nope" が types にありません'));
    expect(
      warnings(
        broken((g) => {
          node(g, 'comp:TotalCard').ports[0]!.items[0]!.id = '_';
          g.wires.find((w) => w.to === 'comp:TotalCard#in/view')!.to = 'comp:TotalCard#in/_';
        }),
      ),
    ).toContainEqual(expect.stringContaining('口の単位の項目（"_"）'));
    expect(warnings(broken((g) => delete node(g, 'comp:TodayIsland').links))).toContainEqual(
      expect.stringContaining('不透明な箱'),
    );
    // table と endpoint は既定の links が決まっているので不透明の警告を出さない
    expect(warnings(sample).some((m) => m.includes('endpoint:POST /transactions'))).toBe(false);
  });
});

describe('validateAnyGraph / detectGraphVersion', () => {
  it('version で v1 / v2 を振り分ける', () => {
    expect(detectGraphVersion(sample)).toBe(2);
    expect(detectGraphVersion({ version: 1 })).toBe(1);
    expect(detectGraphVersion({})).toBeNull();
    expect(detectGraphVersion(null)).toBeNull();
    const r = validateAnyGraph(sample);
    expect(r.version).toBe(2);
    expect(r.ok).toBe(true);
    expect(r.issues.map((i) => i.level)).toEqual(['warning']);
    const v1 = validateAnyGraph({ version: 1, layers: [], nodes: [], edges: [] });
    expect(v1.version).toBe(1);
    expect(v1.ok).toBe(false);
  });
});
