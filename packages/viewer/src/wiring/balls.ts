// 球（流れるデータ）と再生バー。1 通信 = 1 球（docs/15 §3.5、D33）。時刻は @stack-atlas/wiring の schedule が決め、
// 線の長さはレイアウトの経路の長さ（getTotalLength は使わない）。球が出る瞬間に送り側、着いた瞬間に受け側の項目を光らせる
import {
  drawnBalls,
  pointAt,
  schedule,
  segmentRoute,
  type Ball,
  type LitSelection,
  type Route,
  type Schedule,
  type WiringLayout,
} from '@stack-atlas/wiring';

/** 速さ（px/秒）、箱の中の所要、末端で止まる時間（モックと同じ） */
const SPEED = 420;
const INNER = 0.25;
const REST = 0.6;
/** 子の項目を順に光らせる間隔 */
const STAGGER_MS = 60;

/** 速さの倍率から、球の時刻の決め方（線の速さ・箱の中の所要・末端で止まる時間）。どれも倍率に反比例する */
export function timing(speedMul: number): { speed: number; inner: number; rest: number } {
  return { speed: SPEED * speedMul, inner: INNER / speedMul, rest: REST / speedMul };
}

const SVG_NS = 'http://www.w3.org/2000/svg';

interface Flow {
  ball: Ball;
  /** 球を描く経路（線と、キャッシュの箱の中の対応）。それ以外の対応は時間だけ持つ */
  route: Route | null;
  dot: SVGCircleElement | null;
  /** 0: 出発前、1: 走っている、2: 着いた */
  phase: number;
}

export interface TimelineControls {
  play: HTMLButtonElement;
  seek: HTMLInputElement;
  speed: HTMLInputElement;
  speedLabel: HTMLElement;
}

export interface BallPosition {
  key: string;
  x: number;
  y: number;
  visible: boolean;
}

/**
 * 球と再生バー。2 面のとき（Phase 8-6、D106）はこれが時刻の正で、3D の地図は schedule と tau を写す。
 * onClock は時刻の基準が変わったとき（新しい schedule・シーク・一時停止・再生・速さ・バーを離した）に呼ぶ
 */
export class Player {
  private speedMul = 1;
  private paused = false;
  private scrubbing = false;
  private pausedAt = 0;
  private flowStart = performance.now();
  private prevTau = -1;
  private sched: Schedule | null = null;
  private flows: Flow[] = [];
  private lit: LitSelection | null = null;
  private raf = 0;
  /** 面が隠れている（2 面の狭い画面。描かず、項目も光らせない。時刻は進む） */
  private hidden = false;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly offs: (() => void)[] = [];

  constructor(
    private readonly svg: SVGSVGElement,
    private readonly layout: WiringLayout,
    private readonly ui: TimelineControls,
    private readonly onClock: () => void = () => {},
  ) {
    const on = <K extends keyof HTMLElementEventMap>(
      el: HTMLElement | Window,
      type: K,
      fn: (ev: HTMLElementEventMap[K]) => void,
    ) => {
      el.addEventListener(type, fn as EventListener);
      this.offs.push(() => el.removeEventListener(type, fn as EventListener));
    };
    on(ui.play, 'click', () => this.setPaused(!this.paused));
    on(ui.seek, 'pointerdown', () => {
      this.pausedAt = this.tau(performance.now());
      this.scrubbing = true;
      this.onClock();
    });
    on(window, 'pointerup', () => {
      if (!this.scrubbing) return;
      this.scrubbing = false;
      // 離したら、再生中だったなら続きから
      if (!this.paused) this.flowStart = performance.now() - this.pausedAt * 1000;
      this.syncPhases();
      this.onClock();
    });
    on(ui.seek, 'input', () => this.seek(Number(ui.seek.value)));
    on(ui.speed, 'input', () => this.setSpeed(Number(ui.speed.value)));
    this.raf = requestAnimationFrame(this.tick);
  }

  /** 光るものが変わった（描き直した）。restart なら 0 秒から再生し直す */
  setup(lit: LitSelection | null, restart: boolean) {
    this.lit = lit;
    if (restart) {
      this.flowStart = performance.now();
      this.paused = false;
      this.scrubbing = false;
      this.pausedAt = 0;
    }
    this.build();
  }

