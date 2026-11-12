// ライブの画面（最小のもの。10-2b）。道具が渡した出来事を、文字として並べるだけ。
// 10-2c で、ビューアのライブの画面（経路・再生・時間の内訳）に置き換える。
// 道具とは、ブラウザを動かす部品の口だけで話す（受ける: __stackAtlasLiveReceive、送る: __stackAtlasLive）。
// 図とアプリから来た文字は、どれも textContent で出す（HTML として組みこまない）
const delivered = [];
// 確かめ（テスト）が、道具から何が届いたかを読むための置き場
window.__stackAtlasLiveDelivered = delivered;

const $ = (id) => document.getElementById(id);
const pane = $('app-pane');
const list = $('events');
const note = $('note');
let status = null;

const signal = (s) => {
  try {
    window.__stackAtlasLive?.(s);
  } catch {
    // 道具とつながっていない（ふだんのブラウザで開いた、など）
  }
};

function line(text) {
  const li = document.createElement('li');
  li.textContent = text;
  list.prepend(li);
  while (list.children.length > 500) list.lastElementChild.remove();
}

function describe(ev) {
  switch (ev.t) {
    case 'open':
      return `開く ${ev.path}${ev.screen ? `（${ev.screen}）` : ''}`;
    case 'part':
      return `${ev.how} ${ev.parts.join(' < ')}`;
    case 'request':
      return `→ ${ev.method} ${ev.path}${ev.outside ? '（手元の外）' : ''}${ev.body ? ` ${JSON.stringify(ev.body)}` : ''}`;
    case 'response':
      return `← ${ev.status}${ev.inBrowser ? '（ブラウザの中で返事）' : ''}${ev.body ? ` ${JSON.stringify(ev.body)}` : ''}`;
    case 'failed':
      return `× ${{ held: '止めた', outside: '手元の外なので、つながらない', error: '失敗' }[ev.why] ?? ev.why}`;
    case 'dom':
      return `画面 ${ev.changes.map((c) => `${{ added: '+', removed: '-', text: '~' }[c.kind]}${c.text}`).join(' / ')}`;
    default:
      return null; // 部品の場所は、並べない
  }
}

function applyStatus(next) {
  status = next;
  $('reveal').setAttribute('aria-pressed', String(next.reveal));
  $('hold').setAttribute('aria-pressed', String(next.hold));
  $('hold').disabled = next.holdLocked;
  let app;
  try {
    app = new URL(next.app);
  } catch {
    app = undefined;
  }
  const frame = pane.querySelector('iframe');
  if (next.mode === 'frame' && app && (app.protocol === 'http:' || app.protocol === 'https:')) {
    if (!frame) {
      const f = document.createElement('iframe');
      f.title = 'アプリ';
      f.src = app.href;
      pane.append(f);
    }
    note.textContent = '';
  } else {
    frame?.remove();
    note.textContent = 'アプリは、別の窓で開いています。その窓で操作してください。';
  }
}

window.__stackAtlasLiveReceive = (msg) => {
  delivered.push(msg);
  if (msg.t === 'status') applyStatus(msg.status);
  else if (msg.t === 'events')
    for (const ev of msg.events) {
      const text = describe(ev);
      if (text) line(text);
    }
  else if (msg.t === 'values') for (const v of msg.values) line(`値 ${v.raw}`);
};

$('reveal').addEventListener('click', () => signal({ t: 'reveal', on: !status?.reveal }));
$('hold').addEventListener('click', () => signal({ t: 'hold', on: !status?.hold }));
$('reload').addEventListener('click', () => signal({ t: 'reload' }));
if (typeof window.__stackAtlasLive !== 'function')
  note.textContent =
    'この画面は、stack-atlas live が開いた窓の中でだけ動きます。ふだんのブラウザで開いても、つながりません。';
