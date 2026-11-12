// ライブ（docs/27 §4.3）: 出来事を操作に区切る・どの挙動かを決める・図と照らす・時間の軸・画面の変化の差。
// 図は、試しでエージェントが書いたもの（部品が重なっている: 削除のボタンが、一覧の中にある）
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { GraphV2, NodeV2 } from '@stack-atlas/schema';
import { describe, expect, it } from 'vitest';
import { behaviorView } from '../behavior-view.js';
import {
  OperationRecorder,
  chooseBehavior,
  matchRequests,
  netChanges,
  progressAt,
  screenFor,
  startsBehavior,
  stepTimings,
  timelineOf,
  verdictLines,
  worthShowing,
  type LiveEvent,
  type LiveOperation,
} from '../live/index.js';

const graph = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('./fixtures/atlas-live-agent.graph.json', import.meta.url)),
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
  inBrowser: false,
});
const part = (
  at: number,
  how: 'click' | 'submit' | 'input' | 'change',
  ...parts: string[]
): LiveEvent => ({
  t: 'part',
  at: T0 + at,
  how,
  parts,
});
const dom = (at: number, ...texts: string[]): LiveEvent => ({
  t: 'dom',
  at: T0 + at,
  changes: texts.map((t) => ({ kind: t.startsWith('-') ? 'removed' : 'added', text: t.slice(1) })),
});
/** 出来事を順に入れ、最後に「いま」を進めて、閉じた操作を全部返す */
function record(events: LiveEvent[], tickAt?: number, recorder = new OperationRecorder()) {
  const closed: LiveOperation[] = [];
  for (const ev of events) closed.push(...recorder.push(ev));
  if (tickAt !== undefined) closed.push(...recorder.tick(T0 + tickAt));
  return { closed, recorder };
}

/** 投稿する: 送信のボタンを押す（押す → 送信）→ POST → 読み直しの GET → 一覧が描き直される */
const postEvents: LiveEvent[] = [
  part(0, 'click', 'comment-form'),
  part(2, 'submit', 'comment-form'),
  req(5, 'r1', 'POST /api/comments'),
  res(505, 'r1', 201),
  req(510, 'r2', 'GET /api/comments'),
  res(730, 'r2'),
  dom(740, '-a', '-b', '+new', '+a', '+b'),
];

