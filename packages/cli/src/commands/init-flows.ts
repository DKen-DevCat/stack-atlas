/**
 * `stack-atlas init-flows <repo> [--out <file>] [--force]`
 *
 * いまのグラフ（build と同じ抽出。スクショは撮らない）から flows.yaml の雛形を書き出す（docs/09 §4 Phase 4-3）。
 * CloudFront → Lambda（Next）→ route の経路が見つかれば、実在するノード ID で
 *   - miss: 利用者 → CDN（MISS）→ Lambda → route →（api client → API Gateway → API Lambda → ハンドラ → テーブル）→ 戻り
 *   - hit:  利用者 → CDN（HIT）→ 利用者（tone: cache-hit）
 *   - invalidate: 管理画面 → … → API → テーブル → revalidatePath → CDN の無効化
 * を作る。経路が無ければ 2 ステップの最小の雛形を書く。ステップの文はプレースホルダ（人が直す前提）。
 */
import {
  AtlasConfigError,
  buildGraph,
  createConsoleLogger,
  getApiMeta,
  getCdktfMeta,
  getDeployApp,
  getNextMeta,
  getRevalidateSeconds,
  isCdnNode,
  loadConfig,
  routePath,
  type Extractor,
  type FlowDefinition,
  type Logger,
  type StackAtlasConfig,
} from '@stack-atlas/core';
import type { Edge, Graph, GraphNode } from '@stack-atlas/schema';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadExtractors } from '../extractors.js';

export interface InitFlowsOptions {
  repo: string;
  /** 書き出し先（既定 <repo>/flows.yaml） */
  out?: string;
  /** 既存のファイルを上書きする */
  force?: boolean;
  log?: Logger;
  /** 抽出器の差し替え（テスト用） */
  extractors?: Extractor[];
}

type Step = [string, string];

interface ApiHop {
  client: GraphNode;
  handler: GraphNode;
  label?: string;
  gateway?: GraphNode;
  host?: GraphNode;
  store?: GraphNode;
}

class GraphIndex {
  readonly byId: Map<string, GraphNode>;
  constructor(readonly graph: Graph) {
    this.byId = new Map(graph.nodes.map((n) => [n.id, n]));
  }
  out(id: string, kind: string): Array<{ edge: Edge; node: GraphNode }> {
    return this.graph.edges
      .filter((e) => e.from === id && e.kind === kind && this.byId.has(e.to))
      .map((edge) => ({ edge, node: this.byId.get(edge.to)! }));
  }
  in(id: string, kind: string): Array<{ edge: Edge; node: GraphNode }> {
    return this.graph.edges
      .filter((e) => e.to === id && e.kind === kind && this.byId.has(e.from))
      .map((edge) => ({ edge, node: this.byId.get(edge.from)! }));
  }
}

const STORE_TYPES = /dynamodb|rds|s3_bucket|elasticache|db_instance/;

/**
 * route から uses をたどって http エッジ（api client → handler）を探す。write=true なら GET 以外。
 * 読み取り（MISS のサーバー描画）では hook はクライアントで動くのでたどらない
 */
function findApiHop(ix: GraphIndex, route: GraphNode, write: boolean): ApiHop | undefined {
  const seen = new Set<string>([route.id]);
  const queue = [route];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const { edge, node: handler } of ix.out(cur.id, 'http')) {
      if (handler.kind !== 'handler') continue;
      const method = getApiMeta(handler)?.method ?? (edge.label ?? '').split(' ')[0] ?? '';
      const isGet = /^(GET|HEAD)$/i.test(method);
      if (write === isGet) continue;
      const hop: ApiHop = { client: cur, handler, label: edge.label };
      hop.host = ix.in(handler.id, 'deploy').find((x) => x.node.kind === 'infra')?.node;
      if (hop.host) {
        hop.gateway = ix
          .in(hop.host.id, 'flow')
          .find((x) => /apigateway|api_gateway/.test(getCdktfMeta(x.node)?.type ?? ''))?.node;
        const targets = ix.out(hop.host.id, 'flow').map((x) => x.node);
        hop.store =
          targets.find((t) => STORE_TYPES.test(getCdktfMeta(t)?.type ?? '')) ?? targets[0];
      }
      return hop;
    }
    for (const { node } of ix.out(cur.id, 'uses')) {
      if (!write && node.kind === 'hook') continue;
      if (!seen.has(node.id)) {
        seen.add(node.id);
        queue.push(node);
      }
    }
  }
  return undefined;
}

/** `/races/[id]` → config.screenshots.routes のサンプル値で `/races/42`（無ければそのまま） */
function samplePath(path: string, config: StackAtlasConfig): string {
  const sample = config.screenshots?.routes?.[path]?.[0];
  if (!sample) return path;
  const values = sample.split('/');
  let i = 0;
  return path.replace(/\[\[?(?:\.\.\.)?[^\]]+\]\]?/g, (m) => values[i++] ?? m);
}

