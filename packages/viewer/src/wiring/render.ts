// 配線図の SVG（文字列）。場面（索引・配置・差分とメモの印）ごとに 1 回だけ作る（docs/18 §11.3、D114）。
// 選択と分岐で変わる class は塗りの計画（paint.ts の paintPlan）から書く。選択が変わったときは sceneView.ts が
// 同じ計画の差だけを付け替えるので、ここと付け替えの結果は同じになる（D115）。光る線は箱の下・host の上の層に置き、
// 箱は 1 つの層のまま動かさない（D116）。選択は「関係ないものを沈める」だけで形は変えない（docs/15 §3.6）。
// 規則（何が光るか・分岐・経路）は @stack-atlas/wiring が決め、ここは描くだけ。DOM に触らない（単体テストできる）
import {
  type GraphIndex,
  type IndexedItem,
  type LitSelection,
  type Rect,
  type VariantState,
  type WiringLayout,
} from '@stack-atlas/wiring';
import { esc, n1, pathD } from './markup';
import { memoFold } from './memoRules';
import {
  dyn,
  inactiveOf,
  NONE_INACTIVE,
  paintPlan,
  type DiffMarks,
  type PaintLit,
  type PaintPlan,
} from './paint';
import { KIND, KIND_LABEL, LANE_TINT } from './theme';

export { esc, pathD } from './markup';
export type { DiffMarks } from './paint';

export interface SceneInput {
  index: GraphIndex;
  layout: WiringLayout;
  /** 分岐の状態と光るもの（描く索引の語彙）。plan を渡したときは読まない */
  state?: VariantState;
  lit?: PaintLit | null;
  /** 部品の領域の枠（`<g class="regions">` の中身。screens.ts の renderRegions）。無ければ空 */
  regions?: string;
  /** メモのある箱（右下の角を折る。docs/18 §3.4。memoRules.ts の memoBoxIds） */
  memos?: ReadonlySet<string>;
  /** 差分の印。index と layout は今の graph に幽霊を足した graph（diffOverlayV2 の graph） */
  diff?: DiffMarks;
  /** 塗りの計画。省くと state・lit・diff からここで作る（描く索引で分岐を解く）。sceneView は自分の持つ計画を渡す */
  plan?: PaintPlan;
}

/** 文字の幅の見積り（等幅の英数は 0.6em、全角は 1em） */
export function textWidth(s: string, size: number): number {
  let w = 0;
  for (const ch of s) w += (ch.codePointAt(0) ?? 0) > 0x2e80 ? size : size * 0.6;
  return w;
}

