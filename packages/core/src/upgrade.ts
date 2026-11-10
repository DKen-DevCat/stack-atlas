/**
 * graph.json v1 → v2 の変換（docs/16 §10）。純関数（fs も時刻も触らない）。
 *
 * 既存の 12 抽出器は v1 の部分グラフを出し続け、パイプラインがこれで v2 に揃える（D38）。変換した graph は
 * **箱の単位**: どの箱も口に項目 `_`（name 値、type unknown）を 1 つだけ持ち、線は口の単位で引く。項目まで下げるのは
 * 言語アダプタ（8-2）で、同じ箱 id に口と項目を足すとマージで置き換わる。
 *
 * 決めたこと（docs/16 §10 の表から踏み込んだ所。実装結果は docs/16 §10「実装結果」）:
 * - 箱 id は v1 のまま（メモ・overrides・views の結合キー。§3）。`type:` の箱は `types[]` に移る（id は同じ）
 * - **host の枠**（D42）: 箱が動く・置かれる infra（Lambda / ECS / Cloud Run / Cloud Functions と Aurora / RDS /
 *   DynamoDB）のうち、deploy・schema のエッジで実際に箱を載せているものだけが枠（`ports: []`）。何も載せていない
 *   Lambda などは普通の箱。S3 の静的サイトは枠ではなく配信元の箱
 * - endpoint（OpenAPI の契約）は枠に入れない（8-0 の手組みの v2 と同じ。枠は「関数の」場所）。枠への http は、
 *   その infra が deploy で受け持つ endpoint へ引き直す
 * - 枠に入る flow / http は、枠に直に載っている箱（http で endpoint を受け持つなら endpoint）に引き直す（枠には線を
 *   描けないため）。枠から出る flow は直に載っている関数・helper から引き、画面だけの枠（Next の Lambda）からは引かずに
 *   枠の meta.flows に残す
 * - 枠の中の関数から uses でたどれる helper / fn（Go の import）は、たどれる枠が 1 つならその枠に入れる
 * - 口の形: 利用者・時刻は out だけ、endpoint は in / req / res / out、テーブルは key / read（§5 の口の名前）。
 *   それ以外は in / out
 * - uses は相手で線の種類を変える: 部品・画面へは render（戻りなし）、テーブルへは sql の往復、それ以外は call / return
 * - http は呼び出しと戻り（reply）の対。endpoint → 実装は call / return（8-0 の手組みの v2 と同じ）。infra への http は片道。
 *   コードから cache への http は無効化の呼び出しとして links の無い in/purge で止める
 * - flow は http（時刻・キューからは event）
 * - CloudFront（cache）: 口は in / out に key と value。HIT は in/key → out/value、MISS は通り抜け。オリジン（S3・枠の中の
 *   画面など）からの戻りは in/value へ。S3 から配る画面へは、S3 の前に cache があれば cache の out/value から deliver
 * - runtime: meta.runtime（明示）> host > infra の型 > Go（server）> kind の既定。静的エクスポートの画面はブラウザ
 *   （D42 改訂「画面はブラウザで動く」）。誰からも呼ばれずサーバー側だけを呼ぶ helper は server（Lambda の入口）
 */
import {
  RUNTIMES,
  UPGRADE_GENERATOR,
  type CacheV2,
  type Edge,
  type Graph,
  type GraphNode,
  type GraphV2,
  type ItemV2,
  type LinkV2,
  type NamedType,
  type NodeKindV2,
  type NodeV2,
  type PortV2,
  type Runtime,
  type ScreenV2,
  type ValidationIssue,
  type VariantV2,
  type ViewV2,
  type WireV2,
  type WireVia,
} from '@stack-atlas/schema';
import { getApiMeta } from './meta.js';
import { isPlainObject } from './util.js';

export interface UpgradeOptions {
  /** 変換で落としたもの（`#` を含む id など）の知らせ。v1 の検証で出るもの（参照切れ）は知らせない */
  onIssue?: (issue: ValidationIssue) => void;
}

/** v1 の kind → v2 の kind（docs/16 §4・§10）。infra と schema / db は箱ごとに決め直す（下の関数） */
export const V2_KIND_OF_V1: Readonly<Record<string, NodeKindV2>> = {
  actor: 'actor',
  infra: 'infra',
  page: 'screen',
  layout: 'screen',
  component: 'component',
  hook: 'hook',
  lib: 'helper',
  handler: 'fn',
  endpoint: 'endpoint',
  queue: 'queue',
  cron: 'trigger',
  service: 'infra',
  db: 'table',
  schema: 'table',
  external: 'external',
};

/**
 * v1 の kind → runtime の既定（docs/16 §4 ③・§10）。上から順に優先されるもの（meta.runtime、host、Go、infra の型）は
 * runtimeOf が先に見る。表に無い kind は server
 */
export const RUNTIME_OF_V1: Readonly<Record<string, Runtime>> = {
  actor: 'user',
  cron: 'time',
  page: 'browser',
  layout: 'browser',
  component: 'browser',
  hook: 'browser',
  lib: 'browser',
  handler: 'server',
  endpoint: 'server',
  queue: 'server',
  service: 'server',
  infra: 'server',
  db: 'data',
  schema: 'data',
  external: 'external',
};

