// Phase 8-2a の受け入れ条件（docs/17 §5・§7 #6）: fixture-poly を build すると、TS の側（/today の経路と POST
// /transactions の呼び出し元）が手で組んだ例（examples/fixture-poly.today.v2.json）と同じ形で自動で出る。
// 比べ方（§7 #6）: ① id の別名表（空に近づける）② 例の箱が全部ある ③ 合流点の線は from / to の項目の参照まで一致、
// 言語の中の線は（箱, 箱, via, reply）が一致 ④ 例の箱どうしの間で例に無い線は許可した表に無ければ失敗
// ⑤ broken は「線 → {(path, level)}」が一致 ⑥ validateGraphV2 のエラー 0 ⑦ 全体の broken はスナップショットで固定。
// 8-1 が作る箱（CloudFront・S3・利用者）と、8-2b の Go の側（handler・store・テーブル）は比べる対象から除く
import {
  buildGraph,
  createMemoryLogger,
  loadConfig,
  type BuildGraphResult,
} from '@stack-atlas/core';
import { validateGraphV2, type GraphV2, type WireV2 } from '@stack-atlas/schema';
import { defaultState, indexGraph, select } from '@stack-atlas/wiring';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { formatAdapterSummary } from '../commands/build.js';
import { loadExtractors } from '../extractors.js';

const example = (p: string) => fileURLToPath(new URL(`../../../../examples/${p}`, import.meta.url));
const EXAMPLE = JSON.parse(readFileSync(example('fixture-poly.today.v2.json'), 'utf8')) as GraphV2;

/** ① 例の id → 生成した graph の id（規則と例の id がずれる所。docs/17 §7 #2 の表で例を直したので空） */
const ALIAS: Record<string, string> = {};
const alias = (id: string) => ALIAS[id] ?? id;
const aliasRef = (ref: string) => {
  const i = ref.indexOf('#');
  return `${alias(ref.slice(0, i))}${ref.slice(i)}`;
};

/** TS の側の箱（8-2a）と合流点 */
const TS_BOXES = [
  'route:/',
  'comp:TodayIsland',
  'comp:TotalCard',
  'comp:EntryList',
  'fn:getToday',
  'fn:toTodayView',
  'lib:fetcher',
  'fn:createTransaction',
];
const ENDPOINTS = ['endpoint:GET /today', 'endpoint:POST /transactions'];
const COMPARED = new Set([...TS_BOXES, ...ENDPOINTS]);

/** ④ 例の箱どうしの間で、例に無いが生成した graph にある線（許可した表）。今は無い */
const ALLOWED_EXTRA: string[] = [];

const boxOf = (ref: string) => ref.slice(0, ref.indexOf('#'));
const isJoin = (w: WireV2) => ENDPOINTS.includes(boxOf(w.from)) || ENDPOINTS.includes(boxOf(w.to));
const tuple = (w: WireV2) =>
  `${boxOf(w.from)} → ${boxOf(w.to)} (${w.via}${w.reply ? ', reply' : ''})`;
const refs = (w: WireV2) => `${w.from} → ${w.to}`;

let res: BuildGraphResult;
let g: GraphV2;
beforeAll(async () => {
  const root = example('fixture-poly');
  const log = createMemoryLogger();
  const extractors = await loadExtractors(log, { skip: ['screenshots'] });
  res = await buildGraph({ root, extractors, log, config: loadConfig(root, log), commit: false });
  g = res.graphV2!;
}, 60_000);

