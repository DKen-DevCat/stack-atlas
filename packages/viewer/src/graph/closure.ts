/**
 * ハイライト規則（docs/05-viewer-spec.md「ハイライト規則」）。GraphModel だけを引数にとる純関数。
 *
 * - down(a): a から出る flow を 1 ホップ ＋ uses/deploy/http/schema を推移的に
 * - up(a):   a に入る flow を 1 ホップ ＋ uses/deploy/http を逆向きに推移的に（schema はたどらない）
 *
 * flow で 1 ホップ加えたノードからは、さらにたどらない（flow の先の推移閉包は含めない）。
 */
import type { Edge } from '@stack-atlas/schema';
import type { GraphModel } from './model';

export type Direction = 'down' | 'up';

export const DOWN_KINDS: ReadonlySet<string> = new Set(['uses', 'deploy', 'http', 'schema']);
export const UP_KINDS: ReadonlySet<string> = new Set(['uses', 'deploy', 'http']);

export function closure(model: GraphModel, id: string, dir: Direction): Set<string> {
  const seen = new Set<string>();
  const n0 = model.byId.get(id);
  if (!n0) return seen;
  if (dir === 'down') {
    for (const e of n0.out) if (e.kind === 'flow') seen.add(e.to);
  } else {
    for (const e of n0.inn) if (e.kind === 'flow') seen.add(e.from);
  }
  const kinds = dir === 'down' ? DOWN_KINDS : UP_KINDS;
  const stack = [id];
  while (stack.length) {
    const cur = model.byId.get(stack.pop()!);
    if (!cur) continue;
    for (const e of dir === 'down' ? cur.out : cur.inn) {
      if (!kinds.has(e.kind)) continue;
      const next = dir === 'down' ? e.to : e.from;
      if (next !== id && !seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  seen.delete(id);
  return seen;
}

export interface Highlight {
  /** ハイライト対象（ホバー中、なければ選択中）。null ならハイライトなし */
  a: string | null;
  down: ReadonlySet<string>;
  up: ReadonlySet<string>;
}

export const NO_HIGHLIGHT: Highlight = { a: null, down: new Set(), up: new Set() };

export function computeHighlight(model: GraphModel, a: string | null): Highlight {
  if (!a || !model.byId.has(a)) return NO_HIGHLIGHT;
  return { a, down: closure(model, a, 'down'), up: closure(model, a, 'up') };
}

/**
 * エッジを赤（down）・橙（up）にするか。プロトタイプの dHit / uHit と同じ。
 * - down: from が a か down に含まれ、to が down に含まれる（kind が DOWN_KINDS か、from が a の flow）
 * - up:   to が a か up に含まれ、from が up に含まれる（kind が UP_KINDS か、to が a の flow）
 */
export function edgeHighlight(hl: Highlight, edge: Edge): Direction | null {
  const { a, down, up } = hl;
  if (!a) return null;
  const dHit =
    (edge.from === a || down.has(edge.from)) &&
    down.has(edge.to) &&
    (DOWN_KINDS.has(edge.kind) || edge.from === a);
  if (dHit) return 'down';
  const uHit =
    (edge.to === a || up.has(edge.to)) &&
    up.has(edge.from) &&
    (UP_KINDS.has(edge.kind) || edge.to === a);
  if (uHit) return 'up';
  return null;
}
