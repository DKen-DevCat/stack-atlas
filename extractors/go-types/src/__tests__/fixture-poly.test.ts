// go-types を examples/fixture-poly の platform（Go ＋ Terraform HCL ＋ SQL）に掛け、手で組んだ例
// （examples/fixture-poly.today.v2.json）の Go の側と比べる（docs/17 §3.3・§7 #2・#6・#11）:
// 箱の id / kind / runtime / host、口と項目の id、同じ言語の中の線（箱, 箱, via, reply）と参照。性能の上限も見る
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { GraphV2, ItemV2, NodeV2, WireV2 } from '@stack-atlas/schema';
import {
  createMemoryLogger,
  createRepoContext,
  loadConfig,
  type PartialGraph,
  type PartialNodeV2,
} from '@stack-atlas/core';
import { extractor } from '../index.js';

const hasGo = (() => {
  try {
    execFileSync('go', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    if (process.env['STACK_ATLAS_REQUIRE_GO'] === '1')
      throw new Error('go が見つかりません（STACK_ATLAS_REQUIRE_GO=1）');
    return false;
  }
})();

const fixture = fileURLToPath(new URL('../../../../examples/fixture-poly', import.meta.url));
const example = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../examples/fixture-poly.today.v2.json', import.meta.url)),
    'utf8',
  ),
) as GraphV2;

/** 例の Go の側の箱 */
const GO_BOXES = [
  'fn:internal/api.handleToday',
  'fn:internal/store.ListByDate',
  'fn:internal/api.handleCreateTransaction',
  'fn:internal/store.InsertTransaction',
];

/** 例に無いが出る項目（例の箱の中）。handleToday は domain.Sum(txs) も呼ぶ（例は合計の線を省いている） */
const EXTRA_ITEMS: Record<string, string[]> = {
  'fn:internal/api.handleToday': [
    'in/ret_2',
    'out/call_2',
    'out/call_2.txs',
    'out/call_2.txs.id',
    'out/call_2.txs.merchant',
    'out/call_2.txs.amount',
    'out/call_2.txs.occurredAt',
  ],
};

function paths(n: Pick<NodeV2, 'ports'>): string[] {
  const out: string[] = [];
  for (const port of n.ports) {
    const walk = (items: ItemV2[], pre: string) => {
      for (const it of items) {
        const p = pre ? `${pre}.${it.id}` : it.id;
        out.push(`${port.id}/${p}`);
        if (it.children) walk(it.children, p);
      }
    };
    walk(port.items, '');
  }
  return out;
}

const boxOf = (ref: string) => ref.slice(0, ref.indexOf('#'));
const tuple = (w: WireV2) =>
  `${boxOf(w.from)} → ${boxOf(w.to)} (${w.via}${w.reply ? ', reply' : ''})`;
const among = (w: WireV2) => GO_BOXES.includes(boxOf(w.from)) && GO_BOXES.includes(boxOf(w.to));