/** 幅に収まるよう末尾を「…」にする */
export function clipText(s: string, maxW: number, size: number): string {
  if (textWidth(s, size) <= maxW) return s;
  const ell = textWidth('…', size);
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = textWidth(ch, size);
    if (w + cw + ell > maxW) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

const NAME_SIZE = 10;
const TYPE_SIZE = 9.5;

/** 項目の名前と型を幅に収める。型を先に削り（名前を残す）、それでも足りなければ名前を削る */
export function fitLabel(
  name: string,
  type: string,
  avail: number,
): { name: string; type: string; cut: boolean } {
  const nameW = textWidth(name, NAME_SIZE);
  const typeW = textWidth(` ${type}`, TYPE_SIZE);
  if (nameW + typeW <= avail) return { name, type, cut: false };
  const typeAvail = Math.max(avail - nameW, Math.min(typeW, avail * 0.35));
  const t = clipText(type, typeAvail - textWidth(' ', TYPE_SIZE), TYPE_SIZE);
  const n = clipText(name, avail - textWidth(` ${t}`, TYPE_SIZE), NAME_SIZE);
  return { name: n, type: t, cut: true };
}

/** 項目が光っているか（たどった結果に入っているものだけ。子が光れば親も光る、は wiring が入れている） */
export const itemLit = (lit: LitSelection | null, ref: string) => !!lit && lit.items.has(ref);

/** 角の丸い矩形の外周と、内側の矩形の穴（fill-rule evenodd で「箱の中の画面の領域だけ抜いた」塗り） */
export function frameWithHole(b: Rect, rx: number, hole: Rect): string {
  const r = Math.max(0, Math.min(rx, b.w / 2, b.h / 2));
  const { x, y, w, h } = b;
  const outer =
    `M${n1(x + r)},${n1(y)} H${n1(x + w - r)} A${n1(r)},${n1(r)} 0 0 1 ${n1(x + w)},${n1(y + r)} ` +
    `V${n1(y + h - r)} A${n1(r)},${n1(r)} 0 0 1 ${n1(x + w - r)},${n1(y + h)} H${n1(x + r)} ` +
    `A${n1(r)},${n1(r)} 0 0 1 ${n1(x)},${n1(y + h - r)} V${n1(y + r)} A${n1(r)},${n1(r)} 0 0 1 ${n1(x + r)},${n1(y)} Z`;
  const inner = `M${n1(hole.x)},${n1(hole.y)} h${n1(hole.w)} v${n1(hole.h)} h${n1(-hole.w)} Z`;
  return `${outer} ${inner}`;
}

/** 画面の領域を抜く clip-path（レーンの背景が画面の HTML に色を載せない）の id */
export const SCREEN_CUT_ID = 'wv-screen-cut';

/** `<g class="view">` の中の層（この順に重なる。後ろが手前） */
export const LAYERS = [
  'lanes',
  'base-wires',
  'hosts',
  'lit-wires',
  'boxes',
  'regions',
  'balls',
] as const;

/**
 * `<g class="view">` の中身。層の順: レーン → 線（全部。光る線の下の基の線は `under` で隠す）→ host の枠 → 光る線 → 箱（全部）→
 * 部品の領域の枠 → 球。選択と分岐で変わる class（lit・on・under・inactive）は塗りの計画から、markup の class の末尾に書く
 * （沈める側には class を付けない。根の has-sel と CSS で沈む。D122）。画面の箱（画面の領域を持つ箱）は画面の領域を塗らず、
 * 下の層（ScreenLayer の iframe）が透けて見える。読んでいない間はプレースホルダ（文言は ScreenLayer が入れる）
 */
export function renderScene(input: SceneInput): string {
  const { index, layout, regions, memos, diff } = input;
  const plan =
    input.plan ??
    paintPlan({
      index,
      layout,
      lit: input.lit ?? null,
      inactive: input.state ? inactiveOf(index, input.state) : NONE_INACTIVE,
      diff: diff ?? null,
    });
  let lanes = '';
  let baseWires = '';
  let hosts = '';
  let boxes = '';
  let litWires = plan.litWires;

  // レーンの背景（左右は通り道の中央まで、上下は十分に伸ばす）・名前・境目
  const holes = [...layout.boxes.values()].flatMap((b) => (b.screen ? [b.screen] : []));
  let defs = '';
  if (holes.length) {
    const big = 1e6;
    const d =
      `M${-big},${-big} H${big} V${big} H${-big} Z ` +
      holes.map((r) => `M${n1(r.x)},${n1(r.y)} h${n1(r.w)} v${n1(r.h)} h${n1(-r.w)} Z`).join(' ');
    defs = `<defs><clipPath id="${SCREEN_CUT_ID}" clipPathUnits="userSpaceOnUse"><path clip-rule="evenodd" d="${d}"/></clipPath></defs>`;
  }
  for (const l of layout.lanes) {
    lanes += `<rect class="lane-tint" data-lane="${esc(l.id)}" x="${n1(l.x0)}" y="-4000" width="${n1(l.x1 - l.x0)}" height="${n1(layout.height + 8000)}" fill="${LANE_TINT[l.id] ?? '#8b93a5'}" fill-opacity=".06"/>`;
  }
  for (const l of layout.lanes) {
    lanes += `<text class="lane-title" x="${n1(l.x + l.w / 2)}" y="${layout.titleY}" text-anchor="middle">${esc(l.name)}</text>`;
    if (l.index > 0)
      lanes += `<line class="lane-sep" x1="${n1(l.x0)}" y1="${layout.titleY - 12}" x2="${n1(l.x0)}" y2="${n1(layout.height)}"/>`;
  }

  // すべての線（項目のピンからピンへ）。光っている線も基の層に残し（under で隠す）、光る区間は上の層に描く
  for (const w of index.wires) {
    const r = layout.routes.get(w.key);
    if (!r) continue;
    if (diff?.ghost.wires.has(w.key)) {
      baseWires += `<path class="wire thin ghost" data-ghost-wire="${w.key}" d="${pathD(r.points)}"/>`;
      continue;
    }
    const added = diff?.added.wires.has(w.key) ? ' added' : '';
    const cls = `wire thin via-${esc(w.wire.via)}${added}${dyn(plan, 'wires', w.key)}`;
    baseWires += `<path class="${cls}" data-key="${w.key}" data-ends="${esc(w.fromNode.id)}|${esc(w.toNode.id)}" d="${pathD(r.points)}"/>`;
  }

  // 切れている線（コードの事実。受ける側の箱の手前で切れた端を描く）。選択が無いときは全部が赤の破線で基の層、
  // 選択中は送り側の箱が光るものだけ赤（lit）で光る線の層、ほかは薄く基の層（付け替えでは要素ごと層を移す）
  for (const b of layout.broken) {
    const st = dyn(plan, 'broken', b.key);
    const cls = `wire broken ${esc(b.level)}`;
    const pts = b.route.points;
    const end = pts[pts.length - 1]!;
    const cut =
      `<path class="${cls}${st}" data-broken="${b.key}" data-path="${esc(b.path)}" d="${pathD(pts)}"><title>${esc(b.path ? `${b.path}: ${b.reason}` : b.reason)}</title></path>` +
      `<path class="${cls} cut${st}" data-cut="${b.key}" d="M${n1(end.x)},${n1(end.y - 5)} L${n1(end.x)},${n1(end.y + 5)}"/>`;
    if (plan.hasSel && st) litWires += cut;
    else baseWires += cut;
  }

  // host の枠（箱が動く・置かれる場所。D42）。枠は入れ物なので、光っていても箱より下の層に置く
  // （光る枠が中の沈んだ箱を覆って、箱のクリックを奪わないように）
  for (const h of layout.hosts.values()) {
    const name = index.nodes.get(h.id)?.node.name ?? h.id;
    const ghost = !!diff?.ghost.nodes.has(h.id);
    const attr = ghost ? 'data-ghost-host' : 'data-host';
    const st = ghost ? ' ghost' : dyn(plan, 'hosts', h.id);
    const g = `<g class="host${st}" ${attr}="${esc(h.id)}"><rect class="frame" x="${n1(h.x)}" y="${n1(h.y)}" width="${n1(h.w)}" height="${n1(h.h)}" rx="6"/><text class="hname" x="${n1(h.x + 8)}" y="${n1(h.y + 15)}">${esc(name)}</text></g>`;
    hosts += g;
  }

  let memoDefs = '';
  let memoN = 0;
  for (const b of layout.boxes.values()) {
    const n = index.nodes.get(b.id)!;
    const k = KIND[n.node.kind] ?? KIND.infra;
    // 幽霊の箱（前にしか無い）は光らず、選択中は沈む。data-box を付けないのでクリック・hover・分岐の表を受けない
    const ghost = !!diff?.ghost.nodes.has(b.id);
    const added = !ghost && diff?.added.nodes.has(b.id) ? ' added' : '';
    const scr = b.screen;
    const cls = `box${scr ? ' scr' : ''}${ghost ? ' ghost' : ''}${added}${ghost ? '' : dyn(plan, 'boxes', b.id)}`;
    let g = `<g class="${cls}" ${ghost ? 'data-ghost' : 'data-box'}="${esc(b.id)}" data-kind="${esc(n.node.kind)}" style="--c:${k.c}">`;
    const dash = k.dash ? ` stroke-dasharray="${k.dash}"` : '';
    // 丸い端（actor・trigger）は rx と ry を高さの半分に揃える（rx だけだと横長の箱が楕円になる）
    const rx = Math.min(k.rx, b.h / 2, b.w / 2);
    // メモのある箱は右下の角を折る（文字の印は付けない）。角は clipPath で切り、折り返しを上に描く
    const fold = !ghost && memos?.has(b.id) ? memoFold(b) : null;
    let clip = '';
    if (fold) {
      const id = `wv-memo-${memoN++}`;
      memoDefs += `<clipPath id="${id}" clipPathUnits="userSpaceOnUse"><path d="${fold.clip}"/></clipPath>`;
      clip = ` clip-path="url(#${id})"`;
    }
    if (scr) {
      // 画面の領域だけ塗らない（下の iframe が透ける）。枠の rect は透明の塗りでクリックを受ける
      g += `<path class="screen-bg" d="${frameWithHole(b, rx, scr)}" fill="${k.c}1a" fill-rule="evenodd"${clip}/>`;
      g += `<g class="screen-ph" data-screen-ph="${esc(b.id)}"><rect x="${n1(scr.x)}" y="${n1(scr.y)}" width="${n1(scr.w)}" height="${n1(scr.h)}"/><text x="${n1(scr.x + scr.w / 2)}" y="${n1(scr.y + scr.h / 2)}" text-anchor="middle"></text></g>`;
    }
    g += `<rect class="shape" x="${n1(b.x)}" y="${n1(b.y)}" width="${b.w}" height="${n1(b.h)}" rx="${n1(rx)}" ry="${n1(rx)}" fill="${scr ? 'transparent' : `${k.c}1a`}" stroke="${k.c}"${dash}${clip}/>`;
    if (k.double)
      g += `<rect class="deco" x="${n1(b.x + 3)}" y="${n1(b.y + 3)}" width="${b.w - 6}" height="${n1(b.h - 6)}" fill="none" stroke="${k.c}" stroke-width=".8"${clip}/>`;
    if (k.band)
      g += `<line class="deco" x1="${n1(b.x)}" y1="${n1(b.y + 24)}" x2="${n1(b.x + b.w)}" y2="${n1(b.y + 24)}" stroke="${k.c}" stroke-width=".8"/>`;
    if (fold) g += `<path class="memo-fold" d="${fold.fold}" fill="${k.c}55" stroke="${k.c}"/>`;
    // 今だけの箱は外側に緑の縁（種類の色は残す）
    if (added)
      g += `<rect class="dmark" x="${n1(b.x - 3)}" y="${n1(b.y - 3)}" width="${b.w + 6}" height="${n1(b.h + 6)}" rx="${n1(rx + 2)}"/>`;
    g += `<text class="name" x="${n1(b.x + 10)}" y="${n1(b.y + 17)}">${esc(clipText(n.node.name, b.w - 20, 12 * 1.05))}</text>`;
    g += `<text class="kind" x="${n1(b.x)}" y="${n1(b.y - 4)}">${esc(KIND_LABEL[n.node.kind] ?? n.node.kind)}</text>`;
    // 反対側の同じ高さに項目があれば幅の半分、無ければ箱の幅いっぱいまで文字を使う
    const ys = (col: (string | null)[]) =>
      col.filter((r): r is string => r !== null).map((r) => layout.pins.get(r)!.y);
    const inYs = ys(b.ins);
    const outYs = ys(b.outs);
    for (const ref of [...b.ins, ...b.outs]) {
      if (ref === null) continue;
      const it = index.items.get(ref)!;
      const p = layout.pins.get(ref)!;
      const other = p.side === 'in' ? outYs : inYs;
      const shared = other.some((y) => Math.abs(y - p.y) < 9);
      const avail = (shared ? b.w / 2 - 12 : b.w - 24) - it.depth * 10;
      g += itemSvg(input, plan, it, b.w, avail, ghost);
    }
    g += '</g>';
    boxes += g;
  }

  const cut = defs ? ` clip-path="url(#${SCREEN_CUT_ID})"` : '';
  if (memoDefs) defs += `<defs>${memoDefs}</defs>`;
  return (
    `${defs}<g class="lanes"${cut}>${lanes}</g><g class="base-wires">${baseWires}</g><g class="hosts">${hosts}</g>` +
    `<g class="lit-wires">${litWires}</g><g class="boxes">${boxes}</g><g class="regions">${regions ?? ''}</g><g class="balls"></g>`
  );
}

/**
 * 項目の行（ピン・名前・型）。型に typeRef があれば下線を付け、クリックで型の横断面。
 * 幽霊の行（幽霊の箱の項目と、前にしか無い項目）はクリックを受けない（data-item・data-type を付けない）。
 * 今だけの項目と型の変わった項目は行の枠（hit）に緑の縁。ピンは最後の子、文字はその直前（点滅が要素をこの順で引く）
 */
function itemSvg(
  { layout, diff }: SceneInput,
  plan: PaintPlan,
  it: IndexedItem,
  boxW: number,
  avail: number,
  ghostBox = false,
): string {
  const p = layout.pins.get(it.ref)!;
  const ghost = ghostBox || !!diff?.ghost.items.has(it.ref);
  const indent = it.depth * 10;
  const ref = ghost ? undefined : it.item.typeRef;
  const ty = `<tspan class="ty${ref ? ' ref' : ''}"${ref ? ` data-type="${esc(ref)}"` : ''}>`;
  const label = fitLabel(it.item.name, it.item.type, avail);
  const mark =
    !ghost && (diff?.added.items.has(it.ref) || diff?.changed.has(it.ref)) ? ' added' : '';
  // 選択と分岐で変わる class（on・off inactive）は末尾（幽霊には付かない）
  const st = ghost ? '' : dyn(plan, 'items', it.ref);
  let s = `<g class="item${ghost ? ' ghost' : ''}${mark}${it.parent ? ' child' : ''}${st}" ${ghost ? 'data-ghost-item' : 'data-item'}="${esc(it.ref)}">`;
  // 収まらずに削ったときだけ、元の文字をブラウザの吹き出しに入れる
  if (label.cut) s += `<title>${esc(`${it.item.name} ${it.item.type}`)}</title>`;
  // 当たり判定は文字の下に置く（型の文字のクリックを奪わないように）
  if (p.side === 'in') {
    s += `<rect class="hit" x="${n1(p.x)}" y="${n1(p.y - 8)}" width="${boxW / 2}" height="16"/>`;
    s += `<text x="${n1(p.x + 9 + indent)}" y="${n1(p.y + 3.5)}">${esc(label.name)}${ty} ${esc(label.type)}</tspan></text>`;
  } else {
    s += `<rect class="hit" x="${n1(p.x - boxW / 2)}" y="${n1(p.y - 8)}" width="${boxW / 2}" height="16"/>`;
    s += `<text x="${n1(p.x - 9 - indent)}" y="${n1(p.y + 3.5)}" text-anchor="end">${ty}${esc(label.type)} </tspan>${esc(label.name)}</text>`;
  }
  return (
    s + `<circle class="pin" cx="${n1(p.x)}" cy="${n1(p.y)}" r="${it.parent ? 2.2 : 3.2}"/></g>`
  );
}
