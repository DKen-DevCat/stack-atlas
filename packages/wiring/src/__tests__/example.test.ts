// 例の v2 グラフ（examples/fixture-poly.today.v2.json）のたどり。D42 改訂（S3 は配信元の箱、画面は枠を持たない）と分岐
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { GraphV2 } from '@stack-atlas/schema';
import { indexGraph } from '../graph-index.js';
import { drawnBalls, schedule } from '../schedule.js';
import { select } from '../select.js';
import { defaultState, variantKey } from '../variants.js';

const examplePath = fileURLToPath(
  new URL('../../../../examples/fixture-poly.today.v2.json', import.meta.url),
);
const index = indexGraph(JSON.parse(readFileSync(examplePath, 'utf8')) as GraphV2);
const CF_HIT = variantKey('infra:static_site/this', 'hit');
const LOGIN = variantKey('endpoint:GET /today', 'login');
const TODAY_PATH = [
  'route:/',
  'comp:TodayIsland',
  'fn:getToday',
  'lib:fetcher',
  'endpoint:GET /today',
  'fn:internal/api.handleToday',
  'fn:internal/store.ListByDate',
  'schema:transactions',
  'fn:toTodayView',
  'comp:TotalCard',
  'comp:EntryList',
];
const POST_PATH = [
  'endpoint:POST /transactions',
  'fn:createTransaction',
  'fn:internal/api.handleCreateTransaction',
  'fn:internal/store.InsertTransaction',
];

describe('例の v2 グラフ: 画面をクリック', () => {
  it('既定（CloudFront MISS・ログイン済み）: 配信（利用者 → CloudFront → S3）と /today の経路が光り、POST /transactions は光らない', () => {
    const lit = select(index, defaultState(index), { kind: 'box', id: 'route:/' })!;
    for (const id of [
      ...TODAY_PATH,
      'actor:user',
      'infra:static_site/this',
      'infra:static_site/site',
    ])
      expect(lit.boxes.has(id), id).toBe(true);
    for (const id of POST_PATH) expect(lit.boxes.has(id), id).toBe(false);
    // 球は画面から出る（画面の中の対応は時間 0）
    const s = schedule(lit, lit.flowStarts, { startBoxes: lit.startBoxes });
    const first = s.balls.filter((b) => b.seg.kind === 'wire').sort((a, b) => a.t0 - b.t0)[0]!;
    expect(first.t0).toBe(0);
    expect(first.seg.from.node.id).toBe('route:/');
    // 見つかったこと: 親（getToday#out/call_1）に着いた対応の先で、子（call_1.url）に引かれた線へ球が続く。
    // 以前は項目の ref が一致する区間しかつながらず、getToday の中で流れが止まっていた
    const reached = new Set(s.balls.map((b) => b.seg.to.node.id));
    for (const id of [
      'endpoint:GET /today',
      'fn:internal/api.handleToday',
      'schema:transactions',
      'comp:TotalCard',
      'comp:EntryList',
    ])
      expect(reached.has(id), id).toBe(true);
    const http = s.balls.find((b) => b.seg.from.ref === 'fn:getToday#out/call_1.url')!;
    const into = s.balls.find(
      (b) => b.seg.kind === 'link' && b.seg.to.ref === 'fn:getToday#out/call_1',
    )!;
    expect(http.t0).toBeCloseTo(into.t0 + into.dur);
    // 描く球は線ごとに 1 つ（最も早い区間）。getToday の戻りは return・total・entries の 3 区間が同じ線を通る
    const drawn = drawnBalls(s).filter((b) => b.seg.kind === 'wire');
    const keys = drawn.map((b) => b.seg.wire!.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(keys)).toEqual(
      new Set(s.balls.filter((b) => b.seg.kind === 'wire').map((b) => b.seg.wire!.key)),
    );
    const ret = s.balls.filter(
      (b) => b.seg.kind === 'wire' && b.seg.wire!.wire.from === 'fn:getToday#out/return',
    );
    expect(ret.length).toBeGreaterThan(1);
    const kept = drawn.find((b) => b.seg.wire!.wire.from === 'fn:getToday#out/return')!;
    expect(kept.t0).toBe(Math.min(...ret.map((b) => b.t0)));
  });

  it('CloudFront HIT: S3 は光らず、CloudFront が画面の in/html へ折り返して、画面と下流は光ったまま', () => {
    const state = { ...defaultState(index), [CF_HIT]: true };
    const lit = select(index, state, { kind: 'box', id: 'route:/' })!;
    expect(lit.boxes.has('infra:static_site/site')).toBe(false);
    expect(lit.boxes.has('infra:static_site/this')).toBe(true);
    expect(
      lit.links.has(
        'L:infra:static_site/this|infra:static_site/this#in/key|infra:static_site/this#out/value',
      ),
    ).toBe(true);
    for (const id of TODAY_PATH) expect(lit.boxes.has(id), id).toBe(true);
    // 利用者から始めても画面まで届く
    const fromUser = select(index, state, { kind: 'box', id: 'actor:user' })!;
    for (const id of TODAY_PATH) expect(fromUser.boxes.has(id), id).toBe(true);
    expect(fromUser.boxes.has('infra:static_site/site')).toBe(false);
  });

  it('未ログイン（認証の middleware が 401）: GET /today の先（handler・store・テーブル）は光らない', () => {
    const state = { ...defaultState(index), [LOGIN]: false };
    const lit = select(index, state, { kind: 'box', id: 'route:/' })!;
    expect(lit.boxes.has('endpoint:GET /today')).toBe(true);
    for (const id of [
      'fn:internal/api.handleToday',
      'fn:internal/store.ListByDate',
      'schema:transactions',
    ])
      expect(lit.boxes.has(id), id).toBe(false);
  });
});
