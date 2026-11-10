// 塗りの計画（docs/18 §11.3、D115・D122）: 選択と分岐で変わる class を、箱・host・項目・線ごとに決める純関数。DOM に触らない。
// 全体を作る経路（render.ts の renderScene が markup に書く）と、付け替える経路（sceneView.ts が前の計画との差だけ当てる）の
// 両方がこれ 1 つを使う。class は「光る側」にだけ付ける（lit・on・under）。沈める側は根の has-sel と CSS の :not() で決まる。
// 入力は全部「描く索引の語彙の値」（光るもの・今の分岐に無いもの）。ここでは選ばない・分岐を解かない（select・wireActive を
// 呼ばない）。選ぶ索引と描く索引が違う場面（差分の幽霊を足した索引、折りたたみの畳んだ索引。docs/21 §2.9）でも同じ関数を使う
import {
  itemActive,
  segmentRoute,
  wireActive,
  type DiffOverlayV2,
  type GraphIndex,
  type LitSelection,
  type VariantState,
  type WiringLayout,
} from '@stack-atlas/wiring';
import { esc, pathD } from './markup';

/**
 * 前の graph との差分の印（docs/18 §3.4。@stack-atlas/wiring の diffOverlayV2）。幽霊（前にしか無いもの）は灰の点線で、
 * クリックも hover も受けない（data-box・data-item・data-wire を付けない）。今だけのもの・型の変わった項目は緑の縁
 */
export type DiffMarks = Pick<DiffOverlayV2, 'ghost' | 'added' | 'changed'>;

/**
 * 光るもの（描く索引の語彙: 箱の id・項目の ref・区間）。@stack-atlas/wiring の select の結果（LitSelection）はこれを満たす。
 * 描く索引が選ぶ索引と違うときは、呼ぶ側が写したものを渡す（折りたたみの litOn）
 */
export interface PaintLit {
  readonly boxes: ReadonlySet<string>;
  readonly startBoxes: ReadonlySet<string>;
  readonly items: ReadonlySet<string>;
  readonly startItems: ReadonlySet<string>;
  /** 光る区間（線と、箱の中の対応）。経路は配置から引く */
  readonly segs: LitSelection['segs'];
  /** 線を選んだときの、その線の区間のキー */
  readonly startSeg?: string | undefined;
  /** 選択の種類（型の横断面は項目を start にしない） */
  readonly selection: { readonly kind: string };
}

/** 今の分岐に無いもの（描く索引の語彙: 線のキーと項目の ref） */
export interface Inactive {
  readonly wires: ReadonlySet<string>;
  readonly items: ReadonlySet<string>;
}

export const NONE_INACTIVE: Inactive = { wires: new Set(), items: new Set() };

/** 描く索引と分岐の状態から、今の分岐に無い線と項目（親が無ければ子も無い）。選ぶ索引 = 描く索引のときの既定 */
export function inactiveOf(index: GraphIndex, state: VariantState): Inactive {
  const wires = new Set<string>();
  const items = new Set<string>();
  for (const w of index.wires) if (!wireActive(index, state, w)) wires.add(w.key);
  for (const it of index.items.values()) if (!itemActive(index, state, it)) items.add(it.ref);
  return { wires, items };
}

export interface PaintInput {
  /** 描く索引（差分があれば幽霊を足した graph の索引） */
  index: GraphIndex;
  layout: WiringLayout;
  lit: PaintLit | null;
  inactive: Inactive;
  diff?: DiffMarks | null;
}

/**
 * 選択と分岐で変わる class（付くものだけ。無い id は「何も付かない」）。値は空白区切りの class で、先頭に空白は無い。
 * - boxes: 光る箱 `lit`、始点は `lit start`
 * - hosts: 中の箱が 1 つでも光る host `lit`
 * - items: 光る項目 `on`（始点は `on start`。型の選択では start にしない）、今の分岐に無い項目 `off inactive`
 * - wires: 光る線の下に隠れる基の線 `under`、今の分岐に無い線 `inactive`
 * - broken: 切れた線（layout.broken のキー）。選択が無いか、送り側の箱が光るとき `lit`
 */
export interface PaintPlan {
  /** 何か選んでいる（根の has-sel。沈める側はこれで決まる） */
  readonly hasSel: boolean;
  readonly boxes: ReadonlyMap<string, string>;
  readonly hosts: ReadonlyMap<string, string>;
  readonly items: ReadonlyMap<string, string>;
  readonly wires: ReadonlyMap<string, string>;
  readonly broken: ReadonlyMap<string, string>;
  /** 光る線の層の中身（光る区間・cache の中の区間・当たり判定）。切れた線は入れない（要素ごと層を移す） */
  readonly litWires: string;
}

export const PAINT_KINDS = ['boxes', 'hosts', 'items', 'wires', 'broken'] as const;
export type PaintKind = (typeof PAINT_KINDS)[number];

/** 計画の class を markup の class 属性に足す形（先頭に空白。無ければ空） */
export const dyn = (plan: PaintPlan, kind: PaintKind, id: string): string => {
  const c = plan[kind].get(id);
  return c ? ` ${c}` : '';
};

