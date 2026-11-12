/**
 * ライブの画面の入口（docs/27 §4.4）。道具とは、ブラウザを動かす部品の口だけで話す:
 * 受ける: window.__stackAtlasLiveReceive（道具が、この画面のいちばん上の枠にだけ渡す）
 * 送る: window.__stackAtlasLive（道具は、この画面のいちばん上の枠からの合図だけを受ける）
 * 画面の状態は、アドレスの引数では変えない（アプリの URL も、道具が口で渡す）
 */
import { LIVE_PROTOCOL, type LiveMessage } from '@stack-atlas/wiring';
import './live.css';
import { LiveModel } from './model';
import { LiveView } from './view';

type Signal = { t: 'reveal' | 'hold'; on: boolean } | { t: 'reload' };
interface LiveWindow {
  __stackAtlasLive?: (s: Signal) => Promise<void>;
  __stackAtlasLiveReceive?: (m: LiveMessage) => void;
  /** 確かめ（テスト）が、道具から何が届いたかを読むための置き場 */
  __stackAtlasLiveDelivered?: LiveMessage[];
  /** 確かめが、操作がいくつ閉じて、見せることになったかを読む */
  __stackAtlasLivePlayed?: () => Array<{ behavior?: string; ok?: boolean; total: number }>;
}
const w = window as unknown as LiveWindow;

const model = new LiveModel();
const view = new LiveView(model, (s) => {
  void w.__stackAtlasLive?.(s).catch(() => {});
});
const delivered: LiveMessage[] = [];
w.__stackAtlasLiveDelivered = delivered;
w.__stackAtlasLivePlayed = () =>
  model.played.map((p) => {
    const row: { behavior?: string; ok?: boolean; total: number } = { total: p.timeline.total };
    if (p.choice.behavior !== undefined) row.behavior = p.choice.behavior;
    if (p.verdict) row.ok = p.verdict.ok;
    return row;
  });

/** 「値を見る」を切ったら、確かめの置き場からも、値を消す */
const scrubDelivered = () => {
  for (let i = delivered.length - 1; i >= 0; i--) {
    const m = delivered[i]!;
    if (m.t === 'values') delivered.splice(i, 1);
    else if (m.t === 'events')
      for (const ev of m.events) {
        if (ev.t === 'request') delete ev.raw;
        if ((ev.t === 'request' || ev.t === 'response') && ev.body) delete ev.body.value;
      }
  }
};

w.__stackAtlasLiveReceive = (msg) => {
  if (!(msg.t === 'events' && msg.events.length === 0)) delivered.push(msg);
  if (delivered.length > 2000) delivered.splice(0, delivered.length - 2000);
  const played = model.receive(msg);
  if (msg.t === 'graph') view.graph();
  else if (msg.t === 'status') {
    if (!msg.status.reveal) scrubDelivered();
    if (msg.status.protocol !== LIVE_PROTOCOL)
      document.getElementById('note')!.textContent =
        '道具と、この画面の版が合いません。pnpm build で組み立て直してください。';
    view.status();
  } else if (msg.t === 'values') view.valuesArrived();
  else if (msg.t === 'events') {
    if (msg.events.some((e) => e.t === 'parts')) view.rects();
    if (msg.events.some((e) => e.t === 'open')) view.screenChanged();
  }
  if (played.length) view.played(played);
};

// 道具が「どこまで渡し終えたか」を渡さないとき（古い道具）だけ、今の時刻から、道具がためる時間を引いて区切る
const FALLBACK_LAG_MS = 400;
setInterval(() => {
  if (model.watermarked) return;
  const played = model.tick(Date.now() - FALLBACK_LAG_MS);
  if (played.length) view.played(played);
}, 100);

if (typeof w.__stackAtlasLive !== 'function')
  document.getElementById('note')!.textContent =
    'この画面は、stack-atlas live が開いた窓の中でだけ動きます。ふだんのブラウザで開いても、つながりません。';
