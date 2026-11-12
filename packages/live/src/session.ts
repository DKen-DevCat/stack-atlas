/// <reference lib="dom" />
/**
 * 見張り（docs/27 §3〜§5）。ブラウザを開き、人がアプリを操作するのを見て、出来事をライブの画面に渡す。
 *
 * - 手元の外へは、つながせない: ブラウザを起動する段で、手元ではない宛先への通信を、すべて行き先の無い中継に回す（D231）
 * - 通信は、ブラウザの外から見る（D228）。値は、ここで伏せてから渡す（D233）
 * - 押した部品と画面の変化は、枠の中のスクリプト（watcher.ts）が、専用の口で知らせる（D229）。知らせた枠を確かめる
 * - 出来事は、アプリ → ここ → ライブの画面 の一方向（D230）。時刻の順に並べ直してから渡す（区切りは、ライブの画面の側）
 * - 「止めて見る」は、手元宛ての書きこみを、出る直前で止める（D242。止めきる約束はしない）
 * - ファイルは書かない。端末には、案内と誤りだけを出す
 */
import { bundleAtlas, formatAtlasReport } from '@stack-atlas/core';
import type { GraphV2 } from '@stack-atlas/schema';
import {
  findRoute,
  graphRoutes,
  maskBody,
  maskPath,
  queryKeys,
  routeKey,
  sanitizeReport,
  screenFor,
  type LiveEvent,
  type LiveMessage,
  type LiveSignal,
  type LiveStatus,
  type LiveValues,
} from '@stack-atlas/wiring';
import { basename, resolve } from 'node:path';
import type {
  Browser,
  BrowserContext,
  Frame,
  Page,
  Request as PwRequest,
  Response as PwResponse,
  Route,
} from 'playwright';
import { checkLiveUrl, checkLocalName, isLocalHost, proxyBypass, resolverRules } from './local.js';
import { startRefuser, type Refuser } from './refuser.js';
import { MINIMAL_PAGE_DIR, defaultPageDir, startLiveServer, type LiveServer } from './server.js';
import { liveWatcher } from './watcher.js';

/** 起動できなかった（exitCode: 1 = 図に誤りがある、2 = 引数・環境の誤り） */
export class LiveError extends Error {
  constructor(
    message: string,
    readonly exitCode: 1 | 2,
  ) {
    super(message);
  }
}

export interface LiveOptions {
  /** 図の置き場（`.stack-atlas/` の親） */
  root: string;
  /** 手元で起動したアプリの URL */
  url: string;
  /** 「止めて見る」を、起動のときから入れる（画面からは外せない。D242） */
  holdWrites?: boolean;
  /** アプリを、左の枠ではなく、別の窓で開く（D235） */
  window?: boolean;
  /** 手元に数える名前（ブラウザの中で、ループバックに固定する。D232） */
  localNames?: string[];
  /** 窓を出さない（確かめ用） */
  headless?: boolean;
  /** 配るライブの画面のファイルの置き場（確かめ用。既定は defaultPageDir()） */
  pageDir?: string;
  /** 端末への案内（値は渡さない） */
  log?: (line: string) => void;
}

export interface LiveSession {
  /** ライブの画面のページ */
  livePage: Page;
  /** アプリが別の窓のとき、そのページ */
  appPage(): Page | undefined;
  liveUrl: string;
  status(): LiveStatus;
  /** 行き先の無い中継が断った数と、宛先の名前 */
  refused(): { count: number; hosts: string[] };
  /** ライブの画面か、ブラウザが閉じたら解決する */
  closed: Promise<void>;
  close(): Promise<void>;
}

export const SESSION_LIMITS = {
  /** 中身を読む大きさの上限（これより大きい中身は、種類と大きさだけ） */
  bodyBytes: 1024 * 1024,
  /** 値をメモリに持つ、直近の通信の数 */
  values: 200,
  /** 値の長さ */
  value: 4000,
  /** 枠の中からの知らせの、種類ごとの 1 秒あたりの上限 */
  reportsPerSecond: { part: 30, dom: 30, parts: 10 } as Record<string, number>,
  /** 出来事を並べ直すために、ためておく時間 */
  reorderMs: 200,
  flushMs: 100,
} as const;

