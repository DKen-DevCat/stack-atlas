// ライブ（docs/27 §5.3）: 通信の値を伏せた形・受け口との照らし合わせ・枠の中からの知らせの確かめ
import type { NodeV2 } from '@stack-atlas/schema';
import { describe, expect, it } from 'vitest';
import {
  MASKED,
  MASK_LIMITS,
  REPORT_LIMITS,
  findRoute,
  graphRoutes,
  maskBody,
  maskPath,
  pathMatches,
  queryKeys,
  sanitizeReport,
} from '../live/index.js';

describe('maskBody: 既定では、値を出さない', () => {
  const SECRET = 'hunter2-secret';
  const json = JSON.stringify({
    user: { name: SECRET, age: 41, admin: false, note: null },
    tags: [SECRET, SECRET],
    rows: [{ id: 1, token: SECRET }],
    empty: [],
  });

  it('キーと値の形の中身: キーの名前と、値の型・列の長さだけになる', () => {
    const body = maskBody('application/json; charset=utf-8', json, json.length);
    expect(body).toEqual({
      kind: 'tree',
      shape: {
        t: 'object',
        keys: [
          [
            'user',
            {
              t: 'object',
              keys: [
                ['name', { t: 'string' }],
                ['age', { t: 'number' }],
                ['admin', { t: 'boolean' }],
                ['note', { t: 'null' }],
              ],
            },
          ],
          ['tags', { t: 'array', length: 2, item: { t: 'string' } }],
          [
            'rows',
            {
              t: 'array',
              length: 1,
              item: {
                t: 'object',
                keys: [
                  ['id', { t: 'number' }],
                  ['token', { t: 'string' }],
                ],
              },
            },
          ],
          ['empty', { t: 'array', length: 0 }],
        ],
      },
    });
    expect(JSON.stringify(body)).not.toContain(SECRET);
    // 種類の名前のうしろに付け足しのある書き方（`+json`）も、同じ
    expect(maskBody('application/problem+json', json, json.length)?.kind).toBe('tree');
  });

  it('フォームの形の中身: 欄の名前だけ。ファイルを運ぶ形は、「値を見る」でも値を付けない', () => {
    const form = `name=${SECRET}&mail=a%40example.test&name=again`;
    expect(maskBody('application/x-www-form-urlencoded', form, form.length)).toEqual({
      kind: 'form',
      keys: ['name', 'mail'],
    });
    const multi = `--x\r\nContent-Disposition: form-data; name="title"\r\n\r\n${SECRET}\r\n--x\r\nContent-Disposition: form-data; name="file"; filename="a.bin"\r\n\r\n${SECRET}\r\n--x--`;
    const masked = maskBody('multipart/form-data; boundary=x', multi, multi.length, true);
    expect(masked).toEqual({ kind: 'form', keys: ['title', 'file'] });
    expect(JSON.stringify(masked)).not.toContain(SECRET);
  });

  it('そのほかの中身（ただの文字・画面の形・ファイル・読めないもの）: 種類と大きさだけ', () => {
    expect(maskBody('text/html', `<p>${SECRET}</p>`, 30)).toEqual({
      kind: 'other',
      type: 'text/html',
      bytes: 30,
    });
    expect(maskBody('image/png', undefined, 2048)).toEqual({
      kind: 'other',
      type: 'image/png',
      bytes: 2048,
    });
    // キーと値の形の種類なのに、読めない中身
    expect(maskBody('application/json', `{"a": ${SECRET}`, 20)).toEqual({
      kind: 'other',
      type: 'application/json',
      bytes: 20,
    });
    // 種類の名前そのものに、値が紛れこんでいても、出さない
    expect(maskBody(`text/plain ${SECRET}`, 'x', 1)).toMatchObject({ type: 'unknown' });
    expect(maskBody(undefined, 'x', 1)).toMatchObject({ kind: 'other', type: 'unknown' });
  });

  it('中身が無ければ undefined', () => {
    expect(maskBody('application/json', undefined, 0)).toBeUndefined();
    expect(maskBody('application/json', '', 0)).toBeUndefined();
  });

  it('「値を見る」のあいだだけ、値が付く（長さに上限。文字として読めない種類には付けない）', () => {
    expect(maskBody('application/json', json, json.length, true)).toMatchObject({
      kind: 'tree',
      value: json,
    });
    expect(maskBody('text/plain', SECRET, SECRET.length, true)).toMatchObject({ value: SECRET });
    expect(maskBody('image/png', SECRET, 10, true)).not.toHaveProperty('value');
    const long = 'a'.repeat(MASK_LIMITS.value + 50);
    const value = (maskBody('text/plain', long, long.length, true) as { value: string }).value;
    expect(value).toHaveLength(MASK_LIMITS.value + 1);
  });

  it('キーが多い・入れ子が深い中身は、上限で切る（数だけ出す）', () => {
    const wide = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i]));
    const shape = maskBody('application/json', JSON.stringify(wide), 1) as {
      shape: { keys: unknown[]; more: number };
    };
    expect(shape.shape.keys).toHaveLength(MASK_LIMITS.keys);
    expect(shape.shape.more).toBe(50 - MASK_LIMITS.keys);
    let deep: unknown = { leaf: SECRET };
    for (let i = 0; i < 20; i++) deep = { next: deep };
    const text = JSON.stringify(maskBody('application/json', JSON.stringify(deep), 1));
    expect(text).not.toContain('leaf');
    expect(text.length).toBeLessThan(600);
  });
});

