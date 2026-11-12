/// <reference lib="dom" />
/**
 * アプリの枠の中で動く、小さなスクリプト（docs/27 §4.2、D229）。道具が、すべての枠に入れる（ブラウザを動かす部品の、
 * 初めに走るスクリプト）。アプリの出所の枠でだけ動き、**見るだけ**: 何も押さない・通信を変えない・画面を変えない・
 * アプリの持ち物（関数・変数）を置き換えない。入力欄の値は、読まない。
 *
 * 見たことは、道具が用意した専用の口（`__stackAtlasLive`）で、道具にだけ知らせる。道具は、知らせた枠の出所と、
 * 知らせの形を確かめてから使う（アプリも、この口を呼べる）。
 *
 * この関数は、文字にしてブラウザへ渡すので、外の変数を使わない
 */
export interface WatcherArgs {
  appOrigin: string;
  /** 部品の id とセレクタ（図の parts） */
  parts: Array<[string, string]>;
}

export function liveWatcher({ appOrigin, parts }: WatcherArgs): void {
  if (location.origin !== appOrigin) return;
  const channel = (window as unknown as { __stackAtlasLive?: (ev: unknown) => void })
    .__stackAtlasLive;
  if (typeof channel !== 'function') return;
  // アプリが、あとで置き換えても効くように、初めの持ち物を手元に取っておく
  const matches = Element.prototype.matches;
  const closest = Element.prototype.closest;
  const rectOfEl = Element.prototype.getBoundingClientRect;
  const LIMIT = { text: 200, changes: 40, parts: 16 };
  const now = () => performance.timeOrigin + performance.now();
  const post = (ev: Record<string, unknown>) => {
    try {
      void channel({ ...ev, at: now() });
    } catch {
      // 知らせられなくても、アプリの動きは止めない
    }
  };
  const rectOf = (el: Element) => {
    const r = rectOfEl.call(el);
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  };
  const visible = (el: Element) => {
    const check = (el as Element & { checkVisibility?: (o?: object) => boolean }).checkVisibility;
    return typeof check === 'function' ? check.call(el, { visibilityProperty: true }) : true;
  };
  const SKIP = 'script,style,template,noscript,textarea,select';
  /**
   * 外れた要素の中で、隠れていたと分かるもの（外れたあとは、見えていたかを測れないので、印と書き方で見る）。
   * 様式の決まりで隠していたものは見分けられない（docs/27 §5.5）。開いてから足された要素は、足したときの文字を覚えておく
   */
  const HIDDEN =
    '[hidden],[aria-hidden="true"],[style*="display:none"],[style*="display: none"],[style*="visibility:hidden"],[style*="visibility: hidden"]';
  /** 要素の中の文字（区切りを入れてつなぐ）。つながっている要素は、見えている文字だけ。長さに上限 */
  const textOf = (node: Node, connected: boolean): string => {
    const out: string[] = [];
    let length = 0;
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n && length < LIMIT.text; n = walker.nextNode()) {
      const parent = n.parentElement;
      if (!parent || closest.call(parent, SKIP)) continue;
      if (connected ? !visible(parent) : closest.call(parent, HIDDEN)) continue;
      const t = (n.nodeValue ?? '').replace(/\s+/g, ' ').trim();
      if (!t) continue;
      out.push(t);
      length += t.length + 3;
    }
    return out.join(' ・ ').slice(0, LIMIT.text);
  };

  // 1. 部品への操作（人の操作だけ。アプリより先に見るために、捕まえる段で聞く）
  const partsAt = (path: EventTarget[]) => {
    const ids: string[] = [];
    let first: Element | undefined;
    for (const node of path) {
      if (!(node instanceof Element)) continue;
      for (const [id, selector] of parts) {
        if (ids.includes(id)) continue;
        try {
          if (matches.call(node, selector)) {
            ids.push(id);
            first ??= node;
          }
        } catch {
          // 形のおかしいセレクタは、その部品だけ飛ばす
        }
      }
      if (ids.length >= LIMIT.parts) break;
    }
    return { ids, first };
  };
  for (const how of ['click', 'submit', 'input', 'change'] as const) {
    document.addEventListener(
      how,
      (e) => {
        if (!e.isTrusted) return;
        const { ids, first } = partsAt(e.composedPath());
        if (ids.length)
          post({ t: 'part', how, parts: ids, ...(first ? { rect: rectOf(first) } : {}) });
      },
      true,
    );
  }

  // 2. 部品の場所（一覧から挙動を選んだとき、始まりの部品を囲むのに使う）。間引いて知らせる
  let rectsTimer: ReturnType<typeof setTimeout> | undefined;
  const reportRects = () => {
    rectsTimer = undefined;
    const rects: Array<[string, ReturnType<typeof rectOf>]> = [];
    for (const [id, selector] of parts) {
      let el: Element | null;
      try {
        el = document.querySelector(selector);
      } catch {
        continue;
      }
      if (!el || !visible(el)) continue;
      const r = rectOf(el);
      if (r.w > 0 && r.h > 0) rects.push([id, r]);
    }
    post({ t: 'parts', rects });
  };
  const scheduleRects = () => {
    rectsTimer ??= setTimeout(reportRects, 250);
  };
  addEventListener('scroll', scheduleRects, { capture: true, passive: true });
  addEventListener('resize', scheduleRects, { passive: true });

  // 3. 画面の変化（足された・消された要素と、変わった文字）
  const seen = new WeakMap<Node, string>();
  const watch = () => {
    new MutationObserver((records) => {
      const changes: Array<Record<string, unknown>> = [];
      const push = (c: Record<string, unknown>) => {
        if (changes.length < LIMIT.changes) changes.push(c);
      };
      for (const r of records) {
        if (r.type === 'characterData') {
          const parent = r.target.parentElement;
          if (!parent || closest.call(parent, SKIP) || !visible(parent)) continue;
          const before = (r.oldValue ?? '').replace(/\s+/g, ' ').trim().slice(0, LIMIT.text);
          const text = (r.target.nodeValue ?? '').replace(/\s+/g, ' ').trim().slice(0, LIMIT.text);
          if (before !== text) push({ kind: 'text', before, text });
          continue;
        }
        const added = [...r.addedNodes];
        const removed = [...r.removedNodes];
        const isText = (n: Node) => n.nodeType === Node.TEXT_NODE;
        // 文字だけの入れ替え（textContent を書き換えた、など）は、文字の変化として出す
        if ([...added, ...removed].every(isText) && r.target instanceof Element) {
          if (closest.call(r.target, SKIP) || !visible(r.target)) continue;
          const join = (ns: Node[]) =>
            ns
              .map((n) => (n.nodeValue ?? '').replace(/\s+/g, ' ').trim())
              .filter(Boolean)
              .join(' ')
              .slice(0, LIMIT.text);
          const before = join(removed);
          const text = join(added);
          if (before !== text) push({ kind: 'text', before, text });
          continue;
        }
        for (const n of added) {
          if (!(n instanceof Element) || closest.call(n, SKIP) || !visible(n)) continue;
          const text = textOf(n, true);
          seen.set(n, text);
          push({ kind: 'added', text, rect: rectOf(n) });
        }
        for (const n of removed) {
          if (!(n instanceof Element) || matches.call(n, SKIP)) continue;
          push({ kind: 'removed', text: seen.get(n) ?? textOf(n, false) });
        }
      }
      if (changes.length) post({ t: 'dom', changes });
      scheduleRects();
    }).observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      characterDataOldValue: true,
    });
    scheduleRects();
  };
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', watch, { once: true });
  else watch();
}