describe('8-2a 受け入れ: fixture-poly の TS の側が手で組んだ例と同じ形になる', () => {
  it('⑥ graph.json（v2）の検証エラー 0、パイプラインのエラー 0', () => {
    expect(res.issues.filter((i) => i.level === 'error')).toEqual([]);
    expect(validateGraphV2(g).errors).toEqual([]);
  });

  it('② 例の TS の側の箱と endpoint が全部ある（runtime も例と同じ。D54）', () => {
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    for (const id of COMPARED) {
      const n = byId.get(alias(id));
      expect(n, id).toBeDefined();
      const ex = EXAMPLE.nodes.find((x) => x.id === id)!;
      expect([n!.kind, n!.runtime], id).toEqual([ex.kind, ex.runtime]);
    }
  });

  it('③ 言語の中の線は（箱, 箱, via, reply）が例と一致する', () => {
    const exp = EXAMPLE.wires
      .filter((w) => COMPARED.has(boxOf(w.from)) && COMPARED.has(boxOf(w.to)) && !isJoin(w))
      .map((w) => tuple({ ...w, from: aliasRef(w.from), to: aliasRef(w.to) }));
    const got = g.wires
      .filter((w) => COMPARED.has(boxOf(w.from)) && COMPARED.has(boxOf(w.to)) && !isJoin(w))
      .map(tuple);
    expect([...new Set(got)].sort()).toEqual([...new Set(exp)].sort());
  });

  it('③ 合流点（endpoint）の線は from / to の項目の参照まで例と一致する（TS の側。Go の側は 8-2b）', () => {
    const exp = EXAMPLE.wires
      .filter(
        (w) => isJoin(w) && TS_BOXES.includes(boxOf(w.from)) !== TS_BOXES.includes(boxOf(w.to)),
      )
      .filter((w) => TS_BOXES.includes(boxOf(w.from)) || TS_BOXES.includes(boxOf(w.to)))
      .map(
        (w) =>
          `${refs({ ...w, from: aliasRef(w.from), to: aliasRef(w.to) })} (${w.via}${w.reply ? ', reply' : ''})`,
      );
    const got = g.wires
      .filter(
        (w) => isJoin(w) && (TS_BOXES.includes(boxOf(w.from)) || TS_BOXES.includes(boxOf(w.to))),
      )
      .map((w) => `${refs(w)} (${w.via}${w.reply ? ', reply' : ''})`);
    expect(got.sort()).toEqual(exp.sort());
  });

  it('④ 例の箱どうしの間に、例に無い線（残った `_`・二重）が無い', () => {
    const exp = new Set(
      EXAMPLE.wires.map((w) => refs({ ...w, from: aliasRef(w.from), to: aliasRef(w.to) })),
    );
    const extra = g.wires
      .filter((w) => COMPARED.has(boxOf(w.from)) && COMPARED.has(boxOf(w.to)))
      .map(refs)
      .filter((k) => !exp.has(k) && !ALLOWED_EXTRA.includes(k));
    expect(extra).toEqual([]);
  });

  it('配信の線は画面の in/html に着く（8-1 の箱から。docs/17 §7 #2）', () => {
    expect(g.wires.map(refs)).toContain('infra:static_site/this#out/value → route:/#in/html');
  });

  it('⑤ broken: POST /transactions の body（送る側に occurredAt が無い → error、amount の number → integer → warn）', () => {
    const pick = (gr: GraphV2) =>
      new Map(
        gr.wires
          .filter((w) => w.broken?.length && TS_BOXES.includes(boxOf(w.from)))
          .map((w) => [refs(w), w.broken!.map((b) => `${b.path}:${b.level}`).sort()]),
      );
    expect(pick(g)).toEqual(pick(EXAMPLE));
    expect([...pick(g)]).toEqual([
      [
        'fn:createTransaction#out/call_1.body → endpoint:POST /transactions#in/body',
        ['amount:warn', 'occurredAt:error'],
      ],
    ]);
  });

  it('⑦ 全体の broken（スナップショット。Go の側の GET /today・GET /entries の occurredAt は 8-2b で増える）', () => {
    const all = g.wires
      .filter((w) => w.broken?.length)
      .map((w) => ({ wire: refs(w), broken: w.broken!.map((b) => [b.path, b.level]) }));
    expect(all).toEqual([
      {
        wire: 'fn:createTransaction#out/call_1.body → endpoint:POST /transactions#in/body',
        broken: [
          ['amount', 'warn'],
          ['occurredAt', 'error'],
        ],
      },
    ]);
  });

  it('画面 route:/ をクリックすると、TS の経路が項目の単位で endpoint:GET /today まで光る（起動の links。§7 #3）', () => {
    const index = indexGraph(g);
    const lit = select(index, defaultState(index), { kind: 'box', id: 'route:/' })!;
    for (const ref of [
      'route:/#out/render_1',
      'comp:TodayIsland#in/props',
      'comp:TodayIsland#out/call_1',
      'fn:getToday#in/call',
      'fn:getToday#out/call_1',
      'fn:getToday#out/call_1.url',
      'lib:fetcher#in/url',
      'endpoint:GET /today#in/path',
      // 戻り: endpoint → getToday → TodayIsland → toTodayView → TotalCard / EntryList
      'endpoint:GET /today#out/body',
      'fn:getToday#in/ret_1',
      'comp:TodayIsland#in/ret_1',
      'comp:TodayIsland#out/call_2.today',
      'fn:toTodayView#in/today',
      'comp:TodayIsland#in/ret_2',
      'comp:TotalCard#in/view',
      'comp:EntryList#in/entries',
    ])
      expect(lit.items.has(ref), ref).toBe(true);
    // 同じファイルの別の関数（createTransaction）と、その先の POST は光らない
    for (const id of ['fn:createTransaction', 'endpoint:POST /transactions', 'fn:getEntries'])
      expect(lit.boxes.has(id), id).toBe(false);
  });

  it('自動率のサマリ（docs/17 §4）を build の要約に出す', () => {
    const a = res.v2Adapters!;
    // 2026-11-09 変更（8-2a レビュー）: openapi は言語アダプタではなく契約（Extractor.v2Role = contract）。
    // adapters（project.generator.adapters も）は言語アダプタだけ、契約は contracts に分けた（C10）
    expect(a.adapters).toEqual(['ts-types']);
    // 2026-11-09 変更（8-2b）: sql も v2（table の 3 口とカラムの項目）を出す契約になった
    expect(a.contracts).toEqual(['openapi', 'sql']);
    expect(g.project?.generator).toMatchObject({ adapters: ['ts-types'], contracts: ['openapi', 'sql'] });
    // group の v1 の箱に残った線は、参照している中の関数の箱を全部決められた（中の全部への付け替えは 0。C6）
    expect(a.undetermined).toBe(0);
    expect(a.joined).toBe(5);
    expect(a.unjoined).toEqual([]);
    expect(a.groups).toBe(4);
    expect(a.broken).toBe(1);
    const c = a.coverage;
    expect(c.wires).toBe(c.itemWires + c.boxWires);
    // 呼び出しでない参照（API_DOMAIN の定数。fetcher・PushToggle → lib:consts の往復）
    expect(c.refWires).toBe(4);
    const lines = formatAdapterSummary(a);
    // 2026-11-09 変更（8-2a レビュー）: 要約も言語アダプタと契約を分ける（C10）
    expect(lines[0]).toMatch(
      /^言語アダプタ（ts-types）・契約（openapi, sql）: 項目 \d+（unknown \d+）、線 \d+（項目 \d+ \/ 箱の単位 \d+、うち呼び出しでない参照 4）、links \d+（exact \d+ \/ crude \d+）・不透明な箱 \d+$/,
    );
  });
});
