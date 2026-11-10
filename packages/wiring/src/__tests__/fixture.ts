// テスト用の合成グラフ（prototype/dataflow-mock.html のデータを docs/16 の契約に合わせて縮めたもの）
import type { GraphV2, ItemV2, LinkV2, NodeV2, PortV2, WireV2 } from '@stack-atlas/schema';

const T_ENTRY = 'type:Entry';
const T_TODAY = 'type:TodayResponse';
const T_ROW = 'table:entries';

export const I = (id: string, type: string, extra: Partial<ItemV2> = {}): ItemV2 => ({
  id,
  name: id,
  type,
  ...extra,
});
export const P = (id: string, dir: 'in' | 'out', items: ItemV2[]): PortV2 => ({ id, dir, items });
export const L = (from: string, to: string, when?: Record<string, boolean>): LinkV2 =>
  when ? { from, to, when } : { from, to };
export const W = (
  from: string,
  to: string,
  via: WireV2['via'],
  reply = false,
  when?: Record<string, boolean>,
): WireV2 => ({
  from,
  to,
  via,
  ...(reply ? { reply: true } : {}),
  ...(when ? { when } : {}),
});
export const N = (
  id: string,
  kind: NodeV2['kind'],
  runtime: NodeV2['runtime'],
  ports: PortV2[],
  extra: Partial<NodeV2> = {},
): NodeV2 => ({
  id,
  kind,
  name: id.slice(id.indexOf(':') + 1),
  runtime,
  ports,
  ...extra,
});

const entryTs = () => [
  I('id', 'string', { wireType: 'string', typeRef: T_ENTRY }),
  I('amount', 'number', { wireType: 'number', typeRef: T_ENTRY }),
  I('createdAt', 'string', { wireType: 'string', typeRef: T_ENTRY }),
];
const entryGo = () => [
  I('id', 'string', { wireType: 'string', typeRef: T_ENTRY }),
  I('amount', 'int64', { wireType: 'integer', typeRef: T_ENTRY }),
  I('createdAt', 'time.Time', { wireType: 'datetime', typeRef: T_ENTRY }),
];
const entryGoExtra = () => [
  ...entryGo(),
  I('occurredAt', 'time.Time', { wireType: 'datetime', typeRef: T_ENTRY }),
];
const row = () => [
  I('id', 'text', { wireType: 'string', typeRef: T_ROW }),
  I('amount', 'bigint', { wireType: 'integer', typeRef: T_ROW }),
  I('created_at', 'timestamptz', { wireType: 'datetime', typeRef: T_ROW }),
];
const today = (
  entries: () => ItemV2[],
  total = 'number',
  totalWire: ItemV2['wireType'] = 'number',
) => [
  I('total', total, { wireType: totalWire, typeRef: T_TODAY }),
  I('entries', 'Entry[]', { wireType: 'array', typeRef: T_ENTRY, children: entries() }),
];

