/**
 * ノード kind → 表示メタ（日本語名・色・ボックスの大きさ）のレジストリ。
 * プロトタイプの KIND 表を移植したもの。未知の kind は汎用ボックスで描く（前方互換）。
 * graph.json の `kinds`（docs/03）があれば、その名前・色・大きさで上書き・追加する（createKindRegistry）。
 */
import type { KindDefinition } from '@stack-atlas/schema';

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
  endpoint: { ja: 'API エンドポイント', color: '#38bdf8', size: [2.2, 0.3, 1.4] },
  queue: { ja: 'キュー', color: '#f59e0b', size: [2.2, 0.8, 1.4] },
  db: { ja: 'データベース', color: '#4ade80', size: [2.4, 1.0, 1.8] },
  cron: { ja: 'スケジュール', color: '#fb7185', size: [1.8, 0.6, 1.2] },
  service: { ja: 'サービス', color: '#ff9f43', size: [2.4, 0.9, 1.6] },
};

/** screen フィールドがなくても画面として描く kind（docs/08 D3） */
export const SCREEN_KINDS: ReadonlySet<string> = new Set(['page', 'layout']);

/** kind → 表示メタ */
export type KindRegistry = (kind: string) => KindMeta;

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const isSize = (v: unknown): v is [number, number, number] =>
  Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && x > 0);

/** 既定（KINDS）または汎用ボックスに graph.kinds の 1 件を重ねる。形の違う値は無視する */
function withDefinition(base: KindMeta, def: KindDefinition | undefined): KindMeta {
  if (!def) return base;
  return {
    ja: typeof def.name === 'string' && def.name ? def.name : base.ja,
    color: typeof def.color === 'string' && COLOR_RE.test(def.color) ? def.color : base.color,
    size: isSize(def.size) ? def.size : base.size,
  };
}

function builtin(kind: string): KindMeta {
  const known = Object.prototype.hasOwnProperty.call(KINDS, kind) ? KINDS[kind] : undefined;
  return known ?? { ja: kind, color: '#9ca3af', size: DEFAULT_SIZE };
}

/** graph.kinds を既定の表にマージしたレジストリを作る */
export function createKindRegistry(defs?: Readonly<Record<string, KindDefinition>>): KindRegistry {
  const cache = new Map<string, KindMeta>();
  return (kind) => {
    let m = cache.get(kind);
    if (!m) {
      const def = defs && Object.prototype.hasOwnProperty.call(defs, kind) ? defs[kind] : undefined;
      m = withDefinition(builtin(kind), def);
      cache.set(kind, m);
    }
    return m;
  };
}

/** kind の表示メタ。defs（graph.kinds）があれば上書きする */
export function kindMeta(kind: string, defs?: Readonly<Record<string, KindDefinition>>): KindMeta {
  const def = defs && Object.prototype.hasOwnProperty.call(defs, kind) ? defs[kind] : undefined;
  return withDefinition(builtin(kind), def);
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
