// 隣の graph を開く文字のリンク（3D の地図の題名と配線図の帯で共通の部品）。テストは node 環境なので、
// h() が使う document.createElement だけを小さな偽物にする
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAltLink } from './altLink';

class FakeElement {
  className = '';
  hidden = false;
  textContent = '';
  readonly attrs = new Map<string, string>();
  constructor(readonly tagName: string) {}
  setAttribute(k: string, v: string) {
    this.attrs.set(k, v);
  }
  removeAttribute(k: string) {
    this.attrs.delete(k);
  }
  getAttribute(k: string) {
    return this.attrs.get(k) ?? null;
  }
  append() {}
}

beforeEach(() => {
  vi.stubGlobal('document', { createElement: (tag: string) => new FakeElement(tag) });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createAltLink', () => {
  it('最初は隠れたリンク（class alt-link、data-alt）。set で文言と href を出し、null で隠して href を外す', () => {
    const link = createAltLink();
    const el = link.el as unknown as FakeElement;
    expect(el.tagName).toBe('a');
    expect(el.className).toBe('alt-link');
    expect(el.getAttribute('data-alt')).toBe('');
    expect(el.hidden).toBe(true);

    link.set({ href: 'index.html?graph=graph.v1.json', label: '3D の地図' });
    expect(el.hidden).toBe(false);
    expect(el.textContent).toBe('3D の地図');
    expect(el.getAttribute('href')).toBe('index.html?graph=graph.v1.json');

    link.set(null);
    expect(el.hidden).toBe(true);
    expect(el.textContent).toBe('');
    expect(el.getAttribute('href')).toBeNull();
  });
});