/**
 * 語彙に無い v1 の kind（config.kinds で足したもの）→ v1 の既定の層で決める v2 の kind と runtime。
 * 層も既定のものでなければ helper / server
 */
export const UNKNOWN_KIND_BY_LAYER: Readonly<
  Record<string, { kind: NodeKindV2; runtime: Runtime }>
> = {
  infra: { kind: 'infra', runtime: 'server' },
  routes: { kind: 'screen', runtime: 'browser' },
  components: { kind: 'helper', runtime: 'browser' },
  types: { kind: 'helper', runtime: 'server' },
};

/** infra の箱の型ごとの扱い */
export interface InfraProfile {
  /** 表示名（テストと docs 用） */
  name: string;
  kind: NodeKindV2;
  runtime: Runtime;
  /** 箱が動く・置かれる場所になりうる（D42）。実際に箱を載せていれば枠になる */
  host?: 'fn' | 'table';
  /** 静的ファイルの置き場（S3 / GCS）。配る画面があるか cache のオリジンなら edge、そうでなければ data */
  storage?: boolean;
  /** CloudFront Function / Lambda@Edge（cache の脇で動く。オリジンではないので戻りの線を引かない） */
  edgeFn?: boolean;
}

/** Lambda@Edge の名前（`Lambda@Edge`・`lambda_edge`・`cloudfront_lambda_edge` など） */
const LAMBDA_EDGE_NAME = /lambda[\s_-]*@?[\s_-]*edge|@edge/i;

/**
 * infra の型（`meta.infra.type` か `meta.cdktf.type`）と、型が無いとき（手書きの graph）の名前の規則。上から順に最初に合ったもの。
 * 名前の規則は具体的なものを先に置く（CloudFront Function・Lambda@Edge は名前に cloudfront を含みうるので、
 * CloudFront のディストリビューションより前）。`type` の無い行は名前だけで決める（Lambda@Edge の型は aws_lambda_function
 * なので、型があるときは cache の関連付けで決める。infraProfileOf）
 */
export const INFRA_PROFILES: ReadonlyArray<{ type?: RegExp; name: RegExp; profile: InfraProfile }> =
  [
    {
      type: /^aws_cloudfront_function$/,
      name: /cloudfront[\s_-]*functions?(?![a-z])/i,
      profile: { name: 'CloudFront Function', kind: 'infra', runtime: 'edge', edgeFn: true },
    },
    {
      name: LAMBDA_EDGE_NAME,
      profile: { name: 'Lambda@Edge', kind: 'infra', runtime: 'edge', host: 'fn', edgeFn: true },
    },
    {
      type: /^aws_cloudfront_distribution$/,
      name: /cloudfront|\bcdn\b/i,
      profile: { name: 'CloudFront', kind: 'cache', runtime: 'edge' },
    },
    {
      type: /^(aws_lambda_function|google_cloudfunctions2?_function)$/,
      name: /lambda|cloud ?functions?\b/i,
      profile: { name: 'Lambda', kind: 'infra', runtime: 'server', host: 'fn' },
    },
    {
      type: /^(aws_ecs_service|google_cloud_run(_v2)?_service)$/,
      name: /\becs\b|fargate|cloud ?run/i,
      profile: { name: 'ECS / Cloud Run', kind: 'infra', runtime: 'server', host: 'fn' },
    },
    {
      type: /^(aws_dynamodb_table|aws_rds_cluster|aws_rds_cluster_instance|aws_db_instance)$/,
      name: /dynamo|aurora|\brds\b|postgres|mysql/i,
      profile: { name: 'DB', kind: 'infra', runtime: 'data', host: 'table' },
    },
    {
      type: /^(aws_s3_bucket|google_storage_bucket)$/,
      name: /\bs3\b|bucket/i,
      profile: { name: 'S3', kind: 'infra', runtime: 'data', storage: true },
    },
    {
      type: /^(aws_sqs_queue|aws_sns_topic|google_pubsub_topic|google_pubsub_subscription)$/,
      name: /\bsqs\b|\bsns\b|queue|pub\/?sub/i,
      profile: { name: 'キュー', kind: 'queue', runtime: 'server' },
    },
    {
      type: /^(aws_scheduler_schedule|aws_cloudwatch_event_rule)$/,
      name: /scheduler|\bcron\b|eventbridge/i,
      profile: { name: 'スケジューラ', kind: 'trigger', runtime: 'time' },
    },
    {
      type: /^aws_elasticache_/,
      name: /elasticache|redis|memcache/i,
      profile: { name: 'ElastiCache', kind: 'infra', runtime: 'data' },
    },
  ];

const DEFAULT_INFRA: InfraProfile = { name: 'infra', kind: 'infra', runtime: 'server' };

