// 部品（parts）と挙動（behaviors）の検査（Phase 10。docs/26 §5）。graph.json v2 の検証器から呼ばれる。
// 細かい場合分けは、図を書く側のテスト（packages/core の atlas-check.test.ts）にある。ここでは、検証器に組みこまれていることと、
// 指摘に「どの検査か」（rule）が付くことを確かめる
import { describe, expect, it } from 'vitest';
import { advancePath, walkBehavior, type BehaviorIssue } from './behaviors.js';
import { graphSchemaV2, validateGraphV2 } from './validate-v2.js';
import { isLocalId, type BehaviorStepV2, type BehaviorV2, type GraphV2 } from './v2.js';

const item = (id: string) => ({ id, name: id, type: 'void' });
const base = (): GraphV2 => ({
  version: 2,
  nodes: [
    {
      id: 'screen:/',
      kind: 'screen',
      name: '画面',
      runtime: 'browser',
      ports: [{ id: 'out', dir: 'out', items: [item('open')] }],
    },
    {
      id: 'part:form',
      kind: 'component',
      name: '欄',
      runtime: 'browser',
      ports: [
        { id: 'out', dir: 'out', items: [item('send')] },
        { id: 'in', dir: 'in', items: [item('done')] },
      ],
    },
    {
      id: 'endpoint:POST /x',
      kind: 'endpoint',
      name: 'POST /x',
      runtime: 'server',
      ports: [
        { id: 'in', dir: 'in', items: [item('body')] },
        { id: 'req', dir: 'out', items: [item('row')] },
        { id: 'out', dir: 'out', items: [item('body')] },
      ],
    },
    {
      id: 'table:x',
      kind: 'table',
      name: 'x',
      runtime: 'data',
      ports: [{ id: 'write', dir: 'in', items: [item('row')] }],
    },
  ],
  wires: [
    { from: 'part:form#out/send', to: 'endpoint:POST /x#in/body', via: 'http' },
    { from: 'endpoint:POST /x#out/body', to: 'part:form#in/done', via: 'http', reply: true },
    { from: 'endpoint:POST /x#req/row', to: 'table:x#write/row', via: 'call' },
  ],
  parts: [{ id: 'form', box: 'part:form', screen: 'screen:/', selector: 'form' }],
  behaviors: [
    {
      id: 'post',
      name: '送る',
      screen: 'screen:/',
      trigger: { action: 'submit', part: 'form' },
      steps: [
        {
          send: [{ from: 'part:form#out/send', to: 'endpoint:POST /x#in/body' }],
          back: [{ from: 'endpoint:POST /x#out/body', to: 'part:form#in/done' }],
        },
        { send: [{ from: 'endpoint:POST /x#req/row', to: 'table:x#write/row' }] },
      ],
      result: { say: '増える', part: 'form' },
    },
  ],
});
const behavior = (g: GraphV2): BehaviorV2 => g.behaviors![0]!;

describe('validateGraphV2: 部品と挙動', () => {
  it('部品と挙動のある graph が通る（どちらも任意。無い graph は、今までどおり通る）', () => {
    expect(validateGraphV2(base())).toMatchObject({ ok: true, errors: [], warnings: [] });
    const plain = base();
    delete plain.parts;
    delete plain.behaviors;
    expect(validateGraphV2(plain).ok).toBe(true);
  });

  it('段の線が wires に無い: 挙動の指摘（rule: behavior）で、段の場所が出る', () => {
    const g = base();
    behavior(g).steps[1] = {
      send: [{ from: 'endpoint:POST /x#req/row', to: 'table:x#write/rows' }],
    };
    const v = validateGraphV2(g);
    expect(v.ok).toBe(false);
    expect(v.errors).toHaveLength(1);
    expect(v.errors[0]).toMatchObject({ rule: 'behavior', path: '/behaviors/0/steps/1' });
    expect(v.errors[0]!.message).toContain('図の線（wires）にありません');
  });

  it('検証器が誤りにした線（端が解けない）は、挙動からも「無い線」', () => {
    const g = base();
    g.wires[2] = { from: 'endpoint:POST /x#req/row', to: 'table:x#write/nothing', via: 'call' };
    behavior(g).steps[1] = {
      send: [{ from: 'endpoint:POST /x#req/row', to: 'table:x#write/nothing' }],
    };
    const v = validateGraphV2(g);
    expect(v.errors.map((e) => e.path)).toEqual(['/wires/2/to', '/behaviors/0/steps/1']);
  });

  it('段がつながっていない・始まりの部品が無い・画面が画面の箱でない', () => {
    const disconnected = base();
    disconnected.behaviors![0]!.steps.reverse();
    expect(validateGraphV2(disconnected).errors[0]!.message).toContain(
      '最初の段は、始まり（"part:form"）から出る線にしてください',
    );

    const noPart = base();
    behavior(noPart).trigger = { action: 'click', part: 'nope' };
    const e1 = validateGraphV2(noPart).errors[0] as BehaviorIssue;
    expect(e1).toMatchObject({ rule: 'ref', path: '/behaviors/0' });

    const notScreen = base();
    notScreen.parts![0]!.screen = 'table:x';
    expect(validateGraphV2(notScreen).errors[0]!.message).toContain(
      '画面の箱（kind: screen）ではありません',
    );
  });

  it('形（スキーマ）: 知らないキー・空の send・action の語彙・id の # は、スキーマが断る', () => {
    const cases: ((g: GraphV2) => void)[] = [
      (g) => Object.assign(behavior(g), { results: {} }),
      (g) => (behavior(g).steps[0] = { send: [] }),
      (g) => (behavior(g).trigger = { action: 'tap' as never, part: 'form' }),
      (g) => (g.parts![0]!.id = 'a#b'),
    ];
    for (const mutate of cases) {
      const g = base();
      mutate(g);
      const v = validateGraphV2(g);
      expect(v.ok).toBe(false);
      expect(v.graph).toBeUndefined();
    }
  });

  it('open のとき part は書かない・それ以外は part が要る（スキーマでは表せないので、検査が見る）', () => {
    const open = base();
    behavior(open).trigger = { action: 'open', part: 'form' };
    expect(validateGraphV2(open).errors.map((e) => e.message)).toContain(
      'action が open のとき、part は書きません（画面を開くことが始まりです）',
    );
    const click = base();
    behavior(click).trigger = { action: 'click' };
    expect(validateGraphV2(click).errors[0]!.message).toBe(
      'action が click のとき、part（部品の id）が要ります',
    );
  });
});

