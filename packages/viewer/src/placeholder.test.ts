import { describe, expect, it } from 'vitest';
import { KNOWN_NODE_KINDS, validateGraph } from '@stack-atlas/schema';
import { PLACEHOLDER_MESSAGE } from './placeholder';

describe('viewer (Phase 0)', () => {
  it('仮メッセージは日本語', () => {
    expect(PLACEHOLDER_MESSAGE).toMatch(/ビューア/);
  });

  it('@stack-atlas/schema を workspace 依存として読める', () => {
    expect(KNOWN_NODE_KINDS).toContain('component');
    expect(validateGraph({}).ok).toBe(false);
  });
});
