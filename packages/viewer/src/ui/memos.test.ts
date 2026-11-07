import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadSharedMemos,
  LocalMemoStore,
  memoKey,
  mergeMemos,
  orphanIds,
  parseMemos,
  serializeMemos,
  SharedMemoStore,
  storageScope,
} from './memos';

function fakeStorage() {
  const m = new Map<string, string>();
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

describe('LocalMemoStore', () => {
  it('graph ごとのキーに保存し、空なら削除する', () => {
    const st = fakeStorage();
    const scope = storageScope('race-results', 'http://x/g.json');
    const a = new LocalMemoStore(scope, st);
    a.set('infra:lambdaNext', 'コールドスタート要観察');
    a.set('type:Race', 'x');
    a.set('type:Race', '  ');
    expect(JSON.parse(st.m.get(memoKey('race-results'))!)).toEqual({
      'infra:lambdaNext': 'コールドスタート要観察',
    });
    const b = new LocalMemoStore(scope, st);
    expect(b.get('infra:lambdaNext')).toBe('コールドスタート要観察');
    expect(b.get('type:Race')).toBe('');
    expect(new LocalMemoStore('other', st).all()).toEqual({});
  });

  it('project.name がなければ出どころ（URL）をキーにする', () => {
    expect(storageScope(undefined, 'http://x/g.json')).toBe('http://x/g.json');
    expect(storageScope('  ', 'g.json')).toBe('g.json');
  });

  it('壊れたデータやストレージなしでも落ちない', () => {
    const st = fakeStorage();
    st.m.set(memoKey('s'), '{oops');
    expect(new LocalMemoStore('s', st).all()).toEqual({});
    const n = new LocalMemoStore('s', null);
    n.set('a', 'b');
    expect(n.get('a')).toBe('b');
  });
});

describe('共有メモのマージ', () => {
  it('parseMemos は文字列だけを残し、形が違えば null', () => {
    expect(parseMemos({ a: 'x', b: 1, c: '  ' })).toEqual({ a: 'x' });
    expect(parseMemos([])).toBeNull();
    expect(parseMemos('x')).toBeNull();
    expect(parseMemos(null)).toBeNull();
  });

  it('mergeMemos: 共有が土台、ローカルの上書きと削除が勝つ', () => {
    expect(mergeMemos({ a: 'A', b: 'B', c: 'C' }, { b: 'B2', d: 'D' }, new Set(['c']))).toEqual({
      a: 'A',
      b: 'B2',
      d: 'D',
    });
  });

  it('serializeMemos はキー順に並べる', () => {
    expect(serializeMemos({ b: '2', a: '1' })).toBe('{\n  "a": "1",\n  "b": "2"\n}\n');
  });

  it('orphanIds は graph に無い ID を昇順で返す', () => {
    expect(orphanIds({ z: '1', a: '2', keep: '3' }, new Set(['keep']))).toEqual(['a', 'z']);
  });
});

describe('SharedMemoStore', () => {
  it('共有メモを読み、ローカル編集で「未保存」になり、共有と同じに戻すと消える', () => {
    const st = fakeStorage();
    const s = new SharedMemoStore('p', { a: 'A', b: 'B' }, st);
    expect(s.get('a')).toBe('A');
    expect(s.status('a')).toBe('shared');
    expect(s.status('x')).toBe('none');
    expect(s.unsavedIds()).toEqual([]);

    s.set('a', 'A2');
    expect(s.get('a')).toBe('A2');
    expect(s.status('a')).toBe('local');
    s.set('a', 'A');
    expect(s.status('a')).toBe('shared');

    s.set('c', 'C');
    s.set('b', '');
    expect(s.get('b')).toBe('');
    expect(s.status('b')).toBe('local');
    expect(s.unsavedIds()).toEqual(['b', 'c']);
    expect(s.all()).toEqual({ a: 'A', c: 'C' });

    // 再読み込みしても上書き・削除は残る（従来の localStorage キーと互換）
    expect(JSON.parse(st.m.get(memoKey('p'))!)).toEqual({ c: 'C' });
    const s2 = new SharedMemoStore('p', { a: 'A', b: 'B' }, st);
    expect(s2.all()).toEqual({ a: 'A', c: 'C' });
    expect(s2.unsavedIds()).toEqual(['b', 'c']);
  });

  it('共有メモが空のとき（ファイルをドロップして開いた・memos.json を読めなかった）は削除の印を消さない', () => {
    // 以前は構築時の prune で消していたので、serve で削除 → ドロップで開く → serve で開く、で削除したメモが戻っていた
    const st = fakeStorage();
    const s = new SharedMemoStore('p', { a: 'A', b: 'B' }, st);
    s.set('b', '');
    expect(s.unsavedIds()).toEqual(['b']);

    const dropped = new SharedMemoStore('p', {}, st);
    expect(dropped.all()).toEqual({});
    expect(dropped.unsavedIds()).toEqual([]); // 共有を知らないので「未保存」には出さない
    expect(JSON.parse(st.m.get('stack-atlas-memos-deleted:p')!)).toEqual(['b']);

    const again = new SharedMemoStore('p', { a: 'A', b: 'B' }, st);
    expect(again.all()).toEqual({ a: 'A' });
    expect(again.unsavedIds()).toEqual(['b']);

    // 共有メモを実際に読めて、そこに無ければ印は消える
    const gone = new SharedMemoStore('p', { a: 'A' }, st);
    expect(gone.unsavedIds()).toEqual([]);
    expect(st.m.has('stack-atlas-memos-deleted:p')).toBe(false);
  });

  it('従来の LocalMemoStore のメモはローカルの上書きとして読める', () => {
    const st = fakeStorage();
    new LocalMemoStore('p', st).set('a', 'old');
    const s = new SharedMemoStore('p', { a: 'shared', b: 'B' }, st);
    expect(s.get('a')).toBe('old');
    expect(s.status('a')).toBe('local');
    expect(s.status('b')).toBe('shared');
  });

  it('setShared（サーバー保存の成功）で未保存の印が消える', () => {
    const st = fakeStorage();
    const s = new SharedMemoStore('p', { a: 'A', b: 'B' }, st);
    s.set('a', 'A2');
    s.set('b', '');
    s.set('c', 'C');
    s.setShared(s.all());
    expect(s.unsavedIds()).toEqual([]);
    expect(s.all()).toEqual({ a: 'A2', c: 'C' });
    expect(s.status('a')).toBe('shared');
    expect(st.m.get(memoKey('p'))).toBe('{}');
    expect(st.m.has('stack-atlas-memos-deleted:p')).toBe(false);
  });

  it('孤立メモの移し替えと削除', () => {
    const st = fakeStorage();
    const ids = new Set(['comp:New', 'type:Race']);
    const s = new SharedMemoStore(
      'p',
      { 'comp:Old': '旧メモ', 'type:Race': '既存', gone: 'x' },
      st,
    );
    expect(orphanIds(s.all(), ids)).toEqual(['comp:Old', 'gone']);

    s.move('comp:Old', 'comp:New');
    expect(s.get('comp:New')).toBe('旧メモ');
    expect(s.get('comp:Old')).toBe('');
    // 移し先に既にあれば続ける
    s.move('comp:New', 'type:Race');
    expect(s.get('type:Race')).toBe('既存\n旧メモ');
    s.set('gone', '');
    expect(orphanIds(s.all(), ids)).toEqual([]);
    expect(s.unsavedIds()).toEqual(['comp:Old', 'gone', 'type:Race']);
  });
});

describe('loadSharedMemos', () => {
  const okJson = (v: unknown) =>
    new Response(JSON.stringify(v), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  afterEach(() => vi.unstubAllGlobals());

  it('API（serve）が読めたら API だけを正とし、隣の memos.json とは混ぜない', async () => {
    // 以前は { ...memos.json, ...api } だったので、古い build の memos.json に残ったメモが
    // リポジトリから消したあとも表示され、次の「サーバーに保存」で書き戻されていた
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/api/memos') ? okJson({ a: 'api' }) : okJson({ a: 'file', stale: '古い' }),
      ),
    );
    const r = await loadSharedMemos('http://localhost:4173/graph.json', 'http://localhost:4173/');
    expect(r).toEqual({
      memos: { a: 'api' },
      api: true,
      apiUrl: 'http://localhost:4173/api/memos',
    });
  });

  it('API が無ければ memos.json を使う。別オリジンの graph では API を見ない', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        return url.endsWith('memos.json')
          ? okJson({ a: 'file' })
          : new Response('', { status: 404 });
      }),
    );
    expect(
      await loadSharedMemos('http://localhost:4173/graph.json', 'http://localhost:4173/'),
    ).toEqual({ memos: { a: 'file' }, api: false });
    calls.length = 0;
    expect(
      await loadSharedMemos('https://cdn.example/out/graph.json', 'http://localhost:4173/'),
    ).toEqual({ memos: { a: 'file' }, api: false });
    expect(calls).toEqual(['https://cdn.example/out/memos.json']);
  });
});
