// 塗りの計画（docs/18 §11.3、D115・D122）: 選択と分岐で変わる class を決める純関数。全体を作る経路（markup）と
// 付け替える経路（前の計画との差）が同じ class になること、光る側にだけ class が付くこと
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { GraphV2 } from '@stack-atlas/schema';
import {
  defaultState,
  diffOverlayV2,
  indexGraph,
  itemActive,
  layoutWiring,
  select,
  variantKey,
  wireActive,
  type GraphIndex,
  type LitSelection,
  type Selection,
  type VariantState,
  type WiringLayout,
} from '@stack-atlas/wiring';
import { prevOfToday } from '../../../wiring/src/__tests__/diff-fixture';
import { todayGraph } from '../../../wiring/src/__tests__/fixture';
import { SAMPLE_V2_PATH } from '../graph/testSample';
import {
  baseClass,
  dyn,
  inactiveOf,
  NONE_INACTIVE,
  PAINT_KINDS,
  paintedClass,
  paintPlan,
  planDiff,
  type DiffMarks,
  type PaintKind,
  type PaintLit,
  type PaintPlan,
} from './paint';
import { renderScene } from './render';

const graph = JSON.parse(readFileSync(SAMPLE_V2_PATH, 'utf8')) as GraphV2;
const index = indexGraph(graph);
const layout = layoutWiring(index);
const state0 = defaultState(index);
const HIT = variantKey('infra:static_site/this', 'hit');
const hit: VariantState = { ...state0, [HIT]: true };

const plan = (lit: LitSelection | null, state: VariantState = state0) =>
  paintPlan({ index, layout, lit, inactive: inactiveOf(index, state) });
const pick = (sel: Selection, state: VariantState = state0) => select(index, state, sel);

// 分岐で項目・線が消える graph（例の graph は分岐でたどり方だけが変わり、inactive になるものが無い）:
// 画面の date（query.date・props.date と、actor → query.date の線）と login（LoginPrompt()。既定では無い）
const tIndex = indexGraph(todayGraph());
const tLayout = layoutWiring(tIndex);
const tState0 = defaultState(tIndex);
const noDate: VariantState = { ...tState0, [variantKey('screen:/today', 'date')]: false };
const noLogin: VariantState = { ...tState0, [variantKey('screen:/today', 'login')]: false };
const DATE_WIRE = { from: 'actor:user#out/date', to: 'screen:/today#in/query_date' };

/** markup の data 属性 → 計画の種類（切れた線は線と切れた端の印の 2 要素） */
const ATTR: Record<string, PaintKind> = {
  host: 'hosts',
  box: 'boxes',
  item: 'items',
  key: 'wires',
  broken: 'broken',
  cut: 'broken',
};
/** markup から「種類・id・何個目か → class 属性」を引く（付け替える要素の全部。幽霊は data-ghost* なので入らない） */
function classes(svg: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of svg.matchAll(/class="([^"]*)" data-(host|box|item|key|broken|cut)="([^"]*)"/g)) {
    const key = `${ATTR[m[2]!]}|${m[2]}|${m[3]}`;
    expect(out.has(key), key).toBe(false);
    out.set(key, m[1]!);
  }
  return out;
}
const kindOf = (key: string) => key.split('|')[0] as PaintKind;
const idOf = (key: string) => key.split('|').slice(2).join('|');

/** 「種類|id」→ その要素たちのキー（切れた線は線と印の 2 つ） */
function byTarget(keys: Iterable<string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const k of keys) {
    const t = `${kindOf(k)}|${idOf(k)}`;
    const list = out.get(t);
    if (list) list.push(k);
    else out.set(t, [k]);
  }
  return out;
}

/** 付け替えの経路（sceneView.ts と同じ手順）: 作ったときの class から土台を取り、前の計画との差だけ当てる */
function repaint(svg: string, prev: PaintPlan, next: PaintPlan): Map<string, string> {
  const out = classes(svg);
  const base = new Map([...out].map(([k, cls]) => [k, baseClass(cls, prev, kindOf(k), idOf(k))]));
  const targets = byTarget(out.keys());
  for (const op of planDiff(prev, next))
    for (const k of targets.get(`${op.kind}|${op.id}`) ?? [])
      out.set(k, paintedClass(base.get(k)!, op.cls));
  return out;
}

