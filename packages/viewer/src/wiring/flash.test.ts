// 項目の点滅（docs/18 §11.6、D118）: 偽の animate とタイマーで、相手（ピンと文字）・keyframes・60ms ずつのずらし・
// 見えているものだけ・やり直し・取り消しを確かめる（DOM は使わない）
import { describe, expect, it } from 'vitest';
import {
  EDGE_FRAMES,
  FLASH_MS,
  FLASH_OPTIONS,
  Flasher,
  itemTargets,
  PIN_FRAMES,
  pinVisible,
  STAGGER_MS,
  TEXT_FRAMES,
  type FlashHandle,
  type FlashTarget,
} from './flash';

interface FakeAnim extends FlashHandle {
  el: string;
  frames: Keyframe[];
  options: KeyframeAnimationOptions;
  cancelled: boolean;
  at: number;
}

/** 偽の時計と animate。tick(ms) で時間を進める */
function harness(
  opts: { hidden?: Set<string>; missing?: Set<string>; textless?: Set<string> } = {},
) {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const anims: FakeAnim[] = [];
  const asked: string[] = [];
  const flasher = new Flasher<string>({
    targets: (ref) => {
      asked.push(ref);
      if (opts.missing?.has(ref)) return [];
      return itemTargets({
        pin: `${ref}:pin`,
        text: opts.textless?.has(ref) ? null : `${ref}:text`,
      });
    },
    visible: (ref) => !opts.hidden?.has(ref),
    animate: (el, frames, options) => {
      const a: FakeAnim = {
        el,
        frames,
        options,
        cancelled: false,
        at: now,
        cancel() {
          a.cancelled = true;
        },
      };
      anims.push(a);
      return a;
    },
    setTimer: (fn, ms) => {
      timers.set(++seq, { at: now + ms, fn });
      return seq;
    },
    clearTimer: (h) => void timers.delete(h as number),
  });
  const tick = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const next = [...timers]
        .filter(([, t]) => t.at <= until)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]);
      now = next[1].at;
      next[1].fn();
    }
    now = until;
  };
  return { flasher, anims, asked, tick, timers, hidden: opts.hidden };
}

describe('Flasher', () => {
  it('項目のピン（塗りと縁）と文字（塗り）を白くして 0.4 秒で戻す。filter は使わない', () => {
    const h = harness();
    h.flasher.flash(['a#in/x']);
    expect(h.anims.map((a) => a.el)).toEqual(['a#in/x:pin', 'a#in/x:text']);
    expect(h.anims[0]!.frames).toEqual([{ fill: '#fff', stroke: '#fff', offset: 0 }]);
    expect(h.anims[1]!.frames).toEqual([{ fill: '#fff', offset: 0 }]);
    for (const a of h.anims) {
      expect(a.options).toEqual({ duration: 400, easing: 'ease-out' });
      expect(JSON.stringify(a.frames)).not.toContain('filter');
    }
    expect(FLASH_MS).toBe(400);
    expect(FLASH_OPTIONS.duration).toBe(FLASH_MS);
    expect(PIN_FRAMES).toBe(h.anims[0]!.frames);
    expect(TEXT_FRAMES).toBe(h.anims[1]!.frames);
    expect(h.flasher.pending).toEqual({ timers: 0, running: 2 });
  });

  it('子の項目は 60ms ずつずらして上から順に（最初はすぐ）', () => {
    const h = harness();
    h.flasher.flash(['p', 'p.a', 'p.b', 'p.c']);
    expect(STAGGER_MS).toBe(60);
    expect(h.anims.map((a) => a.el)).toEqual(['p:pin', 'p:text']);
    expect(h.flasher.pending).toEqual({ timers: 3, running: 2 });
    h.tick(59);
    expect(h.anims.length).toBe(2);
    h.tick(1);
    expect(h.anims.map((a) => a.el).slice(2)).toEqual(['p.a:pin', 'p.a:text']);
    h.tick(120);
    expect(h.anims.filter((a) => a.el.endsWith(':pin')).map((a) => [a.el, a.at])).toEqual([
      ['p:pin', 0],
      ['p.a:pin', 60],
      ['p.b:pin', 120],
      ['p.c:pin', 180],
    ]);
    expect(h.flasher.pending).toEqual({ timers: 0, running: 8 });
  });

  it('見えていない項目・要素の無い項目は飛ばす（見えるかは光らせる時点で決める。要素は引かない）', () => {
    const hidden = new Set(['b']);
    const h = harness({ hidden, missing: new Set(['c']), textless: new Set(['d']) });
    h.flasher.flash(['a', 'b', 'c', 'd', 'e']);
    hidden.add('e'); // 待っている間に画面の外へ出た
    h.tick(1000);
    expect(h.anims.map((a) => a.el)).toEqual(['a:pin', 'a:text', 'd:pin']);
    // 見えていないものは要素を引かない（b・e）
    expect(h.asked).toEqual(['a', 'c', 'd']);
    expect(h.flasher.pending).toEqual({ timers: 0, running: 3 });
  });

  it('同じ項目が続けて光るときは、前の点滅を止めて最初からやり直す', () => {
    const h = harness();
    h.flasher.flash(['a']);
    h.tick(100);
    h.flasher.flash(['a']);
    expect(h.anims.map((a) => a.cancelled)).toEqual([true, true, false, false]);
    expect(h.flasher.pending.running).toBe(2);
  });

  it('終わった点滅は覚えておかない（onfinish）。やり直したあとに前の onfinish が来ても、今の点滅は消さない', () => {
    const h = harness();
    h.flasher.flash(['a', 'b']);
    h.tick(60);
    expect(h.flasher.pending.running).toBe(4);
    const [aPin, aText] = h.anims;
    (aPin!.onfinish as () => void)();
    (aText!.onfinish as () => void)();
    expect(h.flasher.pending.running).toBe(2);
    h.flasher.flash(['b']);
    const oldB = h.anims[2]!;
    expect(oldB.cancelled).toBe(true);
    (oldB.onfinish as () => void)();
    expect(h.flasher.pending.running).toBe(2);
  });

  it('cancel(): 待っている点滅と走っている点滅を全部取り消す（選び直し・解除・場面の差し替え）', () => {
    const h = harness();
    h.flasher.flash(['a', 'b', 'c']);
    h.tick(60);
    expect(h.flasher.pending).toEqual({ timers: 1, running: 4 });
    h.flasher.cancel();
    expect(h.flasher.pending).toEqual({ timers: 0, running: 0 });
    expect(h.timers.size).toBe(0);
    expect(h.anims.every((a) => a.cancelled)).toBe(true);
    h.tick(1000);
    expect(h.anims.length).toBe(4);
    // 取り消したあとも使える
    h.flasher.flash(['a']);
    expect(h.flasher.pending).toEqual({ timers: 0, running: 2 });
  });

  it('相手は差し替えられる: 鍵は項目の ref でなくてもよい（箱の縁を 1 回光らせる）', () => {
    const anims: [string, Keyframe[]][] = [];
    const targets = (key: string): FlashTarget<string>[] =>
      key.startsWith('box:') ? [{ el: `${key}:shape`, frames: EDGE_FRAMES }] : [];
    const f = new Flasher<string>({
      targets,
      visible: () => true,
      animate: (el, frames) => (anims.push([el, frames]), { cancel() {} }),
      setTimer: () => 0,
      clearTimer: () => {},
    });
    f.flash(['box:fn:a']);
    expect(anims).toEqual([['box:fn:a:shape', [{ stroke: '#fff', offset: 0 }]]]);
    expect(itemTargets(null)).toEqual([]);
    expect(itemTargets({ pin: null, text: 't' })).toEqual([{ el: 't', frames: TEXT_FRAMES }]);
  });
});

