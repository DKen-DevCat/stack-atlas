/**
 * ノード kind → 表示メタ（日本語名・色・ボックスの大きさ）のレジストリ。
 * プロトタイプの KIND 表を移植したもの。未知の kind は汎用ボックスで描く（前方互換）。
 */

export interface KindMeta {
  /** パネルに出す日本語名 */
  ja: string;
  /** `#rrggbb` */
  color: string;
  /** ボックスの大きさ [x, y, z]。画面ノードとして描く kind では使わない */
  size: readonly [number, number, number];
}

const DEFAULT_SIZE = [2.0, 0.5, 1.3] as const;

export const KINDS: Readonly<Record<string, KindMeta>> = {
  actor: { ja: 'クライアント', color: '#cbd5e1', size: [1.6, 1.0, 1.6] },
  infra: { ja: 'インフラリソース', color: '#ff9f43', size: [2.6, 1.0, 1.8] },
  layout: { ja: 'レイアウト', color: '#6d9dff', size: DEFAULT_SIZE },
  page: { ja: '画面', color: '#4f8cff', size: DEFAULT_SIZE },
  component: { ja: 'コンポーネント', color: '#a78bfa', size: [2.0, 0.45, 1.3] },
  hook: { ja: 'hook', color: '#2dd4bf', size: [1.8, 0.45, 1.2] },
  lib: { ja: 'ライブラリ', color: '#38bdf8', size: [2.0, 0.45, 1.3] },
  type: { ja: '型定義', color: '#4ade80', size: [1.7, 0.35, 1.1] },
  schema: { ja: 'DBスキーマ', color: '#86efac', size: [1.9, 0.35, 1.2] },
  handler: { ja: 'APIハンドラ', color: '#38bdf8', size: [2.2, 0.5, 1.4] },
};

/** screen フィールドがなくても画面として描く kind（docs/08 D3） */
export const SCREEN_KINDS: ReadonlySet<string> = new Set(['page', 'layout']);

export function kindMeta(kind: string): KindMeta {
  return KINDS[kind] ?? { ja: kind, color: '#9ca3af', size: DEFAULT_SIZE };
}

/** 層内の線の色（kind 別）。層またぎの線は上の層の色を使う */
export const EDGE_KIND_COLORS: Readonly<Record<string, string>> = {
  flow: '#ff9f43',
  deploy: '#8aa4ff',
  uses: '#9ca3af',
  http: '#38bdf8',
  schema: '#4ade80',
};

export const EDGE_KIND_OPACITY: Readonly<Record<string, number>> = {
  flow: 0.6,
  deploy: 0.3,
  uses: 0.28,
  http: 0.5,
  schema: 0.35,
};

export function edgeKindStyle(kind: string): { color: string; opacity: number } {
  return { color: EDGE_KIND_COLORS[kind] ?? '#9ca3af', opacity: EDGE_KIND_OPACITY[kind] ?? 0.28 };
}

/** キャッシュ tone → 色 */
export const TONE_COLORS: Readonly<Record<string, string>> = {
  ok: '#4ade80',
  warn: '#fbbf24',
  off: '#6b7280',
  info: '#38bdf8',
};