/** infra の箱のリソース型（meta.infra を優先、無ければ meta.cdktf） */
export function infraType(n: Pick<GraphNode, 'meta'>): string | undefined {
  for (const key of ['infra', 'cdktf']) {
    const v = n.meta?.[key];
    if (isPlainObject(v) && typeof v.type === 'string') return v.type;
  }
  return undefined;
}

/**
 * infra の箱の扱い。型があれば型で、無ければ（手書きの graph）id と名前で決める。
 * `edgeAssoc` は cache の関連付け（`*function_association*` のラベルの flow）を受けているか（Lambda@Edge の判定）
 */
export function infraProfileOf(
  n: Pick<GraphNode, 'id' | 'name' | 'meta'>,
  edgeAssoc = false,
): InfraProfile {
  const type = infraType(n);
  const text = `${n.id.replace(/^[a-z]+:/, '')} ${n.name}`;
  let found: InfraProfile | undefined;
  for (const p of INFRA_PROFILES) {
    if (type !== undefined ? !!p.type?.test(type) : p.name.test(text)) {
      found = p.profile;
      break;
    }
  }
  const profile = found ?? DEFAULT_INFRA;
  // Lambda を cache が関連付けていれば Lambda@Edge（エッジで動く）
  if (profile.host === 'fn' && !profile.edgeFn && (edgeAssoc || LAMBDA_EDGE_NAME.test(text))) {
    return { ...profile, name: 'Lambda@Edge', runtime: 'edge', edgeFn: true };
  }
  return profile;
}

/** map のキーの配列に足す（配列を写さない） */
function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const arr = map.get(key);
  if (arr) arr.push(value);
  else map.set(key, [value]);
}

/** v1 の project.generator（あれば残し、v2 の印を足す） */
const generatorOf = (p: Graph['project']) =>
  isPlainObject(p?.generator) ? (p.generator as Record<string, unknown>) : {};

const ITEM_ANY: ItemV2 = { id: '_', name: '値', type: 'unknown', wireType: 'unknown' };
const item = (id: string, name: string, typeRef?: string): ItemV2 => ({
  id,
  name,
  type: 'unknown',
  wireType: 'unknown',
  ...(typeRef ? { typeRef } : {}),
});
const port = (id: string, dir: 'in' | 'out', items: ItemV2[]): PortV2 => ({ id, dir, items });

/** cache の箱の口・分岐・links（docs/16 §6・§7。HIT は折り返し、MISS は通り抜け） */
export const CACHE_PORTS: PortV2[] = [
  port('in', 'in', [item('key', 'key'), item('value', 'value')]),
  port('out', 'out', [item('key', 'key'), item('value', 'value')]),
];
export const CACHE_VARIANTS: VariantV2[] = [{ id: 'hit', name: 'cache hit', default: false }];
export const CACHE_LINKS: LinkV2[] = [
  { from: 'in/key', to: 'out/value', when: { hit: true } },
  { from: 'in/key', to: 'out/key', when: { hit: false } },
  { from: 'in/value', to: 'out/value', when: { hit: false } },
];

/** 箱の役（口の形が違うもの） */
type Shape = 'frame' | 'source' | 'cache' | 'endpoint' | 'table' | 'box';

/** 変換中の箱 */
interface Box {
  v1: GraphNode;
  id: string;
  kind: NodeKindV2;
  shape: Shape;
  profile?: InfraProfile;
  host?: string;
  /** deploy・schema のエッジで直に載っている（uses で受け継いだ枠ではない） */
  direct?: boolean;
  runtime?: Runtime;
  /** テーブルの行型の id（table:<名前>） */
  tableType?: string;
}

/** 線の端（口と項目）。呼ぶ側は send で送って recv で受け、呼ばれる側は recv で受けて send で返す */
interface Ends {
  send?: string;
  recv?: string;
}

const isRuntime = (v: unknown): v is Runtime =>
  typeof v === 'string' && (RUNTIMES as readonly string[]).includes(v);

/** `<接頭辞>:<識別子>` の識別子 */
const idBody = (id: string) => id.slice(id.indexOf(':') + 1);

/** コード由来の箱か（Go か TS の宣言・パッケージ） */
const fromCode = (n: GraphNode) => isPlainObject(n.meta?.go) || isPlainObject(n.meta?.ts);

/** 戻りを返す相手になれる箱（コードの箱）。infra・cache・キュー・時刻・利用者へは片道 */
const CODE_KINDS: ReadonlySet<NodeKindV2> = new Set([
  'screen',
  'component',
  'hook',
  'helper',
  'fn',
  'endpoint',
]);

/** host の枠から uses で枠を受け継ぐ箱（関数・helper。画面・部品・hook はブラウザでも動くので受け継がない） */
const INHERITS_HOST: ReadonlySet<NodeKindV2> = new Set(['fn', 'helper']);

/**
 * graph.json v1 を v2（箱の単位）に変換する。v1 の参照切れ（無い箱へのエッジ）は v1 の検証が報告するので、黙って落とす
 */
