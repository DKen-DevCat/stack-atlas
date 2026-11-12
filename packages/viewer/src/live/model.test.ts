// ライブの画面の状態（docs/27 §4.3・§4.4）: 知らせを、操作に区切り、挙動を選び、図と照らす。DOM は使わない
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { GraphV2 } from '@stack-atlas/schema';
import type { LiveEvent } from '@stack-atlas/wiring';
import { describe, expect, it } from 'vitest';
import { LiveModel, MODEL_LIMITS } from './model';

const graph = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        '../../../wiring/src/__tests__/fixtures/atlas-live-agent.graph.json',
        import.meta.url,
      ),
    ),
    'utf8',
  ),
) as GraphV2;
const T0 = 1_000_000;
const req = (at: number, id: string, route: string): LiveEvent => ({
  t: 'request',
  at: T0 + at,
  id,
  method: route.split(' ')[0]!,
  path: route.split(' ')[1]!,
  route,
  query: [],
  kind: 'script',
});
const res = (at: number, id: string, status = 200): LiveEvent => ({
  t: 'response',
  at: T0 + at,
  id,
  status,
  inBrowser: true,
});
const model = () => {
  const m = new LiveModel();
  m.receive({ t: 'graph', graph });
  return m;
};

describe('LiveModel', () => {
  it('投稿の操作: 挙動が選ばれ、図と照らし、時間の軸と段の時刻ができる', () => {
    const m = model();
    expect(
      m.receive({
        t: 'events',
        events: [
          { t: 'part', at: T0, how: 'click', parts: ['comment-form'] },
          { t: 'part', at: T0 + 2, how: 'submit', parts: ['comment-form'] },
          req(5, 'r1', 'POST /api/comments'),
          res(505, 'r1', 201),
          req(510, 'r2', 'GET /api/comments'),
          res(730, 'r2'),
          { t: 'dom', at: T0 + 740, changes: [{ kind: 'added', text: 'new' }] },
        ],
      }),
    ).toEqual([]);
    const [p] = m.tick(T0 + 2_000);
    expect(p).toMatchObject({
      n: 1,
      choice: { behavior: 'post-comment', part: 'comment-form' },
      verdict: { ok: true },
      lines: [],
    });
    expect(p!.timeline.total).toBe(740);
    expect(p!.timings).toHaveLength(8);
    expect(p!.changes).toEqual([{ kind: 'added', text: 'new', at: T0 + 740 }]);
  });

  it('挙動の始まりにならない出来事は、記録中の操作を切らない（図が届いたときに、区切りに渡す）', () => {
    const m = model();
    m.receive({
      t: 'events',
      events: [
        { t: 'part', at: T0, how: 'submit', parts: ['comment-form'] },
        req(5, 'r1', 'POST /api/comments'),
        { t: 'part', at: T0 + 300, how: 'click', parts: ['comment-list'] },
        res(505, 'r1', 201),
      ],
    });
    expect(m.tick(T0 + 3_000).map((p) => p.choice.behavior)).toEqual(['post-comment']);
  });

  it('画面: 道具が決めた画面の挙動だけを並べる。決まらないときは、利用者が選んだ画面を、開いた操作に使う', () => {
    const m = model();
    m.receive({ t: 'events', events: [{ t: 'open', at: T0, path: '/', screen: 'screen:/' }] });
    expect(m.screen).toBe('screen:/');
    expect(m.behaviors().map((b) => b.id)).toEqual(['open', 'post-comment', 'delete-comment']);
    const n = model();
    n.chosenScreen = 'screen:/';
    n.receive({
      t: 'events',
      events: [
        { t: 'open', at: T0, path: '/x' },
        req(10, 'r1', 'GET /api/comments'),
        res(100, 'r1'),
      ],
    });
    expect(n.screen).toBeUndefined();
    expect(n.tick(T0 + 3_000)[0]).toMatchObject({
      choice: { behavior: 'open' },
      verdict: { ok: true },
    });
  });

  it('部品の場所・値・状態を覚える。見せる操作は、上限まで', () => {
    const m = model();
    m.receive({
      t: 'events',
      events: [{ t: 'parts', at: T0, rects: [['comment-form', { x: 1, y: 2, w: 3, h: 4 }]] }],
    });
    expect(m.rects.get('comment-form')).toEqual({ x: 1, y: 2, w: 3, h: 4 });
    m.receive({ t: 'values', values: [{ id: 'r1', raw: '/api/comments' }] });
    expect(m.values.get('r1')).toEqual({ id: 'r1', raw: '/api/comments' });
    for (let i = 0; i < MODEL_LIMITS.played + 5; i++) {
      const at = i * 10_000;
      m.receive({
        t: 'events',
        events: [{ t: 'part', at: T0 + at, how: 'click', parts: ['delete-button'] }],
      });
      m.tick(T0 + at + 5_000);
    }
    expect(m.played).toHaveLength(MODEL_LIMITS.played);
    expect(m.played[0]!.n).toBe(6);
  });

  it('図が届く前の出来事は、見せない（挙動を選べない）', () => {
    const m = new LiveModel();
    m.receive({
      t: 'events',
      events: [{ t: 'part', at: T0, how: 'click', parts: ['x'] }, req(5, 'r1', 'GET /a')],
    });
    expect(m.tick(T0 + 30_000)).toEqual([]);
  });
});

