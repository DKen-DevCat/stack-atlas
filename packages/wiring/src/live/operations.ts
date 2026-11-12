/**
 * 出来事の列を、操作（1 回の手の動きと、そのあとに起きたこと）に区切る（docs/27 §4.3、D243・D244）。
 * 時計は持たない: 時刻は、出来事の `at` と、tick に渡された「いま」だけを使う（テストで、時間を自由に進められる）
 */
import type {
  LiveAction,
  LiveChange,
  LiveEvent,
  LivePartEvent,
  LiveRect,
  MaskedBody,
} from './events.js';

/** 1 回の手の動きの中の、1 つの出来事（送信のボタンを押すと、「押す」と「送信」の 2 つになる） */
export interface LiveGesture {
  at: number;
  how: LiveAction;
  /** 当たった部品の id（内側から順） */
  parts: string[];
  rect?: LiveRect;
}

export interface LiveRequest {
  id: string;
  method: string;
  path: string;
  route?: string;
  query: string[];
  kind: 'script' | 'form';
  outside?: boolean;
  raw?: string;
  /** 送った時刻と、返った（か、失敗した）時刻。まだ返っていなければ end は無い */
  start: number;
  end?: number;
  status?: number;
  inBrowser?: boolean;
  failed?: 'held' | 'outside' | 'error';
  sent?: MaskedBody;
  received?: MaskedBody;
}

export interface LiveOperation {
  /** 通し番号（0 から） */
  seq: number;
  start: number;
  /** 最後に何かが起きた時刻（通信の返事・画面の変化）。何も起きていなければ start */
  end: number;
  /** 画面を開いたことで始まった操作なら、開いたパスと、図の画面の箱 */
  open?: { path: string; screen?: string };
  /** 部品への操作で始まった操作なら、その出来事（1 回の手の動きの分） */
  gestures: LiveGesture[];
  requests: LiveRequest[];
  changes: Array<LiveChange & { at: number }>;
  /** 閉じた理由: quiet = 通信が済んで静かになった、limit = 長さの上限、next = 次の操作が始まった */
  closed?: 'quiet' | 'limit' | 'next';
}

export interface RecorderOptions {
  /** 通信がすべて済んでから、これだけ何も起きなければ、操作が済んだとみなす */
  quietMs?: number;
  /** 操作の長さの上限（動き続ける表示・返らない通信があっても、ここで打ち切る） */
  limitMs?: number;
  /** これより短い間に続いた部品の出来事は、同じ手の動き（押す → 送信） */
  gestureMs?: number;
  /** 同じ部品への入力が、これより短い間に続けば、ひと続きの入力 */
  typingMs?: number;
}

export const RECORDER_DEFAULTS: Required<RecorderOptions> = {
  quietMs: 400,
  limitMs: 10_000,
  gestureMs: 80,
  typingMs: 1_000,
};

export class OperationRecorder {
  private readonly opt: Required<RecorderOptions>;
  private op: LiveOperation | undefined;
  /** 最後に何かが起きた時刻（通信を送ったことも含む。静かになったかの判定に使う） */
  private lastActivity = 0;
  private seq = 0;

  constructor(options: RecorderOptions = {}) {
    this.opt = { ...RECORDER_DEFAULTS, ...options };
  }

  /** いま記録している操作（無ければ undefined） */
  get current(): LiveOperation | undefined {
    return this.op;
  }

  /** 出来事を 1 つ入れる。この出来事で閉じた操作（次の操作が始まったので閉じたもの）があれば、返す */
  push(ev: LiveEvent): LiveOperation[] {
    switch (ev.t) {
      case 'open': {
        const closed = this.close('next');
        this.begin(ev.at).open =
          ev.screen === undefined ? { path: ev.path } : { path: ev.path, screen: ev.screen };
        return closed;
      }
      case 'part': {
        const gesture: LiveGesture = { at: ev.at, how: ev.how, parts: ev.parts };
        if (ev.rect) gesture.rect = ev.rect;
        if (this.op && this.sameGesture(this.op, ev)) {
          this.op.gestures.push(gesture);
          this.touch(ev.at, false);
          return [];
        }
        const closed = this.close('next');
        this.begin(ev.at).gestures.push(gesture);
        return closed;
      }
      case 'request': {
        if (!this.op) return [];
        const req: LiveRequest = {
          id: ev.id,
          method: ev.method,
          path: ev.path,
          query: ev.query,
          kind: ev.kind,
          start: ev.at,
        };
        if (ev.route !== undefined) req.route = ev.route;
        if (ev.outside) req.outside = true;
        if (ev.raw !== undefined) req.raw = ev.raw;
        if (ev.body) req.sent = ev.body;
        this.op.requests.push(req);
        this.touch(ev.at, false);
        return [];
      }
      case 'response':
      case 'failed': {
        const req = this.op?.requests.find((r) => r.id === ev.id && r.end === undefined);
        if (!req) return [];
        req.end = Math.max(ev.at, req.start);
        if (ev.t === 'response') {
          req.status = ev.status;
          req.inBrowser = ev.inBrowser;
          if (ev.body) req.received = ev.body;
        } else req.failed = ev.why;
        this.touch(req.end, true);
        return [];
      }
      case 'dom': {
        if (!this.op) return [];
        for (const c of ev.changes) this.op.changes.push({ ...c, at: ev.at });
        this.touch(ev.at, true);
        return [];
      }
      default:
        return []; // 部品の場所は、操作に入れない
    }
  }

  /** 時間が進んだことを知らせる。静かになった・上限に達した操作があれば、閉じて返す */
  tick(now: number): LiveOperation[] {
    const op = this.op;
    if (!op) return [];
    if (now - op.start >= this.opt.limitMs) return this.close('limit');
    const waiting = op.requests.some((r) => r.end === undefined);
    if (!waiting && now - this.lastActivity >= this.opt.quietMs) return this.close('quiet');
    return [];
  }

  private begin(at: number): LiveOperation {
    this.op = { seq: this.seq++, start: at, end: at, gestures: [], requests: [], changes: [] };
    this.lastActivity = at;
    return this.op;
  }

  private touch(at: number, visible: boolean) {
    if (!this.op) return;
    this.lastActivity = Math.max(this.lastActivity, at);
    if (visible) this.op.end = Math.max(this.op.end, at);
  }

  private close(why: NonNullable<LiveOperation['closed']>): LiveOperation[] {
    const op = this.op;
    if (!op) return [];
    this.op = undefined;
    op.closed = why;
    return [op];
  }

  private sameGesture(op: LiveOperation, ev: LivePartEvent): boolean {
    const last = op.gestures[op.gestures.length - 1];
    if (!last) return false; // 画面を開いた操作のあとの、部品の出来事は、新しい操作
    const gap = ev.at - last.at;
    if (gap <= this.opt.gestureMs) return true;
    return (
      ev.how === 'input' &&
      last.how === 'input' &&
      ev.parts[0] === last.parts[0] &&
      gap <= this.opt.typingMs
    );
  }
}
