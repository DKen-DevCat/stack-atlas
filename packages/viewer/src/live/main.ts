/**
 * ライブの画面の入口（docs/27 §4.4）。道具とは、ブラウザを動かす部品の口だけで話す:
 * 受ける: window.__stackAtlasLiveReceive（道具が、この画面のいちばん上の枠にだけ渡す）
 * 送る: window.__stackAtlasLive（道具は、この画面のいちばん上の枠からの合図だけを受ける）
 * 画面の状態は、アドレスの引数では変えない（アプリの URL も、道具が口で渡す）
 */
import type { LiveMessage } from '@stack-atlas/wiring';
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

w.__stackAtlasLiveReceive = (msg) => {
  delivered.push(msg);
  if (delivered.length > 2000) delivered.splice(0, delivered.length - 2000);
  const screen = model.screen;
  const played = model.receive(msg);
  if (msg.t === 'graph') view.graph();
  else if (msg.t === 'status') view.status();
  else if (msg.t === 'values') view.valuesArrived();
  else if (msg.t === 'events') {
    if (msg.events.some((e) => e.t === 'parts')) view.rects();
    if (model.screen !== screen) view.screenChanged();
  }
  if (played.length) view.played(played);
};

setInterval(() => {
  const played = model.tick(Date.now());
  if (played.length) view.played(played);
}, 100);

if (typeof w.__stackAtlasLive !== 'function')
  document.getElementById('note')!.textContent =
    'この画面は、stack-atlas live が開いた窓の中でだけ動きます。ふだんのブラウザで開いても、つながりません。';
