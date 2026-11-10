// 沈める表現（docs/18 §11.5、D117・D122）: 係数の正（dim.ts）と style.css の「沈める表現」の区画が合っていること、
// 区画の規則をカスケードどおりに当てた結果が §11.5 の表（箱の係数 × 項目の係数、線は 1 要素 1 値）になること、
// 区画の外に沈める規則・opacity の transition が無いこと
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { boxFactor, brokenOpacity, DIM, itemFactor, itemOpacity, wireOpacity } from './dim';

const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8');
const splitCss = readFileSync(new URL('../split/split.css', import.meta.url), 'utf8');
const BEGIN = '/* ==== 沈める表現 ここから';
const END = '/* ==== 沈める表現 ここまで ==== */';

interface Rule {
  selector: string;
  decls: Map<string, string>;
  /** ファイルの中での順（あとの規則が勝つ） */
  order: number;
}

/** コメントを除いて「セレクタ { 宣言 }」に分ける（@media などの入れ子は中の規則を同じ並びで返す） */
function parseRules(text: string): Rule[] {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Rule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const decls = new Map<string, string>();
    for (const d of m[2]!.split(';')) {
      const i = d.indexOf(':');
      if (i < 0) continue;
      decls.set(d.slice(0, i).trim(), d.slice(i + 1).trim());
    }
    // 入れ子（@media … {）の頭が付いていたら落とす
    const head = m[1]!.includes('{') ? m[1]!.slice(m[1]!.lastIndexOf('{') + 1) : m[1]!;
    for (const selector of head.split(','))
      if (selector.trim() && !selector.trim().startsWith('@'))
        out.push({ selector: selector.trim().replace(/\s+/g, ' '), decls, order: out.length });
  }
  return out;
}

const at = css.indexOf(BEGIN);
const end = css.indexOf(END);
const block = css.slice(at, end + END.length);
const outside = css.slice(0, at) + css.slice(end + END.length);
const rules = parseRules(block);

/** 要素 = タグと class（根から順に並べたものが「祖先の列」） */
interface El {
  tag: string;
  cls: readonly string[];
}
const el = (tag: string, ...cls: (string | false)[]): El => ({
  tag,
  cls: cls.filter((c): c is string => !!c),
});

/** 複合セレクタ（`text`・`.a.b:not(.c)`）が要素に合うか */
function matchesCompound(compound: string, e: El): boolean {
  let rest = compound;
  const nots: string[] = [];
  rest = rest.replace(/:not\(\.([\w-]+)\)/g, (_, c: string) => (nots.push(c), ''));
  const tag = /^[a-z]+/.exec(rest)?.[0];
  const classes = [...rest.matchAll(/\.([\w-]+)/g)].map((m) => m[1]!);
  // このテストが読める形だけ（知らない擬似クラス・属性が来たら止める）
  expect(rest.replace(/^[a-z]+/, '').replace(/\.[\w-]+/g, ''), compound).toBe('');
  if (tag && tag !== e.tag) return false;
  return classes.every((c) => e.cls.includes(c)) && nots.every((c) => !e.cls.includes(c));
}

/** 子孫結合子（空白）だけのセレクタが、祖先の列の最後の要素に合うか */
function matches(selector: string, chain: readonly El[]): boolean {
  const parts = selector.split(' ');
  if (!matchesCompound(parts[parts.length - 1]!, chain[chain.length - 1]!)) return false;
  let i = chain.length - 2;
  for (let p = parts.length - 2; p >= 0; p--) {
    while (i >= 0 && !matchesCompound(parts[p]!, chain[i]!)) i--;
    if (i < 0) return false;
    i--;
  }
  return true;
}

/** 詳細度（class と :not() の中の class の数 × 100 ＋ タグの数） */
function specificity(selector: string): number {
  const classes = (selector.match(/\.[\w-]+/g) ?? []).length;
  const tags = selector.split(' ').filter((c) => /^[a-z]/.test(c)).length;
  return classes * 100 + tags;
}

/** 祖先の列の最後の要素に効く宣言（詳細度 → 並びの順で勝ったもの）。区画の規則だけを見る */
function declared(chain: readonly El[], prop: string): string | undefined {
  let best: Rule | undefined;
  for (const r of rules) {
    if (!r.decls.has(prop) || !matches(r.selector, chain)) continue;
    if (
      !best ||
      specificity(r.selector) > specificity(best.selector) ||
      (specificity(r.selector) === specificity(best.selector) && r.order > best.order)
    )
      best = r;
  }
  return best?.decls.get(prop);
}