describe('paintPlan', () => {
  it('選択なし: 光る class は無い。分岐に無い線・項目だけ inactive、切れた線は全部 lit', () => {
    const p = plan(null);
    expect(p.hasSel).toBe(false);
    expect(p.boxes.size).toBe(0);
    expect(p.hosts.size).toBe(0);
    expect(p.litWires).toBe('');
    expect([...p.broken.values()]).toEqual(layout.broken.map(() => 'lit'));
    expect(layout.broken.length).toBe(3);
    const inactiveWires = index.wires.filter(
      (w) => layout.routes.has(w.key) && !wireActive(index, state0, w),
    );
    expect([...p.wires.keys()].sort()).toEqual(inactiveWires.map((w) => w.key).sort());
    expect(new Set(p.wires.values())).toEqual(new Set(inactiveWires.length ? ['inactive'] : []));
    const inactiveItems = [...index.items.values()].filter((it) => !itemActive(index, state0, it));
    expect(p.items.size).toBe(inactiveItems.filter((it) => layout.pins.has(it.ref)).length);
    for (const c of p.items.values()) expect(c).toBe('off inactive');
  });

  it('箱を選ぶ: 光る箱は lit・始点は lit start、host は中の箱が光れば lit、項目は on・始点は on start', () => {
    const lit = pick({ kind: 'box', id: 'route:/' })!;
    const p = plan(lit);
    expect(p.hasSel).toBe(true);
    expect([...p.boxes.keys()].sort()).toEqual(
      [...lit.boxes].filter((id) => layout.boxes.has(id)).sort(),
    );
    expect(p.boxes.get('route:/')).toBe('lit start');
    expect(p.boxes.get('fn:internal/api.handleToday')).toBe('lit');
    expect(p.boxes.has('endpoint:POST /transactions')).toBe(false);
    for (const h of layout.hosts.values())
      expect(p.hosts.get(h.id), h.id).toBe(
        h.members.some((id) => lit.boxes.has(id)) ? 'lit' : undefined,
      );
    expect(p.hosts.size).toBeGreaterThan(0);
    const on = [...p.items].filter(([, c]) => c.startsWith('on'));
    expect(on.map(([ref]) => ref).sort()).toEqual(
      [...lit.items]
        .filter((ref) => layout.pins.has(ref) && itemActive(index, state0, index.items.get(ref)!))
        .sort(),
    );
    // 箱の選択では始点は箱（項目に start は付かない）
    expect(lit.startItems.size).toBe(0);
    expect(on.every(([, c]) => c === 'on')).toBe(true);
    // 光る線の下の基の線は under。光る線の層は光る区間 ＋ 当たり判定（切れた線は入れない）
    const litKeys = new Set(
      lit.segs.flatMap((s) => (s.kind === 'wire' && s.wire ? [s.wire.key] : [])),
    );
    expect(
      [...p.wires]
        .filter(([, c]) => c.split(' ').includes('under'))
        .map(([k]) => k)
        .sort(),
    ).toEqual([...litKeys].sort());
    expect((p.litWires.match(/class="wire hitarea"/g) ?? []).length).toBe(
      lit.segs.filter((s) => s.kind === 'wire' && s.wire).length,
    );
    expect(p.litWires).not.toContain('broken');
    // 切れた線: 送り側の箱が光るものだけ lit
    for (const b of layout.broken)
      expect(p.broken.get(b.key), b.key).toBe(
        lit.boxes.has(index.items.get(b.from)!.node.id) ? 'lit' : undefined,
      );
    expect(p.broken.size).toBeLessThan(layout.broken.length);
  });

  it('項目を選ぶ: 始点の項目は on start（箱は start にしない）', () => {
    const ref = 'actor:user#out/open';
    const lit = pick({ kind: 'item', ref })!;
    const p = plan(lit);
    expect(p.items.get(ref)).toBe('on start');
    expect([...p.items.values()].filter((c) => c === 'on start').length).toBe(lit.startItems.size);
    expect([...p.boxes.values()].every((c) => c === 'lit')).toBe(true);
    expect(p.boxes.get('actor:user')).toBe('lit');
  });

  it('型を選ぶ: 項目は on だけ（start にしない）。箱は lit', () => {
    const p = plan(pick({ kind: 'type', typeRef: 'type:Entry' }));
    expect(p.hasSel).toBe(true);
    const on = [...p.items.values()].filter((c) => c.startsWith('on'));
    expect(on.length).toBeGreaterThan(0);
    expect(new Set(on)).toEqual(new Set(['on']));
    expect(p.boxes.size).toBeGreaterThan(0);
  });

  it('分岐（たどり方）: CloudFront HIT では S3 が光らない（箱に class が付かない）', () => {
    const p = plan(pick({ kind: 'box', id: 'route:/' }, hit)!, hit);
    const p0 = plan(pick({ kind: 'box', id: 'route:/' })!);
    expect(p0.boxes.has('infra:static_site/site')).toBe(true);
    expect(p.boxes.has('infra:static_site/site')).toBe(false);
    expect(p.boxes.get('comp:TodayIsland')).toBe('lit');
  });

  it('分岐（消えるもの）: 今の分岐に無い項目は off inactive（光るより優先）、無い線は inactive。選択が無くても付く', () => {
    const tPlan = (state: VariantState, sel: Selection | null) =>
      paintPlan({
        index: tIndex,
        layout: tLayout,
        lit: sel ? select(tIndex, state, sel) : null,
        inactive: inactiveOf(tIndex, state),
      });
    const wireKey = tIndex.wires.find(
      (w) => w.wire.from === DATE_WIRE.from && w.wire.to === DATE_WIRE.to,
    )!.key;
    // 既定（date あり・ログイン済み）: 項目は LoginPrompt() だけが無い。線は今の分岐に無いものだけ inactive
    const d = tPlan(tState0, null);
    expect([...d.items]).toEqual([['screen:/today#out/render_login', 'off inactive']]);
    const off0 = tIndex.wires.filter(
      (w) => tLayout.routes.has(w.key) && !wireActive(tIndex, tState0, w),
    );
    expect([...d.wires].sort()).toEqual(off0.map((w) => [w.key, 'inactive']).sort());
    expect(d.wires.has(wireKey)).toBe(false);
    // date なし: query.date・props.date と、actor からの線
    const nd = tPlan(noDate, null);
    expect(nd.hasSel).toBe(false);
    expect(nd.items.get('screen:/today#in/query_date')).toBe('off inactive');
    expect(nd.items.get('screen:/today#out/props_date')).toBe('off inactive');
    expect(nd.wires.get(wireKey)).toBe('inactive');
    for (const [ref, c] of nd.items)
      expect(c === 'off inactive', ref).toBe(!itemActive(tIndex, noDate, tIndex.items.get(ref)!));
    for (const w of tIndex.wires)
      expect(nd.wires.has(w.key), w.key).toBe(!wireActive(tIndex, noDate, w));
    // 選んでいても、今の分岐に無い項目は off inactive のまま（選択の始点でも on にしない）
    const sel = tPlan(tState0, { kind: 'item', ref: 'screen:/today#out/render_login' });
    expect(sel.items.get('screen:/today#out/render_login')).toBe('off inactive');
    const box = tPlan(noDate, { kind: 'box', id: 'screen:/today' });
    expect(box.hasSel).toBe(true);
    expect(box.items.get('screen:/today#in/query_date')).toBe('off inactive');
    expect(box.items.get('screen:/today#in/html')).toBe('on');
    for (const c of box.wires.values())
      expect(['under', 'inactive', 'under inactive']).toContain(c);
    expect(box.wires.get(wireKey)).toMatch(/inactive$/);
  });

  it('幽霊（前にしか無いもの）には何も付けない。計画の id は今あるものだけ', () => {
    const { overlay: ov, index: ui, layout: ul } = unionScene();
    const lit = select(index, state0, { kind: 'box', id: 'fn:toTodayView' })!;
    for (const l of [null, lit]) {
      const p = paintPlan({
        index: ui,
        layout: ul,
        lit: l,
        inactive: inactiveOf(ui, state0),
        diff: ov,
      });
      for (const id of ov.ghost.nodes) {
        expect(p.boxes.has(id), id).toBe(false);
        expect(p.hosts.has(id), id).toBe(false);
      }
      for (const ref of ov.ghost.items) expect(p.items.has(ref), ref).toBe(false);
      for (const key of ov.ghost.wires) expect(p.wires.has(key), key).toBe(false);
    }
    expect(ov.ghost.nodes.size + ov.ghost.items.size + ov.ghost.wires.size).toBeGreaterThan(2);
  });

  it('入力は描く索引の語彙の値だけ: 手で作った「光るもの」「今の分岐に無いもの」でも同じ規則で塗る（選ばない・分岐を解かない）', () => {
    // 分岐の状態を渡さない。今の分岐に無いものは、渡した集合だけで決まる
    const anyWire = index.wires.find((w) => layout.routes.has(w.key))!;
    const anyItem = 'actor:user#out/open';
    const p = paintPlan({
      index,
      layout,
      lit: null,
      inactive: {
        wires: new Set([anyWire.key, 'no-such-wire']),
        items: new Set([anyItem, 'no#such/item']),
      },
    });
    expect([...p.wires]).toEqual([[anyWire.key, 'inactive']]);
    expect([...p.items]).toEqual([[anyItem, 'off inactive']]);
    expect(paintPlan({ index, layout, lit: null, inactive: NONE_INACTIVE }).wires.size).toBe(0);
    // 光るものも、select の結果でなくてよい（箱の id・項目の ref・区間を持つ値。畳んだ場面は写したものを渡す）
    const real = pick({ kind: 'box', id: 'route:/' })!;
    const seg = real.segs.find((s) => s.kind === 'wire' && s.wire)!;
    const hand: PaintLit = {
      boxes: new Set(['route:/', 'comp:TodayIsland', 'no-such-box']),
      startBoxes: new Set(['comp:TodayIsland']),
      items: new Set([anyItem]),
      startItems: new Set([anyItem]),
      segs: [seg],
      startSeg: seg.key,
      selection: { kind: 'fold' },
    };
    const q = paintPlan({ index, layout, lit: hand, inactive: NONE_INACTIVE });
    expect(q.hasSel).toBe(true);
    expect([...q.boxes].sort()).toEqual([
      ['comp:TodayIsland', 'lit start'],
      ['route:/', 'lit'],
    ]);
    expect([...q.items]).toEqual([[anyItem, 'on start']]);
    expect([...q.wires]).toEqual([[seg.wire!.key, 'under']]);
    expect(q.litWires).toContain(`data-seg="${seg.key}"`);
    expect(q.litWires).toMatch(/class="wire lit via-[a-z-]+ sel"/);
    // 同じ値なら、select の結果を渡したときと同じ計画（LitSelection は PaintLit を満たす）
    const copy: PaintLit = {
      boxes: real.boxes,
      startBoxes: real.startBoxes,
      items: real.items,
      startItems: real.startItems,
      segs: real.segs,
      startSeg: real.startSeg,
      selection: { kind: real.selection.kind },
    };
    expect(paintPlan({ index, layout, lit: copy, inactive: inactiveOf(index, state0) })).toEqual(
      plan(real),
    );
  });

  it('沈める側の class（dim・dimmed・off だけ）は計画に無い（D122。off は inactive と組でだけ）', () => {
    for (const p of PLANS())
      for (const kind of PAINT_KINDS)
        for (const c of p.plan[kind].values()) {
          expect(c).not.toMatch(/\bdim(med)?\b/);
          expect(c === 'off inactive' || !c.split(' ').includes('off'), c).toBe(true);
          expect(c).toBe(c.trim());
        }
  });
});