describe('maskPath・queryKeys', () => {
  it('パスの、値に見える部分（数字を含む・長い）を伏せる。文字だけの短い部分は残す', () => {
    expect(maskPath('/api/comments/12')).toBe(`/api/comments/${MASKED}`);
    expect(maskPath('/reset/3f9a0c1e-77aa')).toBe(`/reset/${MASKED}`);
    expect(maskPath(`/invite/${'x'.repeat(40)}/accept`)).toBe(`/invite/${MASKED}/accept`);
    expect(maskPath('/api/comments/')).toBe('/api/comments/');
    expect(maskPath('/a?token=1')).toBe('/a');
    expect(maskPath('/')).toBe('/');
  });

  it('問い合わせの文字列は、キーの名前だけ', () => {
    expect(queryKeys('?q=secret&page=2&q=again')).toEqual(['q', 'page']);
    expect(queryKeys('')).toEqual([]);
  });
});

describe('受け口との照らし合わせ（パスの変わる部分は、{名前} の形だけ）', () => {
  it('pathMatches', () => {
    expect(pathMatches('/api/comments/{id}', '/api/comments/12')).toBe(true);
    expect(pathMatches('/api/comments/{id}', '/api/comments/12/')).toBe(true);
    expect(pathMatches('/api/comments/{id}', '/api/comments')).toBe(false);
    expect(pathMatches('/api/comments/{id}', '/api/comments/12/likes')).toBe(false);
    expect(pathMatches('/api/comments', '/api/comments?page=2')).toBe(true);
    expect(pathMatches('/api/Comments', '/api/comments')).toBe(false);
    expect(pathMatches('/a b', '/a%20b')).toBe(true);
    // ほかの書き方（: や [ ] で書いた変わる部分）は、文字どおりに比べる
    expect(pathMatches('/api/comments/:id', '/api/comments/12')).toBe(false);
    expect(pathMatches('/api/comments/[id]', '/api/comments/12')).toBe(false);
  });

  it('findRoute: メソッドとパスが合う受け口。2 つ合えば、文字どおりの部分が多いもの', () => {
    const routes = [
      { method: 'GET', path: '/items/{id}' },
      { method: 'GET', path: '/items/new' },
      { method: 'POST', path: '/items' },
    ];
    expect(findRoute(routes, 'get', '/items/new')).toEqual(routes[1]);
    expect(findRoute(routes, 'GET', '/items/7')).toEqual(routes[0]);
    expect(findRoute(routes, 'DELETE', '/items/7')).toBeUndefined();
  });

  it('graphRoutes: 受け口の箱の meta.route（文字列でも、{ method, path } でも）。同じ書き方は 1 つ', () => {
    const node = (id: string, meta?: Record<string, unknown>): NodeV2 => ({
      id,
      kind: 'endpoint',
      name: id,
      runtime: 'server' as const,
      ports: [],
      ...(meta ? { meta } : {}),
    });
    expect(
      graphRoutes({
        nodes: [
          node('endpoint:a', { route: 'POST /items' }),
          node('endpoint:b', { route: { method: 'post', path: '/items' } }),
          node('endpoint:c', { route: { method: 'GET', path: '/items/{id}' } }),
          node('fn:x'),
        ],
      }),
    ).toEqual([
      { method: 'POST', path: '/items' },
      { method: 'GET', path: '/items/{id}' },
    ]);
  });
});

