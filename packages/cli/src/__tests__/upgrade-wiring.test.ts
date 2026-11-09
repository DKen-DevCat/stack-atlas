// v1 → v2 の変換（docs/16 §10）を、実際の抽出器で組んだフィクスチャで確かめる（Phase 8-1）。
// - 規模: 箱の単位の v2（fixture-poly ≒ 48 箱、fixture-repo ≒ 28 箱、race-site）が 1 秒未満で layoutWiring でき、
//   箱が重ならず、線は直交で箱の内側を通らない
// - たどり: 画面を選ぶと下流の helper・ハンドラ・テーブルが光り、関係ない画面は光らない（docs/15 §3.5）
// - 見つかったこと（2026-11-09）: 共有の helper・ハンドラ・テーブルを選ぶと、ほぼ全部が光る（下の describe に事実として固定）
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
  return res.graphV2;
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
    for (const id of [
      'comp:TodayIsland',
      'comp:TotalCard',
      'lib:web/src/feature/spend/request.ts',
      'lib:fetcher',
      'endpoint:GET /today',
      'handler:internal/api',
      'schema:internal/store',
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
      'lib:web/src/feature/days/request.ts',
      'endpoint:GET /days',
      'handler:cmd/api',
      'handler:cmd/gmail-webhook',
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
    expect([...lit].sort()).toEqual([
      'handler:cmd/notify',
      'infra:app',
      'infra:aurora/db',
      'infra:scheduler_notify/daily',
      'schema:push_subscriptions',
    ]);
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

  it.each(['route:/', 'route:/races/[id]', 'route:/admin/entry'])(
    '%s を選んでも他の画面は光らない',
    (id) => {
      const lit = litBoxes(repo(), id);
      expect(lit.has('lib:apiClient')).toBe(true);
      expect(lit.has('schema:RaceItem')).toBe(true);
      for (const r of ROUTES) if (r !== id) expect(lit.has(r), r).toBe(false);
    },
  );

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

// 見つかったこと（2026-11-09。事実として固定する。直すのは @stack-atlas/wiring のたどり）:
// 2 段のたどり（D43）は、第 k 回の戻りの絞り込みを「前回の範囲」で判定する。共有の helper・ハンドラ・テーブルから始めると、
// 第 1 回の範囲はほぼ始点だけなので、第 2 回で始点の先の曖昧な戻り（往復の相手が 2 つ以上の箱）が「相手が 1 つも
// 前回の範囲にいない → 全員へ」で全部通る。その回で光った箱が次の回の範囲に入るので、絞り込みが効かないまま止まる。
// 箱の単位の v2 では uses がどれも呼び出しと戻りの対になるので、共有の箱が多く、これが目立つ
describe('見つかったこと: 共有の箱から始めると、ほぼ全部が光る（2 段のたどりの範囲が前回のもの）', () => {
  it('fixture-poly: lib:fetcher の下流に、fetcher を使わない PushToggle と push の endpoint が入る', () => {
    const lit = litBoxes(graphs.get('fixture-poly')!, 'lib:fetcher', { downOnly: true });
    expect(lit.has('comp:PushToggle')).toBe(true);
    expect(lit.has('endpoint:POST /push/subscriptions')).toBe(true);
    // 部品は画面へ戻りを返さない（render は片道）ので、下流に画面は入らない
    expect(lit.has('route:/push')).toBe(false);
  });

  it('fixture-repo: lib:apiClient の下流に、apiClient を使わない /login と Header が入る', () => {
    const lit = litBoxes(graphs.get('fixture-repo')!, 'lib:apiClient', { downOnly: true });
    expect(lit.has('route:/login')).toBe(true);
    expect(lit.has('comp:Header')).toBe(true);
  });
});
