// 配線図のメモの規則（docs/18 §3.4）: 角を折る箱、孤立メモ（箱・型・group の id を見る）、札に並べるメモ、折った角の形
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { GraphV2 } from '@stack-atlas/schema';
import { indexGraph } from '@stack-atlas/wiring';
import { SAMPLE_V2_PATH } from '../graph/testSample';
import { FOLD, memoBoxIds, memoFold, memoOrphans, memoTargets } from './memoRules';

const graph = JSON.parse(readFileSync(SAMPLE_V2_PATH, 'utf8')) as GraphV2;
const index = indexGraph(graph);

describe('memoBoxIds（右下の角を折る箱）', () => {
  it('箱 id か group にメモがある箱。空白だけのメモは無いのと同じ。host の枠は箱ではないので入れない', () => {
    const ids = memoBoxIds(index, {
      'route:/': '画面のメモ',
      'web/src/feature/spend': 'group のメモ',
      'fn:toTodayView': '  \n',
      'infra:lambda_api/api': '枠のメモ',
      'gone:box': '孤立',
    });
    expect([...ids].sort()).toEqual([
      'fn:createTransaction',
      'fn:getToday',
      'fn:toTodayView',
      'route:/',
    ]);
  });
  it('group が箱 id と同じなら箱のメモとして扱う（同じメモを 2 回数えない）', () => {
    const g = structuredClone(graph);
    g.nodes.find((n) => n.id === 'route:/')!.group = 'route:/';
    const i = indexGraph(g);
    expect([...memoBoxIds(i, { 'route:/': 'x' })]).toEqual(['route:/']);
    expect(memoTargets(i, { kind: 'box', id: 'route:/' }, { 'route:/': 'x' })).toHaveLength(1);
  });
});

describe('memoOrphans（孤立メモ）', () => {
  it('箱（host の枠を含む）・型・group のどれでもない id だけ。id の昇順', () => {
    expect(
      memoOrphans(index, {
        'zzz:gone': 'a',
        'route:/': 'b',
        'type:Entry': 'c',
        'web/src/components': 'd',
        'infra:aurora/this': 'e',
        'aaa:gone': 'f',
        'empty:gone': ' ',
      }),
    ).toEqual(['aaa:gone', 'zzz:gone']);
  });
});

describe('memoTargets（札に並べるメモ）', () => {
  const memos = { 'web/src/feature/spend': 'group のメモ', 'type:Entry': '型のメモ' };
  it('箱: その箱（メモが無くても書けるよう出す）＋ group のメモがあれば group', () => {
    expect(memoTargets(index, { kind: 'box', id: 'fn:getToday' }, memos)).toEqual([
      { id: 'fn:getToday', label: 'getToday', role: 'box' },
      { id: 'web/src/feature/spend', label: 'web/src/feature/spend', role: 'group' },
    ]);
    // group にメモが無ければ箱だけ
    expect(memoTargets(index, { kind: 'box', id: 'route:/' }, memos)).toEqual([
      { id: 'route:/', label: '/', role: 'box' },
    ]);
  });
  it('項目はその箱、host の枠はその箱、型の横断面は型の id。線の選択と選択なしは出さない', () => {
    expect(
      memoTargets(index, { kind: 'item', ref: 'fn:toTodayView#in/today' }, memos).map((t) => t.id),
    ).toEqual(['fn:toTodayView', 'web/src/feature/spend']);
    expect(memoTargets(index, { kind: 'host', id: 'infra:lambda_api/api' }, memos)).toEqual([
      { id: 'infra:lambda_api/api', label: 'Lambda api', role: 'box' },
    ]);
    expect(memoTargets(index, { kind: 'type', typeRef: 'type:Entry' }, memos)).toEqual([
      { id: 'type:Entry', label: 'Entry', role: 'type' },
    ]);
    const w = graph.wires[0]!;
    expect(memoTargets(index, { kind: 'wire', from: w.from, to: w.to }, memos)).toEqual([]);
    expect(memoTargets(index, null, memos)).toEqual([]);
    expect(memoTargets(index, { kind: 'box', id: 'nope' }, memos)).toEqual([]);
  });
});

describe('memoFold（右下の角を折った形）', () => {
  it('切る線は右辺と下辺の FOLD px の所を結ぶ。clipPath は箱の外へ広げる。折り返しは切った線を斜辺にした三角形', () => {
    const b = { x: 100, y: 50, w: 300, h: 120 };
    const { clip, fold } = memoFold(b);
    const pts = (d: string) =>
      [...d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    const c = pts(clip);
    // 斜めの辺の 2 点は x + y = 右下の角 − FOLD の上
    const corner = b.x + b.w + b.y + b.h;
    expect(c[2]![0]! + c[2]![1]!).toBeCloseTo(corner - FOLD);
    expect(c[3]![0]! + c[3]![1]!).toBeCloseTo(corner - FOLD);
    // 箱の外に広げている（光る箱の drop-shadow を切らない）
    expect(c[0]![0]!).toBeLessThan(b.x);
    expect(c[0]![1]!).toBeLessThan(b.y);
    expect(c[1]![0]!).toBeGreaterThan(b.x + b.w);
    expect(c[4]![1]!).toBeGreaterThan(b.y + b.h);
    expect(pts(fold)).toEqual([
      [b.x + b.w - FOLD, b.y + b.h],
      [b.x + b.w - FOLD, b.y + b.h - FOLD],
      [b.x + b.w, b.y + b.h - FOLD],
    ]);
  });
});

describe('group が継承したプロパティの名前（constructor・__proto__・toString。8-3c のセキュリティレビュー）', () => {
  // 以前は memos[group]?.trim() が Object.prototype の関数・オブジェクトを拾って TypeError になり、配線図ごと落ちた
  for (const group of ['constructor', '__proto__', 'toString']) {
    it(`group "${group}": 落ちず、メモが無い group として扱う。書けば箱の角が折れる`, () => {
      const g = structuredClone(graph);
      g.nodes.find((n) => n.id === 'route:/')!.group = group;
      const i = indexGraph(g);
      expect([...memoBoxIds(i, {})]).toEqual([]);
      expect(memoTargets(i, { kind: 'box', id: 'route:/' }, {})).toEqual([
        { id: 'route:/', label: '/', role: 'box' },
      ]);
      expect(memoOrphans(i, {})).toEqual([]);
      if (group === '__proto__') return; // __proto__ は通常のオブジェクトの自分のキーにできない（memos.json の読み込みで捨てる）
      const memos = { [group]: 'group のメモ' };
      expect([...memoBoxIds(i, memos)]).toEqual(['route:/']);
      expect(memoTargets(i, { kind: 'box', id: 'route:/' }, memos).map((t) => t.role)).toEqual([
        'box',
        'group',
      ]);
      expect(memoOrphans(i, memos)).toEqual([]);
    });
  }
});
