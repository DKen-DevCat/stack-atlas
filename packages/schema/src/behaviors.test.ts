// 部品（parts）と挙動（behaviors）の検査（Phase 10。docs/26 §5）。graph.json v2 の検証器から呼ばれる。
// 細かい場合分けは、図を書く側のテスト（packages/core の atlas-check.test.ts）にある。ここでは、検証器に組みこまれていることと、
// 指摘に「どの検査か」（rule）が付くことを確かめる
import { describe, expect, it } from 'vitest';
import type { BehaviorIssue } from './behaviors.js';
import { validateGraphV2 } from './validate-v2.js';
import type { BehaviorV2, GraphV2 } from './v2.js';

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
