// 2 面（3D の地図 ⇄ 配線図。Phase 8-6、docs/20）の写しの規則。DOM に触らない（単体テストできる）。
// - 地図のノードのクリック → 配線図の選択（docs/20 §5.1 #7）。箱そのもの・host はそのまま、group は中の箱ごとにたどる
// - `?sel=`（docs/20 §5.1 #16）: 箱・地図のノード・host の id。解ける `?view=` が勝つ。選択から書く値は、箱・host・地図の group だけ
// - メモのキー（docs/20 §5.1 #2）: projectMap の memoKey（箱・host は id、group は group の値そのもの。配線図と同じキー）
// - 流れ（D106）: schedule が変わったときだけ mapFlow を作り直す（シーク・一時停止・再生は時刻だけ）
// - 地図のスクショ: 配線図の画面の HTML と同じ制限（graph.json からの相対パスで、同じ origin の graph.json のディレクトリの下）
import type { Graph, GraphV2, ValidationIssue } from '@stack-atlas/schema';
import {
  findView,
  mapFlow,
  type MapFlow,
  type MapProjection,
  type Schedule,
  type Selection,
} from '@stack-atlas/wiring';
import { screenSrc } from '../wiring/screens';

/** メモのキー（地図のノードの id → 箱・host は id、group は group の値そのもの。@runtime の写しも元のキー） */
export const memoKeyOf = (p: Pick<MapProjection, 'memoKey'>, id: string): string =>
  p.memoKey.get(id) ?? id;

/** 地図のノード → 配線図の選択。地図に無いノードは null */
export function selectionForUnit(p: MapProjection, unit: string): Selection | null {
  const kind = p.unitKind.get(unit);
  if (kind === 'box') return { kind: 'box', id: unit };
  if (kind === 'host') return { kind: 'host', id: unit };
  if (kind === 'group') {
    const name = p.graph.nodes.find((n) => n.id === unit)?.name;
    // id はメモの札のキー（group の値そのもの）。どの写しを選んだかは members で分かる
    return {
      kind: 'group',
      id: memoKeyOf(p, unit),
      members: p.members.get(unit) ?? [],
      ...(name ? { label: name } : {}),
    };
  }
  return null;
}

/**
 * `?sel=` の値 → 配線図の選択。地図のノード（`group:` の付いた id・`@runtime` の写し・host も）を先に見て、次に箱。
 * 解けなければ null（中の箱の無い host は地図のノードにならず、配線図でも選べないので解かない）
 */
export function resolveSel(
  p: MapProjection,
  g: Pick<GraphV2, 'nodes'>,
  raw: string,
): Selection | null {
  if (!raw) return null;
  if (p.unitKind.has(raw)) return selectionForUnit(p, raw);
  if (g.nodes.some((n) => n.id === raw)) return { kind: 'box', id: raw };
  return null;
}

/** 開いた直後の選択（`?view=`・`?sel=`）の決め方 */
export interface InitialSelection {
  /** 開いた直後に選ぶもの（解けた `?sel=`） */
  select?: Selection;
  /** 警告の一覧に足すもの（解けない `?sel=`） */
  issue?: ValidationIssue;
  /** URL から `?sel=` を外す（解けない値・解ける `?view=` に負けた値） */
  dropSel: boolean;
}

/**
 * `?view=` と `?sel=` から開いた直後の選択を決める（§5.1 #16）。`?view=` が勝つのは graph の views で解けるときだけ。
 * 解けない `?view=`（配線図が警告して URL から外す）のときは `?sel=` を当てる
 */
export function initialSelection(
  p: MapProjection,
  g: Pick<GraphV2, 'nodes' | 'views'>,
  sel: string | undefined,
  view: string | undefined,
): InitialSelection {
  if (!sel) return { dropSel: false };
  if (view !== undefined && findView(g.views, view)) return { dropSel: true };
  const r = resolveSel(p, g, sel);
  if (r) return { select: r, dropSel: false };
  return {
    issue: {
      level: 'warning',
      path: '?sel',
      message: `選択 "${sel}" は graph.json の箱・地図のノード・host にありません`,
    },
    dropSel: true,
  };
}

/** 配線図の選択 → `?sel=` の値。箱・host・地図の group だけ（項目・線・型の選択は書かない = null） */
export function selParam(p: MapProjection, sel: Selection | null): string | null {
  if (!sel) return null;
  if (sel.kind === 'box' || sel.kind === 'host') return sel.id;
  if (sel.kind === 'group') {
    const m = sel.members[0];
    return (m !== undefined ? p.unitOf.get(m) : undefined) ?? sel.id;
  }
  return null;
}

/** `?pane=wiring` で配線図だけ（e2e の 1 面のテストと、2 面を使わないとき。docs/20 §5.1 #17） */
export function wiringOnly(search: string): boolean {
  return new URLSearchParams(search).get('pane') === 'wiring';
}

/**
 * 地図のノードのメモのキー（孤立メモの判定と「移す…」の候補に足す。docs/20 §5.1 #12）。キーはメモのキー（group は値そのもの）で、
 * 名前は地図のノードの名前。`@runtime` の写しは地図に別のノードとして出るが、メモは元と同じキーなので候補に出さない
 */
export function mapTargets(p: MapProjection): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  const seen = new Set<string>();
  for (const n of p.graph.nodes) {
    if (p.copies.has(n.id)) continue;
    const id = memoKeyOf(p, n.id);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: n.name });
  }
  return out;
}

/**
 * 配線図の schedule → 地図の流れ（D106）。schedule が変わったとき（新しい選択・分岐・速さ）だけ mapFlow を作り直し、
 * 同じ schedule（シーク・一時停止・再生・バーを離した）は前の流れを返す
 */
export function flowCache(p: MapProjection): {
  get(s: Schedule | null): MapFlow | null;
  /** mapFlow を作った回数（テスト・デバッグ用） */
  readonly builds: number;
} {
  let last: Schedule | null = null;
  let flow: MapFlow | null = null;
  let builds = 0;
  return {
    get(s) {
      if (s === last) return flow;
      last = s;
      flow = s ? mapFlow(p, s) : null;
      if (s) builds++;
      return flow;
    },
    get builds() {
      return builds;
    },
  };
}

/**
 * 地図に渡す前に、画面のスクショのパスを配線図の画面の HTML と同じ規則（screenSrc）で絞る: graph.json からの相対パスで、
 * 解いた先がビューアと同じ origin の graph.json のディレクトリの下のものだけ残し、ほかは外す（プレースホルダになる）。
 * v2 の graph.json は配線図と地図の両方の入力なので、地図だけ絶対 URL（外への読み込み）を許さない
 */
export function restrictScreenshots(
  g: Graph,
  baseUrl: string | undefined,
  pageHref: string,
): Graph {
  let changed = false;
  const nodes = g.nodes.map((n) => {
    const shot = n.screen?.screenshot;
    if (shot === undefined || 'src' in screenSrc(shot, baseUrl, pageHref)) return n;
    changed = true;
    const screen = { ...n.screen! };
    delete screen.screenshot;
    return { ...n, screen };
  });
  return changed ? { ...g, nodes } : g;
}
