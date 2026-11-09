// v1 → v2 の変換（docs/16 §10）を、実際の抽出器で組んだフィクスチャで確かめる（Phase 8-1）。
// - 規模: 箱の単位の v2（fixture-poly ≒ 48 箱、fixture-repo ≒ 28 箱、race-site）が 1 秒未満で layoutWiring でき、
//   箱が重ならず、線は直交で箱の内側を通らない
// - たどり: 画面を選ぶと下流の helper・ハンドラ・テーブルが光り、関係ない画面は光らない（docs/15 §3.5）
// - 見つかったこと（2026-11-09）: 共有の helper・ハンドラ・テーブルを選ぶと、ほぼ全部が光った。8-1 のレビューでたどりを直し、
//   新しい光り方を下の describe に事実として固定した
// - Phase 8-2a から build には言語アダプタ（ts-types・openapi の v2）が重なる。TS の側は項目の単位になり、Go の側は箱の単位のまま
//   （8-2b）。変わった期待値はテストの中に何が変わったかを書いた
// - Phase 8-2b から go-types（Go の関数の箱）・sql（table の口）と、サーバー側・table の合流が重なる。go が無ければ Go の側は
//   v1 のパッケージの箱のまま（D51）なので、Go の箱 id は goId で選ぶ（CI は STACK_ATLAS_REQUIRE_GO=1 で go が必須）
import { buildGraph, createMemoryLogger, loadConfig, upgradeGraph } from '@stack-atlas/core';
import { validateGraphV2, type Graph, type GraphV2 } from '@stack-atlas/schema';
import {
  defaultState,
  indexGraph,
  layoutWiring,
  select,
  withVariants,
  type GraphIndex,
  type Rect,
  type WiringLayout,
} from '@stack-atlas/wiring';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadExtractors } from '../extractors.js';
import { hasGo } from './go-env.js';

/**
 * 2026-11-09 変更（8-2b）: go-types の関数の箱が v1 の Go のパッケージの箱（handler:・lib:・schema:）を置き換えて group に
 * した（D53）。go があれば関数の箱、無ければ v1 のパッケージの箱
 */
const goId = (fn: string, pkg: string) => (hasGo ? fn : pkg);

const example = (p: string) => fileURLToPath(new URL(`../../../../examples/${p}`, import.meta.url));

async function build(name: string): Promise<GraphV2> {
  const root = example(name);
  const log = createMemoryLogger();
  const extractors = await loadExtractors(log, { skip: ['screenshots'] });
  const res = await buildGraph({
    root,
    extractors,
    log,
    config: loadConfig(root, log),
    commit: false,
  });
  expect(res.issues.filter((i) => i.level === 'error')).toEqual([]);
  return res.graphV2!;
}

const graphs = new Map<string, GraphV2>();
beforeAll(async () => {
  graphs.set('fixture-poly', await build('fixture-poly'));
  graphs.set('fixture-repo', await build('fixture-repo'));
  const race = JSON.parse(readFileSync(example('race-site.graph.json'), 'utf8')) as Graph;
  graphs.set('race-site', upgradeGraph(race));
}, 60_000);

/** この処理が使った CPU 時間（ms）。並列に走る他のテストに待たされた分を含めない（wiring の perf.test と同じ） */
const cpuMs = (f: () => void) => {
  const t0 = process.cpuUsage();
  f();
  const d = process.cpuUsage(t0);
  return (d.user + d.system) / 1000;
};
const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
/** 直交の折れ線の区間が箱の内側を通るか（辺に触れるだけは通らない扱い。wiring の layout.test と同じ） */
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

