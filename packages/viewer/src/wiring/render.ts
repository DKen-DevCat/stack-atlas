// 配線図の SVG（文字列）。光るものは常に手前の層へ置き、選択は「関係ないものを沈める」だけで形は変えない（docs/15 §3.6）。
// 規則（何が光るか・分岐・経路）は @stack-atlas/wiring が決め、ここは描くだけ。DOM に触らない（単体テストできる）
import {
  itemActive,
  segmentRoute,
  wireActive,
  type DiffOverlayV2,
  type GraphIndex,
  type IndexedItem,
  type LitSelection,
  type Point,
  type Rect,
  type VariantState,
  type WiringLayout,
} from '@stack-atlas/wiring';
import { memoFold } from './memoRules';
import { KIND, KIND_LABEL, LANE_TINT } from './theme';

/**
 * 前の graph との差分の印（docs/18 §3.4。@stack-atlas/wiring の diffOverlayV2）。幽霊（前にしか無いもの）は灰の点線で、
 * クリックも hover も受けない（data-box・data-item・data-wire を付けない）。今だけのもの・型の変わった項目は緑の縁
 */
export type DiffMarks = Pick<DiffOverlayV2, 'ghost' | 'added' | 'changed'>;

export interface SceneInput {
  index: GraphIndex;
  layout: WiringLayout;
  state: VariantState;
  lit: LitSelection | null;
  /** 部品の領域の枠（`<g class="regions">` の中身。screens.ts の renderRegions）。無ければ空 */
  regions?: string;
  /** メモのある箱（右下の角を折る。docs/18 §3.4。memoRules.ts の memoBoxIds） */
  memos?: ReadonlySet<string>;
  /** 差分の印。index と layout は今の graph に幽霊を足した graph（diffOverlayV2 の graph） */
  diff?: DiffMarks;
}

export const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const n1 = (v: number) => Math.round(v * 10) / 10;