describe.skipIf(!hasGo)('go-types: fixture-poly の platform と手で組んだ例', () => {
  const log = createMemoryLogger();
  let part: PartialGraph;
  let byId: Map<string, PartialNodeV2>;
  let ms = 0;
  beforeAll(async () => {
    const config = loadConfig(fixture, log);
    const repos = { web: `${fixture}/web`, platform: `${fixture}/platform` };
    const ctx = createRepoContext(repos.platform, config, log, {
      repoName: 'platform',
      repos,
      configDir: fixture,
    });
    // host の枠になる Lambda（terraform 抽出器が出すもの）と、go 抽出器のパッケージの箱（refs の宛先。8-2b）
    const upstream: PartialGraph = {
      nodes: [
        ...['api', 'gmail_webhook', 'notify'].map((n) => ({
          id: `infra:lambda_api/${n}`,
          kind: 'infra',
          name: n,
          meta: { infra: { type: 'aws_lambda_function' } },
        })),
        ...[
          ['handler:internal/api', 'internal/api'],
          ['lib:internal/push', 'internal/push'],
          ['schema:internal/store', 'internal/store'],
          ['type:internal/domain', 'internal/domain'],
          // 別の repo の同じパッケージ（複数 repo では file の <repo>/ で見分ける）
          ['lib:other/internal/push', 'internal/push', 'web/internal/push/x.go'],
        ].map(([id, pkg, file]) => ({
          id: id!,
          kind: 'lib',
          name: pkg!,
          file: file ?? `platform/${pkg}/x.go`,
          meta: { go: { pkg } },
        })),
      ],
      edges: [],
    };
    expect(await extractor.detect(ctx)).toBe(true);
    const t0 = performance.now();
    part = await extractor.extract(ctx, upstream);
    ms = performance.now() - t0;
    byId = new Map(part.v2!.nodes.map((n) => [n.id, n]));
  }, 120_000);

  it('例の Go の箱が全部あり、kind・runtime・host が同じ（InsertTransaction は 2 つの入口から届くので host 無し・meta.hosts）', () => {
    for (const id of GO_BOXES) {
      const ex = example.nodes.find((n) => n.id === id)!;
      const n = byId.get(id);
      expect(n, id).toBeDefined();
      expect([n!.kind, n!.runtime, n!.host], id).toEqual([ex.kind, ex.runtime, ex.host]);
    }
    // 2026-11-09（8-2b）: 規則（§7 #11）に合わせて例も host を外し meta.hosts にした
    expect(byId.get('fn:internal/store.InsertTransaction')!.meta?.['hosts']).toEqual(
      example.nodes.find((n) => n.id === 'fn:internal/store.InsertTransaction')!.meta?.['hosts'],
    );
    expect(byId.get('fn:internal/store.New')!.meta?.['hosts']).toEqual([
      'infra:lambda_api/api',
      'infra:lambda_api/gmail_webhook',
    ]);
    expect(byId.get('fn:internal/store.New')!.host).toBeUndefined();
    // 入口
    expect(byId.get('fn:cmd/api.main')).toMatchObject({
      host: 'infra:lambda_api/api',
      meta: { entry: 'cmd/api' },
    });
    expect(byId.get('fn:cmd/notify.main')!.host).toBe('infra:lambda_api/notify');
    expect(byId.get('fn:internal/inbound.ServeHTTP')!.host).toBe('infra:lambda_api/gmail_webhook');
  });

  it('口と項目の id が例と同じ（例に無いのは domain.Sum の呼び出しだけ）', () => {
    for (const id of GO_BOXES) {
      const ex = example.nodes.find((n) => n.id === id)!;
      expect(paths(byId.get(id)! as NodeV2).sort(), id).toEqual(
        [...paths(ex), ...(EXTRA_ITEMS[id] ?? [])].sort(),
      );
    }
  });

  it('同じ言語の中の線は（箱, 箱, via, reply）も参照も例と同じ', () => {
    const exp = example.wires.filter(among);
    const got = part.v2!.wires.filter(among);
    expect([...new Set(got.map(tuple))].sort()).toEqual([...new Set(exp.map(tuple))].sort());
    const refs = (w: WireV2) => `${w.from} → ${w.to}`;
    expect(got.map(refs).sort()).toEqual(exp.map(refs).sort());
  });

  it('合流の段が読むもの: handler の meta.route と meta.auth、Encode の out/resp、out/status、meta.sql と in/row', () => {
    const today = byId.get('fn:internal/api.handleToday')!;
    expect(today.meta).toMatchObject({
      route: { method: 'GET', path: '/today' },
      auth: 'login',
      authBy: { fn: 'fn:internal/auth.Middleware', header: 'Authorization', status: 401 },
    });
    const resp = today.ports.find((p) => p.id === 'out')!.items.find((i) => i.id === 'resp')!;
    expect(resp).toMatchObject({
      name: 'resp',
      type: 'map[string]any',
      wireType: 'object',
      meta: { http: 'response' },
    });
    expect(resp.children!.map((c) => [c.id, c.wireType])).toEqual([
      ['total', 'integer'],
      ['entries', 'array'],
    ]);
    const create = byId.get('fn:internal/api.handleCreateTransaction')!;
    expect(create.meta).toMatchObject({
      route: { method: 'POST', path: '/transactions' },
      auth: 'login',
    });
    // 全部のルートが mux 全体を包む middleware の内側（例の POST にも付ける。§7 #11）
    const routes = part.v2!.nodes.filter((n) => n.meta?.['route']);
    expect(routes.map((n) => `${n.id} ${n.meta?.['auth']}`).sort()).toEqual([
      'fn:internal/api.handleCreateTransaction login',
      'fn:internal/api.handleDays login',
      'fn:internal/api.handleDeleteTransaction login',
      'fn:internal/api.handleEntries login',
      'fn:internal/api.handleSubscribe login',
      'fn:internal/api.handleToday login',
      'fn:internal/api.handleUnsubscribe login',
    ]);
    const list = byId.get('fn:internal/store.ListByDate')!;
    expect(list.meta?.['sql']).toMatchObject({
      table: 'transactions',
      op: 'select',
      where: ['occurred_at'],
      read: ['id', 'merchant', 'amount', 'occurred_at'],
      item: 'query_1',
      row: 'row',
    });
    const ex = example.nodes.find((n) => n.id === 'fn:internal/store.ListByDate')!;
    const rowOf = (n: Pick<NodeV2, 'ports'>) =>
      n.ports
        .find((p) => p.id === 'in')!
        .items.find((i) => i.id === 'row')!
        .children!.map((c) => [c.id, c.type, c.wireType, c.typeRef]);
    expect(rowOf(list as NodeV2)).toEqual(rowOf(ex));
    const q = list.ports.find((p) => p.id === 'out')!.items.find((i) => i.id === 'query_1')!;
    expect(q).toMatchObject({ name: 'queryByDate', type: 'SELECT … WHERE occurred_at::date = $1' });
    expect(q.children).toEqual([
      {
        id: 'occurred_at',
        name: 'occurred_at',
        type: 'date',
        wireType: 'datetime',
        typeRef: 'table:transactions',
      },
    ]);
    // links は例と同じ（$1 ← day は exact、Scan が無いので行 → 戻り値は crude、改名の子だけ明示）
    expect(list.links).toEqual(ex.links);
  });

  it('見つかったこと（links）: 例との違いを固定する', () => {
    // handleToday: 合計は domain.Sum の戻り（ret_2）から。起動の link は呼び出しの項目に（例は call_1.day）
    expect(byId.get('fn:internal/api.handleToday')!.links).toEqual([
      { from: 'in/ret_1', to: 'out/call_2.txs', confidence: 'exact' },
      { from: 'in/ret_2', to: 'out/resp.total', confidence: 'exact' },
      { from: 'in/ret_1', to: 'out/resp.entries', confidence: 'exact' },
      { from: 'in/r', to: 'out/call_1', confidence: 'crude' },
    ]);
    // handleCreateTransaction: status は body（起動）と、その前に戻った InsertTransaction（ret_1）から
    expect(byId.get('fn:internal/api.handleCreateTransaction')!.links).toEqual([
      { from: 'in/body', to: 'out/call_1.tx', confidence: 'exact' },
      { from: 'in/body', to: 'out/status', confidence: 'crude' },
      { from: 'in/ret_1', to: 'out/status', confidence: 'crude' },
    ]);
    // InsertTransaction: プレースホルダ 4 つに値 1 つ（`_, _ = insertTx, tx`）なので、フィールドとカラムの名前の照合（crude）
    expect(byId.get('fn:internal/store.InsertTransaction')!.links).toEqual([
      { from: 'in/tx', to: 'out/insert_1', confidence: 'crude' },
      { from: 'in/tx.id', to: 'out/insert_1.id', confidence: 'crude' },
      { from: 'in/tx.merchant', to: 'out/insert_1.merchant', confidence: 'crude' },
      { from: 'in/tx.amount', to: 'out/insert_1.amount', confidence: 'crude' },
      { from: 'in/tx.occurredAt', to: 'out/insert_1.occurred_at', confidence: 'crude' },
      { from: 'in/tx', to: 'out/return', confidence: 'crude' },
    ]);
  });

  it('refs（掃除の付け替え先の手がかり。2026-11-09 8-2b）: 関数がシグネチャと本体で参照する別のパッケージの v1 の箱', () => {
    const refs = part.v2!.refs!;
    // 型だけを使う import（push.Subscription）も参照。関数の呼び出し（s.store.ListByDate）も
    expect(refs['fn:internal/api.handleSubscribe']).toEqual([
      'lib:internal/push',
      'schema:internal/store',
    ]);
    expect(refs['fn:internal/store.SaveSubscription']).toEqual(['lib:internal/push']);
    expect(refs['fn:internal/api.handleToday']).toEqual([
      'type:internal/domain',
      'schema:internal/store',
    ]);
    // 自分のパッケージと標準ライブラリは数えない
    expect(refs['fn:internal/store.New']).toBeUndefined();
    expect(refs['fn:cmd/notify.main']).toBeUndefined();
  });

  it('全体の数（fixture-poly。テストで固定）', () => {
    const v2 = part.v2!;
    let items = 0;
    let unknown = 0;
    for (const n of v2.nodes)
      for (const p of n.ports) {
        const walk = (xs: ItemV2[]) => {
          for (const x of xs) {
            items++;
            if (x.wireType === 'unknown') unknown++;
            if (x.children) walk(x.children);
          }
        };
        walk(p.items);
      }
    const links = v2.nodes.flatMap((n) => n.links ?? []);
    expect({
      boxes: v2.nodes.length,
      items,
      unknown,
      wires: v2.wires.length,
      links: links.length,
      exact: links.filter((l) => l.confidence === 'exact').length,
      types: v2.types?.length,
    }).toEqual({ boxes: 30, items: 242, unknown: 11, wires: 41, links: 75, exact: 30, types: 8 });
  });

  it('性能: helper の解析は 3 秒より十分短く、extract 全体（go run のコンパイルを含む）も上限の中', () => {
    expect(ms).toBeLessThan(60_000);
    const total = log.of('info').find((m) => m.startsWith('go-types: 箱'));
    const helperMs = Number(/、(\d+)ms（module/.exec(total ?? '')?.[1]);
    expect(helperMs).toBeLessThan(3000);
  });
});
