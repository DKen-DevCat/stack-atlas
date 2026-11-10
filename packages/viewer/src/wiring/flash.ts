// 球が出た・着いた項目の点滅（docs/18 §11.6、D118）: 項目のピンと文字を白くして 0.4 秒で戻す。親の線で届いたなら子を 60ms ずつ
// ずらして上から順に。Web Animations API で再始動する（class の付け外しと強制レイアウトを使わない）。filter は使わない。
// 画面に見えている項目だけ光らせる（配置の座標と canvas の表示範囲から計算する。DOM を測らない）。
// animate とタイマーは差し替えられる（単体テストは偽物で確かめる）。光らせる相手（要素と keyframes）は targets が決めるので、
// 項目のほか、箱の縁を 1 回光らせるのにも同じ仕組みを使える（鍵は項目の ref でなくてもよい。docs/21 §2.9）
import type { View } from './view';

/** 子の項目を順に光らせる間隔 */
export const STAGGER_MS = 60;
/** 点滅の長さ */
export const FLASH_MS = 400;

/** 点滅させる要素 1 つと、その keyframes（最初の値から、要素の今の値へ戻す） */
export interface FlashTarget<E> {
  el: E;
  frames: Keyframe[];
}

/** 項目のピンと文字（無ければ null） */
export interface FlashParts<E> {
  pin: E | null;
  text: E | null;
}

/** 項目の点滅: ピンは塗りと縁を白く、文字は塗りを白く */
export const PIN_FRAMES: Keyframe[] = [{ fill: '#fff', stroke: '#fff', offset: 0 }];
export const TEXT_FRAMES: Keyframe[] = [{ fill: '#fff', offset: 0 }];
/** 縁だけを白く（箱の形・枠） */
export const EDGE_FRAMES: Keyframe[] = [{ stroke: '#fff', offset: 0 }];

/** 項目のピンと文字 → 点滅の相手 */
export function itemTargets<E>(parts: FlashParts<E> | null): FlashTarget<E>[] {
  const out: FlashTarget<E>[] = [];
  if (parts?.pin) out.push({ el: parts.pin, frames: PIN_FRAMES });
  if (parts?.text) out.push({ el: parts.text, frames: TEXT_FRAMES });
  return out;
}

/** 走っている点滅（取り消せる） */
export interface FlashHandle {
  cancel(): void;
  /** 終わったときに呼ばれる口（Animation.onfinish と同じ形。偽物は呼ばなくてよい） */
  onfinish?: ((...args: never[]) => unknown) | null;
}

export interface FlashDeps<E> {
  /** 鍵（項目の ref など）→ 点滅の相手（要素の Map から引く。querySelector を使わない）。無ければ空 */
  targets(key: string): readonly FlashTarget<E>[];
  /** 画面に見えているか */
  visible(key: string): boolean;
  /** 既定は el.animate(…)（Web Animations API） */
  animate?: (el: E, keyframes: Keyframe[], options: KeyframeAnimationOptions) => FlashHandle;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export const FLASH_OPTIONS: KeyframeAnimationOptions = { duration: FLASH_MS, easing: 'ease-out' };

export class Flasher<E = Element> {
  private readonly timers = new Set<unknown>();
  private readonly running = new Map<string, FlashHandle[]>();
  private readonly animate: NonNullable<FlashDeps<E>['animate']>;
  private readonly setTimer: NonNullable<FlashDeps<E>['setTimer']>;
  private readonly clearTimer: NonNullable<FlashDeps<E>['clearTimer']>;

  constructor(private readonly deps: FlashDeps<E>) {
    this.animate =
      deps.animate ?? ((el, frames, opts) => (el as unknown as Element).animate(frames, opts));
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** refs を順に（i 番目は i × 60ms 後に）光らせる。光らせる時点で見えていないもの・要素の無いものは飛ばす */
  flash(refs: readonly string[]): void {
    refs.forEach((ref, i) => {
      if (i === 0) return this.fire(ref);
      const t = this.setTimer(() => {
        this.timers.delete(t);
        this.fire(ref);
      }, i * STAGGER_MS);
      this.timers.add(t);
    });
  }

  /** 待っている点滅と走っている点滅を全部取り消す（選び直し・解除・場面の差し替えのとき） */
  cancel(): void {
    for (const t of this.timers) this.clearTimer(t);
    this.timers.clear();
    for (const list of this.running.values()) for (const a of list) a.cancel();
    this.running.clear();
  }

  /** 待っているタイマーと走っている点滅の数（テスト・デバッグ用） */
  get pending(): { timers: number; running: number } {
    let running = 0;
    for (const list of this.running.values()) running += list.length;
    return { timers: this.timers.size, running };
  }

  private fire(ref: string): void {
    if (!this.deps.visible(ref)) return;
    const targets = this.deps.targets(ref);
    if (!targets.length) return;
    // 同じものが続けて光るときは、前の点滅を止めて最初からやり直す
    for (const a of this.running.get(ref) ?? []) a.cancel();
    const list = targets.map((t) => this.animate(t.el, t.frames, FLASH_OPTIONS));
    this.running.set(ref, list);
    for (const a of list)
      a.onfinish = () => {
        if (this.running.get(ref) === list) this.running.delete(ref);
      };
  }
}

/**
 * 項目（ピンの位置）が画面に見えているか。文字はピンから箱の内側へ伸びるので、横は箱の幅ぶん、縦は 1 行ぶんの余裕を見る
 * （余裕は配置の座標。倍率を掛ける）
 */
export function pinVisible(
  pin: { x: number; y: number } | undefined,
  view: View,
  stage: { width: number; height: number },
  margin: { x: number; y: number } = { x: 320, y: 16 },
): boolean {
  if (!pin || !(stage.width > 0) || !(stage.height > 0)) return false;
  const x = pin.x * view.k + view.tx;
  const y = pin.y * view.k + view.ty;
  const mx = margin.x * view.k;
  const my = margin.y * view.k;
  return x >= -mx && x <= stage.width + mx && y >= -my && y <= stage.height + my;
}
