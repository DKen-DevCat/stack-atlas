import { describe, expect, it } from 'vitest';
import { framePlan, type FrameState } from './frames';

const idle: FrameState = {
  dirty: false,
  camera: false,
  controls: false,
  explode: false,
  flow: false,
  cache: false,
  mapFlow: false,
  hidden: false,
};

describe('framePlan（止まっている間は描かない。docs/20 §5.1 #10）', () => {
  it('何も動かず変わってもいなければ描かず、次のフレームも頼まない', () => {
    expect(framePlan(idle)).toEqual({ render: false, next: false });
  });

  it('見た目が変わっただけなら 1 回描いて止まる', () => {
    expect(framePlan({ ...idle, dirty: true })).toEqual({ render: true, next: false });
  });

  it('動いているものが 1 つでもあれば描いて、次のフレームも頼む', () => {
    for (const k of ['camera', 'controls', 'explode', 'flow', 'cache', 'mapFlow'] as const)
      expect(framePlan({ ...idle, [k]: true })).toEqual({ render: true, next: true });
  });

  it('隠れた面は何があっても描かない（出したときに描き直す）', () => {
    expect(framePlan({ ...idle, hidden: true, dirty: true, mapFlow: true, camera: true })).toEqual({
      render: false,
      next: false,
    });
  });
});
