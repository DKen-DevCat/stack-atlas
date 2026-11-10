// 起動と、読んだ graph をどの画面で開くかの振り分け（DOM に触らない。単体テストできる）。
// 3D の地図（v1）は WebGL が要るが、配線図（v2）は SVG なので要らない。WebGL が無くても空の案内・ファイル選択・
// ドロップは出し、v1 の graph を開こうとしたときだけ「WebGL が使えない」と出す（2026-11-09 のレビュー指摘）

/** WebGL が無いときに空の案内に添える一文 */
export const NO_WEBGL_NOTE =
  'このブラウザでは WebGL が使えないため、3D マップ（version 1 の graph.json）は表示できません。version 2 の graph.json は配線図で開けます。';

export type StartPlan =
  /** 空の案内（ファイル選択・ドロップ・サンプル）。note は案内に添える一文 */
  | { kind: 'empty'; note?: string }
  /** ?graph= の graph を読む */
  | { kind: 'load' };

/** 起動時に何を出すか。どちらの場合もドロップは受け付ける（main.ts が先に入れる） */
export function startPlan(hasGraphUrl: boolean, webgl: boolean): StartPlan {
  if (hasGraphUrl) return { kind: 'load' };
  return webgl ? { kind: 'empty' } : { kind: 'empty', note: NO_WEBGL_NOTE };
}

export type ViewKind =
  /** 2 面（v2 で WebGL がある。左に 3D の地図、右に配線図。Phase 8-6、docs/20） */
  | 'split'
  /** 配線図だけ（v2 で WebGL が無い・`?pane=wiring`） */
  | 'wiring'
  /** 3D の地図だけ（v1。ドロップ・`--v1`・race-site・`?graph=graph.v1.json`。今までどおり） */
  | 'map'
  /** v1 だが WebGL が無い */
  | 'no-webgl'
  /** 描ける graph が無い（一覧のエラーを見る） */
  | 'unrenderable';

/**
 * 読んだ graph をどこで開くか。v2 は WebGL があれば 2 面（wiringOnly = `?pane=wiring` なら配線図だけ）、無ければ配線図だけ。
 * v1 は今までどおり 3D の地図だけ（docs/20 §5.1 #14）
 */
export function viewFor(
  res: { v2?: boolean; graph?: unknown },
  webgl: boolean,
  wiringOnly = false,
): ViewKind {
  if (res.v2) return webgl && !wiringOnly ? 'split' : 'wiring';
  if (!res.graph) return 'unrenderable';
  return webgl ? 'map' : 'no-webgl';
}