  private build() {
    this.prevTau = -1;
    const layer = this.svg.querySelector<SVGGElement>('g.balls');
    layer?.replaceChildren();
    const lit = this.lit;
    if (!lit || !lit.flows || !lit.segs.length) {
      this.sched = null;
      this.flows = [];
      this.updateBar();
      this.onClock();
      return;
    }
    const routes = new Map(lit.segs.map((s) => [s.key, segmentRoute(this.layout, s)]));
    this.sched = schedule(lit, lit.flowStarts, {
      lengthOf: (s) => routes.get(s.key)?.length ?? 0,
      ...timing(this.speedMul),
      startBoxes: lit.startBoxes,
    });
    // 線ごとに 1 球（同じ線を子の区間で何度も通るときは最も早い球だけ描く）。キャッシュの箱の中の対応も描く
    const visible = new Set(drawnBalls(this.sched));
    this.flows = this.sched.balls.map((ball) => {
      const s = ball.seg;
      const drawn = visible.has(ball) && (s.kind === 'wire' || s.node?.node.kind === 'cache');
      const route = drawn ? (routes.get(s.key) ?? null) : null;
      let dot: SVGCircleElement | null = null;
      if (route && layer) {
        dot = document.createElementNS(SVG_NS, 'circle');
        dot.setAttribute('class', 'ball');
        dot.setAttribute('r', '4');
        dot.setAttribute('visibility', 'hidden');
        dot.dataset.seg = s.key;
        layer.append(dot);
      }
      return { ball, route, dot, phase: 0 };
    });
    this.pausedAt = Math.min(this.pausedAt, this.cycle);
    this.syncPhases();
    this.updateBar();
    this.draw(this.tau(performance.now()));
    this.onClock();
  }

  /**
   * 速さを変える。周期を計算し直し、周回の中の同じ割合の位置から続ける（球が飛ばない）。
   * 止めている・バーを動かしている間は、止めた時刻を同じ割合に置き直す
   */
  setSpeed(mul: number) {
    const now = performance.now();
    const oldCycle = this.cycle;
    const tau = this.tau(now);
    this.speedMul = mul;
    this.ui.speedLabel.textContent = `×${mul.toFixed(mul < 1 ? 2 : 1)}`;
    this.build(); // 周期を計算し直す
    const t = rescaleTime(tau, oldCycle, this.cycle);
    if (this.paused || this.scrubbing) this.pausedAt = t;
    else this.flowStart = now - t * 1000;
    this.ui.seek.value = String(t);
    this.syncPhases();
    this.draw(this.tau(now));
    this.onClock();
  }

  get cycle() {
    return this.sched?.cycle ?? 1;
  }
  get isPaused() {
    return this.paused;
  }
  /** 球が動いている（流れる選択で、止めてもバーを動かしてもいない） */
  get isPlaying() {
    return !!this.sched && this.flows.length > 0 && !this.paused && !this.scrubbing;
  }
  get schedule() {
    return this.sched;
  }

  /** 今の時刻（1 周回の中） */
  tau(now: number) {
    if (this.paused || this.scrubbing) return Math.min(this.pausedAt, this.cycle);
    return ((((now - this.flowStart) / 1000) % this.cycle) + this.cycle) % this.cycle;
  }

  /** 好きな時刻へ（止めていれば止めたまま、再生中ならそこから続ける） */
  seek(t: number) {
    const v = Math.max(0, Math.min(t, this.cycle));
    if (this.scrubbing || this.paused) this.pausedAt = v;
    else this.flowStart = performance.now() - v * 1000;
    this.syncPhases();
    this.draw(this.tau(performance.now()));
    this.onClock();
  }

  setPaused(v: boolean) {
    if (v === this.paused) return;
    if (v) this.pausedAt = this.tau(performance.now());
    else {
      this.flowStart = performance.now() - this.pausedAt * 1000;
    }
    this.paused = v;
    this.syncPhases();
    this.updateBar();
    this.onClock();
  }

  /**
   * 面を隠す・出す（2 面の狭い画面。docs/20 §5.1 #9）。隠れている間は描かず、項目も光らせない。時刻（tau）は
   * performance.now から出すので進み続け、3D の地図はそれを写す。出したら今の時刻から描き直す
   */
  setHidden(v: boolean) {
    if (v === this.hidden) return;
    this.hidden = v;
    cancelAnimationFrame(this.raf);
    if (!v) {
      this.syncPhases();
      this.draw(this.tau(performance.now()));
      this.raf = requestAnimationFrame(this.tick);
    }
  }