/** http エッジの label（`GET /races, GET /races/{id}`）から、route のパスに近いものを選ぶ */
function pickCall(hop: ApiHop, write: boolean, path?: string): string {
  const parts = (hop.label ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  const api = getApiMeta(hop.handler);
  const want = path?.replace(/\[\[?(?:\.\.\.)?([^\]]+)\]\]?/g, '{$1}');
  return (
    parts.find((p) => want !== undefined && p.endsWith(` ${want}`)) ??
    parts[0] ??
    (api ? `${api.method} ${api.path}` : write ? 'POST' : 'GET')
  );
}

function apiSteps(hop: ApiHop, write: boolean, path?: string): Step[] {
  const call = pickCall(hop, write, path);
  const steps: Step[] = [[hop.client.id, `${call} を呼ぶ（fetch のキャッシュ設定を確認）`]];
  if (hop.gateway) steps.push([hop.gateway.id, `${call} をルーティング`]);
  if (hop.host) steps.push([hop.host.id, 'API ハンドラの Lambda を起動']);
  steps.push([hop.handler.id, write ? '入力を検証して保存' : 'データを取得']);
  if (hop.store) steps.push([hop.store.id, write ? '書き込み' : '結果を返す']);
  return steps;
}

export interface GeneratedFlows {
  defs: FlowDefinition[];
  /** 見つけた経路の説明（ファイル先頭のコメント用） */
  summary: string[];
}

/** グラフから flows.yaml の雛形を作る */
export function generateFlows(graph: Graph, config: StackAtlasConfig = {}): GeneratedFlows {
  const ix = new GraphIndex(graph);
  for (const cdn of graph.nodes.filter(isCdnNode)) {
    const lambda = ix
      .out(cdn.id, 'flow')
      .map((x) => x.node)
      .find(
        (n) =>
          getDeployApp(n) === 'next' ||
          ix.out(n.id, 'deploy').some((d) => d.node.id.startsWith('route:')),
      );
    if (!lambda) continue;
    const routes = ix
      .out(lambda.id, 'deploy')
      .map((x) => x.node)
      .filter((n) => n.id.startsWith('route:'));
    if (!routes.length) continue;

    const actor =
      ix.in(cdn.id, 'flow').find((x) => x.node.kind === 'actor')?.node ??
      graph.nodes.find((n) => n.kind === 'actor');
    const edgeFn = ix.out(cdn.id, 'flow').find((x) => x.node.meta?.edge === true)?.node;

    // MISS の対象: ISR かつ API まで届く route → ISR → 最初の route
    const score = (r: GraphNode) =>
      (getRevalidateSeconds(r) !== undefined ? 2 : 0) + (findApiHop(ix, r, false) ? 1 : 0);
    const missRoute = [...routes].sort((a, b) => score(b) - score(a))[0]!;
    const missPath = samplePath(routePath(missRoute) ?? '/', config);
    const revalidate = getRevalidateSeconds(missRoute);
    const readHop = findApiHop(ix, missRoute, false);

    const start = (text: string): Step[] => (actor ? [[actor.id, text]] : []);
    const end = (text: string): Step[] => (actor ? [[actor.id, text]] : []);

    const miss: Step[] = [
      ...start(`${missPath} をリクエスト`),
      [cdn.id, 'MISS → オリジン（Lambda）へ'],
      [lambda.id, 'Next.js を起動（コールドスタートの可能性）'],
      [missRoute.id, revalidate ? 'ISR キャッシュなし → ページを再生成' : 'ページを生成（SSR）'],
      ...(readHop ? apiSteps(readHop, false, routePath(missRoute)) : []),
      [
        missRoute.id,
        revalidate ? `HTML 完成 → ISR キャッシュに保存（${revalidate}s）` : 'HTML 完成',
      ],
      [cdn.id, 'エッジにキャッシュして返却'],
      ...end('表示（次の人は HIT）'),
    ];
    const hit: Step[] = [
      ...start(`${missPath} をリクエスト`),
      [cdn.id, 'HIT → エッジで即返却'],
      ...end('表示（Lambda 起動ゼロ・DB アクセスゼロ）'),
    ];

    // 無効化の起点: 書き込み API に届く route（force-dynamic / admin を優先）
    const writers = routes
      .map((r) => ({ r, hop: findApiHop(ix, r, true) }))
      .filter((x): x is { r: GraphNode; hop: ApiHop } => x.hop !== undefined)
      .sort((a, b) => adminScore(b.r) - adminScore(a.r));
    const admin = writers[0];
    const invalidate: Step[] = [];
    if (admin) {
      const adminPath = samplePath(routePath(admin.r) ?? '/', config);
      invalidate.push(...start(`管理者が ${adminPath} を開く`), [
        cdn.id,
        `${adminPath} は素通し（CachingDisabled を確認）`,
      ]);
      if (edgeFn) invalidate.push([edgeFn.id, 'viewer-request で認証（キャッシュ判定より前）']);
      invalidate.push(
        [lambda.id, 'Next.js（dynamic SSR）'],
        [admin.r.id, '入稿画面を表示'],
        ...apiSteps(admin.hop, true),
        [admin.r.id, `保存成功 → revalidatePath("${missPath}")`],
      );
    } else {
      invalidate.push(...start('更新を反映したい'), [
        missRoute.id,
        `revalidatePath("${missPath}")`,
      ]);
    }
    invalidate.push(
      [lambda.id, 'ISR キャッシュ破棄（※このインスタンスだけ）'],
      [cdn.id, `CreateInvalidation ${missPath} → 次回は MISS`],
    );

    return {
      defs: [
        { id: 'miss', name: '閲覧 MISS', tone: 'default', steps: miss },
        { id: 'hit', name: '閲覧 HIT', tone: 'cache-hit', steps: hit },
        { id: 'invalidate', name: '更新 → 無効化', tone: 'default', steps: invalidate },
      ],
      summary: [
        `経路: ${[actor?.id, cdn.id, lambda.id, missRoute.id].filter(Boolean).join(' → ')}`,
        readHop
          ? `API: ${[readHop.client.id, readHop.gateway?.id, readHop.host?.id, readHop.handler.id, readHop.store?.id].filter(Boolean).join(' → ')}`
          : 'API: route から http エッジが見つからないので省略',
        admin
          ? `無効化の起点: ${admin.r.id}`
          : '無効化の起点: 書き込み API に届く route が無いので MISS の route を使う',
      ],
    };
  }

  // 経路が無い: 最初のエッジ（無ければ最初のノード）で 2 ステップ
  const e = graph.edges.find((x) => ix.byId.has(x.from) && ix.byId.has(x.to));
  const first = graph.nodes[0];
  const steps: Step[] = e
    ? [
        [e.from, 'ここから始まる（文を書き換える）'],
        [e.to, '次のノード（ステップを足していく）'],
      ]
    : first
      ? [[first.id, 'ここから始まる（文を書き換える）']]
      : [];
  return {
    defs: steps.length ? [{ id: 'example', name: 'フローの例', tone: 'default', steps }] : [],
    summary: [
      'CloudFront → Lambda（Next）→ route の経路が見つからないので、最小の雛形を書きました。',
      'steps の node はグラフに存在する ID にしてください（stack-atlas build で検査されます）。',
    ],
  };
}