// PR を作る前のレビュー（10-2c）で見つかったこと
describe('LiveModel（レビューで見つかったこと）', () => {
  it('「値を見る」を切ったら、持っている値を消す（出来事に付いて届いた値も、メモリから届いた値も）', () => {
    const m = model();
    m.receive({
      t: 'status',
      status: {
        protocol: 1,
        app: 'http://localhost/',
        mode: 'frame',
        reveal: true,
        hold: false,
        holdLocked: false,
      },
    });
    m.receive({
      t: 'events',
      events: [
        { t: 'part', at: T0, how: 'submit', parts: ['comment-form'] },
        {
          ...req(5, 'r1', 'POST /api/comments'),
          raw: '/api/comments?token=SECRET',
          body: { kind: 'tree', shape: { t: 'string' }, value: 'SECRET' },
        } as LiveEvent,
        {
          ...res(500, 'r1', 201),
          body: { kind: 'other', type: 'text/plain', bytes: 6, value: 'SECRET' },
        } as LiveEvent,
      ],
    });
    m.receive({
      t: 'values',
      values: [{ id: 'r1', raw: '/api/comments?token=SECRET', sent: 'SECRET' }],
    });
    const [p] = m.tick(T0 + 3_000);
    expect(JSON.stringify(p!.op)).toContain('SECRET');
    m.receive({
      t: 'status',
      status: {
        protocol: 1,
        app: 'http://localhost/',
        mode: 'frame',
        reveal: false,
        hold: false,
        holdLocked: false,
      },
    });
    expect(JSON.stringify(p!.op)).not.toContain('SECRET');
    expect(m.values.size).toBe(0);
  });

  it('道具の「どこまで渡し終えたか」で区切る（今の時刻ではなく。遅れて届く出来事を、別の操作にしない）', () => {
    const m = model();
    // 投稿の返事のあと 250ms で読み直しの GET を出すアプリ。道具は、出来事を少しためてから渡す
    m.receive({
      t: 'events',
      events: [
        { t: 'part', at: T0, how: 'submit', parts: ['comment-form'] },
        req(5, 'r1', 'POST /api/comments'),
        res(505, 'r1', 201),
      ],
      upTo: T0 + 600,
    });
    expect(m.watermarked).toBe(true);
    expect(m.played).toEqual([]);
    const played = m.receive({
      t: 'events',
      events: [req(755, 'r2', 'GET /api/comments'), res(900, 'r2')],
      upTo: T0 + 1_400,
    });
    expect(played).toHaveLength(1);
    expect(played[0]).toMatchObject({
      choice: { behavior: 'post-comment' },
      verdict: { ok: true },
    });
  });
});
