import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createMemoryLogger } from '../logger.js';
import { loadMemos, memosFile, orphanMemos, saveMemos } from '../memos.js';
import { FIXTURE, tmpRepo } from './helpers.js';

describe('memos', () => {
  it('フィクスチャの memos.json を読む', () => {
    const memos = loadMemos({ root: FIXTURE, log: createMemoryLogger() });
    expect(Object.keys(memos)).toEqual(['infra:next', 'type:RaceResult']);
  });

  it('無ければ {}、壊れていれば警告して {}、文字列以外は捨てる', () => {
    const log = createMemoryLogger();
    expect(loadMemos({ root: tmpRepo(), log })).toEqual({});
    expect(loadMemos({ root: tmpRepo({ '.stack-atlas/memos.json': '{oops' }), log })).toEqual({});
    expect(
      loadMemos({ root: tmpRepo({ '.stack-atlas/memos.json': '{"a":"x","b":1}' }), log }),
    ).toEqual({ a: 'x' });
    expect(log.of('warn')).toHaveLength(2);
  });

  it('saveMemos はキー順で書き、空のメモを落とす', () => {
    const root = tmpRepo();
    saveMemos(root, { z: 'last', a: 'first', e: '  ' });
    expect(readFileSync(memosFile(root), 'utf8')).toBe('{\n  "a": "first",\n  "z": "last"\n}\n');
  });

  it('orphanMemos は graph に無い ID', () => {
    expect(
      orphanMemos({ a: '1', b: '2' }, { nodes: [{ id: 'a', layer: 'l', kind: 'lib', name: 'a' }] }),
    ).toEqual(['b']);
  });
});
