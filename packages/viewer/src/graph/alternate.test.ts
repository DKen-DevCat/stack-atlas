import { describe, expect, it } from 'vitest';
import { alternateGraph, graphExists } from './alternate';

const PAGE = 'http://localhost:4173/index.html?graph=./graph.json';

describe('alternateGraph（build の graph.json ↔ graph.v1.json）', () => {
  it('v2 の graph.json → 3D の地図（graph.v1.json）。?graph= の相対パスの書き方を保つ', () => {
    expect(alternateGraph('http://localhost:4173/graph.json', PAGE, 2)).toEqual({
      url: 'http://localhost:4173/graph.v1.json',
      href: 'http://localhost:4173/index.html?graph=.%2Fgraph.v1.json',
      label: '3D の地図',
    });
  });

  it('v1 の graph.v1.json → 配線図（graph.json）。?prev=（差分は v1 の地図だけ）は外す', () => {
    const page = 'http://h/out/index.html?graph=maps%2Fbuilt%2Fgraph.v1.json&prev=old.json#x';
    expect(alternateGraph('http://h/out/maps/built/graph.v1.json', page, 1)).toEqual({
      url: 'http://h/out/maps/built/graph.json',
      href: 'http://h/out/index.html?graph=maps%2Fbuilt%2Fgraph.json',
      label: '配線図',
    });
  });

  it('build の名前でない graph（サンプル・手書き）と、名前と version が合わないものは null', () => {
    expect(alternateGraph('http://h/samples/race-site.graph.json', PAGE, 1)).toBeNull();
    expect(alternateGraph('http://h/samples/fixture-poly.today.v2.json', PAGE, 2)).toBeNull();
    // v1 の graph.json（--v1 の build や 8-1 より前の build）は行き来しない
    expect(alternateGraph('http://h/graph.json', PAGE, 1)).toBeNull();
    expect(alternateGraph('http://h/graph.v1.json', PAGE, 2)).toBeNull();
    expect(alternateGraph('not a url', PAGE, 2)).toBeNull();
  });

  it('?graph= が別の書き方（絶対 URL・クエリ付き）なら絶対 URL にする', () => {
    const page = 'http://h/index.html?graph=http%3A%2F%2Fcdn%2Fa%2Fgraph.json%3Fv%3D1';
    expect(alternateGraph('http://cdn/a/graph.json?v=1', page, 2)?.href).toBe(
      'http://h/index.html?graph=http%3A%2F%2Fcdn%2Fa%2Fgraph.v1.json%3Fv%3D1',
    );
  });
});

describe('graphExists（HEAD の応答）', () => {
  const res = (ok: boolean, type: string | null) => ({
    ok,
    headers: { get: () => type },
  });
  it('200 の JSON はある、404 は無い', () => {
    expect(graphExists(res(true, 'application/json; charset=utf-8'))).toBe(true);
    expect(graphExists(res(true, null))).toBe(true);
    expect(graphExists(res(false, 'application/json'))).toBe(false);
  });
  it('SPA の fallback（無いパスに index.html を 200 で返す）は無いとみなす', () => {
    expect(graphExists(res(true, 'text/html; charset=utf-8'))).toBe(false);
  });
});