/** markup の class から計画の class（末尾）を除いたもの = 選択・分岐に依らない class（付け替えの土台） */
export const baseClass = (cls: string, plan: PaintPlan, kind: PaintKind, id: string): string => {
  const d = dyn(plan, kind, id);
  return d && cls.endsWith(d) ? cls.slice(0, cls.length - d.length) : cls;
};

/** 付け替えたあとの class 属性（土台 ＋ 計画の class。markup に書いたときと同じ並び） */
export const paintedClass = (base: string, cls: string): string => (cls ? `${base} ${cls}` : base);

export function paintPlan(input: PaintInput): PaintPlan {
  const { index, layout, lit, inactive } = input;
  const diff = input.diff ?? null;
  const boxes = new Map<string, string>();
  const hosts = new Map<string, string>();
  const items = new Map<string, string>();
  const wires = new Map<string, string>();
  const broken = new Map<string, string>();
  let litWires = '';

  // 線: 光っている線は上の層で描くので、基の線は隠す（under）。今の分岐に無い線は inactive。幽霊の線は何も付けない
  const litWireKeys = new Set<string>();
  if (lit) for (const s of lit.segs) if (s.kind === 'wire' && s.wire) litWireKeys.add(s.wire.key);
  for (const w of index.wires) {
    if (!layout.routes.has(w.key) || diff?.ghost.wires.has(w.key)) continue;
    const c = `${litWireKeys.has(w.key) ? ' under' : ''}${inactive.wires.has(w.key) ? ' inactive' : ''}`;
    if (c) wires.set(w.key, c.slice(1));
  }
  if (lit) {
    for (const s of lit.segs) {
      const r = segmentRoute(layout, s);
      if (!r) continue;
      if (s.kind === 'wire' && s.wire) {
        const d = pathD(r.points);
        const sel = s.key === lit.startSeg ? ' sel' : '';
        litWires += `<path class="wire lit via-${esc(s.wire.wire.via)}${sel}" data-seg="${esc(s.key)}" d="${d}"/>`;
        litWires += `<path class="wire hitarea" data-wire="${s.wire.key}" d="${d}"/>`;
      } else if (s.node && s.node.node.kind === 'cache') {
        // 箱の中の対応線はキャッシュだけ描く（HIT の折り返しが見えるように。§8 #9）
        litWires += `<path class="wire lit inner" data-seg="${esc(s.key)}" d="${pathD(r.points)}"/>`;
      }
    }
  }

  // 切れている線（コードの事実）: 選択が無いときは全部、選択中は送り側の箱が光るものだけ赤（lit）
  for (const b of layout.broken) {
    const fromNode = index.items.get(b.from)?.node.id ?? '';
    if (!lit || lit.boxes.has(fromNode)) broken.set(b.key, 'lit');
  }

  // host の枠: 中の箱が 1 つでも光れば光る。幽霊は光らない
  if (lit)
    for (const h of layout.hosts.values()) {
      if (diff?.ghost.nodes.has(h.id)) continue;
      if (h.members.some((id) => lit.boxes.has(id))) hosts.set(h.id, 'lit');
    }

  for (const b of layout.boxes.values()) {
    // 幽霊の箱（前にしか無い）は光らない。中の項目も幽霊
    const ghostBox = !!diff?.ghost.nodes.has(b.id);
    if (lit && !ghostBox && lit.boxes.has(b.id))
      boxes.set(b.id, lit.startBoxes.has(b.id) ? 'lit start' : 'lit');
    if (ghostBox) continue;
    for (const ref of [...b.ins, ...b.outs]) {
      if (ref === null || diff?.ghost.items.has(ref)) continue;
      if (!index.items.has(ref)) continue;
      if (inactive.items.has(ref))
        items.set(ref, 'off inactive'); // 今の分岐には無い項目（薄く残す。光るより優先）
      else if (lit && lit.items.has(ref))
        items.set(
          ref,
          lit.startItems.has(ref) && lit.selection.kind !== 'type' ? 'on start' : 'on',
        );
    }
  }
  return { hasSel: !!lit, boxes, hosts, items, wires, broken, litWires };
}

/** class の付け替え 1 件（cls は付ける class。空なら「選択と分岐の class を全部外す」） */
export interface ClassOp {
  kind: PaintKind;
  id: string;
  cls: string;
}

/**
 * 前の計画から次の計画へ移すときの class の付け替え（変わる要素だけ）。順は kind（PAINT_KINDS）→ 前の計画から外れる id →
 * 次の計画で付く・変わる id。数は光るもの・分岐で変わるものに比例する（沈める側には触らない）
 */
export function planDiff(prev: PaintPlan, next: PaintPlan): ClassOp[] {
  const ops: ClassOp[] = [];
  for (const kind of PAINT_KINDS) {
    const a = prev[kind];
    const b = next[kind];
    for (const id of a.keys()) if (!b.has(id)) ops.push({ kind, id, cls: '' });
    for (const [id, cls] of b) if (a.get(id) !== cls) ops.push({ kind, id, cls });
  }
  return ops;
}
