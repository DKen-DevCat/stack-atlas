// Phase 8-2 の受け入れ条件（docs/17 §4・§5・§7 #6）: fixture-poly を build すると、手で組んだ例
// （examples/fixture-poly.today.v2.json）と同じ形が自動で出る。8-2a は TS の側（/today の経路と POST /transactions の
// 呼び出し元）、8-2b は Go の側（handler・store）とテーブル、サーバー側と table の合流。
// 比べ方（§7 #6）: ① id の別名表（空に近づける）② 例の箱が全部ある（kind・runtime・host）③ 合流点の線は from / to の項目の
// 参照まで一致、言語の中の線は（箱, 箱, via, reply）が一致 ④ 例の箱どうしの間で例に無い線は許可した表に無ければ失敗
// ⑤ broken は「線 → {(path, level)}」が一致 ⑥ validateGraphV2 のエラー 0 ⑦ 全体の broken はスナップショットで固定。
// 8-1 が作る箱（CloudFront・S3・利用者・Lambda・Aurora の枠）は比べる対象から除く。
// go が無ければ Go の側は v1 のパッケージの箱のまま（D51）なので、8-2b の describe は飛ばす（CI は STACK_ATLAS_REQUIRE_GO=1）
import {
  buildGraph,
  createMemoryLogger,
  loadConfig,
  type BuildGraphResult,
} from '@stack-atlas/core';
import { validateGraphV2, type GraphV2, type NodeV2, type WireV2 } from '@stack-atlas/schema';
import { defaultState, indexGraph, select, withVariants } from '@stack-atlas/wiring';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { formatAdapterSummary } from '../commands/build.js';
import { loadExtractors } from '../extractors.js';
import { hasGo } from './go-env.js';

const example = (p: string) => fileURLToPath(new URL(`../../../../examples/${p}`, import.meta.url));
const EXAMPLE = JSON.parse(readFileSync(example('fixture-poly.today.v2.json'), 'utf8')) as GraphV2;

/** ① 例の id → 生成した graph の id（規則と例の id がずれる所。docs/17 §7 #2 の表で例を直したので空） */
const ALIAS: Record<string, string> = {};
const alias = (id: string) => ALIAS[id] ?? id;
const aliasRef = (ref: string) => {
  const i = ref.indexOf('#');
  return `${alias(ref.slice(0, i))}${ref.slice(i)}`;
};

/** TS の側の箱（8-2a） */
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
/** Go の側の箱（8-2b） */
const GO_BOXES = [
  'fn:internal/api.handleToday',
  'fn:internal/store.ListByDate',
  'fn:internal/api.handleCreateTransaction',
  'fn:internal/store.InsertTransaction',
];
const ENDPOINTS = ['endpoint:GET /today', 'endpoint:POST /transactions'];
const TABLES = ['schema:transactions'];
const JUNCTIONS = [...ENDPOINTS, ...TABLES];

/**
 * ④ 例の箱どうしの間で、例に無いが生成した graph にある線（許可した表）。今は無い（handleToday → domain.Sum の合計の
 * 呼び出しは例が省いているが、domain.Sum は例の箱ではないので比べる対象に入らない）
 */
const ALLOWED_EXTRA: string[] = [];

const boxOf = (ref: string) => ref.slice(0, ref.indexOf('#'));
const tuple = (w: WireV2) =>
  `${boxOf(w.from)} → ${boxOf(w.to)} (${w.via}${w.reply ? ', reply' : ''})`;
const refs = (w: WireV2) => `${w.from} → ${w.to}`;
const full = (w: WireV2) => `${refs(w)} (${w.via}${w.reply ? ', reply' : ''})`;
const exampleRefs = (w: WireV2) => ({ ...w, from: aliasRef(w.from), to: aliasRef(w.to) });

let res: BuildGraphResult;
let g: GraphV2;
let repo: BuildGraphResult;
beforeAll(async () => {
  const log = createMemoryLogger();
  const extractors = await loadExtractors(log, { skip: ['screenshots'] });
  const build = (name: string) => {
    const root = example(name);
    return buildGraph({ root, extractors, log, config: loadConfig(root, log), commit: false });
  };
  res = await build('fixture-poly');
  g = res.graphV2!;
  repo = await build('fixture-repo');
}, 60_000);