describe.each(['fixture-poly', 'fixture-repo', 'race-site'])('箱の単位の v2: %s', (name) => {
  let g: GraphV2;
  let index: GraphIndex;
  let layout: WiringLayout;
  let ms = 0;
  beforeAll(() => {
    g = graphs.get(name)!;
    index = indexGraph(g);
    // 1 回目は JIT の暖機を含むので 2 回目を測る
    layoutWiring(index);
    ms = cpuMs(() => {
      layout = layoutWiring(index);
    });
  });

  it('検証エラー 0', () => {
    expect(validateGraphV2(g).errors).toEqual([]);
  });

  it('layoutWiring は 1 秒未満（CPU 時間）', () => {
    expect(ms).toBeLessThan(1000);
  });

  it('箱どうし・枠と外の箱が重ならない。枠は中の箱を囲む', () => {
    const boxes = [...layout.boxes.values()];
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++)
        expect(overlaps(boxes[i]!, boxes[j]!), `${boxes[i]!.id} と ${boxes[j]!.id}`).toBe(false);
    expect(layout.hosts.size).toBeGreaterThan(0);
    for (const h of layout.hosts.values()) {
      for (const id of h.members) {
        const b = layout.boxes.get(id)!;
        expect(b.x > h.x && b.y > h.y && b.x + b.w < h.x + h.w && b.y + b.h < h.y + h.h, id).toBe(
          true,
        );
      }
      for (const b of boxes)
        if (!h.members.includes(b.id)) expect(overlaps(h, b), `${h.id} と ${b.id}`).toBe(false);
    }
  });

  it('線は直交の折れ線で、箱の内側を通らない', () => {
    const boxes = [...layout.boxes.values()];
    expect(layout.routes.size).toBeGreaterThan(0);
    for (const [key, r] of layout.routes) {
      const pts = r.points;
      for (let i = 1; i < pts.length; i++)
        expect(pts[i - 1]!.x === pts[i]!.x || pts[i - 1]!.y === pts[i]!.y, key).toBe(true);
      for (const b of boxes) expect(crossesBox(pts, b), `${key} が ${b.id} を横切る`).toBe(false);
    }
  });
});

/** 箱を選んだときに光る箱 */
const litBoxes = (g: GraphV2, id: string, opts: { downOnly?: boolean; hit?: string } = {}) => {
  const index = indexGraph(g);
  let state = defaultState(index);
  if (opts.hit) state = withVariants(state, { [`${opts.hit}#hit`]: true });
  const r = select(index, state, {
    kind: 'box',
    id,
    ...(opts.downOnly ? { downOnly: true } : {}),
  })!;
  return r.boxes;
};

describe('たどり: 画面を選ぶと下流が光り、関係ない画面は光らない（fixture-poly）', () => {
  const poly = () => graphs.get('fixture-poly')!;
  const ROUTES = ['route:/', 'route:/calendar', 'route:/push', 'layout:/'];

  it('route:/ は TodayIsland → getToday 系 → endpoint → ハンドラ → テーブルまで光り、他の画面は光らない', () => {
    const lit = litBoxes(poly(), 'route:/');
    // Phase 8-2a で変更: ts-types の関数の箱が v1 のファイルの箱を置き換えたので、lib:web/src/feature/spend/request.ts
    // ではなく fn:getToday・fn:toTodayView が光る。同じファイルの getEntries・createTransaction は光らず、
    // その先の endpoint（GET /entries・POST /transactions）も光らなくなった（以前はファイルの単位なので光っていた）
    for (const id of [
      'comp:TodayIsland',
      'comp:TotalCard',
      'fn:getToday',
      'fn:toTodayView',
      'lib:fetcher',
      'endpoint:GET /today',
      // 2026-11-09 変更（8-2b）: handler:internal/api → handleToday（GET /today の handler）、schema:internal/store →
      // ListByDate（handleToday が呼ぶ store の関数）。どちらも項目の単位（route:/ → … → transactions の往復）
      goId('fn:internal/api.handleToday', 'handler:internal/api'),
      goId('fn:internal/store.ListByDate', 'schema:internal/store'),
      'schema:transactions',
      // 上流: CloudFront（MISS）と S3、利用者
      'infra:static_site/this',
      'infra:static_site/site',
      'actor:user',
    ])
      expect(lit.has(id), id).toBe(true);
    for (const id of [
      ...ROUTES.filter((r) => r !== 'route:/'),
      'comp:CalendarIsland',
      'comp:PushToggle',
      'fn:getDays',
      'fn:getEntries',
      'fn:createTransaction',
      'endpoint:GET /days',
      'endpoint:GET /entries',
      'endpoint:POST /transactions',
      goId('fn:cmd/api.main', 'handler:cmd/api'),
      goId('fn:cmd/gmail-webhook.main', 'handler:cmd/gmail-webhook'),
      // 2026-11-09 追加（8-2b）: 関数の単位なので、同じパッケージの別の handler・store の関数は光らない
      ...(hasGo
        ? [
            'fn:internal/api.handleEntries',
            'fn:internal/api.handleCreateTransaction',
            'fn:internal/store.InsertTransaction',
            'fn:internal/store.ListRecent',
          ]
        : []),
    ])
      expect(lit.has(id), id).toBe(false);
  });

  it('route:/calendar・route:/push も自分の部品と endpoint だけ', () => {
    const cal = litBoxes(poly(), 'route:/calendar');
    expect(cal.has('endpoint:GET /days')).toBe(true);
    expect(cal.has('comp:TodayIsland')).toBe(false);
    for (const r of ROUTES) if (r !== 'route:/calendar') expect(cal.has(r), r).toBe(false);
    const push = litBoxes(poly(), 'route:/push');
    expect(push.has('endpoint:POST /push/subscriptions')).toBe(true);
    for (const r of ROUTES) if (r !== 'route:/push') expect(push.has(r), r).toBe(false);
  });

  it('CloudFront の HIT でも画面へ届く（S3 は光らない。D42 改訂）', () => {
    const lit = litBoxes(poly(), 'actor:user', { downOnly: true, hit: 'infra:static_site/this' });
    expect(lit.has('route:/')).toBe(true);
    expect(lit.has('infra:static_site/site')).toBe(false);
  });

  it('Scheduler から始めると notify → push_subscriptions だけ（画面を通らない流れ）', () => {
    const lit = litBoxes(poly(), 'infra:scheduler_notify/daily');
    // 2026-11-09 変更（8-2b）: handler:cmd/notify → fn:cmd/notify.main（cmd/notify の唯一の関数）。overrides の
    // notify → push_subscriptions（uses）は、SQL で push_subscriptions を使う関数が中に無いので中の全部（main 1 つ）へ
    // 付け替わる（付け替え先を決められない線として数える）
    expect([...lit].sort()).toEqual(
      [
        goId('fn:cmd/notify.main', 'handler:cmd/notify'),
        'infra:app',
        'infra:aurora/db',
        'infra:scheduler_notify/daily',
        'schema:push_subscriptions',
      ].sort(),
    );
  });
});