/** 差分の場面（幽霊を足した graph の索引と配置） */
function unionScene(): {
  overlay: ReturnType<typeof diffOverlayV2>;
  index: GraphIndex;
  layout: WiringLayout;
} {
  const ov = diffOverlayV2(prevOfToday(graph), graph);
  const ui = indexGraph(ov.graph);
  return { overlay: ov, index: ui, layout: layoutWiring(ui) };
}

interface Case {
  name: string;
  state: VariantState;
  lit: LitSelection | null;
  plan: PaintPlan;
}
interface World {
  index: GraphIndex;
  layout: WiringLayout;
}
const SAMPLE: World = { index, layout };
const TODAY: World = { index: tIndex, layout: tLayout };

function casesOf(
  w: World,
  states: readonly (readonly [string, VariantState])[],
  sels: readonly (readonly [string, Selection | null])[],
): Case[] {
  const out: Case[] = [];
  for (const [sname, state] of states)
    for (const [name, sel] of sels) {
      const lit = sel ? select(w.index, state, sel) : null;
      if (sel) expect(lit, `${name}（${sname}）`).not.toBeNull();
      out.push({
        name: `${name}（${sname}）`,
        state,
        lit,
        plan: paintPlan({
          index: w.index,
          layout: w.layout,
          lit,
          inactive: inactiveOf(w.index, state),
        }),
      });
    }
  return out;
}