/** 折れ線を path の d にする */
export function pathD(points: readonly Point[]): string {
  return points.map((p, i) => `${i ? 'L' : 'M'}${n1(p.x)},${n1(p.y)}`).join(' ');
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

/**
 * `<g class="view">` の中身。層の順: レーン → 沈んだ線 → host の枠 → 沈んだ箱 → 光る線 → 光る箱 → 部品の領域の枠 → 球。
 * 何も選んでいないときは全部が下の層（線は細く薄く）。画面の箱（画面の領域を持つ箱）は画面の領域を塗らず、
 * 下の層（ScreenLayer の iframe）が透けて見える。読んでいない間はプレースホルダ（文言は ScreenLayer が入れる）
 */
export function renderScene(input: SceneInput): string {
  const { index, layout, state, lit, regions, memos, diff } = input;
  let lanes = '';
  let baseWires = '';
  let hosts = '';
  let baseBoxes = '';
  let litWires = '';
  let litBoxes = '';

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

  // すべての線（項目のピンからピンへ）。光っている線は上の層で描く
  const litWireKeys = new Set<string>();
  if (lit) for (const s of lit.segs) if (s.kind === 'wire' && s.wire) litWireKeys.add(s.wire.key);
  for (const w of index.wires) {
    const r = layout.routes.get(w.key);
    if (!r || litWireKeys.has(w.key)) continue;
    if (diff?.ghost.wires.has(w.key)) {
      baseWires += `<path class="wire thin ghost${lit ? ' dimmed' : ''}" data-ghost-wire="${w.key}" d="${pathD(r.points)}"/>`;
      continue;
    }
    const added = diff?.added.wires.has(w.key) ? ' added' : '';
    const cls = `wire thin via-${esc(w.wire.via)}${added}${lit ? ' dimmed' : ''}${wireActive(index, state, w) ? '' : ' inactive'}`;
    baseWires += `<path class="${cls}" data-key="${w.key}" data-ends="${esc(w.fromNode.id)}|${esc(w.toNode.id)}" d="${pathD(r.points)}"/>`;
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

  // 切れている線（コードの事実。選択に関係なく常に赤の破線。受ける側の箱の手前で切れた端を描く）
  for (const b of layout.broken) {
    const fromNode = index.items.get(b.from)?.node.id ?? '';
    const on = !lit || lit.boxes.has(fromNode);
    const cls = `wire broken ${esc(b.level)}${on ? ' lit' : ' dimmed'}`;
    const pts = b.route.points;
    const end = pts[pts.length - 1]!;
    const cut =
      `<path class="${cls}" data-broken="${b.key}" data-path="${esc(b.path)}" d="${pathD(pts)}"><title>${esc(b.path ? `${b.path}: ${b.reason}` : b.reason)}</title></path>` +
      `<path class="${cls} cut" d="M${n1(end.x)},${n1(end.y - 5)} L${n1(end.x)},${n1(end.y + 5)}"/>`;
    if (lit && on) litWires += cut;
    else baseWires += cut;
  }

  // host の枠（箱が動く・置かれる場所。D42）。枠は入れ物なので、光っていても箱より下の層に置く
  // （光る枠が中の沈んだ箱を覆って、箱のクリックを奪わないように）
  for (const h of layout.hosts.values()) {
    const name = index.nodes.get(h.id)?.node.name ?? h.id;
    const ghost = !!diff?.ghost.nodes.has(h.id);
    const on = !ghost && (!lit || h.members.some((id) => lit.boxes.has(id)));
    const attr = ghost ? 'data-ghost-host' : 'data-host';
    const st = ghost ? ` ghost${lit ? ' dim' : ''}` : lit ? (on ? ' lit' : ' dim') : '';
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
    const on = !ghost && (!lit || lit.boxes.has(b.id));
    const st = ghost
      ? ` ghost${lit ? ' dim' : ''}`
      : !lit
        ? ''
        : on
          ? ` lit${lit.startBoxes.has(b.id) ? ' start' : ''}`
          : ' dim';
    const added = !ghost && diff?.added.nodes.has(b.id) ? ' added' : '';
    const scr = b.screen;
    let g = `<g class="box${scr ? ' scr' : ''}${st}${added}" ${ghost ? 'data-ghost' : 'data-box'}="${esc(b.id)}" data-kind="${esc(n.node.kind)}" style="--c:${k.c}">`;
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
      g += itemSvg(input, it, b.w, avail, ghost);
    }
    g += '</g>';
    if (lit && on) litBoxes += g;
    else baseBoxes += g;
  }

  const cut = defs ? ` clip-path="url(#${SCREEN_CUT_ID})"` : '';
  if (memoDefs) defs += `<defs>${memoDefs}</defs>`;
  return (
    `${defs}<g class="lanes"${cut}>${lanes}</g><g class="base-wires">${baseWires}</g><g class="hosts">${hosts}</g><g class="base-boxes">${baseBoxes}</g>` +
    `<g class="lit-wires">${litWires}</g><g class="lit-boxes">${litBoxes}</g><g class="regions">${regions ?? ''}</g><g class="balls"></g>`
  );
}

/**
 * 項目の行（ピン・名前・型）。型に typeRef があれば下線を付け、クリックで型の横断面。
 * 幽霊の行（幽霊の箱の項目と、前にしか無い項目）はクリックを受けない（data-item・data-type を付けない）。
 * 今だけの項目と型の変わった項目は行の枠（hit）に緑の縁
 */
function itemSvg(
  { index, layout, state, lit, diff }: SceneInput,
  it: IndexedItem,
  boxW: number,
  avail: number,
  ghostBox = false,
): string {
  const p = layout.pins.get(it.ref)!;
  const ghost = ghostBox || !!diff?.ghost.items.has(it.ref);
  let st = '';
  if (ghost) st = ' ghost';
  else if (!itemActive(index, state, it))
    st = ' off inactive'; // 今の分岐には無い項目（薄く残す）
  else if (lit) {
    const on = itemLit(lit, it.ref);
    st = on
      ? ` on${lit.startItems.has(it.ref) && lit.selection.kind !== 'type' ? ' start' : ''}`
      : ' off';
  }
  const indent = it.depth * 10;
  const ref = ghost ? undefined : it.item.typeRef;
  const ty = `<tspan class="ty${ref ? ' ref' : ''}"${ref ? ` data-type="${esc(ref)}"` : ''}>`;
  const label = fitLabel(it.item.name, it.item.type, avail);
  const mark =
    !ghost && (diff?.added.items.has(it.ref) || diff?.changed.has(it.ref)) ? ' added' : '';
  let s = `<g class="item${st}${mark}${it.parent ? ' child' : ''}" ${ghost ? 'data-ghost-item' : 'data-item'}="${esc(it.ref)}">`;
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