/** 継承する値（変数と塗りの不透明度）: 自分に宣言が無ければ親の値 */
function inherited(chain: readonly El[], prop: string): string | undefined {
  for (let n = chain.length; n > 0; n--) {
    const v = declared(chain.slice(0, n), prop);
    if (v !== undefined) return v;
  }
  return undefined;
}

/** 値を数にする（数・var(--x)・calc(var(--a) * var(--b)) だけ） */
function resolve(chain: readonly El[], value: string | undefined): number {
  if (value === undefined) return 1;
  const calc = /^calc\((.+)\)$/.exec(value);
  if (calc) return calc[1]!.split('*').reduce((n, t) => n * resolve(chain, t.trim()), 1);
  const v = /^var\((--[\w-]+)\)$/.exec(value);
  if (v) return resolve(chain, inherited(chain, v[1]!));
  expect(value, value).toMatch(/^[\d.]+$/);
  return Number(value);
}

/** 塗り（fill-opacity）の実効の値。要素の opacity が宣言されていればそれも掛ける */
const paintOpacity = (chain: readonly El[], prop: 'fill-opacity' | 'stroke-opacity'): number =>
  resolve(chain, inherited(chain, prop)) * resolve(chain, declared(chain, 'opacity'));

const root = (hasSel: boolean) => el('div', 'wv', hasSel && 'has-sel');
const bools = [false, true] as const;

describe('沈める表現の区画（style.css）と係数の正（dim.ts）', () => {
  it('区画は 1 つで、中の規則はこの表のとおり（規則を足したら表も足す）', () => {
    expect(css.split(BEGIN).length).toBe(2);
    expect(css.split(END).length).toBe(2);
    expect(end).toBeGreaterThan(at);
    const num = (n: number) => String(n);
    const both = (n: number | string) => ({
      'fill-opacity': String(n),
      'stroke-opacity': String(n),
    });
    const want: Record<string, Record<string, string>> = {
      '.wv .box': { '--bo': '1', '--io': '1', ...both('var(--bo)') },
      '.wv.has-sel .box:not(.lit)': { '--bo': num(DIM.box) },
      '.wv .box .item': both('calc(var(--bo) * var(--io))'),
      '.wv.has-sel .box .item:not(.on):not(.ghost):not(.inactive)': { '--io': num(DIM.itemOff) },
      '.wv .box .item.inactive': { '--io': num(DIM.itemInactive) },
      '.wv .box.scr .item text': { ...both(1), opacity: 'calc(var(--bo) * var(--io))' },
      '.wv.has-sel .host:not(.lit)': both(DIM.box),
      '.wv.has-sel .box:not(.lit) text': { visibility: 'hidden' },
      '.wv.has-sel .host:not(.lit) text': { visibility: 'hidden' },
      '.wv .wire.thin': { 'stroke-opacity': num(DIM.wire) },
      '.wv .wire.thin.inactive': { 'stroke-opacity': num(DIM.wireInactive) },
      '.wv .wire.thin.ghost': { 'stroke-opacity': num(DIM.wireGhost) },
      '.wv .wire.thin.added': { 'stroke-opacity': num(DIM.wireAdded) },
      '.wv.has-sel .wire.thin': { 'stroke-opacity': num(DIM.wireSel) },
      '.wv.has-sel .wire.thin.inactive': { 'stroke-opacity': num(DIM.wireSelInactive) },
      '.wv.has-sel .wire.thin.added': { 'stroke-opacity': num(DIM.wireSelAdded) },
      '.wv .wire.under': { visibility: 'hidden' },
      '.wv .wire.broken:not(.lit)': { 'stroke-opacity': num(DIM.brokenOff) },
    };
    const got = Object.fromEntries(rules.map((r) => [r.selector, Object.fromEntries(r.decls)]));
    expect(got).toEqual(want);
    expect(rules.length).toBe(Object.keys(want).length);
  });

  it('区画の中: transition は無い。要素の opacity は画面の箱の上の項目の文字だけ（縁取りがあるので）', () => {
    for (const r of rules) {
      expect(
        [...r.decls.keys()].some((p) => p.startsWith('transition')),
        r.selector,
      ).toBe(false);
      expect(r.decls.has('opacity'), r.selector).toBe(r.selector === '.wv .box.scr .item text');
      expect(r.decls.has('display'), r.selector).toBe(false);
      expect(r.decls.has('filter'), r.selector).toBe(false);
    }
  });

  it('区画の外: 沈める規則が無い（opacity の宣言は球のまわりの光だけ。has-sel・under・inactive・dim のセレクタが無い）', () => {
    const others = parseRules(outside);
    expect(others.length).toBeGreaterThan(100);
    const opacity = others.filter((r) => [...r.decls.keys()].some((p) => p.endsWith('opacity')));
    expect(opacity.map((r) => [r.selector, Object.fromEntries(r.decls)['fill-opacity']])).toEqual([
      ['.wv .ball-halo', '0.28'],
    ]);
    for (const r of others) {
      expect(r.selector, r.selector).not.toMatch(
        /\.(has-sel|under|inactive|dim|dimmed|off)(?![\w-])/,
      );
      // opacity を動かす transition・animation は無い（all も opacity を含む）
      for (const [p, v] of r.decls)
        if (p.startsWith('transition')) expect(v, r.selector).not.toMatch(/opacity|\ball\b/);
    }
    expect(outside).not.toMatch(/@keyframes/);
    // 2 面の CSS は配線図の濃さに触らない
    const split = parseRules(splitCss);
    expect(split.length).toBeGreaterThan(5);
    for (const r of split) {
      expect(r.selector, r.selector).not.toMatch(/\.(has-sel|under|inactive|dim|lit|on)(?![\w-])/);
      expect(
        [...r.decls.keys()].some((p) => p.endsWith('opacity')),
        r.selector,
      ).toBe(false);
    }
  });
});