describe('pinVisible', () => {
  const stage = { width: 1000, height: 600 };
  const view = { k: 1, tx: 0, ty: 0 };

  it('画面の中のピンは見えている。外でも、文字の幅（横 320）と 1 行（縦 16）の余裕までは見えている扱い', () => {
    expect(pinVisible({ x: 500, y: 300 }, view, stage)).toBe(true);
    expect(pinVisible({ x: -320, y: 0 }, view, stage)).toBe(true);
    expect(pinVisible({ x: -321, y: 0 }, view, stage)).toBe(false);
    expect(pinVisible({ x: 1320, y: 616 }, view, stage)).toBe(true);
    expect(pinVisible({ x: 1321, y: 300 }, view, stage)).toBe(false);
    expect(pinVisible({ x: 500, y: 617 }, view, stage)).toBe(false);
    expect(pinVisible({ x: 500, y: -17 }, view, stage)).toBe(false);
  });

  it('倍率と移動を掛ける（余裕も倍率ぶん）', () => {
    const zoomed = { k: 2, tx: -1000, ty: -100 };
    expect(pinVisible({ x: 600, y: 100 }, zoomed, stage)).toBe(true); // 画面の (200, 100)
    expect(pinVisible({ x: 100, y: 100 }, zoomed, stage)).toBe(false); // 画面の (-800, 100)。余裕は 640
    expect(pinVisible({ x: 180, y: 100 }, zoomed, stage)).toBe(true); // 画面の (-640, 100)
    const small = { k: 0.1, tx: 0, ty: 0 };
    expect(pinVisible({ x: 10_320, y: 0 }, small, stage)).toBe(true);
    expect(pinVisible({ x: 10_330, y: 0 }, small, stage)).toBe(false);
  });

  it('ピンが無い・面に大きさが無い（隠れている）ときは見えていない', () => {
    expect(pinVisible(undefined, view, stage)).toBe(false);
    expect(pinVisible({ x: 1, y: 1 }, view, { width: 0, height: 600 })).toBe(false);
    expect(pinVisible({ x: 1, y: 1 }, view, { width: 1000, height: 0 })).toBe(false);
  });
});