export function upgradeGraph(v1: Graph, opts: UpgradeOptions = {}): GraphV2 {
  const onIssue = opts.onIssue ?? (() => {});
  const byId = new Map<string, GraphNode>();
  v1.nodes.forEach((n, i) => {
    if (n.id.includes('#')) {
      onIssue({
        level: 'warning',
        path: `/nodes/${i}/id`,
        message: `ノード ID "${n.id}" は # を含むので graph.json v2 には入れません（v2 の参照は最初の # で箱を切る。docs/16 §3）`,
      });
      return;
    }
    if (!byId.has(n.id)) byId.set(n.id, n);
  });
  const edges = v1.edges.filter((e) => byId.has(e.from) && byId.has(e.to) && e.from !== e.to);
  const edgesFrom = new Map<string, Edge[]>();
  const edgesTo = new Map<string, Edge[]>();
  for (const e of edges) {
    pushTo(edgesFrom, e.from, e);
    pushTo(edgesTo, e.to, e);
  }
  const outOf = (id: string, kind: string) =>
    (edgesFrom.get(id) ?? []).filter((e) => e.kind === kind);
  const inOf = (id: string, kind?: string) =>
    (edgesTo.get(id) ?? []).filter((e) => kind === undefined || e.kind === kind);

  // --- 1. 箱と型に分ける ---
  const typeNodes: GraphNode[] = [];
  const boxes = new Map<string, Box>();
  /** schema のエッジで DB から指されている箱（テーブル） */
  const schemaTargets = new Set(edges.filter((e) => e.kind === 'schema').map((e) => e.to));
  /** cache の関連付け（function_association）を受けている箱（Lambda@Edge の判定） */
  const edgeAssoc = new Set(
    edges
      .filter((e) => e.kind === 'flow' && /function_association/.test(e.label ?? ''))
      .map((e) => e.to),
  );
  for (const n of byId.values()) {
    if (n.kind === 'type') {
      typeNodes.push(n);
      continue;
    }
    // 語彙に無い kind（config.kinds で足したもの）は v1 の層で決める。元の kind は meta.kindV1 に残す
    const kind = V2_KIND_OF_V1[n.kind] ?? UNKNOWN_KIND_BY_LAYER[n.layer]?.kind ?? 'helper';
    const box: Box = { v1: n, id: n.id, kind, shape: 'box' };
    if (n.kind === 'infra') {
      box.profile = infraProfileOf(n, edgeAssoc.has(n.id));
      box.kind = box.profile.kind;
    } else if (n.kind === 'schema') {
      // コードのパッケージを schema に分類したもの（Go の store など）は helper。テーブルは SQL・DB から指されるもの
      const table = isPlainObject(n.meta?.sql) || schemaTargets.has(n.id) || !fromCode(n);
      box.kind = table ? 'table' : 'helper';
    } else if (n.kind === 'db') {
      // 行型（テーブル）を持つ DB は infra（テーブルの枠）、持たなければテーブルそのもの（docs/16 §4）
      const hasTables = outOf(n.id, 'schema').length > 0;
      box.kind = hasTables ? 'infra' : 'table';
      if (hasTables) box.profile = { name: 'DB', kind: 'infra', runtime: 'data', host: 'table' };
    }
    boxes.set(n.id, box);
  }
  const typeIds = new Set(typeNodes.map((n) => n.id));

  // --- 2. host の枠（D42） ---
  /** infra の箱 → deploy で受け持つ endpoint（枠に入れないが、枠への http の引き直し先） */
  const served = new Map<string, Box[]>();
  const hostable = (b: Box | undefined): b is Box => !!b?.profile?.host;
  for (const e of edges) {
    const h = boxes.get(e.from);
    const x = boxes.get(e.to);
    if (!x || !hostable(h)) continue;
    if (e.kind === 'deploy') {
      if (x.kind === 'endpoint') pushTo(served, h.id, x);
      else if (x.host === undefined && x.kind !== 'table') {
        x.host = h.id;
        x.direct = true;
      }
    } else if (e.kind === 'schema' && x.kind === 'table' && h.profile?.host === 'table') {
      if (x.host === undefined) {
        x.host = h.id;
        x.direct = true;
      }
    }
  }
  // 枠の中の関数から uses でたどれる関数・helper は、たどれる枠が 1 つならその枠に入れる（同じバイナリ・同じ関数で動く）
  const reach = new Map<string, Set<string>>();
  for (const b of boxes.values()) {
    if (!b.host || !INHERITS_HOST.has(b.kind)) continue;
    const seen = new Set<string>([b.id]);
    const q = [b.id];
    for (let qi = 0; qi < q.length; qi++) {
      const id = q[qi]!;
      for (const e of outOf(id, 'uses')) {
        const t = boxes.get(e.to);
        if (!t || seen.has(t.id) || !INHERITS_HOST.has(t.kind)) continue;
        if (t.host !== undefined) continue; // deploy で載っている箱はそのまま
        seen.add(t.id);
        q.push(t.id);
        const set = reach.get(t.id) ?? new Set<string>();
        set.add(b.host);
        reach.set(t.id, set);
      }
    }
  }
  for (const [id, hosts] of reach) {
    const b = boxes.get(id)!;
    if (hosts.size === 1) b.host = [...hosts][0]!;
  }
  /** 枠 → 中の箱（宣言順） */
  const members = new Map<string, Box[]>();
  for (const b of boxes.values()) if (b.host) pushTo(members, b.host, b);

  // --- 3. 口の形 ---
  for (const b of boxes.values()) {
    if (members.has(b.id)) b.shape = 'frame';
    else if (b.kind === 'actor' || b.kind === 'trigger') b.shape = 'source';
    else if (b.kind === 'cache') b.shape = 'cache';
    else if (b.kind === 'endpoint') b.shape = 'endpoint';
    else if (b.kind === 'table') b.shape = 'table';
  }
  const tableTypeIds = new Set<string>();
  for (const b of boxes.values()) {
    if (b.shape !== 'table') continue;
    const sql = b.v1.meta?.sql;
    const name = isPlainObject(sql) && typeof sql.table === 'string' ? sql.table : idBody(b.id);
    let id = `table:${name}`;
    for (let k = 2; tableTypeIds.has(id) || typeIds.has(id); k++) id = `table:${name}_${k}`;
    tableTypeIds.add(id);
    b.tableType = id;
  }

  // --- 4. runtime（docs/16 §4 の優先順） ---
  /** cache のオリジン（cache → X の flow の先） */
  const cacheOrigins = new Set(
    edges.filter((e) => e.kind === 'flow' && boxes.get(e.from)?.shape === 'cache').map((e) => e.to),
  );
  const fixedRuntime = (b: Box): Runtime | undefined => {
    const explicit = b.v1.meta?.runtime;
    if (isRuntime(explicit)) return explicit;
    if (b.host) return boxes.get(b.host)?.profile?.runtime ?? 'server';
    if (b.profile) {
      if (b.profile.storage) {
        const delivers = outOf(b.id, 'deploy').length > 0 || cacheOrigins.has(b.id);
        return delivers ? 'edge' : 'data';
      }
      return b.profile.runtime;
    }
    if (isPlainObject(b.v1.meta?.go)) return 'server';
    if (b.kind === 'table') return 'data';
    // コードのパッケージを schema に分類したもの（テーブルでない）はサーバー側のコード
    if (b.v1.kind === 'schema') return 'server';
    const base = RUNTIME_OF_V1[b.v1.kind] ?? UNKNOWN_KIND_BY_LAYER[b.v1.layer]?.runtime;
    return base === 'browser' ? undefined : (base ?? 'server');
  };
  for (const b of boxes.values()) {
    const r = fixedRuntime(b);
    if (r !== undefined) b.runtime = r;
  }
  // 既定が browser の箱: 誰からも呼ばれず、呼ぶ先が全部サーバー側なら server（Lambda の入口のファイルなど）
  for (const b of boxes.values()) {
    if (b.runtime !== undefined) continue;
    const callees = outOf(b.id, 'uses')
      .map((e) => boxes.get(e.to))
      .filter((t): t is Box => !!t);
    const serverSide = (t: Box) => t.runtime === 'server' || t.runtime === 'data';
    const entry =
      b.kind === 'helper' &&
      inOf(b.id).length === 0 &&
      callees.length > 0 &&
      callees.every(serverSide);
    b.runtime = entry ? 'server' : 'browser';
  }

  // --- 5. 線 ---
  const wires: WireV2[] = [];
  const wireAt = new Map<string, WireV2>();
  const addWire = (
    from: string | undefined,
    to: string | undefined,
    via: WireVia,
    extra: Partial<WireV2> = {},
  ) => {
    if (!from || !to || from.startsWith(`${to.split('#')[0]}#`)) return;
    const key = `${from}\u0000${to}`;
    const had = wireAt.get(key);
    if (had) {
      // 同じ種類の線どうしならラベルを補う（flow の属性名を sql の線に付けない）
      if (!had.label && extra.label && had.via === via) had.label = extra.label;
      return;
    }
    const w: WireV2 = { from, to, via, ...extra };
    wireAt.set(key, w);
    wires.push(w);
  };
  const ref = (b: Box, portId: string, itemId = '_') => `${b.id}#${portId}/${itemId}`;
  /** 呼ぶ側の端（送る・受ける） */
  const caller = (b: Box): Ends => {
    switch (b.shape) {
      case 'source':
        return { send: ref(b, 'out') };
      case 'cache':
        return { send: ref(b, 'out', 'key'), recv: ref(b, 'in', 'value') };
      case 'endpoint':
        return { send: ref(b, 'req'), recv: ref(b, 'res') };
      case 'table':
        return { send: ref(b, 'read') };
      case 'frame':
        return {};
      default:
        return { send: ref(b, 'out'), recv: ref(b, 'in') };
    }
  };
  /** 呼ばれる側の端（受ける・返す） */
  const callee = (b: Box): Ends => {
    switch (b.shape) {
      case 'source':
        return { send: ref(b, 'out') };
      case 'cache':
        return { recv: ref(b, 'in', 'key'), send: ref(b, 'out', 'value') };
      case 'endpoint':
        return { recv: ref(b, 'in'), send: ref(b, 'out') };
      case 'table':
        return { recv: ref(b, 'key'), send: ref(b, 'read') };
      case 'frame':
        return {};
      default:
        return { recv: ref(b, 'in'), send: ref(b, 'out') };
    }
  };
  const isFrame = (b: Box) => b.shape === 'frame';
  /** 枠へ向かう線の引き直し先。http なら受け持つ endpoint、無ければ直に載っている箱（uses で枠を受け継いだ箱は入口ではない） */
  const targetsOf = (b: Box, kind: string): Box[] => {
    if (!isFrame(b)) return [b];
    const eps = served.get(b.id) ?? [];
    if (kind === 'http' && eps.length) return eps;
    return (members.get(b.id) ?? []).filter((m) => m.direct);
  };
  /**
   * 枠から出る線の引き直し元: 直に載っている関数・helper（Go の main パッケージ、Lambda のハンドラ）。
   * 画面だけを載せた枠（Next の Lambda）からは引かない: 環境変数の参照（API_BASE_URL など）を全部の画面から引くと、
   * どのハンドラの上流にも全部の画面が入る（2026-11-09 の確認）。引かなかった flow は枠の meta.flows に残す
   */
  const sourcesOf = (b: Box): Box[] => {
    if (!isFrame(b)) return [b];
    return (members.get(b.id) ?? []).filter((m) => m.direct && INHERITS_HOST.has(m.kind));
  };
  /** 枠 → 線にしなかった flow（to と label） */
  const unwired = new Map<string, { to: string; label?: string }[]>();
  const usedBy = new Map<string, string[]>();
  const addUsedBy = (typeId: string, by: string) => {
    const list = usedBy.get(typeId) ?? [];
    if (!list.includes(by)) list.push(by);
    usedBy.set(typeId, list);
  };

  const onUses = (e: Edge) => {
    if (typeIds.has(e.to)) return addUsedBy(e.to, e.from);
    const a = boxes.get(e.from);
    const b = boxes.get(e.to);
    if (!a || !b) return;
    for (const s of sourcesOf(a))
      for (const t of targetsOf(b, 'uses')) {
        if (s === t) continue;
        const c = caller(s);
        const d = callee(t);
        if (t.shape === 'table') {
          addWire(c.send, d.recv, 'sql');
          addWire(d.send, c.recv, 'sql', { reply: true });
        } else if (t.kind === 'component' || t.kind === 'screen') {
          addWire(c.send, d.recv, 'render');
        } else {
          addWire(c.send, d.recv, 'call');
          if (CODE_KINDS.has(t.kind)) addWire(d.send, c.recv, 'return', { reply: true });
        }
      }
  };
  /** コードから無効化の呼び出しを受ける cache（in/purge を足す） */
  const purged = new Set<string>();
  const onHttp = (e: Edge) => {
    const a = boxes.get(e.from);
    const b = boxes.get(e.to);
    if (!a || !b) return;
    const label = e.label ? { label: e.label } : {};
    for (const s of sourcesOf(a))
      for (const t of targetsOf(b, 'http')) {
        if (s === t) continue;
        const c = caller(s);
        const d = callee(t);
        if (t.shape === 'cache' && CODE_KINDS.has(s.kind)) {
          // コードから cache への http は無効化（invalidation）の API 呼び出し。キャッシュの要求ではないので、
          // links の無い in/purge で止める（in/key に入れると MISS で全部のオリジンへ広がる。2026-11-09 の確認）
          purged.add(t.id);
          addWire(c.send, ref(t, 'in', 'purge'), 'http', label);
        } else if (s.shape === 'endpoint') {
          // 契約 → 実装: フレームワークが実装を呼び、戻りを契約の res へ（8-0 の手組みの v2 と同じ）
          addWire(c.send, d.recv, 'call', label);
          if (CODE_KINDS.has(t.kind)) addWire(d.send, c.recv, 'return', { reply: true });
        } else {
          addWire(c.send, d.recv, 'http', label);
          if (CODE_KINDS.has(t.kind)) addWire(d.send, c.recv, 'http', { reply: true });
        }
      }
  };
  const onSchema = (e: Edge) => {
    const a = boxes.get(e.from);
    const t = boxes.get(e.to);
    if (!a || !t || t.host === a.id) return;
    for (const s of sourcesOf(a)) addWire(caller(s).send, callee(t).recv, 'sql');
  };
  /** S3 の前にいる cache（cache → S3 の flow の元） */
  const cachesInFront = (b: Box) =>
    inOf(b.id, 'flow')
      .map((e) => boxes.get(e.from))
      .filter((c): c is Box => c?.shape === 'cache');
  const onDeploy = (e: Edge) => {
    const h = boxes.get(e.from);
    const x = boxes.get(e.to);
    if (!h || !x || x.host === h.id) return;
    if (x.kind === 'endpoint' && isFrame(h) && served.get(h.id)?.includes(x)) return;
    if (isFrame(h)) {
      // 線にしない理由は箱ごとに違う: テーブルは deploy では枠に入れない（DB からの schema で入る）。ほかは別の枠に載っている
      const why =
        x.kind === 'table'
          ? 'テーブルで、deploy では枠に入れません（テーブルは DB からの schema のエッジで枠に入る）'
          : x.host !== undefined
            ? `別の枠（${x.host}）に載っています`
            : '枠に入れられません';
      onIssue({
        level: 'warning',
        path: `edge:${e.from}->${e.to}`,
        message: `"${x.id}" は${why}。deploy "${h.id}" → "${x.id}" は線にしません`,
      });
      return;
    }
    if (h.profile?.storage) {
      const fronts = cachesInFront(h);
      if (fronts.length) {
        // 配信元の前に cache があれば、cache が画面へ配る（HIT でも画面以下が光る。D42 改訂）
        for (const c of fronts)
          addWire(ref(c, 'out', 'value'), callee(x).recv, 'deliver', { reply: true });
      } else addWire(caller(h).send, callee(x).recv, 'deliver');
      return;
    }
    addWire(caller(h).send, callee(x).recv, 'http');
  };
  const onFlow = (e: Edge) => {
    const a = boxes.get(e.from);
    const b = boxes.get(e.to);
    if (!a || !b) return;
    // 時刻・キューからは event、それ以外（インフラどうし・利用者から）は http（docs/16 §4）
    const via: WireVia = a.kind === 'trigger' || a.kind === 'queue' ? 'event' : 'http';
    const label = e.label ? { label: e.label } : {};
    // エッジの関数（CloudFront Function・Lambda@Edge）かは、枠の中の箱へ引き直す前の箱で決める（コードを載せた
    // Lambda@Edge は枠になり、引き直し先の箱は profile を持たない）
    const edgeFn = !!b.profile?.edgeFn;
    const sources = sourcesOf(a);
    if (!sources.length && isFrame(a)) {
      const list = unwired.get(a.id) ?? [];
      list.push({ to: e.to, ...label });
      unwired.set(a.id, list);
    }
    for (const s of sources)
      for (const t of targetsOf(b, 'flow')) {
        if (s === t) continue;
        const d = callee(t);
        addWire(caller(s).send, d.recv, via, label);
        // cache → オリジン: オリジンの戻りは cache の in/value へ（エッジの関数は脇で動くので戻さない）
        if (s.shape === 'cache' && !edgeFn && t.shape !== 'source') {
          addWire(d.send, ref(s, 'in', 'value'), t.profile?.storage ? 'deliver' : 'http', {
            reply: true,
          });
        }
      }
  };
  // コードの関係（uses / http / schema）を先に引く。同じ (from, to) は先に引いた線の種類が残る（sql が http に勝つ）
  for (const e of edges) {
    if (e.kind === 'uses') onUses(e);
    else if (e.kind === 'http') onHttp(e);
    else if (e.kind === 'schema') onSchema(e);
  }
  for (const e of edges) if (e.kind === 'deploy') onDeploy(e);
  for (const e of edges) if (!['uses', 'http', 'schema', 'deploy'].includes(e.kind)) onFlow(e);

  // --- 6. 箱 ---
  const nodes: NodeV2[] = [];
  for (const b of boxes.values()) nodes.push(toNodeV2(b));

  // --- 7. 型（v1 の type: の箱 ＋ テーブルの行型） ---
  const allFiles = v1.nodes.map((n) => n.file).filter((f): f is string => !!f);
  const types: NamedType[] = typeNodes.map((n) => toNamedType(n, usedBy.get(n.id), allFiles));
  for (const b of boxes.values()) {
    if (!b.tableType) continue;
    const t: NamedType = { id: b.tableType, name: b.tableType.slice('table:'.length) };
    if (b.v1.file) t.file = b.v1.file;
    if (b.v1.line) t.line = b.v1.line;
    t.source = isPlainObject(b.v1.meta?.sql)
      ? 'sql'
      : isPlainObject(b.v1.meta?.ts)
        ? 'typescript'
        : 'schema';
    types.push(t);
  }

  // --- 8. views（flows の置き換え。docs/15 §3.9） ---
  const views: ViewV2[] = [];
  /** view の始点にする箱。枠（口が無く線も無い）は、直に載っている最初の箱（無ければ受け持つ endpoint） */
  const entryOf = (b: Box): string => {
    if (!isFrame(b)) return b.id;
    const direct = (members.get(b.id) ?? []).find((m) => m.direct);
    return direct?.id ?? served.get(b.id)?.[0]?.id ?? b.id;
  };
  for (const f of v1.flows ?? []) {
    const first = f.steps.map((s) => boxes.get(s.node)).find((b): b is Box => !!b);
    if (!first) continue;
    const start = entryOf(first);
    const view: ViewV2 = { id: f.id, name: f.name, start };
    const caches = [...new Set(f.steps.map((s) => s.node))].filter(
      (id) => boxes.get(id)?.shape === 'cache',
    );
    if (caches.length) {
      view.variants = Object.fromEntries(caches.map((id) => [`${id}#hit`, f.tone === 'cache-hit']));
    }
    views.push(view);
  }

  // フィールドの順は graph.json v2 の慣例（version, project, types, nodes, wires, views）。
  // project.generator.v2 は「v1 から変換した箱の単位の graph」の印（ビューアが箱の単位で必ず出る警告を畳む。docs/16 §10）
  const out: GraphV2 = {
    version: 2,
    project: { ...v1.project, generator: { ...generatorOf(v1.project), v2: UPGRADE_GENERATOR } },
    ...(types.length ? { types } : {}),
    nodes,
    wires,
    ...(views.length ? { views } : {}),
  };
  return out;

  function toNodeV2(b: Box): NodeV2 {
    const n = b.v1;
    const node: NodeV2 = {
      id: b.id,
      kind: b.kind,
      name: n.name,
      runtime: b.runtime ?? 'server',
      ...(n.file ? { file: n.file } : {}),
      ...(n.line ? { line: n.line } : {}),
      ...(n.code ? { code: n.code } : {}),
      ...(b.host ? { host: b.host } : {}),
      ports: portsOf(b),
    };
    if (b.shape === 'cache') {
      node.links = CACHE_LINKS.map((l) => ({ ...l, when: { ...l.when } }));
      node.variants = CACHE_VARIANTS.map((v) => ({ ...v }));
    }
    if (n.cache) node.cache = structuredClone(n.cache) as CacheV2;
    if (n.screen) {
      // screen はそのまま写す（v1 と v2 で同じ形。html / source は 8-3b の screens 抽出器が出す。docs/18 §3.3）。
      // source の無いスクショだけの画面は、従来どおり source: screenshot にする
      const screen = structuredClone(n.screen) as ScreenV2;
      if (!screen.source && screen.screenshot && !screen.html) screen.source = 'screenshot';
      node.screen = screen;
    }
    const meta: Record<string, unknown> = n.meta ? structuredClone(n.meta) : {};
    if (!(n.kind in V2_KIND_OF_V1)) meta.kindV1 = n.kind;
    const flows = unwired.get(b.id);
    if (flows) meta.flows = flows;
    const api = getApiMeta(n);
    if (b.kind === 'fn' && api && meta.route === undefined)
      meta.route = `${api.method} ${api.path}`;
    if (Object.keys(meta).length) node.meta = meta;
    return node;
  }

  function portsOf(b: Box): PortV2[] {
    switch (b.shape) {
      case 'frame':
        return [];
      case 'source':
        return [port('out', 'out', [{ ...ITEM_ANY }])];
      case 'cache': {
        const ports = structuredClone(CACHE_PORTS);
        if (purged.has(b.id)) ports[0]!.items.push(item('purge', 'purge'));
        return ports;
      }
      case 'endpoint':
        return [
          port('in', 'in', [{ ...ITEM_ANY }]),
          port('req', 'out', [{ ...ITEM_ANY }]),
          port('res', 'in', [{ ...ITEM_ANY }]),
          port('out', 'out', [{ ...ITEM_ANY }]),
        ];
      case 'table':
        return [
          port('key', 'in', [{ ...ITEM_ANY, typeRef: b.tableType! }]),
          port('read', 'out', [{ ...ITEM_ANY, typeRef: b.tableType! }]),
        ];
      default:
        return [port('in', 'in', [{ ...ITEM_ANY }]), port('out', 'out', [{ ...ITEM_ANY }])];
    }
  }
}