describe('sanitizeReport: アプリの枠からの知らせは、形と大きさを確かめてから使う', () => {
  const now = 1_700_000_000_000;
  const known = new Set(['comment-list', 'delete-button']);

  it('部品の出来事: 図にある部品だけを、内側から順のまま残す', () => {
    expect(
      sanitizeReport(
        {
          t: 'part',
          at: now - 5,
          how: 'click',
          parts: ['delete-button', 'ghost', 'comment-list', 'delete-button', 7],
          rect: { x: 1, y: 2, w: 3, h: 4, extra: 'x' },
          html: '<img onerror=alert(1)>',
        },
        now,
        known,
      ),
    ).toEqual({
      t: 'part',
      at: now - 5,
      how: 'click',
      parts: ['delete-button', 'comment-list'],
      rect: { x: 1, y: 2, w: 3, h: 4 },
    });
  });

  it('合わない知らせは捨てる（知らない種類・知らない操作・部品が 1 つも無い・形が違う）', () => {
    for (const raw of [
      null,
      'part',
      [],
      { t: 'reveal', on: true },
      { t: 'hold', on: false },
      { t: 'request', id: '1', method: 'POST', path: '/x' },
      { t: 'part', how: 'open', parts: ['comment-list'] },
      { t: 'part', how: 'tap', parts: ['comment-list'] },
      { t: 'part', how: 'click', parts: ['ghost'] },
      { t: 'part', how: 'click', parts: 'comment-list' },
      { t: 'dom', changes: 'x' },
      { t: 'dom', changes: [{ kind: 'moved', text: 'x' }] },
      { t: 'parts', rects: [] },
    ])
      expect(sanitizeReport(raw, now, known), JSON.stringify(raw)).toBeUndefined();
  });

  it('長い文字・多すぎる数は切る。道具の時計と大きくずれた時刻は、道具の時計に置き換える', () => {
    const dom = sanitizeReport(
      {
        t: 'dom',
        at: now + 10 * 60_000,
        changes: [
          ...Array.from({ length: 100 }, () => ({ kind: 'added', text: 'a'.repeat(5000) })),
        ],
      },
      now,
    );
    expect(dom).toMatchObject({ t: 'dom', at: now });
    const changes = (dom as { changes: { text: string }[] }).changes;
    expect(changes).toHaveLength(REPORT_LIMITS.changes);
    expect(changes[0]!.text).toHaveLength(REPORT_LIMITS.text);
    expect(sanitizeReport({ t: 'dom', at: 'soon', changes: [{ kind: 'removed' }] }, now)).toEqual({
      t: 'dom',
      at: now,
      changes: [{ kind: 'removed', text: '' }],
    });
  });

  it('文字の変化は、変わる前とあと。部品の場所は、図にある部品の、形の合うものだけ', () => {
    expect(
      sanitizeReport(
        { t: 'dom', at: now, changes: [{ kind: 'text', before: 'a', text: 'b' }] },
        now,
      ),
    ).toEqual({ t: 'dom', at: now, changes: [{ kind: 'text', before: 'a', text: 'b' }] });
    expect(
      sanitizeReport(
        {
          t: 'parts',
          at: now,
          rects: {
            'comment-list': { x: 0, y: 0, w: 10, h: 10 },
            ghost: { x: 0, y: 0, w: 1, h: 1 },
            'delete-button': { x: 0, y: 0, w: -1, h: 1 },
          },
        },
        now,
        known,
      ),
    ).toEqual({ t: 'parts', at: now, rects: { 'comment-list': { x: 0, y: 0, w: 10, h: 10 } } });
  });
});