/** 選択 × 分岐の組（箱・項目・線・型・解除、既定と HIT）。例の graph */
function PLANS(): Case[] {
  const firstWire = index.wires.find((w) => layout.routes.has(w.key))!;
  return casesOf(
    SAMPLE,
    [
      ['既定', state0],
      ['HIT', hit],
    ],
    [
      ['なし', null],
      ['画面', { kind: 'box', id: 'route:/' }],
      ['関数', { kind: 'box', id: 'fn:toTodayView' }],
      ['POST', { kind: 'box', id: 'endpoint:POST /transactions' }],
      ['切れた線の送り側', { kind: 'box', id: index.items.get(layout.broken[0]!.from)!.node.id }],
      ['項目', { kind: 'item', ref: 'actor:user#out/open' }],
      ['線', { kind: 'wire', from: firstWire.wire.from, to: firstWire.wire.to }],
      ['型', { kind: 'type', typeRef: 'type:Entry' }],
    ],
  );
}

/** 分岐で項目・線が消える graph の組（date なし・未ログイン） */
function TODAY_PLANS(): Case[] {
  return casesOf(
    TODAY,
    [
      ['既定', tState0],
      ['date なし', noDate],
      ['未ログイン', noLogin],
    ],
    [
      ['なし', null],
      ['画面', { kind: 'box', id: 'screen:/today' }],
      ['分岐に無い項目', { kind: 'item', ref: 'screen:/today#out/render_login' }],
      ['date の項目', { kind: 'item', ref: 'actor:user#out/date' }],
      ['date の線', { kind: 'wire', ...DATE_WIRE }],
    ],
  );
}