/** 比べる対象の箱の間の線（junction: 合流点に触れる線か） */
function wiresBetween(gr: GraphV2, boxes: ReadonlySet<string>, junction: boolean) {
  const isJoin = (w: WireV2) =>
    JUNCTIONS.includes(boxOf(w.from)) || JUNCTIONS.includes(boxOf(w.to));
  return gr.wires.filter(
    (w) => boxes.has(boxOf(w.from)) && boxes.has(boxOf(w.to)) && isJoin(w) === junction,
  );
}

describe('8-2a 受け入れ: fixture-poly の TS の側が手で組んだ例と同じ形になる', () => {
  const COMPARED = new Set([...TS_BOXES, ...ENDPOINTS]);

  it('⑥ graph.json（v2）の検証エラー 0、パイプラインのエラー 0（fixture-poly・fixture-repo）', () => {
    expect(res.issues.filter((i) => i.level === 'error')).toEqual([]);
    expect(validateGraphV2(g).errors).toEqual([]);
    // 2026-11-09 追加（8-2b）: fixture-repo（OpenAPI の無い TS の Lambda）も
    expect(repo.issues.filter((i) => i.level === 'error')).toEqual([]);
    expect(validateGraphV2(repo.graphV2!).errors).toEqual([]);
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
    const exp = wiresBetween(EXAMPLE, COMPARED, false).map((w) => tuple(exampleRefs(w)));
    const got = wiresBetween(g, COMPARED, false).map(tuple);
    expect([...new Set(got)].sort()).toEqual([...new Set(exp)].sort());
  });

  it('③ 合流点（endpoint）の線は from / to の項目の参照まで例と一致する（TS の側）', () => {
    const ts = new Set([...TS_BOXES, ...ENDPOINTS]);
    const pick = (gr: GraphV2) =>
      wiresBetween(gr, ts, true)
        .filter((w) => TS_BOXES.includes(boxOf(w.from)) || TS_BOXES.includes(boxOf(w.to)))
        .map((w) => full(exampleRefs(w)));
    expect(pick(g).sort()).toEqual(pick(EXAMPLE).sort());
  });

  it('④ 例の箱どうしの間に、例に無い線（残った `_`・二重）が無い', () => {
    const exp = new Set(EXAMPLE.wires.map((w) => refs(exampleRefs(w))));
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

  it('⑦ 全体の broken（スナップショット。見つかったことを固定する）', () => {
    const all = g.wires
      .filter((w) => w.broken?.length)
      .map((w) => ({ wire: refs(w), broken: w.broken!.map((b) => [b.path, b.level]) }));
    expect(all).toEqual([
      // 2026-11-09 追加（8-2b。D59）: PushToggle は fetch(…, { method: 'POST' }) で body を送らないが、POST
      // /push/subscriptions の requestBody は required。役割ごとの欠けは子の照合では出ないので、呼び出しの親の項目から
      // endpoint の in/body へ線を 1 本引き、線そのもの（path ""）を error にする（go が無くても出る。クライアント側）
      {
        wire: 'comp:PushToggle#out/call_1 → endpoint:POST /push/subscriptions#in/body',
        broken: [['', 'error']],
      },
      // 例の 2 件（TS の Entry に occurredAt が無い・amount が number）
      {
        wire: 'fn:createTransaction#out/call_1.body → endpoint:POST /transactions#in/body',
        broken: [
          ['amount', 'warn'],
          ['occurredAt', 'error'],
        ],
      },
      ...(hasGo
        ? [
            // 例の 1 件: Go の handleToday は domain.Transaction（occurredAt を持つ）をそのまま返すが、OpenAPI の Entry
            // には occurredAt が無い
            {
              wire: 'fn:internal/api.handleToday#out/resp → endpoint:GET /today#res/body',
              broken: [['entries.occurredAt', 'error']],
            },
            // 見つかったこと（§7 #6 ⑦）: GET /entries も Go は []domain.Transaction、OpenAPI は Entry[] で occurredAt が
            // 食い違う（例の範囲の外なので 3 件より多い）
            {
              wire: 'fn:internal/api.handleEntries#out/txs → endpoint:GET /entries#res/body',
              broken: [['occurredAt', 'error']],
            },
          ]
        : []),
    ]);
    // D59 の線の理由
    const missing = g.wires.find((w) => w.from === 'comp:PushToggle#out/call_1')!;
    expect(missing.broken).toEqual([
      { path: '', level: 'error', reason: '送る側に無い（必須の body）' },
    ]);
    expect(missing.via).toBe('http');
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

  it('自動率と合流のサマリ（docs/17 §4）を build の要約に出す', () => {
    const a = res.v2Adapters!;
    // 2026-11-09 変更（8-2a レビュー）: openapi は言語アダプタではなく契約（Extractor.v2Role = contract）。
    // adapters（project.generator.adapters も）は言語アダプタだけ、契約は contracts に分けた（C10）
    // 2026-11-09 変更（8-2b）: go-types（言語アダプタ）が加わった（go が無ければ v2 を出さないので入らない）
    const adapters = hasGo ? ['ts-types', 'go-types'] : ['ts-types'];
    expect(a.adapters).toEqual(adapters);
    // 2026-11-09 変更（8-2b）: sql も v2（table の 3 口とカラムの項目）を出す契約になった
    expect(a.contracts).toEqual(['openapi', 'sql']);
    expect(g.project?.generator).toMatchObject({ adapters, contracts: ['openapi', 'sql'] });
    expect(a.joined).toBe(5);
    expect(a.unjoined).toEqual([]);
    // 2026-11-09 追加（8-2b）: 合流の内訳。クライアント側（必須の body の欠け 1。D59）、サーバー側（7 つの endpoint と
    // handler の対。GET /transactions は OpenAPI にあるが Go に handler が無い。認証の middleware が mux 全体を包むので
    // 7 つ全部に login）、table（SELECT 3・INSERT 2・DELETE 2・全件の SELECT 1 の 8 項目）
    expect(a.join.client).toEqual({ matched: 5, direct: 0, unmatched: [], missing: 1 });
    expect(a.join.server).toEqual(
      hasGo
        ? { matched: 7, unmatched: [], withoutHandler: ['endpoint:GET /transactions'], login: 7 }
        : { matched: 0, unmatched: [], withoutHandler: [], login: 0 },
    );
    expect(a.join.table).toEqual({ matched: hasGo ? 8 : 0, unmatched: [] });
    // group にした v1 の箱: TS のファイルの箱 4 ＋ Go のパッケージの箱 9（internal/domain は type なので types[]）
    expect(a.groups).toBe(hasGo ? 13 : 4);
    // 2026-11-10 追加（8-6）: group になった v1 の箱の元の名前・kind・file が v2 のトップの groups に残る（docs/20 §5.1 #3）
    expect(g.groups?.map((x) => x.id).sort()).toEqual(
      [...new Set(g.nodes.flatMap((n) => (n.group ? [n.group] : [])))].sort(),
    );
    expect(g.groups).toHaveLength(hasGo ? 13 : 4);
    expect(g.groups?.find((x) => x.id === 'lib:web/src/feature/spend/request.ts')).toEqual({
      id: 'lib:web/src/feature/spend/request.ts',
      name: 'request',
      kind: 'lib',
      file: 'web/src/feature/spend/request.ts',
    });
    if (hasGo)
      expect(g.groups?.find((x) => x.id === 'handler:internal/api')).toMatchObject({
        kind: 'handler',
      });
    // 付け替え先を決められない線（中の全部へ付け替えたもの）。C6 の refs は go-types も出す（pkgRefs。型だけの import の
    // push も参照している関数へ）。
    // 2026-11-09 変更（8-2b レビュー）: 中が 1 つだけの group は付け替え先が決まっているものとして数える（11 → 0）。
    // 以前の 11 は全部、Go の入口のパッケージ（cmd/*。中は main 1 つ）に付いたインフラ・利用者・Scheduler の線と、
    // overrides の notify → push_subscriptions（main は SQL を使わない。往復で 2）だった
    expect(a.undetermined).toBe(0);
    expect(a.broken).toBe(hasGo ? 4 : 2);
    const c = a.coverage;
    expect(c.wires).toBe(c.itemWires + c.boxWires);
    // 呼び出しでない参照: API_DOMAIN の定数（fetcher・PushToggle → lib:consts の往復）4、Go は push.Subscription の型だけを
    // 使う handleSubscribe・handleUnsubscribe・SaveSubscription・ListSubscriptions → push.Send の往復 8
    expect(c.refWires).toBe(hasGo ? 12 : 4);
    const lines = formatAdapterSummary(a);
    // 2026-11-09 変更（8-2a レビュー）: 要約も言語アダプタと契約を分ける（C10）
    expect(lines[0]).toMatch(
      new RegExp(
        `^言語アダプタ（${adapters.join(', ')}）・契約（openapi, sql）: 項目 \\d+（unknown \\d+）、線 \\d+（項目 \\d+ / 箱の単位 \\d+、うち呼び出しでない参照 ${c.refWires}）、links \\d+（exact \\d+ / crude \\d+）・不透明な箱 \\d+$`,
      ),
    );
    // 2026-11-09 変更（8-2b）: 合流をクライアント側・サーバー側・table に分け、掃除の数は次の行へ
    expect(lines[1]).toBe(
      hasGo
        ? '  合流: クライアント側 5（必須の役割の欠け 1）、サーバー側 7（handler の無い endpoint 1、login の分岐 7）、table 8'
        : '  合流: クライアント側 5（必須の役割の欠け 1）、サーバー側 0、table 0',
    );
    expect(lines[2]).toMatch(/^ {2}掃除: group にした v1 の箱 \d+、/);
  });

  it('fixture-repo（OpenAPI が無い）: api のメソッドの箱から TS の handler へ直接結ぶ（8-2b）', () => {
    const a = repo.v2Adapters!;
    // export const api = { getRaces, getRace, postResult } が関数の箱になり（server component と client から使うので
    // @server・@browser の複製）、HTTP の呼び出しが項目の単位になった。endpoint が無いので handler（meta.apiRoutes）と直接
    expect(a.join.client).toEqual({ matched: 0, direct: 6, unmatched: [], missing: 0 });
    expect(a.joined).toBe(6);
    const gr = repo.graphV2!;
    expect(gr.nodes.find((n) => n.id === 'lib:apiClient')).toBeUndefined();
    const m = gr.nodes.find((n) => n.id === 'fn:api.getRace@server')!;
    expect([m.kind, m.group, m.name]).toEqual(['fn', 'lib:apiClient', 'api.getRace']);
    expect(
      gr.wires.filter((w) => w.from.startsWith('fn:api.getRace@server#out/call_1')).map(full),
    ).toEqual(['fn:api.getRace@server#out/call_1.path → handler:getRaces#in/e (http)']);
    expect(gr.wires.map(full)).toContain(
      'handler:getRaces#out/return → fn:api.getRace@server#in/ret_1 (http, reply)',
    );
  });
});

describe.skipIf(!hasGo)(
  '8-2b 受け入れ: fixture-poly の Go の側と合流（サーバー側・table）が手で組んだ例と同じ形になる',
  () => {
    const COMPARED = new Set([...TS_BOXES, ...GO_BOXES, ...JUNCTIONS]);
    const byId = () => new Map(g.nodes.map((n) => [n.id, n]));
    const exampleNode = (id: string) => EXAMPLE.nodes.find((x) => x.id === id)!;

    it('② 例の箱が全部ある（TS・Go・endpoint・テーブル）。kind・runtime・host が例と同じ（InsertTransaction は host が無く meta.hosts）', () => {
      const nodes = byId();
      for (const id of COMPARED) {
        const n = nodes.get(alias(id));
        expect(n, id).toBeDefined();
        const ex = exampleNode(id);
        expect([n!.kind, n!.runtime, n!.host], id).toEqual([ex.kind, ex.runtime, ex.host]);
      }
      // 複数の入口から使う関数（§7 #11）。group（schema:internal/store）の host を受け継がない（2026-11-09 8-2b の決定）
      const ins = nodes.get('fn:internal/store.InsertTransaction')!;
      expect(ins.meta?.hosts).toEqual(
        exampleNode('fn:internal/store.InsertTransaction').meta?.hosts,
      );
    });

    it('③ 言語の中の線（TS と Go）は（箱, 箱, via, reply）が例と一致する', () => {
      const exp = wiresBetween(EXAMPLE, COMPARED, false).map((w) => tuple(exampleRefs(w)));
      const got = wiresBetween(g, COMPARED, false).map(tuple);
      expect([...new Set(got)].sort()).toEqual([...new Set(exp)].sort());
    });

    it('③ 合流点の線（クライアント側・サーバー側・table）は from / to の項目の参照まで例と一致する', () => {
      const exp = wiresBetween(EXAMPLE, COMPARED, true).map((w) => full(exampleRefs(w)));
      const got = wiresBetween(g, COMPARED, true).map(full);
      expect(got.sort()).toEqual(exp.sort());
      // サーバー側の形（docs/17 §7 #2）: レシピの項目の無い handler は req/path → in/r、body は役割ごとに親 1 本
      expect(got).toEqual(
        expect.arrayContaining([
          'endpoint:GET /today#req/path → fn:internal/api.handleToday#in/r (call)',
          'fn:internal/api.handleToday#out/resp → endpoint:GET /today#res/body (return, reply)',
          'endpoint:POST /transactions#req/body → fn:internal/api.handleCreateTransaction#in/body (call)',
          'fn:internal/api.handleCreateTransaction#out/status → endpoint:POST /transactions#res/status (return, reply)',
          'fn:internal/store.ListByDate#out/query_1.occurred_at → schema:transactions#key/occurred_at (sql)',
          'schema:transactions#read/row → fn:internal/store.ListByDate#in/row (sql, reply)',
          'fn:internal/store.InsertTransaction#out/insert_1 → schema:transactions#write/row (sql)',
        ]),
      );
    });

    it('④ 例の箱どうしの間に、例に無い線（残った `_`・二重）が無い', () => {
      const exp = new Set(EXAMPLE.wires.map((w) => refs(exampleRefs(w))));
      const extra = g.wires
        .filter((w) => COMPARED.has(boxOf(w.from)) && COMPARED.has(boxOf(w.to)))
        .map(refs)
        .filter((k) => !exp.has(k) && !ALLOWED_EXTRA.includes(k));
      expect(extra).toEqual([]);
    });

    it('⑤ 例の線の broken は例の 3 件と一致する（GET /today の entries.occurredAt、POST の occurredAt・amount）', () => {
      const exampleWires = new Set(EXAMPLE.wires.map((w) => refs(exampleRefs(w))));
      const pick = (gr: GraphV2) =>
        new Map(
          gr.wires
            .filter((w) => w.broken?.length && exampleWires.has(refs(exampleRefs(w))))
            .map((w) => [
              refs(exampleRefs(w)),
              w.broken!.map((b) => `${b.path}:${b.level}`).sort(),
            ]),
        );
      expect(pick(g)).toEqual(pick(EXAMPLE));
      expect([...pick(g).values()].flat().sort()).toEqual([
        'amount:warn',
        'entries.occurredAt:error',
        'occurredAt:error',
      ]);
    });

    it('endpoint の login の分岐（認証の middleware が mux 全体を包む。§7 #11）は例と同じ形: 持ち主は endpoint、when は in → req の links', () => {
      const nodes = byId();
      for (const id of ENDPOINTS) {
        const n = nodes.get(id)!;
        const ex = exampleNode(id);
        expect(n.variants, id).toEqual(ex.variants);
        for (const l of ex.links ?? [])
          expect(n.links, `${id} ${l.from} → ${l.to}`).toContainEqual(l);
        // 線には when を付けない（例と同じ）
        expect(
          g.wires.filter((w) => w.when && (w.from.startsWith(id) || w.to.startsWith(id))),
        ).toEqual([]);
      }
      expect(nodes.get('endpoint:GET /today')!.meta?.auth).toBe(
        'internal/auth.Middleware（Authorization ヘッダ）',
      );
      // 未ログインなら handler に届かない
      const index = indexGraph(g);
      const off = withVariants(defaultState(index), { 'endpoint:GET /today#login': false });
      const lit = select(index, off, { kind: 'box', id: 'route:/' })!;
      expect(lit.boxes.has('endpoint:GET /today')).toBe(true);
      for (const id of ['fn:internal/api.handleToday', 'schema:transactions'])
        expect(lit.boxes.has(id), id).toBe(false);
    });

    it('型（D65）: 同じ id は契約が言語アダプタに勝つ。type:Transaction は OpenAPI の型で、Go の宣言は copies に', () => {
      const t = g.types!.find((x) => x.id === 'type:Transaction')!;
      const ex = EXAMPLE.types!.find((x) => x.id === 'type:Transaction')!;
      expect([t.source, t.file, t.line]).toEqual([ex.source, ex.file, ex.line]);
      expect(t.meta?.copies).toEqual(ex.meta?.copies);
    });

    it('画面 route:/ をクリックすると、endpoint → handler → ListByDate → transactions → 戻りまで項目の単位で光る', () => {
      const index = indexGraph(g);
      const lit = select(index, defaultState(index), { kind: 'box', id: 'route:/' })!;
      for (const ref of [
        'endpoint:GET /today#in/path',
        'endpoint:GET /today#req/path',
        'fn:internal/api.handleToday#in/r',
        'fn:internal/api.handleToday#out/call_1.day',
        'fn:internal/store.ListByDate#in/day',
        'fn:internal/store.ListByDate#out/query_1.occurred_at',
        'schema:transactions#key/occurred_at',
        // 戻り: テーブル → ListByDate → handleToday → endpoint → getToday
        'schema:transactions#read/row',
        'fn:internal/store.ListByDate#in/row',
        'fn:internal/store.ListByDate#out/return',
        'fn:internal/api.handleToday#in/ret_1',
        'fn:internal/api.handleToday#out/resp',
        'endpoint:GET /today#res/body',
        'endpoint:GET /today#out/body',
        'fn:getToday#in/ret_1',
      ])
        expect(lit.items.has(ref), ref).toBe(true);
      for (const id of [
        'fn:internal/api.handleCreateTransaction',
        'fn:internal/store.InsertTransaction',
        'fn:internal/store.ListRecent',
      ])
        expect(lit.boxes.has(id), id).toBe(false);
    });

    it('overrides の notify → push_subscriptions（uses）は残り、cmd/notify の main に付け替わる（Scheduler から光る）', () => {
      const notify = g.wires.filter(
        (w) => boxOf(w.from) === 'fn:cmd/notify.main' || boxOf(w.to) === 'fn:cmd/notify.main',
      );
      expect(notify.map(full)).toEqual(
        expect.arrayContaining([
          'fn:cmd/notify.main#out/_ → schema:push_subscriptions#key/_ (sql)',
          'schema:push_subscriptions#read/_ → fn:cmd/notify.main#in/_ (sql, reply)',
          'infra:scheduler_notify/daily#out/_ → fn:cmd/notify.main#in/_ (event)',
        ]),
      );
      const index = indexGraph(g);
      const lit = select(index, defaultState(index), {
        kind: 'box',
        id: 'infra:scheduler_notify/daily',
      })!;
      expect(lit.boxes.has('schema:push_subscriptions')).toBe(true);
    });

    it('D66: テーブルを読む線は受ける側（SELECT のカラム）だけを比べる。DailyTotals は 2 カラムと式だけを読む', () => {
      const daily = g.wires.find(
        (w) =>
          w.from === 'schema:transactions#read/row' &&
          w.to === 'fn:internal/store.DailyTotals#in/row',
      )!;
      expect(daily).toBeDefined();
      // テーブルにしか無い id・merchant・amount（選んでいない）と、SUM(amount) の式（カラムではない）は食い違いにしない
      expect(daily.broken).toBeUndefined();
      const row = (g.nodes.find((n) => n.id === 'fn:internal/store.DailyTotals') as NodeV2).ports
        .find((p) => p.id === 'in')!
        .items.find((i) => i.id === 'row')!;
      expect(row.children!.map((c) => c.id)).toEqual(['occurred_at', 'sum']);
    });
  },
);
