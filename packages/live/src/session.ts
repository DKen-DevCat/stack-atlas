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
import { startLiveServer, type LiveServer } from './server.js';
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
  /** 枠の中からの知らせの、1 秒あたりの上限 */
  reportsPerSecond: 60,
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
  const cleanup = async () => {
    await browser?.close().catch(() => {});
    await server?.close().catch(() => {});
    await refuser.close().catch(() => {});
  };

  try {
    server = await startLiveServer({ hostname: appUrl.hostname, appOrigin });
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
      // 暗号つきのアプリは、枠の中では Cookie がほとんど送られないので、別の窓（D235）
      mode: opts.window || appUrl.protocol === 'https:' ? 'window' : 'frame',
      reveal: false,
      hold: opts.holdWrites === true,
      holdLocked: opts.holdWrites === true,
    };
    let livePage: Page;
    let appPage: Page | undefined;
    /** 終わりかけ（ライブの画面か、ブラウザが閉じた）。このあとは、窓を開かない */
    let closing = false;

    // --- ライブの画面へ渡す ---
    const queue: LiveEvent[] = [];
    const deliver = async (msg: LiveMessage) => {
      if (livePage.isClosed()) return;
      await livePage
        .evaluate((m) => {
          const receive = (window as unknown as { __stackAtlasLiveReceive?: (m: unknown) => void })
            .__stackAtlasLiveReceive;
          receive?.(m);
        }, msg)
        .catch(() => {});
    };
    const emit = (ev: LiveEvent) => queue.push(ev);
    const flush = async (all = false) => {
      const limit = Date.now() - SESSION_LIMITS.reorderMs;
      queue.sort((a, b) => a.at - b.at);
      const ready: LiveEvent[] = [];
      while (queue.length && (all || queue[0]!.at <= limit)) ready.push(queue.shift()!);
      if (ready.length) await deliver({ t: 'events', events: ready });
    };
    const timer = setInterval(() => void flush(), SESSION_LIMITS.flushMs);
    const sendStatus = () => deliver({ t: 'status', status: { ...state } });

    // --- 値（「値を見る」のあいだだけ渡す。メモリに直近の分だけ持つ。ファイルにも端末にも出さない） ---
    const values = new Map<string, LiveValues>();
    const remember = (id: string, patch: Partial<LiveValues> & { raw?: string }) => {
      const v = values.get(id) ?? { id, raw: '' };
      Object.assign(v, patch);
      values.delete(id);
      values.set(id, v);
      while (values.size > SESSION_LIMITS.values) values.delete(values.keys().next().value!);
    };

    // --- アプリの枠か ---
    /** アプリの出所の枠（ライブの画面のいちばん上の枠ではないもの） */
    const isAppFrame = (f: Frame) =>
      !(f.page() === livePage && f === livePage.mainFrame()) && originOf(f.url()) === appOrigin;
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
    let seq = 0;
    const tracked = new WeakMap<PwRequest, { id: string; outside: boolean; responded: boolean }>();
    const held = new WeakSet<PwRequest>();
    /** 裏で動く部品（返事を差し替える仕組み）の書きこみを止めたもの。画面の側の通信の失敗を「止めた」と見分ける */
    const heldKeys = new Map<string, number>();
    const kindOf = (r: PwRequest): 'script' | 'form' | undefined => {
      const type = r.resourceType();
      if (type === 'fetch' || type === 'xhr' || type === 'ping') return 'script';
      if (type === 'document' && r.method() !== 'GET') return 'form';
      return undefined; // 画面の資産・画面の移動・つなぎっぱなしの通信は、数えない
    };
    const startOf = (r: PwRequest) => {
      const t = r.timing().startTime;
      return t > 0 ? t : Date.now();
    };

    context.on('request', (r) => {
      if (r.serviceWorker() || !fromApp(r)) return;
      const kind = kindOf(r);
      if (!kind) return;
      let url: URL;
      try {
        url = new URL(r.url());
      } catch {
        return;
      }
      const id = `r${++seq}`;
      const outside = !isLocalHost(url.hostname, localNames);
      tracked.set(r, { id, outside, responded: false });
      const route = findRoute(routes, r.method(), url.pathname);
      const buffer = r.postDataBuffer();
      const type = r.headers()['content-type'];
      const text =
        buffer && buffer.length <= SESSION_LIMITS.bodyBytes && textual(type)
          ? buffer.toString('utf8')
          : undefined;
      const raw = clip(`${url.pathname}${url.search}`, SESSION_LIMITS.value);
      remember(id, {
        raw,
        ...(text !== undefined ? { sent: clip(text, SESSION_LIMITS.value) } : {}),
      });
      const body = maskBody(type, text, buffer?.length ?? 0, state.reveal);
      emit({
        t: 'request',
        at: startOf(r),
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

    context.on('response', (res: PwResponse) => {
      const r = res.request();
      const entry = tracked.get(r);
      if (!entry || entry.responded) return;
      entry.responded = true;
      const t = r.timing();
      const at =
        t.startTime > 0 && t.responseStart >= 0 ? t.startTime + t.responseStart : Date.now();
      if (entry.outside) {
        // 行き先の無い中継の返事（403）は、アプリの側の返事ではない
        emit({ t: 'failed', at, id: entry.id, why: 'outside' });
        return;
      }
      void (async () => {
        const type = res.headers()['content-type'];
        const length = Number(res.headers()['content-length'] ?? NaN);
        let text: string | undefined;
        let bytes = Number.isFinite(length) ? length : 0;
        if (textual(type) && !(bytes > SESSION_LIMITS.bodyBytes)) {
          try {
            const buf = await res.body();
            bytes = buf.length;
            if (buf.length <= SESSION_LIMITS.bodyBytes) text = buf.toString('utf8');
          } catch {
            // 中身の無い返事（204 など）・読めない返事
          }
        }
        if (text !== undefined) remember(entry.id, { received: clip(text, SESSION_LIMITS.value) });
        const body = maskBody(type, text, bytes, state.reveal);
        emit({
          t: 'response',
          at,
          id: entry.id,
          status: res.status(),
          inBrowser: res.fromServiceWorker(),
          ...(body ? { body } : {}),
        });
      })();
    });

    context.on('requestfailed', (r) => {
      const entry = tracked.get(r);
      // 返事を見たあとの失敗（中身の無い返事のあとに来る、など）は、失敗にしない
      if (!entry || entry.responded) return;
      entry.responded = true;
      const key = `${r.method()} ${r.url()}`;
      const heldNow = held.has(r) || (heldKeys.get(key) ?? 0) > Date.now() - 2_000;
      emit({
        t: 'failed',
        at: Date.now(),
        id: entry.id,
        why: entry.outside ? 'outside' : heldNow ? 'held' : 'error',
      });
    });

    // --- 止めて見る（入れているあいだだけ、通信を途中で受け取る仕組みを入れる。D228・D242） ---
    const holdHandler = async (route: Route, request: PwRequest) => {
      if (READ_ONLY.has(request.method()) || (!request.serviceWorker() && !fromApp(request)))
        return route.continue().catch(() => {});
      held.add(request);
      if (request.serviceWorker()) heldKeys.set(`${request.method()} ${request.url()}`, Date.now());
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
    let windowStart = Date.now();
    let inWindow = 0;
    await context.exposeBinding('__stackAtlasLive', async (source, payload: unknown) => {
      const frame = source.frame;
      const fromLive =
        source.page === livePage &&
        frame === livePage.mainFrame() &&
        originOf(frame.url()) === live.origin;
      if (fromLive) return onSignal(payload);
      if (!isAppFrame(frame)) return;
      const now = Date.now();
      if (now - windowStart >= 1_000) {
        windowStart = now;
        inWindow = 0;
      }
      if (++inWindow > SESSION_LIMITS.reportsPerSecond) return;
      const report = sanitizeReport(payload, now, knownParts);
      if (report) emit(report);
    });

    const onSignal = async (payload: unknown) => {
      if (typeof payload !== 'object' || payload === null) return;
      const s = payload as Partial<LiveSignal> & { on?: unknown };
      if (s.t === 'reveal' && typeof s.on === 'boolean') {
        state.reveal = s.on;
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
        ? f.parentFrame() === livePage.mainFrame()
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
    livePage = await context.newPage();
    livePage.on('framenavigated', (f) => {
      // アプリが、いちばん上の窓を自分に移した（D235）。その窓をアプリの窓にして、ライブの画面を開き直す
      if (f === livePage.mainFrame() && originOf(f.url()) !== live.origin) {
        void (async () => {
          state.mode = 'window';
          appPage = livePage;
          appPage.on('framenavigated', onNavigated);
          log('アプリが、いちばん上の窓を移したので、アプリを別の窓にしました');
          livePage = await context.newPage();
          await openLive();
        })();
        return;
      }
      onNavigated(f);
    });
    const openLive = async () => {
      await livePage.goto(live.url);
      await deliver({ t: 'graph', graph });
      await sendStatus();
    };
    await openLive();
    // 枠に入るのを、応答で拒むアプリ（D235）: アプリの出所の画面の読みこみが、応答で止められた
    // （つながらなかった画面一般とは分ける。手元の外へ移ろうとしたときも、つながらなかった画面になる）
    context.on('requestfailed', (r) => {
      if (r.resourceType() !== 'document' || state.mode !== 'frame') return;
      if (originOf(r.url()) !== appOrigin) return;
      if (!/BLOCKED_BY_RESPONSE/.test(r.failure()?.errorText ?? '')) return;
      try {
        if (r.frame().parentFrame() !== livePage.mainFrame()) return;
      } catch {
        return;
      }
      void toWindow('枠に入るのを拒むアプリなので、別の窓で開きます');
    });
    if (state.mode === 'window') await openAppWindow();
    if (!opts.headless) await livePage.bringToFront();

    // --- 終わり ---
    let resolveClosed!: () => void;
    const closed = new Promise<void>((ok) => (resolveClosed = ok));
    const close = async () => {
      if (closing) return closed;
      closing = true;
      clearInterval(timer);
      values.clear();
      await cleanup();
      resolveClosed();
      return closed;
    };
    browser.on('disconnected', () => void close());
    context.on('close', () => void close());
    const watchLive = (p: Page) => p.on('close', () => p === livePage && void close());
    watchLive(livePage);
    context.on('page', (p) => watchLive(p));

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