/** どの組からどの組へ付け替えても、全体を作り直したときと class が同じ */
function roundTrip(w: World, cases: Case[]): number {
  const svgs = cases.map((c) => renderScene({ ...w, state: c.state, lit: c.lit }));
  const want = svgs.map(classes);
  let checked = 0;
  for (let a = 0; a < cases.length; a++)
    for (let b = 0; b < cases.length; b++) {
      const got = repaint(svgs[a]!, cases[a]!.plan, cases[b]!.plan);
      expect([...got].sort(), `${cases[a]!.name} → ${cases[b]!.name}`).toEqual(
        [...want[b]!].sort(),
      );
      checked++;
    }
  return checked;
}

describe('全体を作る経路と付け替える経路', () => {
  const cases = PLANS();

  it('選択の組は全部ちがう計画になる（確かめる組に意味がある）', () => {
    expect(cases.filter((c) => c.lit).length).toBeGreaterThanOrEqual(12);
    expect(cases.every((c) => (c.lit !== null) === c.plan.hasSel)).toBe(true);
  });

  it('markup の class は「選択と分岐に依らない class ＋ 計画の class（末尾）」', () => {
    for (const c of cases) {
      const svg = renderScene({ index, layout, state: c.state, lit: c.lit });
      const got = classes(svg);
      expect(got.size, c.name).toBeGreaterThan(50);
      for (const [k, cls] of got) {
        const d = dyn(c.plan, kindOf(k), idOf(k));
        expect(cls.endsWith(d), `${c.name} ${k}: ${cls}`).toBe(true);
        // 土台に選択と分岐の class は残らない
        expect(baseClass(cls, c.plan, kindOf(k), idOf(k)), `${c.name} ${k}`).not.toMatch(
          /(^| )(lit|start|on|off|under|inactive)( |$)/,
        );
      }
      // 計画にある id は markup に必ずある（付け替える相手がいる）
      for (const kind of PAINT_KINDS)
        for (const id of c.plan[kind].keys())
          expect(
            [...got.keys()].some((k) => kindOf(k) === kind && idOf(k) === id),
            `${c.name} ${kind} ${id}`,
          ).toBe(true);
    }
  });

  it('どの組からどの組へ付け替えても、全体を作り直したときと class が同じ（解除も、分岐の切り替えも）', () => {
    expect(roundTrip(SAMPLE, cases)).toBe(cases.length ** 2);
  });

  it('分岐で項目・線が消える graph でも同じ（inactive の付け外し）', () => {
    const t = TODAY_PLANS();
    expect(roundTrip(TODAY, t)).toBe(t.length ** 2);
    // 確かめた組に inactive の線・項目の付け外しが入っている
    expect(t.some((c) => [...c.plan.wires.values()].some((x) => x.includes('inactive')))).toBe(
      true,
    );
    expect(new Set(t.map((c) => c.plan.items.size)).size).toBeGreaterThan(1);
  });

  it('続けて付け替えても同じ（前の計画との差を積み重ねる）', () => {
    let svgClasses = classes(renderScene({ index, layout, state: state0, lit: null }));
    const base = new Map(
      [...svgClasses].map(([k, cls]) => [k, baseClass(cls, cases[0]!.plan, kindOf(k), idOf(k))]),
    );
    const targets = byTarget(base.keys());
    let prev = cases[0]!.plan;
    const order = [3, 9, 1, 0, 12, 5, 7, 15, 8, 2, 0];
    for (const i of order) {
      const next = cases[i]!.plan;
      svgClasses = new Map(svgClasses);
      for (const op of planDiff(prev, next))
        for (const k of targets.get(`${op.kind}|${op.id}`) ?? [])
          svgClasses.set(k, paintedClass(base.get(k)!, op.cls));
      prev = next;
      const want = classes(
        renderScene({ index, layout, state: cases[i]!.state, lit: cases[i]!.lit }),
      );
      expect([...svgClasses].sort(), cases[i]!.name).toEqual([...want].sort());
    }
  });

  it('差分の場面でも同じ（幽霊は付け替えの相手に入らない）', () => {
    const { overlay: ov, index: ui, layout: ul } = unionScene();
    const diff: DiffMarks = ov;
    const union = { index: ui, layout: ul, diff };
    // 選ぶのは今の graph の索引、描くのは幽霊を足した索引（id は同じ。今の分岐に無いものは描く索引から）
    const inactive = inactiveOf(ui, state0);
    const lits = [
      null,
      select(index, state0, { kind: 'box', id: 'fn:toTodayView' }),
      select(index, state0, { kind: 'box', id: 'route:/' }),
      select(index, state0, { kind: 'type', typeRef: 'type:Entry' }),
    ];
    const plans = lits.map((l) => paintPlan({ ...union, lit: l, inactive }));
    const svgs = lits.map((l) => renderScene({ ...union, state: state0, lit: l }));
    for (let a = 0; a < lits.length; a++)
      for (let b = 0; b < lits.length; b++)
        expect([...repaint(svgs[a]!, plans[a]!, plans[b]!)].sort(), `${a} → ${b}`).toEqual(
          [...classes(svgs[b]!)].sort(),
        );
    for (const svg of svgs) expect(svg).toMatch(/data-ghost(-item|-wire)?=/);
  });
});

