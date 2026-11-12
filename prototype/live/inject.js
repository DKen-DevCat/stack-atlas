// 道具が、ブラウザのすべての枠に入れるスクリプト（run.mjs が addInitScript で入れる）。
// アプリの枠の中でだけ動き、「見る」ことしかしない: 何も押さない・通信を変えない・画面を変えない。
// 見たものは、いちばん上の窓（ビューア）へ postMessage で渡す。
//
// 見るもの:
//   part  押された・送信された要素が、図のどの部品（セレクタ）に当たるか
//   req   アプリが fetch で送ろうとした通信（メソッド・パス・本文）
//   res   その返事（状態・本文）
//   dom   画面の中で足された・消された要素
//
// この関数は文字列にしてブラウザへ渡すので、外の変数を使わない。
export function atlasInject({ parts }) {
  if (window.top === window) return; // ビューア自身では何もしない

  // 時刻は、この枠の時計で測る（1 ミリ秒より細かい）。ビューアは、知らせどうしの差だけを使う
  const now = () => performance.timeOrigin + performance.now();
  const post = (ev) => {
    try {
      window.top.postMessage({ __atlasLive: 1, at: now(), ...ev }, '*');
    } catch {
      // 渡せなくても、アプリの動きは止めない
    }
  };
  const rectOf = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  };
  // 要素の中の文字を、区切りを入れてつなぐ（「本文」「書いた人」「ボタン」がくっついて読めなくならないように）
  const textOf = (el) => {
    const parts = [];
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const t = n.nodeValue.trim();
      if (t) parts.push(t);
    }
    return parts.join(' ・ ').slice(0, 120);
  };
  const partOf = (target) => {
    if (!(target instanceof Element)) return null;
    for (const p of parts) {
      const hit = target.closest(p.selector);
      if (hit) return { id: p.id, rect: rectOf(hit) };
    }
    return null;
  };

  // 1. 部品（click と submit。アプリより先に見るために capture の段で聞く）
  for (const how of ['click', 'submit']) {
    document.addEventListener(
      how,
      (e) => {
        const p = partOf(e.target);
        if (p) post({ t: 'part', how, part: p.id, rect: p.rect });
      },
      true,
    );
  }

  // 2. 通信（fetch を包む。元の fetch をそのまま呼び、返事には触らない）
  const origFetch = window.fetch.bind(window);
  let seq = 0;
  window.fetch = async (input, init) => {
    const id = ++seq;
    const isReq = typeof Request !== 'undefined' && input instanceof Request;
    const method = ((init && init.method) || (isReq ? input.method : 'GET')).toUpperCase();
    const u = new URL(isReq ? input.url : String(input), location.href);
    const body = init && typeof init.body === 'string' ? init.body.slice(0, 4000) : null;
    post({ t: 'req', id, method, path: u.pathname + u.search, sameOrigin: u.origin === location.origin, body });
    const res = await origFetch(input, init);
    const at = now(); // 返事が届いた時刻（本文を読み終える前に取る）
    res
      .clone()
      .text()
      .then((text) => post({ t: 'res', id, at, status: res.status, body: text.slice(0, 4000) }))
      .catch(() => post({ t: 'res', id, at, status: res.status, body: null }));
    return res;
  };

  // 3. 画面の変化
  const watch = () => {
    post({ t: 'open', path: location.pathname });
    new MutationObserver((muts) => {
      const changes = [];
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType === 1) changes.push({ kind: 'added', text: textOf(n), rect: rectOf(n) });
        }
        for (const n of m.removedNodes) {
          if (n.nodeType === 1) changes.push({ kind: 'removed', text: textOf(n) });
        }
      }
      if (changes.length) post({ t: 'dom', changes: changes.slice(0, 20) });
    }).observe(document.documentElement, { subtree: true, childList: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch, { once: true });
  else watch();
}
