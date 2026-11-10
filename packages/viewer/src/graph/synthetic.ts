/**
 * テスト用: 実プロジェクトに近い形の合成 graph（既定 250 ノード・4 層）を作る。
 * 決定的（シード付き乱数）。本体からは import しない（単体テストと e2e が使う）。
 */
import type { Edge, Graph, GraphNode } from '@stack-atlas/schema';

export interface SyntheticCounts {
  infra: number;
  routes: number;
  components: number;
  types: number;
}

export const SYNTHETIC_250: SyntheticCounts = { infra: 22, routes: 14, components: 120, types: 94 };

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const WORDS = [
  'Budget',
  'Transaction',
  'Today',
  'Spend',
  'Dashboard',
  'Entry',
  'Subscription',
  'Report',
  'Account',
  'Category',
  'Summary',
  'Push',
  'Daily',
  'Monthly',
  'Settings',
  'Profile',
  'Invoice',
  'Payment',
  'Export',
  'Import',
];
const SUFFIX = ['Card', 'List', 'Table', 'Form', 'Chart', 'Panel', 'Island', 'Skeleton', 'Row'];
const INFRA = [
  'CloudFront',
  'S3 site',
  'Lambda: api',
  'Lambda: webhook',
  'Lambda: notify',
  'Lambda: ops',
  'Lambda: migrate',
  'CloudFront Function rewrite-index',
  'Secret app/gmail',
  'Secret app/vapid',
  'Secret app/database-url',
  'Scheduler daily-summary',
  'Scheduler gmail-watch-renew',
  'Cognito app-users',
  'ECR app-api',
  'Aurora app-db',
  'SQS app-events',
  'SNS app-alerts',
  'Route53 app.example.com',
  'ACM app.example.com',
  'WAF app-acl',
  'EventBridge app-bus',
];
const ROUTES = [
  '/',
  '/dashboard',
  '/callback',
  '/push',
  '/settings',
  '/reports',
  '/reports/[id]',
  '/accounts',
  '/accounts/[id]',
  '/budget',
  '/entries',
  '/entries/new',
  '/login',
  '/export',
];