describe('OperationRecorder: 出来事を、操作に区切る', () => {
  it('1 回の手の動き（押す → 送信）は、1 つの操作。通信が済んで静かになったら、閉じる', () => {
    const early = record(postEvents, 800);
    expect(early.closed).toEqual([]); // まだ静かになっていない
    const { closed } = record(postEvents, 740 + 400);
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ seq: 0, start: T0, end: T0 + 740, closed: 'quiet' });
    expect(closed[0]!.gestures.map((g) => g.how)).toEqual(['click', 'submit']);
    expect(closed[0]!.requests.map((r) => `${r.route} ${r.status} ${r.end! - r.start}ms`)).toEqual([
      'POST /api/comments 201 500ms',
      'GET /api/comments 200 220ms',
    ]);
    expect(closed[0]!.changes).toHaveLength(5);
  });

  it('返事を待っているあいだは、閉じない。長さの上限で打ち切る（返らない通信・動き続ける表示）', () => {
    const waiting = [part(0, 'click', 'delete-button'), req(5, 'r1', 'DELETE /api/comments/{id}')];
    expect(record(waiting, 5_000).closed).toEqual([]);
    const { closed } = record(waiting, 10_000);
    // 2026-11-12 変更（レビュー 7）: 返らなかった通信があるとき、軸を閉じた時刻まで延ばす（前は end: T0 で、待っていた時間が消えていた）
    expect(closed[0]).toMatchObject({ closed: 'limit', end: T0 + 10_000 });
    expect(closed[0]!.requests[0]!.end).toBeUndefined();

    // 画面が変わり続けると、静かにならない。上限で閉じる
    const ticking = [part(0, 'click', 'delete-button')];
    for (let at = 100; at < 11_000; at += 300) ticking.push(dom(at, '+tick'));
    const r = new OperationRecorder();
    const seen: LiveOperation[] = [];
    for (const ev of ticking) {
      seen.push(...r.push(ev));
      seen.push(...r.tick(ev.at));
    }
    expect(seen[0]).toMatchObject({ closed: 'limit' });
  });

  it('次の操作が始まったら、前の操作を閉じる（返事を待っていても）', () => {
    const { closed, recorder } = record([
      part(0, 'click', 'delete-button'),
      req(5, 'r1', 'DELETE /api/comments/{id}'),
      part(900, 'click', 'delete-button'),
      res(950, 'r1', 204), // 前の操作の返事。もう数えない
    ]);
    expect(closed.map((o) => o.closed)).toEqual(['next']);
    expect(recorder.current).toMatchObject({ seq: 1, requests: [] });
  });

  it('続けて打った入力は、1 つの操作。間が空けば、別の操作', () => {
    const { closed, recorder } = record([
      part(0, 'input', 'comment-form'),
      part(120, 'input', 'comment-form'),
      part(300, 'input', 'comment-form'),
      part(2_000, 'input', 'comment-form'),
    ]);
    expect(closed).toHaveLength(1);
    expect(closed[0]!.gestures).toHaveLength(3);
    expect(recorder.current!.gestures).toHaveLength(1);
  });

  it('画面を開いたことも、操作の始まり。操作が無いときの通信・画面の変化は、数えない', () => {
    const orphan = record([req(0, 'r0', 'GET /api/comments'), dom(10, '+x')], 5_000);
    expect(orphan.closed).toEqual([]);
    const { closed } = record(
      [
        { t: 'open', at: T0, path: '/', screen: 'screen:/' },
        req(30, 'r1', 'GET /api/comments'),
        res(250, 'r1'),
        dom(260, '+a', '+b'),
      ],
      700,
    );
    expect(closed[0]).toMatchObject({ open: { path: '/', screen: 'screen:/' }, gestures: [] });
    // 開いた操作のあとの、部品の出来事は、新しい操作
    const next = record([{ t: 'open', at: T0, path: '/' }, part(20, 'click', 'delete-button')]);
    expect(next.closed.map((o) => o.closed)).toEqual(['next']);
  });
});

