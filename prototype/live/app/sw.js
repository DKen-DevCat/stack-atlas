// サンプルのアプリの「バックエンド」。/api/* の通信を途中で受け取り、返事を差し替える。
// 返事を差し替える仕組みを使う開発環境と同じ形（通信はブラウザの外へ出ない）。
// コメントは、この Service Worker のメモリにだけある（止まると最初の 2 件に戻る）。
let nextId = 3;
let comments = [
  { id: 2, body: '読んでくれてありがとう。次は凡例の話を書きます。', author: 'mio' },
  { id: 1, body: '地図があると、歩き方が変わりますね。', author: 'ken' },
];

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (!url.pathname.startsWith('/api/')) return;
  event.respondWith(handle(event.request, url));
});

async function handle(req, url) {
  if (url.pathname === '/api/comments' && req.method === 'GET') {
    return json({ comments });
  }
  if (url.pathname === '/api/comments' && req.method === 'POST') {
    const { comment } = await req.json();
    const row = { id: nextId++, body: String(comment.body).slice(0, 500), author: 'me' };
    comments = [row, ...comments];
    return json({ comment: row }, 201);
  }
  const m = /^\/api\/comments\/(\d+)$/.exec(url.pathname);
  if (m && req.method === 'DELETE') {
    comments = comments.filter((c) => c.id !== Number(m[1]));
    return new Response(null, { status: 204 });
  }
  return json({ error: 'not found' }, 404);
}