describe('実効の不透明度（§11.5 の表）', () => {
  it('表の値: 箱の係数 × 項目の係数（沈んだ箱の中の光らない項目は 0.0525、分岐に無い項目は 0.03）', () => {
    const o = (
      hasSel: boolean,
      boxLit: boolean,
      s: { on?: boolean; inactive?: boolean; ghost?: boolean },
    ) => itemOpacity({ hasSel, boxLit, on: !!s.on, inactive: !!s.inactive, ghost: !!s.ghost });
    // 選択なし
    expect(o(false, false, {})).toBe(1);
    expect(o(false, false, { inactive: true })).toBe(0.2);
    expect(o(false, false, { ghost: true })).toBe(1);
    // 選択中・光る箱
    expect(o(true, true, { on: true })).toBe(1);
    expect(o(true, true, {})).toBe(0.35);
    expect(o(true, true, { inactive: true })).toBe(0.2);
    expect(o(true, true, { ghost: true })).toBe(1);
    // 選択中・沈む箱
    expect(boxFactor({ hasSel: true, lit: false })).toBe(0.15);
    expect(o(true, false, {})).toBeCloseTo(0.0525, 10);
    expect(o(true, false, { inactive: true })).toBeCloseTo(0.03, 10);
    expect(o(true, false, { ghost: true })).toBe(0.15);
    expect(boxFactor({ hasSel: false, lit: false })).toBe(1);
    expect(boxFactor({ hasSel: true, lit: true })).toBe(1);
    // 項目の係数: 今の分岐に無いほうが、光らないより優先
    expect(itemFactor({ hasSel: true, on: false, inactive: true, ghost: false })).toBe(0.2);
    expect(itemFactor({ hasSel: true, on: true, inactive: true, ghost: false })).toBe(0.2);
  });

  it('線の表: 選択なし .35 / 無い .1 / 幽霊 .6 / 今だけ .75、選択中 .12 / 無い .1 / 今だけ .15（幽霊は .12）、切れた線は 1 か .6', () => {
    const w = (hasSel: boolean, s: { inactive?: boolean; ghost?: boolean; added?: boolean }) =>
      wireOpacity({ hasSel, inactive: !!s.inactive, ghost: !!s.ghost, added: !!s.added });
    expect(w(false, {})).toBe(0.35);
    expect(w(false, { inactive: true })).toBe(0.1);
    expect(w(false, { ghost: true })).toBe(0.6);
    expect(w(false, { added: true })).toBe(0.75);
    expect(w(false, { added: true, inactive: true })).toBe(0.75);
    expect(w(true, {})).toBe(0.12);
    expect(w(true, { inactive: true })).toBe(0.1);
    expect(w(true, { ghost: true })).toBe(0.12);
    expect(w(true, { added: true })).toBe(0.15);
    expect(w(true, { added: true, inactive: true })).toBe(0.15);
    expect(brokenOpacity({ lit: true })).toBe(1);
    expect(brokenOpacity({ lit: false })).toBe(0.6);
  });

  it('CSS の区画をカスケードどおりに当てると、箱・項目の実効が dim.ts と同じ（全部の組）', () => {
    let n = 0;
    for (const hasSel of bools)
      for (const boxLit of bools)
        for (const on of bools)
          for (const inactive of bools)
            for (const ghost of bools)
              for (const scr of bools) {
                // 幽霊の項目には選択と分岐の class が付かない（塗りの計画が飛ばす。paint.test.ts）
                if (ghost && (on || inactive)) continue;
                const box = el('g', 'box', scr && 'scr', boxLit && 'lit');
                const item = el(
                  'g',
                  'item',
                  ghost && 'ghost',
                  on && 'on',
                  inactive && 'off',
                  inactive && 'inactive',
                );
                const name = JSON.stringify({ hasSel, boxLit, on, inactive, ghost, scr });
                // 箱の図形（箱の子の rect）
                const shape = [root(hasSel), box, el('rect', 'shape')];
                const bo = boxFactor({ hasSel, lit: boxLit });
                expect(paintOpacity(shape, 'fill-opacity'), name).toBeCloseTo(bo, 10);
                expect(paintOpacity(shape, 'stroke-opacity'), name).toBeCloseTo(bo, 10);
                // 項目のピンと文字
                const want = itemOpacity({ hasSel, boxLit, on, inactive, ghost });
                for (const leaf of [el('circle', 'pin'), el('text')]) {
                  const chain = [root(hasSel), box, item, leaf];
                  expect(paintOpacity(chain, 'fill-opacity'), `${name} ${leaf.tag}`).toBeCloseTo(
                    want,
                    10,
                  );
                  expect(paintOpacity(chain, 'stroke-opacity'), `${name} ${leaf.tag}`).toBeCloseTo(
                    want,
                    10,
                  );
                }
                n++;
              }
    expect(n).toBe(40);
  });

  it('画面の箱の上の項目の文字は、塗りを 1 に戻して要素の opacity に同じ積（縁と塗りが別々に薄くならない）', () => {
    const chain = [root(true), el('g', 'box', 'scr'), el('g', 'item'), el('text')];
    expect(resolve(chain, inherited(chain, 'fill-opacity'))).toBe(1);
    expect(resolve(chain, inherited(chain, 'stroke-opacity'))).toBe(1);
    expect(resolve(chain, declared(chain, 'opacity'))).toBeCloseTo(DIM.box * DIM.itemOff, 10);
    // 画面でない箱の文字は要素の opacity を使わない
    const plain = [root(true), el('g', 'box'), el('g', 'item'), el('text')];
    expect(declared(plain, 'opacity')).toBeUndefined();
  });

  it('CSS の区画をカスケードどおりに当てると、線の値が dim.ts と同じ（全部の組）。host と切れた線も', () => {
    for (const hasSel of bools)
      for (const inactive of bools)
        for (const ghost of bools)
          for (const added of bools) {
            const wire = el(
              'path',
              'wire',
              'thin',
              ghost && 'ghost',
              added && 'added',
              inactive && 'inactive',
            );
            expect(
              paintOpacity([root(hasSel), wire], 'stroke-opacity'),
              JSON.stringify({ hasSel, inactive, ghost, added }),
            ).toBe(wireOpacity({ hasSel, inactive, ghost, added }));
          }
    for (const hasSel of bools)
      for (const lit of bools) {
        const host = [root(hasSel), el('g', 'host', lit && 'lit'), el('rect', 'frame')];
        expect(paintOpacity(host, 'stroke-opacity')).toBe(boxFactor({ hasSel, lit }));
        expect(paintOpacity(host, 'fill-opacity')).toBe(boxFactor({ hasSel, lit }));
        const broken = [root(hasSel), el('path', 'wire', 'broken', lit && 'lit')];
        expect(paintOpacity(broken, 'stroke-opacity')).toBe(brokenOpacity({ lit }));
      }
  });

  it('沈んだ箱・host の文字と、光る線の下の基の線は隠す（visibility。display: none にしない）', () => {
    const hidden = (chain: El[]) => declared(chain, 'visibility') === 'hidden';
    expect(hidden([root(true), el('g', 'box'), el('text')])).toBe(true);
    expect(hidden([root(true), el('g', 'box'), el('g', 'item'), el('text')])).toBe(true);
    expect(hidden([root(true), el('g', 'box', 'lit'), el('g', 'item'), el('text')])).toBe(false);
    expect(hidden([root(false), el('g', 'box'), el('text')])).toBe(false);
    expect(hidden([root(true), el('g', 'host'), el('text')])).toBe(true);
    expect(hidden([root(true), el('g', 'host', 'lit'), el('text')])).toBe(false);
    expect(hidden([root(false), el('path', 'wire', 'thin', 'under')])).toBe(true);
    expect(hidden([root(true), el('path', 'wire', 'thin')])).toBe(false);
  });
});
