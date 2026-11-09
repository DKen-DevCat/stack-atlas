// 起動と画面の振り分け: WebGL が無くても空の案内（ファイル選択・ドロップ）を出し、v2 は配線図で開ける
import { describe, expect, it } from 'vitest';
import { NO_WEBGL_NOTE, startPlan, viewFor } from './startup';

describe('startPlan', () => {
  it('?graph= が無い: WebGL が無くても空の案内を出す（その旨を添える）。v2 をファイル選択・ドロップで開けるように', () => {
    expect(startPlan(false, false)).toEqual({ kind: 'empty', note: NO_WEBGL_NOTE });
    expect(startPlan(false, true)).toEqual({ kind: 'empty' });
  });

  it('?graph= がある: WebGL の有無に依らず読む（v1 か v2 かは読んでから決める）', () => {
    expect(startPlan(true, false)).toEqual({ kind: 'load' });
    expect(startPlan(true, true)).toEqual({ kind: 'load' });
  });
});

describe('viewFor', () => {
  it('v2 は WebGL が無くても配線図', () => {
    expect(viewFor({ v2: true }, false)).toBe('wiring');
    expect(viewFor({ v2: true, graph: {} }, true)).toBe('wiring');
  });

  it('v1 は WebGL があれば 3D の地図、無ければ「WebGL が使えない」', () => {
    expect(viewFor({ graph: {} }, true)).toBe('map');
    expect(viewFor({ graph: {} }, false)).toBe('no-webgl');
  });

  it('描ける graph が無ければ WebGL の有無に依らず一覧のエラーを見せる', () => {
    expect(viewFor({}, true)).toBe('unrenderable');
    expect(viewFor({}, false)).toBe('unrenderable');
  });
});
