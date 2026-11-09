// 検証の一覧のリンク（D64）の文言。開く・Esc・外のクリックで閉じる・図の上の枠が無いことは e2e（wiring-views.spec.ts）
import { describe, expect, it } from 'vitest';
import type { ValidationIssue } from '@stack-atlas/schema';
import { issuesLabel } from './issuesLink';

const w = (n: number): ValidationIssue[] =>
  Array.from({ length: n }, (_, i) => ({ level: 'warning', path: `/w${i}`, message: 'w' }));
const e = (n: number): ValidationIssue[] =>
  Array.from({ length: n }, (_, i) => ({ level: 'error', path: `/e${i}`, message: 'e' }));

describe('issuesLabel', () => {
  it('警告だけ・エラーだけ・両方。問題が無ければ空（リンクを出さない）', () => {
    expect(issuesLabel(w(2))).toBe('警告 2 件');
    expect(issuesLabel(e(1))).toBe('エラー 1 件');
    expect(issuesLabel([...w(3), ...e(2)])).toBe('エラー 2 件・警告 3 件');
    expect(issuesLabel([])).toBe('');
  });
});
