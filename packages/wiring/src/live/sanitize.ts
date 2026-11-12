/**
 * アプリの枠の中のスクリプトから来た知らせを、形と大きさを確かめてから使う（docs/27 §4.2・§5.1）。
 * アプリは、にせの知らせも送れる。合わないものは捨て、長いものは切る。知らせで変わるのは、ライブの画面の表示だけ
 */
import {
  LIVE_ACTIONS,
  type LiveAction,
  type LiveChange,
  type LiveRect,
  type LiveReport,
} from './events.js';

export const REPORT_LIMITS = {
  /** 1 つの出来事に当たる部品の数（重なった部品） */
  parts: 16,
  /** 1 回の知らせの、画面の変化の数 */
  changes: 40,
  /** 1 回の知らせの、部品の場所の数 */
  rects: 2000,
  /** 部品の id の長さ */
  id: 200,
  /** 画面の文字の長さ */
  text: 200,
  /** 道具の時計と、これ以上ずれた時刻は、道具の時計に置き換える（ミリ秒） */
  clockSkew: 60_000,
} as const;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const text = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' ? v.slice(0, max) : undefined;

function rectOf(v: unknown): LiveRect | undefined {
  if (!isObject(v)) return undefined;
  const { x, y, w, h } = v;
  return finite(x) && finite(y) && finite(w) && finite(h) && w >= 0 && h >= 0
    ? { x, y, w, h }
    : undefined;
}

function changeOf(v: unknown): LiveChange | undefined {
  if (!isObject(v)) return undefined;
  const kind = v.kind;
  if (kind !== 'added' && kind !== 'removed' && kind !== 'text') return undefined;
  const change: LiveChange = { kind, text: text(v.text, REPORT_LIMITS.text) ?? '' };
  if (kind === 'text') change.before = text(v.before, REPORT_LIMITS.text) ?? '';
  const rect = rectOf(v.rect);
  if (rect) change.rect = rect;
  return change;
}

/**
 * @param now 道具の時計（ミリ秒）。知らせの時刻が、これと大きくずれていれば、置き換える
 * @param known 図にある部品の id。無い id は捨てる（省くと、id は確かめない）
 */
export function sanitizeReport(
  raw: unknown,
  now: number,
  known?: ReadonlySet<string>,
): LiveReport | undefined {
  if (!isObject(raw)) return undefined;
  const at = finite(raw.at) && Math.abs(raw.at - now) <= REPORT_LIMITS.clockSkew ? raw.at : now;
  const knownId = (id: unknown): id is string =>
    typeof id === 'string' &&
    id.length > 0 &&
    id.length <= REPORT_LIMITS.id &&
    (known === undefined || known.has(id));

  if (raw.t === 'part') {
    if (!LIVE_ACTIONS.includes(raw.how as LiveAction) || !Array.isArray(raw.parts))
      return undefined;
    const parts = [...new Set(raw.parts.filter(knownId))].slice(0, REPORT_LIMITS.parts);
    if (parts.length === 0) return undefined;
    const rect = rectOf(raw.rect);
    return { t: 'part', at, how: raw.how as LiveAction, parts, ...(rect ? { rect } : {}) };
  }
  if (raw.t === 'dom') {
    if (!Array.isArray(raw.changes)) return undefined;
    const changes = raw.changes.slice(0, REPORT_LIMITS.changes).flatMap((c) => changeOf(c) ?? []);
    return changes.length ? { t: 'dom', at, changes } : undefined;
  }
  if (raw.t === 'parts') {
    if (!isObject(raw.rects)) return undefined;
    const rects: Record<string, LiveRect> = {};
    for (const [id, r] of Object.entries(raw.rects).slice(0, REPORT_LIMITS.rects)) {
      const rect = rectOf(r);
      if (rect && knownId(id)) rects[id] = rect;
    }
    return { t: 'parts', at, rects };
  }
  return undefined;
}