/**
 * v1 の type: の箱 → types[] の 1 件。OpenAPI にもある型は契約側を正にする（D37）: file を OpenAPI のファイルにし、
 * 元の場所を meta.copies に残す
 */
function toNamedType(n: GraphNode, usedBy: string[] | undefined, files: string[]): NamedType {
  const t: NamedType = { id: n.id, name: n.name };
  const meta: Record<string, unknown> = n.meta ? structuredClone(n.meta) : {};
  const openapi = n.meta?.openapi;
  const openapiFile =
    isPlainObject(openapi) && typeof openapi.file === 'string' ? openapi.file : undefined;
  const here = n.file ? `${n.file}${n.line ? `:${n.line}` : ''}` : undefined;
  if (openapiFile) {
    t.source = 'openapi';
    // 複数 repo では node.file は `<repo>/<path>`、meta.openapi.file は repo 相対。同じファイルを指す node.file を探す
    const qualified = files.find((f) => f === openapiFile || f.endsWith(`/${openapiFile}`));
    if (qualified && qualified !== n.file) {
      t.file = qualified;
      if (here) meta.copies = [here];
    } else {
      if (n.file) t.file = n.file;
      if (n.line) t.line = n.line;
    }
  } else {
    if (n.file) t.file = n.file;
    if (n.line) t.line = n.line;
    if (isPlainObject(n.meta?.sql)) t.source = 'sql';
    else if (isPlainObject(n.meta?.go)) t.source = 'go';
    else if (isPlainObject(n.meta?.ts)) t.source = 'typescript';
  }
  if (n.code) meta.code = n.code;
  if (usedBy?.length) meta.usedBy = usedBy;
  if (Object.keys(meta).length) t.meta = meta;
  return t;
}