describe('たどり: fixture-repo（Next を Lambda に載せた SSR）', () => {
  const repo = () => graphs.get('fixture-repo')!;
  const ROUTES = [
    'route:/',
    'route:/races',
    'route:/races/[id]',
    'route:/admin/entry',
    'route:/login',
    'layout:/',
  ];

  // 2026-11-09 変更（8-2b）: apiClient の `export const api = { getRaces, getRace, postResult }` のメソッドが関数の箱
  // （fn:api.<メソッド>。server component と client の両方から使うので @server / @browser の複製）になり、lib:apiClient は
  // group になって箱としては消えた。画面は自分が呼ぶメソッドの箱から handler（OpenAPI が無いので直接の合流）とテーブルまで光る
  it.each([
    ['route:/', ['fn:api.getRaces@browser', 'handler:getRaces']],
    ['route:/races/[id]', ['fn:api.getRace@server', 'handler:getRaces']],
    [
      'route:/admin/entry',
      ['fn:api.getRace@server', 'fn:api.postResult@server', 'handler:postResult'],
    ],
  ])('%s を選んでも他の画面は光らない', (id, calls) => {
    const lit = litBoxes(repo(), id);
    for (const c of calls) expect(lit.has(c), c).toBe(true);
    expect(lit.has('schema:RaceItem')).toBe(true);
    for (const r of ROUTES) if (r !== id) expect(lit.has(r), r).toBe(false);
  });

  it('入稿画面の CDN 無効化（overrides の http）は cache の in/purge で止まり、全部のオリジン（画面）へ広がらない', () => {
    const lit = litBoxes(repo(), 'route:/admin/entry', { downOnly: true });
    expect(lit.has('infra:cdn')).toBe(true);
    expect(lit.has('route:/')).toBe(false);
    expect(lit.has('infra:static')).toBe(false);
  });

  it('CloudFront の HIT では SSR の画面まで届かない（Lambda の画面はオリジン）', () => {
    const lit = litBoxes(repo(), 'actor:user', { downOnly: true, hit: 'infra:cdn' });
    expect([...lit].sort()).toEqual(['actor:user', 'infra:cdn']);
  });
});

