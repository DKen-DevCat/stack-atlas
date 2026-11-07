// プロトタイプ（prototype/stack-atlas.html）に直書きされているデータを
// graph.json 形式（schema/graph.schema.json）に書き出すスクリプト。
// 使い方: node scripts/export-prototype-data.mjs > examples/race-site.graph.json
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../prototype/stack-atlas.html', import.meta.url), 'utf8');
const data = html.slice(html.indexOf('const LAYERS = ['), html.indexOf('/* ================= storage'));
const screens = html.slice(html.indexOf('const CW=768'), html.indexOf('/* ================= three setup'));

// Canvas の描画呼び出しはすべて無視し、regions だけ回収するためのダミー ctx
const noop = () => {};
const ctx = new Proxy({}, {
  get: (_, k) => k === 'createLinearGradient' ? () => ({ addColorStop: noop })
    : k === 'measureText' ? () => ({ width: 0 }) : noop,
  set: () => true,
});

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(
  data + '\n' + screens +
  '\nthis.out={LAYERS,KIND,NODES,EDGES,CACHE,FLOWS,SCREENS,CW,CH};',
  sandbox,
);
const { LAYERS, NODES, EDGES, CACHE, FLOWS, SCREENS, CW, CH } = sandbox.out;

// ID 規約: <kind>:<識別子>
const PREFIX = { actor: 'actor', infra: 'infra', layout: 'layout', page: 'route', component: 'comp',
  hook: 'hook', lib: 'lib', type: 'type', schema: 'schema', handler: 'handler' };
const LAYER_IDS = ['infra', 'routes', 'components', 'types'];
const idMap = {};
for (const n of NODES) {
  let key = n.id;
  if (n.k === 'page') key = n.name.trim();
  if (n.k === 'layout') key = '/';
  idMap[n.id] = `${PREFIX[n.k]}:${key}`;
}

const graph = {
  $schema: '../schema/graph.schema.json',
  version: 1,
  project: {
    name: 'race-results (sample)',
    description: 'プロトタイプ用の架空構成。Next.js on Lambda + CloudFront + API Gateway + DynamoDB、CDKtf 管理。',
    sources: ['infra/', 'apps/web', 'apps/api', 'packages/types'],
  },
  layers: LAYERS.map((l, i) => ({ id: LAYER_IDS[i], name: l.name, source: l.sub, color: l.color })),
  nodes: NODES.map(n => {
    const node = {
      id: idMap[n.id],
      layer: LAYER_IDS[n.L],
      kind: n.k,
      name: n.name,
    };
    if (n.file && n.file !== '—') node.file = n.file;
    if (n.code) node.code = n.code;
    node.position = { x: n.x, z: n.z };
    const c = CACHE[n.id];
    if (c) {
      node.cache = { tone: c.tone, badge: c.badge, rules: c.rules ?? c.rows.map(([key, value]) => ({ key, value })) };
      if (c.note) node.cache.note = c.note;
    }
    if (SCREENS[n.id]) {
      const R = [];
      SCREENS[n.id](ctx, R);
      node.screen = {
        width: CW, height: CH,
        regions: R.map(r => ({ ref: idMap[r.c], x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) })),
      };
    }
    return node;
  }),
  edges: EDGES.map(e => ({ from: idMap[e.from], to: idMap[e.to], kind: e.kind })),
  flows: Object.entries(FLOWS).map(([id, steps]) => ({
    id,
    name: { miss: '閲覧 MISS', hit: '閲覧 HIT', entry: '入稿→反映' }[id],
    tone: id === 'hit' ? 'cache-hit' : 'default',
    steps: steps.map(([node, text]) => ({ node: idMap[node], text })),
  })),
};

process.stdout.write(JSON.stringify(graph, null, 2) + '\n');