describe('planDiff', () => {
  it('同じ計画どうしは 0 件。変わる要素だけを返す（沈める側には触らない）', () => {
    const a = plan(pick({ kind: 'box', id: 'route:/' }));
    expect(planDiff(a, plan(pick({ kind: 'box', id: 'route:/' })))).toEqual([]);
    const none = plan(null);
    const ops = planDiff(none, a);
    // 付く・変わる id の数だけ（箱・host・項目・線は光るもの、切れた線は lit が外れるもの）
    const touched = PAINT_KINDS.reduce((n, k) => {
      let c = 0;
      for (const id of none[k].keys()) if (!a[k].has(id)) c++;
      for (const [id, cls] of a[k]) if (none[k].get(id) !== cls) c++;
      return n + c;
    }, 0);
    expect(ops.length).toBe(touched);
    const total =
      layout.boxes.size +
      layout.hosts.size +
      layout.pins.size +
      index.wires.length +
      layout.broken.length;
    expect(ops.length).toBeLessThan(total);
    // 外す op は cls が空
    const back = planDiff(a, none);
    expect(back.filter((o) => o.kind === 'boxes').every((o) => o.cls === '')).toBe(true);
    expect(back.length).toBe(ops.length);
  });

  it('op の順は kind（PAINT_KINDS）→ 外す → 付ける', () => {
    const a = plan(pick({ kind: 'box', id: 'route:/' }));
    const b = plan(pick({ kind: 'box', id: 'endpoint:POST /transactions' }));
    const ops = planDiff(a, b);
    const kinds = ops.map((o) => PAINT_KINDS.indexOf(o.kind));
    expect(kinds).toEqual([...kinds].sort((x, y) => x - y));
    for (const kind of PAINT_KINDS) {
      const of = ops.filter((o) => o.kind === kind).map((o) => o.cls === '');
      // 外す（true）が先に並び、そのあと付ける（false）
      expect(of.lastIndexOf(true)).toBeLessThan(of.includes(false) ? of.indexOf(false) : of.length);
    }
  });
});