// PR を作る前のコードレビュー（docs/26 §9）で見つかったことを、事実のまま固定する
describe('validateGraphV2: 部品と挙動（レビューで見つかったこと）', () => {
  it('名指しの形は、スキーマでは問わない。解けない名指しは、何が無いかを名指しした指摘になる（スキーマの読みにくい指摘にしない）', () => {
    const cases: [(g: GraphV2) => void, string][] = [
      [
        (g) => (g.parts![0]!.box = 'status-badge'),
        '部品 "form" の box "status-badge" の箱がありません',
      ],
      [(g) => (g.parts![0]!.screen = 'home'), '部品 "form" の screen "home" の箱がありません'],
      [(g) => (behavior(g).screen = 'home'), '挙動 "post" の screen "home" の箱がありません'],
      [
        (g) => (behavior(g).trigger = { action: 'click', part: 'a#b' }),
        '挙動 "post" の始まりの部品 "a#b" が、部品（parts）にありません',
      ],
      [
        (g) => (behavior(g).result = { part: 'x y' }),
        '挙動 "post" の result の部品 "x y" が、部品（parts）にありません',
      ],
      [
        (g) =>
          (behavior(g).steps[1] = {
            send: [{ from: 'endpoint:POST /x#req', to: 'table:x#write/row' }],
          }),
        'send の線 "endpoint:POST /x#req" → "table:x#write/row" が、図の線（wires）にありません',
      ],
      [
        (g) => (behavior(g).when = { 'Screen Home#Logged In': true }),
        'when のキー "Screen Home#Logged In" の箱 "Screen Home" がありません',
      ],
      [
        (g) => ((behavior(g).steps[0] as BehaviorStepV2).when = { filled: true }),
        'when のキー "filled" は "<箱 id>#<分岐 id>" で書いてください',
      ],
    ];
    for (const [mutate, message] of cases) {
      const g = base();
      mutate(g);
      const v = validateGraphV2(g);
      expect(v.graph, message).toBeDefined(); // スキーマは通る（形の誤りではない）
      expect(v.errors.map((e) => e.message)).toContain(message);
      expect(v.errors.every((e) => e.rule !== undefined)).toBe(true);
    }
  });

  it('部品の箱が無いとき、その部品から始まる挙動に、つながりの指摘を重ねない（指摘は、部品の 1 件だけ）', () => {
    const g = base();
    g.parts![0]!.box = 'part:nothing';
    const v = validateGraphV2(g);
    expect(v.errors.map((e) => e.message)).toEqual([
      '部品 "form" の box "part:nothing" の箱がありません',
    ]);
  });

  it('始まりの部品と、変わる部品は、別の画面の部品でもよい（docs/26 §4。誤りにも警告にもしない）', () => {
    const g = base();
    g.nodes.push({
      id: 'screen:/other',
      kind: 'screen',
      name: '別の画面',
      runtime: 'browser',
      ports: [],
    });
    g.parts![0]!.screen = 'screen:/other';
    expect(validateGraphV2(g)).toMatchObject({ ok: true, errors: [], warnings: [] });
  });

  it('段の形の誤りは、合わない所の 1 件だけが出る（「どちらの形にも合わない」というまとめの指摘を出さない）', () => {
    const cases: [BehaviorV2['steps'][number], string, string][] = [
      [{ send: [] }, '/behaviors/0/steps/0/send', '要素が 1 個以上必要です'],
      [
        { send: [{ from: 'a', to: 'b' }], bak: [] } as never,
        '/behaviors/0/steps/0',
        '未定義のフィールド "bak" があります',
      ],
      [
        { parallel: [[{ send: [{ from: 'a', to: 'b' }] }]] },
        '/behaviors/0/steps/0/parallel',
        '要素が 2 個以上必要です',
      ],
      [
        { parallel: [], send: [{ from: 'a', to: 'b' }] } as never,
        '/behaviors/0/steps/0',
        '未定義のフィールド "send" があります',
      ],
    ];
    for (const [step, path, message] of cases) {
      const g = base();
      behavior(g).steps[0] = step;
      const v = validateGraphV2(g);
      expect(v.graph).toBeUndefined();
      expect(v.errors.filter((e) => e.path === path).map((e) => e.message)).toContain(message);
      expect(v.errors.map((e) => e.message).join('\n')).not.toMatch(/anyOf|スキーマ違反（if）/);
    }
    // 並んだ列と、段のキーを混ぜた形の指摘は、1 件だけ
    const mixed = base();
    behavior(mixed).steps[0] = {
      parallel: [[{ send: [{ from: 'a', to: 'b' }] }], [{ send: [{ from: 'a', to: 'b' }] }]],
      say: 'x',
    } as never;
    expect(validateGraphV2(mixed).errors).toHaveLength(1);
  });

  it('isLocalId は、スキーマの localId と同じ決まり（図を読む側の指摘と、契約がずれない）', () => {
    const defs = graphSchemaV2.$defs as { localId: { pattern: string } };
    const pattern = new RegExp(defs.localId.pattern);
    for (const id of [
      'form',
      'コメント欄',
      'a b',
      'a/b',
      '',
      '#',
      'a#b',
      'a\nb',
      'a\tb',
      '\u0000',
      'a\u001f',
    ])
      expect(isLocalId(id), JSON.stringify(id)).toBe(pattern.test(id));
  });

  it('部品も挙動も無い graph では、指摘に rule が付かない（部品と挙動の検査をしていない）', () => {
    const g = base();
    delete g.parts;
    delete g.behaviors;
    g.wires[2]!.to = 'table:x#write/nothing';
    const v = validateGraphV2(g);
    expect(v.errors).toHaveLength(1);
    expect(v.errors[0]!.rule).toBeUndefined();
  });
});