/** 画面 → 部品 → hook → SWR → fetcher → endpoint → Go → テーブル、と Scheduler → notify → ListEntries / Gmail */
export function todayGraph(): GraphV2 {
  return {
    version: 2,
    types: [
      { id: T_ENTRY, name: 'Entry' },
      { id: T_TODAY, name: 'TodayResponse' },
      { id: T_ROW, name: 'entries' },
    ],
    nodes: [
      N('actor:user', 'actor', 'user', [
        P('out', 'out', [
          I('date', 'string', { wireType: 'string' }),
          I('open', 'url', { wireType: 'string' }),
        ]),
      ]),
      N('trigger:scheduler', 'trigger', 'time', [
        P('out', 'out', [I('at', 'cron', { wireType: 'datetime' })]),
      ]),
      N(
        'screen:/today',
        'screen',
        'browser',
        [
          P('in', 'in', [
            I('query_date', 'string', {
              name: 'query.date',
              wireType: 'string',
              when: { date: true },
            }),
            I('html', 'text/html', { wireType: 'string' }),
          ]),
          P('out', 'out', [
            I('props_date', 'string', {
              name: 'props.date',
              wireType: 'string',
              when: { date: true },
            }),
            I('render_island', 'JSX', { name: 'TodayIsland()', wireType: 'object' }),
            I('render_login', 'JSX', {
              name: 'LoginPrompt()',
              wireType: 'object',
              when: { login: false },
            }),
          ]),
        ],
        {
          variants: [
            { id: 'date', name: 'date あり', default: true },
            { id: 'login', name: 'ログイン済み', default: true },
          ],
          links: [
            L('in/query_date', 'out/props_date', { date: true }),
            L('in/html', 'out/render_island'),
            L('in/html', 'out/render_login', { login: false }),
          ],
        },
      ),
      N('comp:LoginPrompt', 'component', 'browser', [
        P('in', 'in', [I('props', '{}', { wireType: 'object' })]),
      ]),
      N(
        'comp:TodayIsland',
        'component',
        'browser',
        [
          P('in', 'in', [
            I('props', '{}', { wireType: 'object' }),
            I('date', 'string', { wireType: 'string' }),
            ...today(entryTs),
          ]),
          P('out', 'out', [I('date', 'string', { wireType: 'string' }), ...today(entryTs)]),
        ],
        {
          links: [
            L('in/date', 'out/date'),
            L('in/total', 'out/total'),
            L('in/entries', 'out/entries'),
          ],
        },
      ),
      N('comp:TotalCard', 'component', 'browser', [
        P('in', 'in', [I('total', 'number', { wireType: 'number', typeRef: T_TODAY })]),
      ]),
      N('comp:EntryList', 'component', 'browser', [
        P('in', 'in', [
          I('entries', 'Entry[]', { wireType: 'array', typeRef: T_ENTRY, children: entryTs() }),
        ]),
      ]),
      N(
        'hook:useToday',
        'hook',
        'browser',
        [
          P('in', 'in', [
            I('date', 'string', { wireType: 'string' }),
            I('data', 'TodayResponse', {
              wireType: 'object',
              typeRef: T_TODAY,
              children: today(entryTs),
            }),
          ]),
          P('out', 'out', [
            I('key', 'string', { wireType: 'string' }),
            ...today(entryTs),
            I('isLoading', 'boolean', { wireType: 'boolean' }),
          ]),
        ],
        {
          links: [
            L('in/date', 'out/key'),
            L('in/data.total', 'out/total'),
            L('in/data.entries', 'out/entries'),
            L('in/data', 'out/isLoading'),
          ],
        },
      ),
      N(
        'cache:swr',
        'cache',
        'browser',
        [
          P('in', 'in', [
            I('key', 'string', { wireType: 'string' }),
            I('value', 'TodayResponse', {
              wireType: 'object',
              typeRef: T_TODAY,
              children: today(entryTs),
            }),
          ]),
          P('out', 'out', [
            I('key', 'string', { wireType: 'string' }),
            I('value', 'TodayResponse', {
              wireType: 'object',
              typeRef: T_TODAY,
              children: today(entryTs),
            }),
          ]),
        ],
        {
          variants: [{ id: 'hit', name: 'cache hit', default: false }],
          links: [
            L('in/key', 'out/value', { hit: true }),
            L('in/key', 'out/key', { hit: false }),
            L('in/value', 'out/value', { hit: false }),
          ],
        },
      ),
      N(
        'lib:fetcher',
        'helper',
        'browser',
        [
          P('in', 'in', [
            I('key', 'string', { wireType: 'string' }),
            I('response', 'TodayResponse', {
              wireType: 'object',
              typeRef: T_TODAY,
              children: today(entryTs),
            }),
          ]),
          P('out', 'out', [
            I('path', 'string', { wireType: 'string' }),
            I('query_date', 'string', { name: 'query.date', wireType: 'string' }),
            I('data', 'TodayResponse', {
              wireType: 'object',
              typeRef: T_TODAY,
              children: today(entryTs),
            }),
          ]),
        ],
        {
          links: [
            L('in/key', 'out/path'),
            L('in/key', 'out/query_date'),
            L('in/response', 'out/data'),
          ],
        },
      ),
      N('endpoint:GET /today', 'endpoint', 'server', [
        P('in', 'in', [
          I('path', 'string', { wireType: 'string' }),
          I('query_date', 'string', { name: 'query.date', wireType: 'string' }),
        ]),
        P('req', 'out', [I('query_date', 'string', { name: 'query.date', wireType: 'string' })]),
        P('res', 'in', [
          I('body', 'TodayResponse', {
            wireType: 'object',
            typeRef: T_TODAY,
            children: today(entryTs, 'integer', 'integer'),
          }),
        ]),
        P('out', 'out', [
          I('body', 'TodayResponse', {
            wireType: 'object',
            typeRef: T_TODAY,
            children: today(entryTs, 'integer', 'integer'),
          }),
        ]),
      ]),
      N(
        'fn:api.handleToday',
        'fn',
        'server',
        [
          P('in', 'in', [
            I('date', 'string', { wireType: 'string' }),
            I('rows', '[]store.Row', { wireType: 'array', typeRef: T_ENTRY, children: row() }),
          ]),
          P('out', 'out', [
            I('date', 'string', { wireType: 'string' }),
            I('resp', 'TodayResponse', {
              wireType: 'object',
              typeRef: T_TODAY,
              children: today(entryGoExtra, 'int64', 'integer'),
            }),
          ]),
        ],
        {
          host: 'infra:lambda-api',
          links: [
            L('in/date', 'out/date'),
            L('in/rows', 'out/resp.total'),
            L('in/rows', 'out/resp.entries'),
            L('in/rows.created_at', 'out/resp.entries.createdAt'),
          ],
        },
      ),
      N(
        'fn:store.ListEntries',
        'fn',
        'server',
        [
          P('in', 'in', [
            I('date', 'string', { wireType: 'string' }),
            I('row', 'pgx.Row', { wireType: 'object', typeRef: T_ENTRY, children: row() }),
          ]),
          P('out', 'out', [
            I('query_date', 'string', { name: 'query.date', wireType: 'string' }),
            I('rows', '[]store.Row', { wireType: 'array', typeRef: T_ENTRY, children: row() }),
          ]),
        ],
        {
          host: 'infra:lambda-api',
          links: [L('in/date', 'out/query_date'), L('in/row', 'out/rows')],
        },
      ),
      N(
        'fn:notify.Run',
        'fn',
        'server',
        [
          P('in', 'in', [
            I('at', 'time.Time', { wireType: 'datetime' }),
            I('rows', '[]store.Row', { wireType: 'array', typeRef: T_ENTRY, children: row() }),
          ]),
          P('out', 'out', [
            I('date', 'string', { wireType: 'string' }),
            I('mail_subject', 'string', { name: 'mail.subject', wireType: 'string' }),
            I('mail_body', 'string', { name: 'mail.body', wireType: 'string' }),
          ]),
        ],
        {
          host: 'infra:lambda-notify',
          links: [
            L('in/at', 'out/date'),
            L('in/at', 'out/mail_subject'),
            L('in/rows', 'out/mail_subject'),
            L('in/rows', 'out/mail_body'),
          ],
        },
      ),
      N('table:entries', 'table', 'data', [
        P('key', 'in', [I('date', 'date', { wireType: 'datetime', typeRef: T_ROW })]),
        P('write', 'in', []),
        P('read', 'out', [
          I('row', 'record', { wireType: 'object', typeRef: T_ROW, children: row() }),
        ]),
      ]),
      N('external:gmail', 'external', 'external', [
        P('in', 'in', [
          I('subject', 'string', { wireType: 'string' }),
          I('body', 'string', { wireType: 'string' }),
        ]),
      ]),
      N('infra:lambda-api', 'infra', 'server', []),
      N('infra:lambda-notify', 'infra', 'server', []),
    ],
    wires: [
      W('actor:user#out/open', 'screen:/today#in/html', 'http'),
      W('actor:user#out/date', 'screen:/today#in/query_date', 'http', false, { date: true }),
      W('screen:/today#out/render_island', 'comp:TodayIsland#in/props', 'render', false, {
        login: true,
      }),
      W('screen:/today#out/props_date', 'comp:TodayIsland#in/date', 'props', false, {
        date: true,
        login: true,
      }),
      W('screen:/today#out/render_login', 'comp:LoginPrompt#in/props', 'render', false, {
        login: false,
      }),
      W('comp:TodayIsland#out/date', 'hook:useToday#in/date', 'call'),
      W('hook:useToday#out/key', 'cache:swr#in/key', 'call'),
      W('cache:swr#out/key', 'lib:fetcher#in/key', 'call'),
      W('lib:fetcher#out/path', 'endpoint:GET /today#in/path', 'http'),
      W('lib:fetcher#out/query_date', 'endpoint:GET /today#in/query_date', 'http'),
      W('endpoint:GET /today#req/query_date', 'fn:api.handleToday#in/date', 'call'),
      W('fn:api.handleToday#out/date', 'fn:store.ListEntries#in/date', 'call'),
      W('fn:store.ListEntries#out/query_date', 'table:entries#key/date', 'sql'),
      W('table:entries#read/row', 'fn:store.ListEntries#in/row', 'sql', true),
      W('fn:store.ListEntries#out/rows', 'fn:api.handleToday#in/rows', 'return', true),
      W('fn:api.handleToday#out/resp', 'endpoint:GET /today#res/body', 'return', true),
      W('endpoint:GET /today#out/body', 'lib:fetcher#in/response', 'http', true),
      W('lib:fetcher#out/data', 'cache:swr#in/value', 'return', true),
      W('cache:swr#out/value', 'hook:useToday#in/data', 'return', true),
      W('hook:useToday#out/total', 'comp:TodayIsland#in/total', 'return', true),
      W('hook:useToday#out/entries', 'comp:TodayIsland#in/entries', 'return', true),
      W('comp:TodayIsland#out/total', 'comp:TotalCard#in/total', 'props'),
      W('comp:TodayIsland#out/entries', 'comp:EntryList#in/entries', 'props'),
      W('trigger:scheduler#out/at', 'fn:notify.Run#in/at', 'event'),
      W('fn:notify.Run#out/date', 'fn:store.ListEntries#in/date', 'call'),
      W('fn:store.ListEntries#out/rows', 'fn:notify.Run#in/rows', 'return', true),
      W('fn:notify.Run#out/mail_subject', 'external:gmail#in/subject', 'http'),
      W('fn:notify.Run#out/mail_body', 'external:gmail#in/body', 'http'),
    ],
  };
}