describe('chooseBehavior: どの挙動か', () => {
  const closedOf = (events: LiveEvent[]) => record(events, 60_000).closed[0]!;

  it('重なった部品: 削除のボタンを押すと、一覧ではなく、削除のボタンから始まる挙動になる', () => {
    const op = closedOf([
      part(0, 'click', 'delete-button', 'comment-list'),
      req(3, 'r1', 'DELETE /api/comments/{id}'),
      res(200, 'r1', 204),
    ]);
    // 2026-11-12 変更（レビュー 6）: 選んだ挙動が起きた回数（runs）も返す
    expect(chooseBehavior(graph, op)).toEqual({
      behavior: 'delete-comment',
      candidates: ['delete-comment'],
      part: 'delete-button',
      runs: 1,
    });
    // 部品の並びが逆（外側が先）に知らされても、挙動を持つ部品が選ばれる
    const outerFirst = closedOf([part(0, 'click', 'comment-list', 'delete-button')]);
    expect(chooseBehavior(graph, outerFirst).behavior).toBe('delete-comment');
  });

  it('押す → 送信: 「押す」に挙動が無くても、「送信」の挙動が選ばれる', () => {
    expect(chooseBehavior(graph, closedOf(postEvents))).toEqual({
      behavior: 'post-comment',
      candidates: ['post-comment'],
      part: 'comment-form',
      runs: 1,
    });
  });

  it('始まりの合う挙動が無い操作: 通信が出たときだけ、見せる（図に無い操作）', () => {
    const silent = closedOf([part(0, 'click', 'comment-list')]);
    const noisy = closedOf([part(0, 'click', 'comment-list'), req(3, 'r1', 'GET /api/comments')]);
    expect(chooseBehavior(graph, silent)).toEqual({ candidates: [], runs: 0 });
    expect(worthShowing(silent, chooseBehavior(graph, silent))).toBe(false);
    expect(worthShowing(noisy, chooseBehavior(graph, noisy))).toBe(true);
    // 挙動があれば、通信が出なくても見せる（図にある通信が出なかった、と分かる）
    const quiet = closedOf([part(0, 'click', 'delete-button')]);
    expect(worthShowing(quiet, chooseBehavior(graph, quiet))).toBe(true);
  });

  it('始まりが同じ挙動が 2 つあるとき: 実際の通信と、いちばん多く合うもの。ほかも候補に残る', () => {
    const g = structuredClone(graph);
    const del = g.behaviors!.find((b) => b.id === 'delete-comment')!;
    // 削除と同じ始まりで、通信を出さない挙動（確かめの窓を出すだけ、のような分岐）を、先に書く
    g.behaviors!.unshift({ ...del, id: 'delete-cancelled', steps: [del.steps[2]!] });
    const op = closedOf([
      part(0, 'click', 'delete-button', 'comment-list'),
      req(3, 'r1', 'DELETE /api/comments/{id}'),
    ]);
    expect(chooseBehavior(g, op)).toMatchObject({
      behavior: 'delete-comment',
      candidates: ['delete-comment', 'delete-cancelled'],
    });
  });

  it('開いた操作: その画面の「開く」挙動。画面が決まっていなければ、選ばない', () => {
    const open = (screen?: string) =>
      closedOf([{ t: 'open', at: T0, path: '/', ...(screen ? { screen } : {}) }]);
    expect(chooseBehavior(graph, open('screen:/'))).toEqual({
      behavior: 'open',
      candidates: ['open'],
      runs: 1,
    });
    expect(chooseBehavior(graph, open('screen:/other'))).toEqual({ candidates: [], runs: 0 });
    expect(chooseBehavior(graph, open())).toEqual({ candidates: [], runs: 0 });
  });
});

describe('screenFor: いま開いているアドレスが、図のどの画面か', () => {
  const screen = (id: string, path?: string): NodeV2 => ({
    id,
    kind: 'screen',
    name: id,
    runtime: 'browser' as const,
    ports: [],
    ...(path ? { meta: { path } } : {}),
  });

  it('画面の箱が 1 つなら、アドレスを書いていなくても、それ', () => {
    expect(screenFor(graph, '/anything')).toEqual({ screen: 'screen:/', candidates: ['screen:/'] });
  });

  it('画面が 2 つ以上: meta.path の合うもの。2 つ合えば、文字どおりの部分が多いもの', () => {
    const g = {
      nodes: [
        screen('screen:list', '/articles'),
        screen('screen:detail', '/articles/{id}'),
        screen('screen:new', '/articles/new'),
        screen('screen:nopath'),
      ],
    };
    expect(screenFor(g, '/articles').screen).toBe('screen:list');
    expect(screenFor(g, '/articles/12').screen).toBe('screen:detail');
    expect(screenFor(g, '/articles/new').screen).toBe('screen:new');
    // 決まらなければ、利用者が選ぶ（候補を全部返す）
    expect(screenFor(g, '/settings')).toEqual({
      candidates: ['screen:list', 'screen:detail', 'screen:new', 'screen:nopath'],
    });
  });
});