export function makeSyntheticGraph(counts: SyntheticCounts = SYNTHETIC_250, seed = 42): Graph {
  const r = rng(seed);
  const pick = <T>(a: readonly T[]): T => a[Math.floor(r() * a.length)]!;
  const nodes: GraphNode[] = [];
  const edges: Edge[] = [];
  const seenEdge = new Set<string>();
  const edge = (from: string, to: string, kind: string) => {
    const k = `${from}|${to}|${kind}`;
    if (from === to || seenEdge.has(k)) return;
    seenEdge.add(k);
    edges.push({ from, to, kind });
  };
  // i ごとに一意な名前（WORDS の周期 20 を超えても衝突しない）
  const words = (i: number): string => {
    const a = WORDS[i % WORDS.length]!;
    const b = Math.floor(i / WORDS.length);
    if (b === 0) return a;
    return `${a}${WORDS[(b * 7) % WORDS.length]}${b >= WORDS.length ? b : ''}`;
  };

  // ---- L0 インフラ ----
  const infra: string[] = [];
  nodes.push({ id: 'actor:browser', layer: 'infra', kind: 'actor', name: 'Browser' });
  infra.push('actor:browser');
  for (let i = 0; i < counts.infra - 1; i++) {
    const name = INFRA[i % INFRA.length]! + (i >= INFRA.length ? ` ${i}` : '');
    const id = `infra:${i}`;
    nodes.push({ id, layer: 'infra', kind: 'infra', name, file: `infra/stack.ts` });
    infra.push(id);
  }
  const lambdas = infra.filter((id) => /Lambda/.test(nodes.find((n) => n.id === id)!.name));
  edge('actor:browser', 'infra:0', 'http');
  for (let i = 1; i < infra.length; i++) if (r() < 0.6) edge(pick(infra), infra[i]!, 'uses');

  // ---- L1 画面 ----
  const routes: string[] = [];
  for (let i = 0; i < counts.routes; i++) {
    const p = ROUTES[i % ROUTES.length]! + (i >= ROUTES.length ? `/${i}` : '');
    const id = `route:${p}`;
    nodes.push({
      id,
      layer: 'routes',
      kind: i === 0 ? 'layout' : 'page',
      name: p,
      file: `web/app${p === '/' ? '' : p}/page.tsx`,
    });
    routes.push(id);
    edge(lambdas[0] ?? 'infra:0', id, 'deploy');
  }

  // ---- L2 コンポーネント・hooks・lib ----
  const comps: string[] = [];
  const hooks: string[] = [];
  const libs: string[] = [];
  const nComp = Math.round(counts.components * 0.5);
  const nHook = Math.round(counts.components * 0.17);
  for (let i = 0; i < counts.components; i++) {
    let kind: string;
    let name: string;
    if (i < nComp) {
      kind = 'component';
      name = `${words(i)}${SUFFIX[i % SUFFIX.length]}`;
    } else if (i < nComp + nHook) {
      kind = 'hook';
      name = `use${words(i)}`;
    } else {
      kind = 'lib';
      name = `internal/${words(i).toLowerCase()}`;
    }
    const id = `${kind}:${name}`;
    nodes.push({ id, layer: 'components', kind, name, file: `web/src/${kind}s/${name}.ts` });
    (kind === 'component' ? comps : kind === 'hook' ? hooks : libs).push(id);
  }
  for (const rt of routes) {
    const k = 4 + Math.floor(r() * 5);
    for (let j = 0; j < k; j++) edge(rt, pick(comps), 'uses');
  }
  for (const c of comps) {
    const k = 1 + Math.floor(r() * 3);
    for (let j = 0; j < k; j++) edge(c, pick(r() < 0.5 ? hooks : libs), 'uses');
    if (r() < 0.3) edge(c, pick(comps), 'uses');
  }
  for (const hk of hooks) edge(hk, pick(libs), 'uses');

  // ---- L3 型・API ----
  const types: string[] = [];
  const handlers: string[] = [];
  const endpoints: string[] = [];
  const schemas: string[] = [];
  const nHandler = Math.round(counts.types * 0.13);
  const nEndpoint = Math.round(counts.types * 0.13);
  const nSchema = Math.round(counts.types * 0.1);
  for (let i = 0; i < counts.types; i++) {
    let kind: string;
    let name: string;
    if (i < nHandler) {
      kind = 'handler';
      name = `cmd/${words(i).toLowerCase()}`;
    } else if (i < nHandler + nEndpoint) {
      kind = 'endpoint';
      name = `${pick(['GET', 'POST', 'DELETE'])} /api/${words(i).toLowerCase()}`;
    } else if (i < nHandler + nEndpoint + nSchema) {
      kind = 'schema';
      name = `${words(i).toLowerCase()}s`;
    } else {
      kind = 'type';
      name = `${words(i)}${pick(['Response', 'Request', 'Data', 'Props', ''])}`;
    }
    const id = `${kind}:${name}:${i}`;
    nodes.push({ id, layer: 'types', kind, name, file: `api/${kind}/${i}.ts` });
    (kind === 'handler'
      ? handlers
      : kind === 'endpoint'
        ? endpoints
        : kind === 'schema'
          ? schemas
          : types
    ).push(id);
  }
  for (const c of [...comps, ...hooks]) {
    const k = Math.floor(r() * 3);
    for (let j = 0; j < k; j++) edge(c, pick(types), 'uses');
  }
  for (const l of libs) if (r() < 0.6) edge(l, pick(endpoints), 'http');
  endpoints.forEach((e, i) => edge(e, handlers[i % handlers.length]!, 'uses'));
  for (const hd of handlers) {
    edge(pick(lambdas.length ? lambdas : infra), hd, 'deploy');
    edge(hd, pick(schemas), 'schema');
    edge(hd, pick(types), 'uses');
  }

  return {
    version: 1,
    project: { name: `synthetic-${nodes.length}`, sources: ['synthetic'] },
    layers: [
      { id: 'infra', name: 'インフラ', color: '#ff9f43', source: 'cdktf' },
      { id: 'routes', name: '画面・ルート', color: '#4f8cff', source: 'next app/' },
      { id: 'components', name: 'コンポーネント・hooks', color: '#a78bfa', source: 'web/src' },
      { id: 'types', name: '型・APIハンドラ', color: '#4ade80', source: 'api' },
    ],
    nodes,
    edges,
    flows: [
      {
        id: 'view',
        name: '閲覧',
        tone: 'default',
        steps: [
          { node: 'actor:browser', text: 'ブラウザがアクセス' },
          { node: 'infra:0', text: 'CloudFront' },
          { node: routes[1]!, text: 'ページを描画' },
        ],
      },
    ],
  } as Graph;
}