function adminScore(r: GraphNode): number {
  return (
    (getNextMeta(r)?.dynamic === 'force-dynamic' ? 2 : 0) + (/admin|manage|cms/i.test(r.id) ? 1 : 0)
  );
}

const q = (s: string) => JSON.stringify(s);

/** FlowDefinition[] を flows.yaml の文字列にする（文字列は JSON 形式の引用で YAML としても正しい） */
export function serializeFlowsYaml(gen: GeneratedFlows, repo?: string): string {
  const lines = [
    '# データフロー定義（stack-atlas init-flows が生成した雛形）。steps は [node, text] の配列（docs/09 §3.2）',
    '# 文はプレースホルダです。実際の挙動に合わせて書き換えてください。',
    ...(repo ? [`# 対象: ${repo}`] : []),
    ...gen.summary.map((s) => `# ${s}`),
    '',
  ];
  if (!gen.defs.length) {
    lines.push(
      '# 例:',
      '# - id: miss',
      '#   name: 閲覧 MISS',
      '#   steps:',
      '#     - [actor:user, "/ をリクエスト"]',
      '[]',
    );
    return `${lines.join('\n')}\n`;
  }
  gen.defs.forEach((d, i) => {
    if (i > 0) lines.push('');
    lines.push(`- id: ${d.id}`, `  name: ${q(d.name)}`);
    if (d.tone) lines.push(`  tone: ${d.tone}`);
    lines.push('  steps:');
    for (const s of d.steps) {
      const [node, text] = Array.isArray(s) ? s : [s.node, s.text];
      lines.push(`    - [${q(node)}, ${q(text)}]`);
    }
  });
  return `${lines.join('\n')}\n`;
}

export async function runInitFlows(opts: InitFlowsOptions): Promise<number> {
  const log = opts.log ?? createConsoleLogger();
  const repo = resolve(opts.repo);
  if (!existsSync(repo) || !statSync(repo).isDirectory()) {
    log.error(`リポジトリ ${repo} がありません`);
    return 2;
  }
  const out = resolve(opts.out ?? join(repo, 'flows.yaml'));
  if (existsSync(out) && !opts.force) {
    log.error(`${out} はすでにあります（上書きするなら --force）`);
    return 1;
  }
  let graph: Graph;
  let config: StackAtlasConfig;
  try {
    config = loadConfig(repo, log);
    const extractors = opts.extractors ?? (await loadExtractors(log, { skip: ['screenshots'] }));
    log.info(`解析中: ${repo}`);
    ({ graph } = await buildGraph({ root: repo, extractors, log, config, commit: false }));
  } catch (e) {
    if (e instanceof AtlasConfigError) {
      log.error(e.message);
      return 2;
    }
    throw e;
  }
  const gen = generateFlows(graph, config);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, serializeFlowsYaml(gen));
  console.log(
    [
      `flows.yaml の雛形を書きました: ${out}`,
      ...gen.summary.map((s) => `  ${s}`),
      `  フロー: ${gen.defs.map((d) => `${d.id}（${d.steps.length} ステップ）`).join('、') || 'なし'}`,
    ].join('\n'),
  );
  return 0;
}