describe('matchRequests: 図の通信と、実際の通信', () => {
  const view = behaviorView(graph, 'post-comment')!;
  const opOf = (events: LiveEvent[]) => record(events, 60_000).closed[0]!;

  it('合っている: 図の通信の段それぞれに、実際の通信が 1 つずつ当たる（順番は問わない）', () => {
    const v = matchRequests(view, opOf(postEvents).requests);
    expect(v).toEqual({
      matched: [
        { step: 0, request: 'r1' },
        { step: 3, request: 'r2' },
      ],
      missing: [],
      skipped: [], // 2026-11-12 追加（レビュー 5）: 条件つきの段で、出なかったもの
      extra: [],
      ok: true,
    });
    const swapped = opOf([
      part(0, 'submit', 'comment-form'),
      req(5, 'r2', 'GET /api/comments'),
      req(6, 'r1', 'POST /api/comments'),
    ]);
    expect(matchRequests(view, swapped.requests).ok).toBe(true);
  });

  it('図にあるが出なかった・図に無い（図より多く出た分も）: 検査の指摘と同じ書き方の文になる', () => {
    const op = opOf([
      part(0, 'submit', 'comment-form'),
      req(5, 'r1', 'POST /api/comments'),
      req(6, 'r2', 'POST /api/comments'),
      { ...req(7, 'r3', 'GET /api/tags'), route: undefined, path: '/api/tags' } as LiveEvent,
    ]);
    const v = matchRequests(view, op.requests);
    expect(v).toMatchObject({ missing: [3], extra: ['r2', 'r3'], ok: false });
    expect(verdictLines(view, v, op.requests)).toEqual([
      '[警告・挙動] 挙動 "post-comment" の段 4: 図にある通信 GET /api/comments が、実際の操作では出ませんでした',
      // 2026-11-12 変更（セキュリティのレビューの覚え書き）: 実際の通信は、アプリが選べる文字なので、引用の印で囲む
      '[警告・挙動] 挙動 "post-comment": 実際の操作で出た通信「POST /api/comments」が、図の経路にありません',
      '[警告・挙動] 挙動 "post-comment": 実際の操作で出た通信「GET /api/tags」が、図の経路にありません',
    ]);
    expect(verdictLines(view, matchRequests(view, opOf(postEvents).requests), [])).toEqual([]);
  });
});

describe('timelineOf: 時間の軸と、再生バーの帯', () => {
  it('帯は、軸を出来事の境目で切ったもの。合計は、実際の時間。いちばん長い帯が分かる', () => {
    const op = record(postEvents, 60_000).closed[0]!;
    const line = timelineOf(op);
    expect(line.total).toBe(740);
    expect(line.slices).toEqual([
      { from: 0, to: 5, kind: 'before' },
      { from: 5, to: 505, kind: 'wait', request: 'r1' },
      { from: 505, to: 510, kind: 'between' },
      { from: 510, to: 730, kind: 'wait', request: 'r2' },
      { from: 730, to: 740, kind: 'after' },
    ]);
    expect(line.slices.reduce((sum, s) => sum + (s.to - s.from), 0)).toBe(line.total);
    expect(line.longest).toBe(1);
    expect(line.requests.map((r) => `${r.id} ${r.ms}`)).toEqual(['r1 500', 'r2 220']);
    // 2026-11-12 変更（レビュー 12）: 画面の変化は、時刻の種類ではなく、変化ごとに数える（op.changes と同じ数）
    expect(line.changes).toEqual([740, 740, 740, 740, 740]);
  });

  it('同時に出た通信は、足し合わせない（帯の合計は軸の長さ。内訳の合計は、それより長い）', () => {
    const op = record(
      [
        { t: 'open', at: T0, path: '/' },
        req(10, 'a', 'GET /api/comments'),
        req(20, 'b', 'GET /api/comments'),
        res(120, 'b'),
        res(300, 'a'),
        dom(310, '+x'),
      ],
      60_000,
    ).closed[0]!;
    const line = timelineOf(op);
    expect(line.slices).toEqual([
      { from: 0, to: 10, kind: 'before' },
      { from: 10, to: 300, kind: 'wait', request: 'a' },
      { from: 300, to: 310, kind: 'after' },
    ]);
    expect(line.requests.reduce((sum, r) => sum + r.ms, 0)).toBeGreaterThan(line.total);
  });

  it('返らなかった通信は、軸の終わりまで待っている扱い。通信の無い操作は、帯が 1 本', () => {
    const pending = record(
      [part(0, 'click', 'delete-button'), req(5, 'r1', 'DELETE /api/comments/{id}'), dom(50, '+x')],
      60_000,
    ).closed[0]!;
    // 2026-11-12 変更（レビュー 7）: 上限で閉じたとき、軸は上限まで延びる（前は、最後の画面の変化 50ms で切れていた）
    expect(timelineOf(pending)).toMatchObject({
      total: 10_000,
      requests: [{ id: 'r1', from: 5, to: 10_000, pending: true }],
    });
    const bare = record([part(0, 'click', 'delete-button'), dom(40, '+x')], 60_000).closed[0]!;
    // 2026-11-12 変更（レビュー 12）: 通信の無い操作は local（前は before と呼んでいた）
    expect(timelineOf(bare).slices).toEqual([{ from: 0, to: 40, kind: 'local' }]);
    const empty = record([part(0, 'click', 'delete-button')], 60_000).closed[0]!;
    expect(timelineOf(empty)).toMatchObject({ total: 0, slices: [], longest: -1 });
  });

  it('progressAt: 軸の上の時刻で、どの通信が出て・返って、画面がいくつ変わったか', () => {
    const line = timelineOf(record(postEvents, 60_000).closed[0]!);
    expect(progressAt(line, 0)).toEqual({ sent: [], returned: [], changes: 0, slice: 0 });
    expect(progressAt(line, 100)).toEqual({ sent: ['r1'], returned: [], changes: 0, slice: 1 });
    expect(progressAt(line, 600)).toEqual({
      sent: ['r1', 'r2'],
      returned: ['r1'],
      changes: 0,
      slice: 3,
    });
    expect(progressAt(line, 740)).toEqual({
      sent: ['r1', 'r2'],
      returned: ['r1', 'r2'],
      changes: 5, // 2026-11-12 変更（レビュー 12）: 変化の件数（op.changes の先頭から、この数だけ起きている）
      slice: 4,
    });
  });
});

