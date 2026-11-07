import { describe, expect, it } from 'vitest';
import { LocalMemoStore, memoKey, storageScope } from './memos';

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