// 検査と、見せる形（@stack-atlas/wiring の behaviorView）が、同じたどり方をするための関数
describe('advancePath・walkBehavior', () => {
  it('advancePath: 先の箱から出れば深くなり、手前の箱から出れば、そこより先を捨てる。経路に無い箱からは進めない', () => {
    expect(advancePath(['a'], 'a', 'b')).toEqual(['a', 'b']);
    expect(advancePath(['a', 'b', 'c'], 'c', 'd')).toEqual(['a', 'b', 'c', 'd']);
    expect(advancePath(['a', 'b', 'c'], 'a', 'x')).toEqual(['a', 'x']);
    expect(advancePath(['a', 'b'], 'z', 'x')).toBeUndefined();
    // 同じ箱が経路に 2 度あれば、先のほう（いちばん奥）から出る
    expect(advancePath(['a', 'b', 'a'], 'a', 'x')).toEqual(['a', 'b', 'a', 'x']);
  });

  it('walkBehavior: 並んだ列は、どの列も、分かれる前の値から始まる。列が済んだら、分かれる前の値に戻る', () => {
    const step = (name: string): BehaviorStepV2 => ({ send: [{ from: name, to: name }] });
    const seen: string[] = [];
    walkBehavior(
      { steps: [step('a'), { parallel: [[step('b'), step('c')], [step('d')]] }, step('e')] },
      'start',
      (state, s, place) => {
        const here = s.send[0]!.from;
        const lane = place.parallel ? ` ${place.parallel.group}/${place.parallel.lane}` : '';
        seen.push(`${state} → ${here} @${place.path}${lane}`);
        return `${state}.${here}`;
      },
    );
    expect(seen).toEqual([
      'start → a @/steps/0',
      'start.a → b @/steps/1/parallel/0/0 0/0',
      'start.a.b → c @/steps/1/parallel/0/1 0/0',
      'start.a → d @/steps/1/parallel/1/0 0/1',
      'start.a → e @/steps/2',
    ]);
  });
});