describe('netChanges: 画面の変化の差', () => {
  it('一覧を丸ごと描き直しても、増えた 1 件だけが残る（同じ中身の「消えた」と「増えた」を打ち消す）', () => {
    const op = record(postEvents, 60_000).closed[0]!;
    expect(netChanges(op.changes).map((c) => `${c.kind} ${c.text}`)).toEqual(['added new']);
    const removed = netChanges([
      { kind: 'removed', text: 'a' },
      { kind: 'removed', text: 'b' },
      { kind: 'added', text: 'a' },
    ] as const);
    expect(removed).toEqual([{ kind: 'removed', text: 'b' }]);
  });

  it('同じ中身が 2 件あっても、数を合わせて打ち消す。文字の無い要素・文字の変化は、打ち消さない', () => {
    expect(
      netChanges([
        { kind: 'removed', text: 'x' },
        { kind: 'added', text: 'x' },
        { kind: 'added', text: 'x' },
        { kind: 'added', text: '' },
        { kind: 'removed', text: '' },
        { kind: 'text', before: '読みこみ中…', text: '2 件のコメント' },
        { kind: 'text', before: '同じ', text: '同じ' },
      ] as const).map((c) => `${c.kind} ${c.text}`),
    ).toEqual(['added x', 'added ', 'removed ', 'text 2 件のコメント']);
  });
});

