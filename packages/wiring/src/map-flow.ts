// 地図の流れ（D106。docs/20 §6・§7）: 配線図の球の時刻（schedule）を、3D の地図の束の上の球と単位の脈動に写す。
// 時刻の正は配線図の Player（schedule と tau）で、地図はそれを写すだけ。純関数・決定的（DOM・three.js 無し）。
// - 単位（group・host・箱）をまたぐ線 w を球が t0〜t1 に通るとき、地図では w を含む束の線の上を、同じ t0〜t1 に
//   送る側の単位から受ける側の単位へ球が動く（戻りの線は束の向きと逆に進む）
// - 同じ束を同じ向きに、時間の重なる球は 1 つにまとめる（1 通信 = 1 球を束の上でも保つ。D33）
// - 同じ単位の中の線は、地図ではその単位のノードの脈動（短く明るくする）にする
import { drawnBalls, type Schedule } from './schedule.js';
import type { MapProjection } from './project-map.js';

/** 地図の束の上を動く球 */
export interface MapBall {
  /** 束のキー（edgeKey(edge.from, edge.to)） */
  edge: string;
  /** 送る側の単位 → 受ける側の単位（データの向き） */
  from: string;
  to: string;
  /** 束の向き（edge.from → edge.to）と逆に進む（往復の戻り） */
  reverse: boolean;
  t0: number;
  t1: number;
  /** まとめた線のキー（GraphIndex の `w<index>`） */
  wires: string[];
}

/** 地図のノードの脈動（同じ単位の中の線） */
export interface MapPulse {
  node: string;
  t0: number;
  t1: number;
  wires: string[];
}

export interface MapFlow {
  balls: MapBall[];
  pulses: MapPulse[];
  /** 1 周回の長さ（schedule と同じ） */
  cycle: number;
}

/** 脈動の最短の長さ（秒。所要の短い線でも見えるように） */
export const PULSE_MIN = 0.3;
const EPS = 1e-9;

/**
 * 時間の重なるものを 1 つにまとめる（t0 の順。触れるだけ（前の t1 = 次の t0）はまとめない）。
 * まとめた線は Set で重複を見る（配列の includes だと 1 つの束に M 本の線が重なると O(M²)。docs/20 §7.7）
 */
export function mergeOverlaps<T extends { t0: number; t1: number; wires: string[] }>(xs: T[]): T[] {
  const sorted = [...xs].sort((a, b) => a.t0 - b.t0 || a.t1 - b.t1);
  const out: T[] = [];
  let seen = new Set<string>();
  for (const x of sorted) {
    const cur = out[out.length - 1];
    if (cur && x.t0 < cur.t1 - EPS) {
      cur.t1 = Math.max(cur.t1, x.t1);
      for (const w of x.wires) {
        if (seen.has(w)) continue;
        seen.add(w);
        cur.wires.push(w);
      }
    } else {
      out.push({ ...x, wires: [...x.wires] });
      seen = new Set(x.wires);
    }
  }
  return out;
}

/**
 * 配線図の schedule を地図に写す。描く球（drawnBalls。線ごとに最も早い区間）の線だけを見る（箱の中の対応は写さない）。
 * 球は時刻の順、脈動はノードの順に並ぶ
 */
export function mapFlow(p: MapProjection, sched: Schedule): MapFlow {
  const wireToEdge = new Map<string, string>();
  for (const [k, info] of p.edges) for (const w of info.wires) wireToEdge.set(w, k);

  const balls = new Map<string, MapBall[]>();
  const pulses = new Map<string, MapPulse[]>();
  for (const b of drawnBalls(sched)) {
    const seg = b.seg;
    if (seg.kind !== 'wire' || !seg.wire) continue;
    const fu = p.unitOf.get(seg.from.node.id);
    const tu = p.unitOf.get(seg.to.node.id);
    if (fu === undefined || tu === undefined) continue;
    const key = seg.wire.key;
    if (fu === tu) {
      const t1 = Math.min(Math.max(b.t0 + b.dur, b.t0 + PULSE_MIN), sched.cycle);
      const list = pulses.get(fu) ?? [];
      list.push({ node: fu, t0: b.t0, t1, wires: [key] });
      pulses.set(fu, list);
      continue;
    }
    if (!(b.dur > 0)) continue;
    const ek = wireToEdge.get(key);
    const info = ek === undefined ? undefined : p.edges.get(ek);
    if (!ek || !info) continue;
    const reverse = !(info.edge.from === fu && info.edge.to === tu);
    const k = `${ek}\n${reverse ? '<' : '>'}`;
    const list = balls.get(k) ?? [];
    list.push({ edge: ek, from: fu, to: tu, reverse, t0: b.t0, t1: b.t0 + b.dur, wires: [key] });
    balls.set(k, list);
  }
  const outBalls = [...balls.values()]
    .flatMap(mergeOverlaps)
    .sort((a, b) => a.t0 - b.t0 || a.edge.localeCompare(b.edge));
  const outPulses = [...pulses.values()].flatMap(mergeOverlaps);
  return { balls: outBalls, pulses: outPulses, cycle: sched.cycle };
}

/** 時刻 tau の球（束の上の進み具合 f は束の向き（edge.from → edge.to）で 0〜1） */
export interface MapBallAt {
  ball: MapBall;
  /** 送る側から受ける側への進み具合（0〜1） */
  progress: number;
  /** 束の向きでの位置（reverse なら 1 − progress） */
  along: number;
}

/** 時刻 tau の脈動の強さ（0〜1。sin の山） */
export interface MapPulseAt {
  pulse: MapPulse;
  intensity: number;
}

/** 時刻 tau（配線図の Player の tau）に地図で見えている球と脈動 */
export function mapFlowAt(
  flow: MapFlow,
  tau: number,
): { balls: MapBallAt[]; pulses: MapPulseAt[] } {
  const balls: MapBallAt[] = [];
  for (const b of flow.balls) {
    if (tau < b.t0 || tau >= b.t1) continue;
    const progress = (tau - b.t0) / (b.t1 - b.t0);
    balls.push({ ball: b, progress, along: b.reverse ? 1 - progress : progress });
  }
  const pulses: MapPulseAt[] = [];
  for (const q of flow.pulses) {
    if (tau < q.t0 || tau >= q.t1 || !(q.t1 > q.t0)) continue;
    pulses.push({ pulse: q, intensity: Math.sin(Math.PI * ((tau - q.t0) / (q.t1 - q.t0))) });
  }
  return { balls, pulses };
}