/** 循環: A が B を呼び、B が A を呼ぶ（戻りも互いに） */
export function cycleGraph(): GraphV2 {
  const fn = (id: string) =>
    N(
      id,
      'fn',
      'server',
      [
        P('in', 'in', [
          I('x', 'int', { wireType: 'integer' }),
          I('ret_1', 'int', { wireType: 'integer' }),
        ]),
        P('out', 'out', [
          I('call_1', 'int', { children: [I('x', 'int', { wireType: 'integer' })] }),
          I('return', 'int', { wireType: 'integer' }),
        ]),
      ],
      { links: [L('in/x', 'out/call_1.x'), L('in/ret_1', 'out/return'), L('in/x', 'out/return')] },
    );
  return {
    version: 2,
    nodes: [fn('fn:A'), fn('fn:B')],
    wires: [
      W('fn:A#out/call_1.x', 'fn:B#in/x', 'call'),
      W('fn:B#out/call_1.x', 'fn:A#in/x', 'call'),
      W('fn:B#out/return', 'fn:A#in/ret_1', 'return', true),
      W('fn:A#out/return', 'fn:B#in/ret_1', 'return', true),
    ],
  };
}

/** 合流: X と Y から Z に入り、Z から W へ */
export function fanInGraph(): GraphV2 {
  return {
    version: 2,
    nodes: [
      N('fn:X', 'fn', 'server', [P('out', 'out', [I('a', 'int')])]),
      N('fn:Y', 'fn', 'server', [P('out', 'out', [I('b', 'int')])]),
      N(
        'fn:Z',
        'fn',
        'server',
        [P('in', 'in', [I('a', 'int'), I('b', 'int')]), P('out', 'out', [I('c', 'int')])],
        {
          links: [L('in/a', 'out/c'), L('in/b', 'out/c')],
        },
      ),
      N(
        'fn:W',
        'fn',
        'server',
        [P('in', 'in', [I('c', 'int')]), P('out', 'out', [I('d', 'int'), I('e', 'int')])],
        {
          links: [L('in/c', 'out/d'), L('in/c', 'out/e')],
        },
      ),
      N('fn:V1', 'fn', 'server', [P('in', 'in', [I('d', 'int')])]),
      N('fn:V2', 'fn', 'server', [P('in', 'in', [I('e', 'int')])]),
    ],
    wires: [
      W('fn:X#out/a', 'fn:Z#in/a', 'call'),
      W('fn:Y#out/b', 'fn:Z#in/b', 'call'),
      W('fn:Z#out/c', 'fn:W#in/c', 'call'),
      W('fn:W#out/d', 'fn:V1#in/d', 'call'),
      W('fn:W#out/e', 'fn:V2#in/e', 'call'),
    ],
  };
}