// PR を作る前のコードレビュー（10-2a）で見つかったことを、事実のまま固定する
describe('区切り・照合・選び方（レビューで見つかったこと）', () => {
  /** 出来事を時刻の順に入れながら、ms ごとに tick する（本物の流れに近い進め方） */
  function stream(events: LiveEvent[], until: number, recorder = new OperationRecorder(), ms = 50) {
    const closed: LiveOperation[] = [];
    const queue = [...events].sort((a, b) => a.at - b.at);
    for (let now = T0; now <= T0 + until; now += ms) {
      while (queue.length && queue[0]!.at <= now) closed.push(...recorder.push(queue.shift()!));
      closed.push(...recorder.tick(now));
    }
    return closed;
  }

  it('最初の通信が遅れて出る操作（準備を待ってから読みこむ）も、空のまま閉じない', () => {
    const closed = stream(
      [
        { t: 'open', at: T0, path: '/', screen: 'screen:/' },
        req(450, 'r1', 'GET /api/comments'),
        res(600, 'r1'),
        dom(610, '+a'),
      ],
      5_000,
    );
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ closed: 'quiet', end: T0 + 610 });
    expect(closed[0]!.requests).toHaveLength(1);
    expect(closed[0]!.changes).toHaveLength(1);
    // 何も起きない操作は、firstMs（2 秒）で閉じる
    const idle = stream([part(0, 'click', 'delete-button')], 5_000);
    expect(idle[0]).toMatchObject({ closed: 'quiet', requests: [] });
  });

  it('打っているあいだは、静かでも閉じない（入力を 500ms おきに 3 回 → 1 つの操作）', () => {
    const closed = stream(
      [
        part(0, 'input', 'comment-form'),
        part(500, 'input', 'comment-form'),
        part(1_000, 'input', 'comment-form'),
      ],
      6_000,
    );
    expect(closed).toHaveLength(1);
    expect(closed[0]!.gestures).toHaveLength(3);
  });

  it('挙動の始まりにならない出来事は、返事を待っている操作を切らない', () => {
    const recorder = new OperationRecorder({ startsBehavior: startsBehavior(graph) });
    const closed = stream(
      [
        part(0, 'submit', 'comment-form'),
        req(5, 'r1', 'POST /api/comments'),
        part(300, 'click', 'comment-list'), // 一覧の中を押した（押す挙動は無い）
        res(505, 'r1', 201),
        req(510, 'r2', 'GET /api/comments'),
        res(730, 'r2'),
        dom(740, '+new'),
      ],
      5_000,
      recorder,
    );
    expect(closed).toHaveLength(1);
    expect(closed[0]!.requests.map((r) => r.status)).toEqual([201, 200]);
    expect(closed[0]!.changes).toHaveLength(1);
    expect(chooseBehavior(graph, closed[0]!).behavior).toBe('post-comment');
    // 記録中の操作が無ければ、始まりにならない出来事も、図に無い操作として記録する
    const alone = stream(
      [part(0, 'click', 'comment-list'), req(5, 'r1', 'GET /api/tags'), res(50, 'r1')],
      5_000,
      new OperationRecorder({ startsBehavior: startsBehavior(graph) }),
    );
    expect(alone).toHaveLength(1);
    expect(worthShowing(alone[0]!, chooseBehavior(graph, alone[0]!))).toBe(true);
  });

  it('startsBehavior: その種類の操作から始まる挙動を持つ部品が、当たった部品の中にあるか', () => {
    const starts = startsBehavior(graph);
    const ev = (how: 'click' | 'submit', ...parts: string[]) => ({
      t: 'part' as const,
      at: 0,
      how,
      parts,
    });
    expect(starts(ev('click', 'delete-button', 'comment-list'))).toBe(true);
    expect(starts(ev('submit', 'comment-form'))).toBe(true);
    expect(starts(ev('click', 'comment-form'))).toBe(false);
    expect(starts(ev('click', 'comment-list'))).toBe(false);
  });

  it('条件つき（when）の段は、出なくても食い違いにしない（skipped）', () => {
    const g = structuredClone(graph);
    const post = g.behaviors!.find((b) => b.id === 'post-comment')!;
    (post.steps[3] as { when?: Record<string, boolean> }).when = {
      'part:comment-form#filled': true,
    };
    const v = matchRequests(
      behaviorView(g, 'post-comment')!,
      record([part(0, 'submit', 'comment-form'), req(5, 'r1', 'POST /api/comments')], 60_000)
        .closed[0]!.requests,
    );
    expect(v).toMatchObject({ missing: [], skipped: [3], extra: [], ok: true });
  });

  it('続けた入力が 1 回ずつ通信を出す挙動: 起きた回数（runs）まで、同じ段に当てる', () => {
    const g = structuredClone(graph);
    // 入力のたびに一覧を読み直す挙動（検索の欄のような作り）を足す
    g.behaviors!.push({
      id: 'search',
      name: '探す',
      screen: 'screen:/',
      trigger: { action: 'input', part: 'comment-form' },
      steps: graph.behaviors!.find((b) => b.id === 'open')!.steps.slice(1),
    });
    const op = record(
      [
        part(0, 'input', 'comment-form'),
        req(10, 'a', 'GET /api/comments'),
        part(150, 'input', 'comment-form'),
        req(160, 'b', 'GET /api/comments'),
        part(300, 'input', 'comment-form'),
        req(310, 'c', 'GET /api/comments'),
      ],
      60_000,
    ).closed[0]!;
    const choice = chooseBehavior(g, op);
    expect(choice).toMatchObject({ behavior: 'search', runs: 3 });
    expect(matchRequests(behaviorView(g, 'search')!, op.requests, choice.runs)).toMatchObject({
      extra: [],
      ok: true,
    });
    expect(matchRequests(behaviorView(g, 'search')!, op.requests).extra).toEqual(['b', 'c']);
  });

  it('次の操作で閉じたとき: 送ったが返らない通信の、送った時刻と、待っていた時間を消さない', () => {
    const { closed } = record([
      part(0, 'click', 'delete-button'),
      req(5, 'r1', 'DELETE /api/comments/{id}'),
      part(900, 'click', 'delete-button'),
    ]);
    expect(closed[0]).toMatchObject({ closed: 'next', end: T0 + 900 });
    expect(timelineOf(closed[0]!).requests).toEqual([
      { id: 'r1', from: 5, to: 900, ms: 895, pending: true },
    ]);
  });

  it('同じ id の通信が 2 度届いても、あとのものは捨てる（返らない扱いで、閉じなくならない）', () => {
    const closed = stream(
      [
        part(0, 'click', 'delete-button'),
        req(5, 'r1', 'DELETE /api/comments/{id}'),
        req(6, 'r1', 'DELETE /api/comments/{id}'),
        res(200, 'r1', 204),
      ],
      3_000,
    );
    expect(closed[0]).toMatchObject({ closed: 'quiet' });
    expect(closed[0]!.requests).toHaveLength(1);
  });

  it('tick が遅れて来ても、静かに済んだ操作を、上限で閉じたことにしない', () => {
    const { closed } = record(
      [
        part(0, 'click', 'delete-button'),
        req(5, 'r1', 'DELETE /api/comments/{id}'),
        res(200, 'r1', 204),
      ],
      30_000,
    );
    expect(closed[0]).toMatchObject({ closed: 'quiet', end: T0 + 200 });
  });

  it('画面の箱が 1 つでも、meta.path が書いてあって合わなければ、その画面にしない', () => {
    const one = (path?: string): Pick<GraphV2, 'nodes'> => ({
      nodes: [
        {
          id: 'screen:list',
          kind: 'screen',
          name: '一覧',
          runtime: 'browser',
          ports: [],
          ...(path ? { meta: { path } } : {}),
        },
      ],
    });
    expect(screenFor(one('/list'), '/settings')).toEqual({ candidates: ['screen:list'] });
    expect(screenFor(one('/list'), '/list')).toEqual({
      screen: 'screen:list',
      candidates: ['screen:list'],
    });
    expect(screenFor(one(), '/settings')).toEqual({
      screen: 'screen:list',
      candidates: ['screen:list'],
    });
  });

  it('同点の候補: 食い違いの少ない挙動を選ぶ（投稿が断られたとき、「断られる」の挙動になる）', () => {
    const g = structuredClone(graph);
    const post = g.behaviors!.find((b) => b.id === 'post-comment')!;
    // 「通る」（POST → GET）を先に、「断られる」（POST だけ）をあとに書く
    g.behaviors!.push({ ...post, id: 'post-rejected', steps: post.steps.slice(0, 1) });
    const op = record(
      [part(0, 'submit', 'comment-form'), req(5, 'r1', 'POST /api/comments'), res(100, 'r1', 400)],
      60_000,
    ).closed[0]!;
    expect(chooseBehavior(g, op)).toMatchObject({
      behavior: 'post-rejected',
      candidates: ['post-rejected', 'post-comment'],
    });
  });

  it('再生バーの帯は、画面が変わった時刻でも切る。帯が無い操作の progressAt は -1', () => {
    const op = record(
      [
        part(0, 'click', 'delete-button'),
        req(10, 'r1', 'DELETE /api/comments/{id}'),
        res(100, 'r1', 204),
        dom(150, '-a'),
        dom(400, '+b'),
      ],
      60_000,
    ).closed[0]!;
    const line = timelineOf(op);
    expect(line.slices.map((x) => `${x.from}-${x.to} ${x.kind}`)).toEqual([
      '0-10 before',
      '10-100 wait',
      '100-150 after',
      '150-400 after',
    ]);
    expect(progressAt(line, 200)).toMatchObject({ changes: 1, slice: 3 });
    expect(progressAt(line, -5)).toMatchObject({ slice: 0, changes: 0 });
    const empty = timelineOf(record([part(0, 'click', 'delete-button')], 60_000).closed[0]!);
    expect(progressAt(empty, -5)).toEqual({ sent: [], returned: [], changes: 0, slice: -1 });
  });
});