  positions(): BallPosition[] {
    const tau = this.tau(performance.now());
    return this.flows
      .filter((x) => x.route)
      .map((x) => {
        const f = frac(tau, x.ball);
        const visible = f >= 0 && f < 1;
        const p = pointAt(x.route!.points, Math.max(0, f) * x.route!.length);
        return { key: x.ball.seg.key, x: p.x, y: p.y, visible };
      });
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const off of this.offs) off();
  }

  private syncPhases() {
    const tau = this.tau(performance.now());
    this.prevTau = tau;
    for (const x of this.flows) x.phase = phaseOf(frac(tau, x.ball));
  }

  private updateBar() {
    const on = !!this.sched && this.flows.length > 0;
    this.ui.play.hidden = !on;
    this.ui.seek.hidden = !on;
    this.ui.seek.max = String(this.cycle);
    this.ui.seek.value = String(Math.min(Number(this.ui.seek.value), this.cycle));
    this.ui.play.textContent = this.paused ? '▶' : '❚❚';
    this.ui.play.setAttribute('aria-label', this.paused ? '再生' : '一時停止');
  }

  private tick = (now: number) => {
    const tau = this.tau(now);
    if (this.paused || this.scrubbing)
      this.syncPhases(); // 止めている間は光らせない（位相だけ合わせる）
    else {
      if (tau < this.prevTau) for (const x of this.flows) x.phase = 0; // 最初から繰り返す
      this.prevTau = tau;
      for (const x of this.flows) {
        const ph = phaseOf(frac(tau, x.ball));
        if (ph >= 1 && x.phase < 1) this.onDepart(x);
        if (ph === 2 && x.phase < 2) this.onArrive(x);
        x.phase = ph;
      }
    }
    if (!this.scrubbing && !this.ui.seek.hidden) this.ui.seek.value = String(tau);
    this.draw(tau);
    if (!this.hidden) this.raf = requestAnimationFrame(this.tick);
  };

  private draw(tau: number) {
    for (const x of this.flows) {
      if (!x.dot || !x.route) continue;
      const f = frac(tau, x.ball);
      if (f < 0 || f >= 1) {
        x.dot.setAttribute('visibility', 'hidden');
        continue;
      }
      const p = pointAt(x.route.points, f * x.route.length);
      x.dot.setAttribute('cx', String(p.x));
      x.dot.setAttribute('cy', String(p.y));
      x.dot.setAttribute('visibility', 'visible');
    }
  }

  private onDepart(x: Flow) {
    if (x.ball.seg.kind === 'wire') this.flash(x.ball.seg.from.ref);
  }

  private onArrive(x: Flow) {
    const s = x.ball.seg;
    if (s.kind === 'wire') {
      this.flash(s.to.ref);
      return;
    }
    // 箱の中を通って出口に着いたとき: その先に光る線が無い末端だけ光らせる（線があれば出る瞬間に光る）
    if (!this.flows.some((y) => y.ball.seg.kind === 'wire' && y.ball.seg.from === s.to))
      this.flash(s.to.ref);
  }

  /** 項目を白く光らせて 0.4 秒で戻す。親の線で届いたなら子を 60ms ずつずらして上から順に */
  private flash(ref: string) {
    const nodeId = ref.slice(0, ref.indexOf('#'));
    const box = this.layout.boxes.get(nodeId);
    const col = box ? [...box.ins, ...box.outs] : [];
    const targets = [ref, ...col.filter((r): r is string => !!r && r.startsWith(ref + '.'))];
    targets.forEach((r, i) => {
      const t = setTimeout(() => {
        this.timers.delete(t);
        const el = this.svg.querySelector(`[data-item="${CSS.escape(r)}"]`);
        if (!el) return;
        el.classList.remove('flash');
        void el.getBoundingClientRect(); // アニメーションをやり直す
        el.classList.add('flash');
      }, i * STAGGER_MS);
      this.timers.add(t);
    });
  }
}

/**
 * 周期が変わったとき（速さの変更）の、新しい周期での時刻。周回の中の割合を保つ（球の時刻は全部が速さに反比例するので、
 * 同じ割合の時刻で球は同じ位置にいる）。周期が 0 以下なら 0
 */
export function rescaleTime(tau: number, oldCycle: number, newCycle: number): number {
  if (!(oldCycle > 0) || !(newCycle > 0)) return 0;
  const f = Math.min(1, Math.max(0, tau / oldCycle));
  return f * newCycle;
}

/** 区間の中の進み具合。所要 0 の区間（クリックした箱の中）は出発と同時に着く */
function frac(tau: number, b: Ball): number {
  if (b.dur <= 0) return tau >= b.t0 ? 1 : -1;
  return (tau - b.t0) / b.dur;
}

const phaseOf = (f: number) => (f < 0 ? 0 : f < 1 ? 1 : 2);