// 見つかったこと（2026-11-09）と、その直し（8-1 のレビュー。@stack-atlas/wiring のたどり）:
// 以前の 2 段のたどり（D43）は、第 k 回の戻りの絞り込みを「前回の範囲」だけで判定していた。共有の helper・ハンドラ・
// テーブルから始めると、第 1 回の範囲はほぼ始点だけなので、第 2 回で始点の先の曖昧な戻り（往復の相手が 2 つ以上の箱）が
// 「相手が 1 つも前回の範囲にいない → 全員へ」で、同じ回に相手が光る箱の分まで全部通り、ほぼ全部が光った。
// 今は曖昧な戻りを保留し、戻り先が光っているものから通し、光る箱が増えなくなってから「全員へ」を決める（docs/15 §3.5）。
// 共有の箱が呼び出し元を全部光らせるのは正しい（誰も光っていなければ全員へ）ので、残る
describe('見つかったこと: 共有の箱から始めたときの光り方（「全員へ」を早く決めすぎない）', () => {
  /** 光る箱の数（上流＋下流 / 下流だけ） */
  const counts = (g: GraphV2, id: string) => [
    litBoxes(g, id).size,
    litBoxes(g, id, { downOnly: true }).size,
  ];

  it('fixture-poly: lib:fetcher の下流に、fetcher を使わない PushToggle と push の endpoint は入らない', () => {
    // 8-1 のレビューで変更: 以前は PushToggle と POST /push/subscriptions が入っていた（48 箱中 40 / 下流 33）
    const lit = litBoxes(graphs.get('fixture-poly')!, 'lib:fetcher', { downOnly: true });
    expect(lit.has('comp:PushToggle')).toBe(false);
    expect(lit.has('endpoint:POST /push/subscriptions')).toBe(false);
    // fetcher を使う関数・部品は光る
    for (const id of ['comp:TodayIsland', 'comp:CalendarIsland', 'fn:getToday', 'fn:getDays'])
      expect(lit.has(id), id).toBe(true);
    // Phase 8-2a で変更: 以前は fetcher の下流に endpoint（GET /today・GET /days）とその先のハンドラ・テーブルが
    // 入っていた（26 / 下流 21）。項目の単位では HTTP の線はパスのリテラルを持つ呼び出し元（getToday の call_1.url）から
    // endpoint へ直接引き、fetcher は脇に置く（D45）ので、fetcher の下流は戻りを受ける呼び出し元とその先だけになった
    for (const id of [
      'endpoint:GET /today',
      'endpoint:GET /days',
      goId('fn:internal/api.handleToday', 'handler:internal/api'),
    ])
      expect(lit.has(id), id).toBe(false);
    // 部品は画面へ戻りを返さない（render は片道）ので、下流に画面は入らない
    expect(lit.has('route:/push')).toBe(false);
    expect(counts(graphs.get('fixture-poly')!, 'lib:fetcher')).toEqual([18, 13]);
  });

  it('fixture-repo: 共有の api.getRace（2 つの画面から呼ぶ）の下流に、使わない /login と Header は入らない', () => {
    // 8-1 のレビューで変更: 以前は /login と Header が入っていた（28 箱中 19 / 下流 18）。
    // useSession は光っている AuthGuard（入稿画面の部品）へだけ返す
    // 2026-11-09 変更（8-2b）: lib:apiClient はメソッドの関数の箱（fn:api.getRaces / getRace / postResult の @server・@browser）
    // の group になり、箱としては消えた（以前は 17 / 下流 16）。共有の箱は api.getRace@server（route:/races/[id] と
    // route:/admin/entry の server component から呼ぶ）。誰も光っていないので戻りは呼び出し元の両方へ、その先は
    // ResultTable だけ（AuthGuard・useSession は postResult 側でも getRace 側でもないので入らない）
    const lit = litBoxes(graphs.get('fixture-repo')!, 'fn:api.getRace@server', { downOnly: true });
    expect(lit.has('route:/login')).toBe(false);
    expect(lit.has('comp:Header')).toBe(false);
    expect(lit.has('route:/races/[id]')).toBe(true);
    expect(lit.has('route:/admin/entry')).toBe(true);
    expect(lit.has('handler:getRaces')).toBe(true);
    expect(lit.has('fn:api.getRaces@browser')).toBe(false);
    expect(counts(graphs.get('fixture-repo')!, 'fn:api.getRace@server')).toEqual([8, 6]);
  });

  it.skipIf(hasGo)(
    'fixture-poly（go が無いとき）: テーブルから始めると、store の呼び出し元までで止まる（画面までは光らない）',
    () => {
      // 8-1 のレビューで変更: 以前は 38 / 下流 32（web の部品と endpoint まで）。store は誰も光っていないので全員
      // （cmd/api・internal/api・gmail-webhook・inbound）へ返し、internal/api は光っている cmd/api へだけ返す
      const g = graphs.get('fixture-poly')!;
      const lit = litBoxes(g, 'schema:transactions', { downOnly: true });
      expect(lit.has('handler:internal/api')).toBe(true);
      expect(lit.has('handler:cmd/gmail-webhook')).toBe(true);
      expect(lit.has('endpoint:GET /today')).toBe(false);
      expect(counts(g, 'schema:transactions')).toEqual([14, 13]);
    },
  );

  it.skipIf(!hasGo)(
    'fixture-poly: テーブルから始めると、読んだ行が戻りで表示する部品まで届く（画面と書く側は光らない）',
    () => {
      // 2026-11-09 変更（8-2b）: 上の go の無いときの事実（store の呼び出し元までで止まる）から変わった。項目の単位では
      // テーブルの read/row → SELECT した関数（ListByDate・ListRecent・DailyTotals）→ handler → endpoint → 呼び出し元の
      // 戻りの線が 1 本ずつつながり、読んだ行が TotalCard・EntryList・CalendarGrid まで流れる。画面は render が片道なので
      // 光らず、INSERT・DELETE の側（POST /transactions・gmail-webhook）は行を受けないので下流に入らない
      const g = graphs.get('fixture-poly')!;
      const lit = litBoxes(g, 'schema:transactions', { downOnly: true });
      for (const id of [
        'fn:internal/store.ListByDate',
        'fn:internal/store.ListRecent',
        'fn:internal/store.DailyTotals',
        'fn:internal/api.handleToday',
        'endpoint:GET /today',
        'fn:getToday',
        'comp:TotalCard',
        'comp:EntryList',
        'comp:CalendarGrid',
      ])
        expect(lit.has(id), id).toBe(true);
      for (const id of [
        'route:/',
        'route:/calendar',
        'fn:internal/store.InsertTransaction',
        'fn:internal/api.handleCreateTransaction',
        'endpoint:POST /transactions',
        'fn:internal/inbound.ServeHTTP',
      ])
        expect(lit.has(id), id).toBe(false);
      // 上流も含めると書く側（INSERT・DELETE と、その呼び出し元）も光る
      const all = litBoxes(g, 'schema:transactions');
      for (const id of [
        'fn:internal/store.InsertTransaction',
        'fn:internal/inbound.ServeHTTP',
        'fn:createTransaction',
      ])
        expect(all.has(id), id).toBe(true);
      expect(counts(g, 'schema:transactions')).toEqual([35, 21]);
    },
  );

  it.skipIf(!hasGo)(
    'fixture-poly: handler（handleToday）は自分の endpoint と、その呼び出し元・戻りの先だけを光らせる',
    () => {
      // 2026-11-09 変更（8-2b）: 下の go の無いときの handler:internal/api（全部の endpoint を受け持つパッケージの箱）は、
      // handler ごとの関数の箱（fn:internal/api.handleToday など）に分かれた。handleToday は GET /today だけを受け持つ
      const g = graphs.get('fixture-poly')!;
      const lit = litBoxes(g, 'fn:internal/api.handleToday');
      for (const id of [
        'endpoint:GET /today',
        'fn:getToday',
        'comp:TodayIsland',
        'schema:transactions',
      ])
        expect(lit.has(id), id).toBe(true);
      for (const id of [
        'endpoint:GET /days',
        'endpoint:GET /entries',
        'endpoint:POST /transactions',
        'lib:fetcher',
      ])
        expect(lit.has(id), id).toBe(false);
      expect(counts(g, 'fn:internal/api.handleToday')).toEqual([14, 10]);
    },
  );

  it.skipIf(hasGo)(
    'fixture-poly（go が無いとき）: 全部の endpoint を受け持つ handler:internal/api は、呼び出し元の endpoint を全部光らせる（変わらない）',
    () => {
      // Phase 8-2a で変更: 35 → 36。v1 のファイルの箱 4 つ（lib:web/src/feature/*/{request,transformer}.ts）が関数の箱 6 つ
      // （fn:getToday など）になり、endpoint の戻りは呼び出し元へ直接返る（D45）ので lib:fetcher は入らなくなった（+6 −4 −1）
      const g = graphs.get('fixture-poly')!;
      expect(counts(g, 'handler:internal/api')).toEqual([36, 29]);
      const lit = litBoxes(g, 'handler:internal/api');
      expect(lit.has('fn:getToday')).toBe(true);
      expect(lit.has('lib:fetcher')).toBe(false);
    },
  );
});
