// 差分（docs/18 §3.4）のテスト用: 例の v2（examples/fixture-poly.today.v2.json）を写して「前の graph」を作る。
// 単体テスト（diff.test.ts）とビューアの e2e（wiring-views.spec.ts）が同じ前の graph を使う
import type { GraphV2, NodeV2 } from '@stack-atlas/schema';

/** 前の graph で変えたこと（今の graph から見た印） */
export const PREV_EDITS = {
  /** 前に無かった箱（今だけ = 緑の縁）。前の graph から箱と線を消した */
  addedNode: 'comp:TotalCard',
  /** 前にしか無い箱（幽霊）。前の graph に足した */
  ghostNode: 'fn:legacyFormat',
  /** 前にしか無い箱で、host が今の host の枠（残る） */
  ghostInHost: 'fn:internal/store.LegacyQuery',
  /** 前にしか無い箱で、host が今は枠でない箱（外す。今の箱が枠に変わらないように） */
  ghostBadHost: 'fn:orphanChild',
  /** 前にしか無い画面の箱（HTML を外す） */
  ghostScreen: 'route:/old',
  /** 今もある箱の中の、前にしか無い項目（灰の点線の行） */
  removedItem: 'fn:getToday#out/legacy',
  /** 今もある箱の、前にしか無い口の項目 */
  removedPortItem: 'lib:fetcher#err/e',
  /** type / wireType が変わった項目（緑の縁） */
  changedItem: 'fn:getToday#in/call',
  /** 前に無かった線（今の項目どうし。緑の縁） */
  addedWire: { from: 'comp:TodayIsland#out/render_2.entries', to: 'comp:EntryList#in/entries' },
  /** 前にしか無い線（今の項目どうし。幽霊） */
  ghostWire: { from: 'fn:toTodayView#out/return', to: 'comp:EntryList#in/entries' },
} as const;

const fn = (id: string, extra: Partial<NodeV2> = {}): NodeV2 => ({
  id,
  kind: 'fn',
  name: id.slice(id.indexOf(':') + 1),
  runtime: 'browser',
  ports: [
    { id: 'in', dir: 'in', items: [{ id: 'x', name: 'x', type: 'string', wireType: 'string' }] },
    {
      id: 'out',
      dir: 'out',
      items: [{ id: 'return', name: 'return', type: 'string', wireType: 'string' }],
    },
  ],
  ...extra,
});

/** 今の graph（例の v2）から前の graph を作る（今の graph は変えない） */
export function prevOfToday(next: GraphV2): GraphV2 {
  const g = structuredClone(next);
  const E = PREV_EDITS;
  g.nodes = g.nodes.filter((n) => n.id !== E.addedNode);
  g.wires = g.wires.filter(
    (w) => !w.from.startsWith(`${E.addedNode}#`) && !w.to.startsWith(`${E.addedNode}#`),
  );
  g.nodes.push(
    fn(E.ghostNode),
    fn(E.ghostInHost, { runtime: 'server', host: 'infra:lambda_api/api' }),
    fn(E.ghostBadHost, { host: 'comp:EntryList' }),
    {
      id: E.ghostScreen,
      kind: 'screen',
      name: '/old',
      runtime: 'browser',
      screen: { html: 'screens/old.html', width: 1280, height: 800 },
      ports: [{ id: 'in', dir: 'in', items: [{ id: 'html', name: 'html', type: 'string' }] }],
    },
  );
  const getToday = g.nodes.find((n) => n.id === 'fn:getToday')!;
  getToday.ports
    .find((p) => p.id === 'out')!
    .items.push({ id: 'legacy', name: 'legacy', type: 'string', wireType: 'string' });
  const call = getToday.ports.find((p) => p.id === 'in')!.items.find((i) => i.id === 'call')!;
  call.type = 'unknown';
  call.wireType = 'unknown';
  g.nodes
    .find((n) => n.id === 'lib:fetcher')!
    .ports.push({
      id: 'err',
      dir: 'out',
      items: [{ id: 'e', name: 'e', type: 'Error', wireType: 'unknown' }],
    });
  // 今の線を 1 本消す（今だけ = 緑）、前にしか無い線を足す（幽霊）。解けない線は足さない
  g.wires = g.wires.filter((w) => !(w.from === E.addedWire.from && w.to === E.addedWire.to));
  g.wires.push(
    { ...E.ghostWire, via: 'render' },
    {
      from: 'fn:toTodayView#out/return',
      to: `${E.ghostNode}#in/x`,
      via: 'call',
      broken: [{ path: '', level: 'error', reason: '前の graph の切れた線' }],
    },
    { from: `${E.ghostNode}#out/return`, to: 'comp:EntryList#in/entries', via: 'render' },
    { from: E.removedItem, to: `${E.ghostNode}#in/x`, via: 'call' },
    { from: 'nope:gone#out/a', to: 'comp:EntryList#in/entries', via: 'render' },
  );
  return g;
}