/** サンドボックスを外す明示の指定（サンドボックスの使えない Linux。CI の runner など）。画面を撮る抽出器と同じ名前 */
export const NO_SANDBOX_ENV = 'STACK_ATLAS_CHROMIUM_NO_SANDBOX';
const READ_ONLY = new Set(['GET', 'HEAD', 'OPTIONS']);
const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max) : s);
const originOf = (url: string): string | undefined => {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : undefined;
  } catch {
    return undefined;
  }
};
const textual = (type: string | undefined) =>
  /^text\/|[/+](json|xml)\b|x-www-form-urlencoded|multipart\/form-data/i.test(type ?? '');

export async function startLive(opts: LiveOptions): Promise<LiveSession> {
  const log = opts.log ?? (() => {});
  const localNames = (opts.localNames ?? []).map((n) => n.toLowerCase());
  for (const name of localNames) {
    const why = checkLocalName(name);
    if (why) throw new LiveError(why, 2);
  }
  const checked = checkLiveUrl(opts.url, localNames);
  if ('error' in checked) throw new LiveError(checked.error, 2);
  const appUrl = checked.url;
  const appOrigin = appUrl.origin;

  // 図: 検査を通ったものだけ使う。メモリの中だけに持つ（D236）
  const root = resolve(opts.root);
  const { report, graph: bundled } = bundleAtlas(opts.root, { name: basename(root) });
  if (!bundled)
    throw new LiveError(
      `${formatAtlasReport(report)}\n図に誤りがあるので、ライブを開きませんでした。`,
      1,
    );
  const graph: GraphV2 = bundled;
  const routes = graphRoutes(graph);
  const knownParts = new Set((graph.parts ?? []).map((p) => p.id));

  const { chromium } = await import('playwright');
  const refuser: Refuser = await startRefuser();
  let server: LiveServer | undefined;
  // 利用者の領域は、ブラウザを動かす部品が、毎回、空のものを作り、閉じるときに消す（D240。持ちこす形では開かない）
  let browser: Browser | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const cleanup = async () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    await browser?.close().catch(() => {});
    await server?.close().catch(() => {});
    await refuser.close().catch(() => {});
  };

  try {
    const pageDir = opts.pageDir ?? defaultPageDir();
    if (pageDir === MINIMAL_PAGE_DIR)
      log(
        'ビューアのライブの画面が組み立てられていないので、出来事を並べるだけの画面で開きます（pnpm build で組み立てると、経路と再生が出ます）',
      );
    server = await startLiveServer({ hostname: appUrl.hostname, appOrigin, pageDir });
    const live = server;
    const noSandbox = process.env[NO_SANDBOX_ENV] === '1';
    if (noSandbox) log(`${NO_SANDBOX_ENV}=1 なので、ブラウザをサンドボックス無しで起動します`);
    browser = await chromium.launch({
      headless: opts.headless ?? false,
      chromiumSandbox: !noSandbox,
      // 手元ではない宛先への通信は、すべて行き先の無い中継へ（D231）
      proxy: { server: refuser.url, bypass: proxyBypass(localNames) },
      args: [
        ...resolverRules(localNames),
        // 画面どうしを直接つなぐ通信も、中継を通らないものは出さない
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      ],
    });
    const context: BrowserContext = await browser.newContext({
      viewport: opts.headless ? { width: 1280, height: 800 } : null,
      // 手元の暗号つきのアプリは、自分で作った証明書が多い。ブラウザは手元にしかつながらないので、見逃す範囲は手元だけ
      ignoreHTTPSErrors: appUrl.protocol === 'https:',
      serviceWorkers: 'allow',
    });

    const state: LiveStatus = {
      protocol: 1,
      app: appUrl.href,
      // 別の窓にするもの（D235）: 暗号つきのアプリ（枠の中では Cookie がほとんど送られない）、
      // IPv6 のアドレスで開くアプリ（読みこみ元を絞るヘッダに、IPv6 のアドレスを書けない）
      mode:
        opts.window || appUrl.protocol === 'https:' || appUrl.hostname.startsWith('[')
          ? 'window'
          : 'frame',
      reveal: false,
      hold: opts.holdWrites === true,
      holdLocked: opts.holdWrites === true,
    };
    let livePage: Page;
    let appPage: Page | undefined;
    /** 終わりかけ（ライブの画面か、ブラウザが閉じた）。このあとは、窓を開かない */
    let closing = false;
    /** アプリが上の窓を移したあと、ライブの画面を開き直しているあいだ（このあいだは、何も渡さない） */
    let swapping = false;
    const quiet = (p: Promise<unknown>) => void p.catch(() => {});

    // --- ライブの画面へ渡す（渡す先の出所を、ページの中でも確かめる。アプリの文書に渡さない） ---
    const queue: LiveEvent[] = [];
    const deliver = async (msg: LiveMessage) => {
      if (swapping || livePage.isClosed()) return;
      await livePage
        .evaluate(
          ([m, origin]) => {
            if (location.origin !== origin) return;
            const receive = (
              window as unknown as { __stackAtlasLiveReceive?: (m: unknown) => void }
            ).__stackAtlasLiveReceive;
            receive?.(m);
          },
          [msg, live.origin] as const,
        )
        .catch(() => {});
    };
    const emit = (ev: LiveEvent) => queue.push(ev);
    const flush = async (all = false) => {
      if (swapping) return;
      const limit = Date.now() - SESSION_LIMITS.reorderMs;
      queue.sort((a, b) => a.at - b.at);
      const ready: LiveEvent[] = [];
      while (queue.length && (all || queue[0]!.at <= limit)) ready.push(queue.shift()!);
      if (ready.length) await deliver({ t: 'events', events: ready });
    };
    timer = setInterval(() => void flush(), SESSION_LIMITS.flushMs);
    const sendStatus = () => deliver({ t: 'status', status: { ...state } });
    const sendInit = async () => {
      await deliver({ t: 'graph', graph });
      await sendStatus();
    };

    // --- 値（「値を見る」のあいだだけ渡す。メモリに直近の分だけ持つ。ファイルにも端末にも出さない） ---
    const values = new Map<string, LiveValues>();
    const remember = (id: string, patch: Partial<LiveValues>) => {
      const v = values.get(id) ?? { id, raw: '' };
      Object.assign(v, patch);
      values.delete(id);
      values.set(id, v);
      while (values.size > SESSION_LIMITS.values) values.delete(values.keys().next().value!);
    };
    /** 「値を見る」を切ったとき、まだ渡していない出来事から、値を外す */
    const stripQueued = () => {
      for (const ev of queue) {
        if (ev.t === 'request') delete ev.raw;
        if ((ev.t === 'request' || ev.t === 'response') && ev.body) delete ev.body.value;
      }
    };

    // --- アプリの側か ---
    /** アプリの出所の枠（ライブの画面の出所とは、ポートが違う） */
    const isAppFrame = (f: Frame) => originOf(f.url()) === appOrigin;
    /** 通信を出した枠が、アプリの側か（ライブの画面のいちばん上の枠が出したもの = 画面の資産、は数えない） */
    const fromApp = (r: PwRequest): boolean => {
      try {
        const f = r.frame();
        return !(f.page() === livePage && f === livePage.mainFrame());
      } catch {
        return false; // 枠の無い通信（裏で動く部品）は、ブラウザの外からは、画面の側の 1 回だけを数える
      }
    };

    // --- 通信（ブラウザの外から見る） ---
    // 時刻: 通信は、道具が知らせを受けた時刻。返事は、その時刻に、ブラウザが測った「送ってから返事が来るまで」を足したもの
    // （通信の知らせの時点では、ブラウザの測った始まりの時刻が、まだ無い。時計を混ぜると、返事が通信より前に並ぶ）
    let seq = 0;
    const tracked = new WeakMap<
      PwRequest,
      { id: string; at: number; outside: boolean; responded: boolean }
    >();
    const held = new WeakSet<PwRequest>();
    /** 裏で動く部品（返事を差し替える仕組み）が出した通信の時刻（素通しを見分ける・止めたものを見分ける） */
    const swSent = new Map<string, number>();
    const heldKeys = new Map<string, number>();
    const prune = (m: Map<string, number>, now: number) => {
      for (const [k, at] of m) if (at < now - 10_000) m.delete(k);
    };
    const kindOf = (r: PwRequest): 'script' | 'form' | undefined => {
      const type = r.resourceType();
      if (type === 'fetch' || type === 'xhr' || type === 'ping') return 'script';
      if (type === 'document' && r.method() !== 'GET') return 'form';
      return undefined; // 画面の資産・画面の移動・つなぎっぱなしの通信は、数えない
    };

    context.on('request', (r) => {
      if (r.serviceWorker()) {
        const now = Date.now();
        prune(swSent, now);
        swSent.set(`${r.method()} ${r.url()}`, now);
        return;
      }
      if (!fromApp(r)) return;
      const kind = kindOf(r);
      if (!kind) return;
      let url: URL;
      try {
        url = new URL(r.url());
      } catch {
        return;
      }
      const id = `r${++seq}`;
      const at = Date.now();
      const outside = !isLocalHost(url.hostname, localNames);
      tracked.set(r, { id, at, outside, responded: false });
      const route = findRoute(routes, r.method(), url.pathname);
      const buffer = r.postDataBuffer();
      const type = r.headers()['content-type'];
      const text =
        buffer && buffer.length <= SESSION_LIMITS.bodyBytes && textual(type)
          ? buffer.toString('utf8')
          : undefined;
      const raw = clip(`${url.pathname}${url.search}`, SESSION_LIMITS.value);
      // ファイルを運ぶ形の中身は、「値を見る」でも出さない（§5.3）ので、持たない
      const keep = text !== undefined && !/multipart\/form-data/i.test(type ?? '');
      remember(id, { raw, ...(keep ? { sent: clip(text, SESSION_LIMITS.value) } : {}) });
      const body = maskBody(type, text, buffer?.length ?? 0, state.reveal);
      emit({
        t: 'request',
        at,
        id,
        method: r.method(),
        path: route ? route.path : maskPath(url.pathname),
        ...(route ? { route: routeKey(route) } : {}),
        query: queryKeys(url.search),
        kind,
        ...(outside ? { outside: true } : {}),
        ...(body ? { body } : {}),
        ...(state.reveal ? { raw } : {}),
      });
    });

    const TIMED_OUT = Symbol('timed out');
    const within = <T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> =>
      Promise.race([p, new Promise<typeof TIMED_OUT>((ok) => setTimeout(() => ok(TIMED_OUT), ms))]);

    context.on('response', (res: PwResponse) => {
      const r = res.request();
      const entry = tracked.get(r);
      if (!entry || entry.responded) return;
      entry.responded = true;
      const t = r.timing();
      const at = t.responseStart >= 0 ? entry.at + t.responseStart : Math.max(Date.now(), entry.at);
      if (entry.outside) {
        // 行き先の無い中継の返事（403）は、アプリの側の返事ではない
        emit({ t: 'failed', at, id: entry.id, why: 'outside' });
        return;
      }
      // 返事を差し替える仕組みが、素通しした（自分で通信を出した）ものは、「ブラウザの中で返事が作られた」に数えない
      const passed = (swSent.get(`${r.method()} ${r.url()}`) ?? 0) >= entry.at - 100;
      const inBrowser = res.fromServiceWorker() && !passed;
      const type = res.headers()['content-type'];
      const length = Number(res.headers()['content-length'] ?? NaN);
      const declared = Number.isFinite(length) ? length : 0;
      // 流しっぱなしの返事・大きな返事は、中身を読まない（読み終わるまで待つと、返事の知らせが届かない）
      const readable =
        textual(type) &&
        !/event-stream/i.test(type ?? '') &&
        !(declared > SESSION_LIMITS.bodyBytes);
      const send = (text: string | undefined, bytes: number) => {
        const body = maskBody(type, text, bytes, state.reveal);
        emit({
          t: 'response',
          at,
          id: entry.id,
          status: res.status(),
          inBrowser,
          ...(body ? { body } : {}),
        });
      };
      if (!readable) return send(undefined, declared);
      const reading = res.body().then(
        (buf) => buf,
        () => undefined, // 中身の無い返事（204 など）・読めない返事
      );
      const keep = (buf: Buffer | undefined) => {
        if (buf && buf.length <= SESSION_LIMITS.bodyBytes)
          remember(entry.id, { received: clip(buf.toString('utf8'), SESSION_LIMITS.value) });
      };
      // 並べ直しの間に合ううちに読めたら、中身の形も付ける。間に合わなければ、形なしで先に知らせる
      void within(reading, SESSION_LIMITS.reorderMs - 50).then((first) => {
        if (first === TIMED_OUT) {
          send(undefined, declared);
          void within(reading, 5_000).then((late) => late !== TIMED_OUT && keep(late));
          return;
        }
        keep(first);
        const ok = first && first.length <= SESSION_LIMITS.bodyBytes;
        send(ok ? first.toString('utf8') : undefined, first?.length ?? declared);
      });
    });

    // 枠に入るのを、応答で拒むアプリ（D235）: アプリの出所の画面の読みこみが、応答か、読みこみ元を絞るヘッダで止められた
    // （つながらなかった画面一般とは分ける。手元の外へ移ろうとしたときも、つながらなかった画面になる）
    const refusedFrame = (r: PwRequest): boolean => {
      if (r.resourceType() !== 'document' || state.mode !== 'frame') return false;
      if (originOf(r.url()) !== appOrigin) return false;
      if (!/BLOCKED_BY_(RESPONSE|CSP)/.test(r.failure()?.errorText ?? '')) return false;
      try {
        return r.frame().parentFrame() === livePage.mainFrame();
      } catch {
        return false;
      }
    };
    context.on('requestfailed', (r) => {
      if (refusedFrame(r)) quiet(toWindow('枠に入るのを拒むアプリなので、別の窓で開きます'));
      const entry = tracked.get(r);
      // 返事を見たあとの失敗（中身の無い返事のあとに来る、など）は、失敗にしない
      if (!entry || entry.responded) return;
      entry.responded = true;
      const now = Date.now();
      const heldNow = held.has(r) || (heldKeys.get(`${r.method()} ${r.url()}`) ?? 0) > now - 2_000;
      emit({
        t: 'failed',
        at: Math.max(now, entry.at),
        id: entry.id,
        why: entry.outside ? 'outside' : heldNow ? 'held' : 'error',
      });
    });

    // --- 止めて見る（入れているあいだだけ、通信を途中で受け取る仕組みを入れる。D228・D242） ---
    const holdHandler = async (route: Route, request: PwRequest) => {
      if (READ_ONLY.has(request.method()) || (!request.serviceWorker() && !fromApp(request)))
        return route.continue().catch(() => {});
      held.add(request);
      if (request.serviceWorker()) {
        const now = Date.now();
        prune(heldKeys, now);
        heldKeys.set(`${request.method()} ${request.url()}`, now);
      }
      return route.abort('blockedbyclient').catch(() => {});
    };
    let routed = false;
    const applyHold = async () => {
      if (state.hold && !routed) {
        routed = true;
        await context.route('**/*', holdHandler);
      } else if (!state.hold && routed) {
        routed = false;
        await context.unroute('**/*', holdHandler);
      }
    };
    await applyHold();

    // --- 枠の中からの知らせと、ライブの画面からの合図（同じ口。呼んだ枠で見分ける。§4.2） ---
    // 知らせの上限は、種類ごと（画面の変化が速いアプリでも、部品への操作を捨てない）
    const budget = new Map<string, { start: number; count: number }>();
    const allow = (kind: string, now: number) => {
      const b = budget.get(kind) ?? { start: now, count: 0 };
      if (now - b.start >= 1_000) {
        b.start = now;
        b.count = 0;
      }
      b.count++;
      budget.set(kind, b);
      return b.count <= (SESSION_LIMITS.reportsPerSecond[kind] ?? 0);
    };
    await context.exposeBinding('__stackAtlasLive', async (source, payload: unknown) => {
      const frame = source.frame;
      const fromLive =
        !swapping &&
        source.page === livePage &&
        frame === livePage.mainFrame() &&
        originOf(frame.url()) === live.origin;
      if (fromLive) return onSignal(payload);
      if (!isAppFrame(frame)) return;
      const now = Date.now();
      const kind =
        typeof payload === 'object' && payload !== null
          ? String((payload as { t?: unknown }).t)
          : '';
      if (!allow(kind, now)) return;
      const report = sanitizeReport(payload, now, knownParts);
      if (report) emit(report);
    });

    const onSignal = async (payload: unknown) => {
      if (typeof payload !== 'object' || payload === null) return;
      const s = payload as Partial<LiveSignal> & { on?: unknown };
      if (s.t === 'reveal' && typeof s.on === 'boolean') {
        state.reveal = s.on;
        if (!state.reveal) stripQueued();
        await sendStatus();
        // 入れる前に起きた操作の分も、メモリから渡す
        if (state.reveal) await deliver({ t: 'values', values: [...values.values()] });
      } else if (s.t === 'hold' && typeof s.on === 'boolean' && !state.holdLocked) {
        state.hold = s.on;
        await applyHold();
        await sendStatus();
      } else if (s.t === 'reload') await reloadApp();
    };

    // 枠の中のスクリプト（アプリの出所の枠でだけ動く）
    await context.addInitScript(liveWatcher, {
      appOrigin,
      parts: (graph.parts ?? []).map((p): [string, string] => [p.id, p.selector]),
    });

    // --- 画面を開いた（枠の移動を、ブラウザの外から見る） ---
    const appTop = (f: Frame) =>
      state.mode === 'frame'
        ? f.page() === livePage && f.parentFrame() === livePage.mainFrame()
        : appPage !== undefined && f === appPage.mainFrame();
    const onNavigated = (f: Frame) => {
      if (!appTop(f)) return;
      const url = f.url();
      // つながらなかった画面（手元の外へ移ろうとした・アプリが止まっている など）は、開いた画面にしない。
      // 手元の外へ移ろうとしたことは、その通信（form の送信・手元の外）として出ている
      if (url.startsWith('chrome-error://')) return;
      if (originOf(url) !== appOrigin) {
        emit({ t: 'open', at: Date.now(), path: '…' });
        return;
      }
      const u = new URL(url);
      const s = screenFor(graph, u.pathname);
      const screen = s.screen ? graph.nodes.find((n) => n.id === s.screen) : undefined;
      const path = typeof screen?.meta?.path === 'string' ? screen.meta.path : maskPath(u.pathname);
      emit({ t: 'open', at: Date.now(), path, ...(s.screen ? { screen: s.screen } : {}) });
    };

    const openAppWindow = async () => {
      if (closing) return;
      appPage = await context.newPage();
      appPage.on('framenavigated', onNavigated);
      await appPage.goto(appUrl.href).catch(() => {});
    };
    const toWindow = async (why: string) => {
      if (state.mode === 'window') return;
      state.mode = 'window';
      log(why);
      await sendStatus();
      await openAppWindow();
    };
    const reloadApp = async () => {
      if (state.mode === 'window') {
        if (appPage && !appPage.isClosed()) await appPage.goto(appUrl.href).catch(() => {});
        else await openAppWindow();
        return;
      }
      const f = livePage.mainFrame().childFrames()[0];
      await f?.goto(appUrl.href).catch(() => {});
    };

    // --- ライブの画面 ---
    const onLiveNavigated = (f: Frame) => {
      if (f.page() !== livePage) return;
      // アプリが、いちばん上の窓を自分に移した（D235）。その窓をアプリの窓にして、ライブの画面を開き直す
      if (f === livePage.mainFrame() && originOf(f.url()) !== live.origin) {
        if (swapping || closing) return;
        swapping = true; // 待つ前に印を立てる（このあいだに、もう一度入れ替えない・何も渡さない）
        const taken = livePage;
        taken.off('framenavigated', onLiveNavigated);
        taken.off('load', onLiveLoad);
        state.mode = 'window';
        appPage = taken;
        appPage.on('framenavigated', onNavigated);
        log('アプリが、いちばん上の窓を移したので、アプリを別の窓にしました');
        quiet(
          (async () => {
            const next = await context.newPage();
            livePage = next;
            swapping = false;
            attachLive(next);
            await next.goto(live.url);
          })().catch(() => {
            swapping = false;
          }),
        );
        return;
      }
      onNavigated(f);
    };
    // ライブの画面を読みこむたび（利用者が読み直したときも）、図と状態を渡し直す
    const onLiveLoad = () => quiet(sendInit());
    const attachLive = (p: Page) => {
      p.on('framenavigated', onLiveNavigated);
      p.on('load', onLiveLoad);
    };
    livePage = await context.newPage();
    attachLive(livePage);
    await livePage.goto(live.url);
    await sendInit();
    if (state.mode === 'window') await openAppWindow();
    if (!opts.headless) await livePage.bringToFront();

    // --- 終わり ---
    let resolveClosed!: () => void;
    const closed = new Promise<void>((ok) => (resolveClosed = ok));
    const close = async () => {
      if (closing) return closed;
      closing = true;
      values.clear();
      await cleanup();
      resolveClosed();
      return closed;
    };
    browser.on('disconnected', () => void close());
    context.on('close', () => void close());
    // ライブの画面を閉じたら終わる（入れ替えたあとのライブの画面も）
    context.on('page', (p) => p.on('close', () => p === livePage && !swapping && void close()));
    livePage.on('close', () => !swapping && void close());

    return {
      get livePage() {
        return livePage;
      },
      appPage: () => appPage,
      liveUrl: live.url,
      status: () => ({ ...state }),
      refused: () => ({ count: refuser.count(), hosts: refuser.hosts() }),
      closed,
      close: async () => {
        await flush(true);
        await close();
      },
    };
  } catch (e) {
    await cleanup();
    throw e;
  }
}