describe('道具は、言語を選ばない（docs/24。docs/27 の条件 11）', () => {
  it('ライブの純粋な計算のコードに、特定の言語やフレームワークの名前が無い', async () => {
    // 名前の一覧は、手順書のテスト（packages/core の atlas-guide.test.ts）と同じもの
    const names =
      /\b(React|Vue|Svelte|Angular|Next\.?js|Nuxt|TypeScript|JavaScript|Python|Java|Kotlin|Swift|PHP|Ruby|Rails|Laravel|Django|Flask|FastAPI|Spring|Express|WordPress|Golang|Rust|Terraform|SQL|GraphQL|JSX|TSX)\b/i;
    const { readdirSync } = await import('node:fs');
    const dir = fileURLToPath(new URL('../live/', import.meta.url));
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(5);
    for (const f of files)
      expect(readFileSync(`${dir}${f}`, 'utf8').match(names)?.[0], f).toBeUndefined();
  });
});

describe('stepTimings: 経路の段が、時間の軸のどこで光るか', () => {
  const view = behaviorView(graph, 'post-comment')!;
  const op = record(postEvents, 60_000).closed[0]!;
  const line = timelineOf(op);
  const verdict = matchRequests(view, op.requests);
  const timings = stepTimings(view, verdict, line);

  it('通信の段は、実際に送った時刻と、返事が来た時刻。奥の段は、その通信の中に並ぶ。手前の段は、返事のあと', () => {
    const at = (i: number) => timings.find((t) => t.index === i)!;
    // 段 0: 投稿の POST（5〜505ms）、段 1: 受け口 → データの置き場（POST の中）
    expect(at(0)).toMatchObject({ observed: true, request: 'r1', sendAt: 5, backAt: 505 });
    expect(at(1).observed).toBe(false);
    expect(at(1).sendAt).toBeGreaterThan(5);
    expect(at(1).sendAt).toBeLessThan(255);
    // 段 2: 返ってから、読み直しを呼ぶ（POST の返事のあと）
    expect(at(2)).toMatchObject({ observed: false, sendAt: 505 });
    // 段 3: 読み直しの GET（510〜730ms）、段 4: その中、段 5〜7: 返ってから描く
    expect(at(3)).toMatchObject({ observed: true, request: 'r2', sendAt: 510, backAt: 730 });
    expect(at(4).sendAt).toBeGreaterThan(510);
    expect(at(4).backAt).toBeGreaterThan(at(4).sendAt!);
    expect(at(4).backAt).toBeLessThan(730);
    for (const i of [5, 6, 7]) expect(at(i).sendAt).toBe(730);
  });

  it('出なかった通信の段は、光らず、印が付く。返らない通信は、行きだけ光る', () => {
    const lone = record(
      [part(0, 'submit', 'comment-form'), req(5, 'r1', 'POST /api/comments')],
      60_000,
    ).closed[0]!;
    const t = stepTimings(view, matchRequests(view, lone.requests), timelineOf(lone));
    expect(t[0]).toMatchObject({ observed: true, sendAt: 5 });
    expect(t[0]!.backAt).toBeUndefined();
    expect(t.find((x) => x.index === 3)).toMatchObject({ observed: false, missing: true });
    expect(t.find((x) => x.index === 3)!.sendAt).toBeUndefined();
  });
});
