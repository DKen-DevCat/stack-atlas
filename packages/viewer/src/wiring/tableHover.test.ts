// 分岐の表の出し入れ: 箱 → 隙間 → 表へ動かしても消えない。箱からも表からも離れたら少し待って消える
import { describe, expect, it } from 'vitest';
import { createTableHover, TABLE_HIDE_DELAY_MS } from './tableHover';

/** 時計を手で進める版 */
function setup(variants: string[] = ['cache:a', 'cache:b']) {
  let now = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let seq = 0;
  const log: string[] = [];
  let shown: string | null = null;
  const hover = createTableHover({
    hasVariants: (id) => variants.includes(id),
    tableNode: () => shown,
    showTable: (id) => {
      shown = id;
      log.push(`show ${id}`);
    },
    hideTable: () => {
      shown = null;
      log.push('hide');
    },
    setTimer: (fn, ms) => {
      timers.set(++seq, { at: now + ms, fn });
      return seq;
    },
    clearTimer: (h) => timers.delete(h as number),
  });
  const advance = (ms: number) => {
    now += ms;
    for (const [id, t] of [...timers]) {
      if (t.at > now) continue;
      timers.delete(id);
      t.fn();
    }
  };
  return { hover, advance, log, shown: () => shown };
}

describe('分岐の表の出し入れ', () => {
  it('箱 → 隙間（SVG の地）→ 表: 隙間を通っても消えず、表の上に居続けても消えない', () => {
    const { hover, advance, log, shown } = setup();
    hover.over('cache:a', false);
    expect(shown()).toBe('cache:a');
    hover.over(null, false); // 箱と表の間の 6px
    advance(10);
    hover.over(null, true); // 表に入った
    advance(TABLE_HIDE_DELAY_MS * 3);
    expect(shown()).toBe('cache:a');
    expect(log).toEqual(['show cache:a']);
  });

  it('箱からも表からも離れたら、待つ時間のあとに消える（それより前は出ている）', () => {
    const { hover, advance, shown } = setup();
    hover.over('cache:a', false);
    hover.over(null, true);
    hover.over(null, false);
    advance(TABLE_HIDE_DELAY_MS - 1);
    expect(shown()).toBe('cache:a');
    advance(1);
    expect(shown()).toBeNull();
  });

  it('隙間から同じ箱へ戻れば消さない。配線図の外へ出たら待って消す', () => {
    const { hover, advance, log, shown } = setup();
    hover.over('cache:a', false);
    hover.over(null, false);
    hover.over('cache:a', false);
    advance(TABLE_HIDE_DELAY_MS * 2);
    expect(shown()).toBe('cache:a');
    hover.leave();
    advance(TABLE_HIDE_DELAY_MS);
    expect(shown()).toBeNull();
    expect(log).toEqual(['show cache:a', 'hide']);
  });

  it('別の箱へ移ったらすぐ切り替える。分岐の無い箱ならすぐ消す', () => {
    const { hover, log, shown } = setup();
    hover.over('cache:a', false);
    hover.over('cache:b', false);
    expect(shown()).toBe('cache:b');
    hover.over('fn:plain', false);
    expect(shown()).toBeNull();
    expect(log).toEqual(['show cache:a', 'show cache:b', 'hide']);
  });

  it('表が出ていなければ消す予約もしない。dispose で予約を取り消す', () => {
    const { hover, advance, log } = setup();
    hover.over(null, false);
    advance(TABLE_HIDE_DELAY_MS);
    expect(log).toEqual([]);
    hover.over('cache:a', false);
    hover.over(null, false);
    hover.dispose();
    advance(TABLE_HIDE_DELAY_MS);
    expect(log).toEqual(['show cache:a']);
  });
});
