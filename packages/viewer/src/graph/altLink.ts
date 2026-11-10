/**
 * 隣の graph（build の graph.json ↔ graph.v1.json。alternate.ts の alternateGraph の結果）を開く文字のリンク。
 * 3D の地図の題名（ui/topbar.ts）と配線図の帯（wiring/app.ts）の両方で使う。見た目は style.css の `.alt-link`
 */
import { h } from '../ui/dom';

/** リンクの行き先と文言（alternateGraph の href と label） */
export interface AltLink {
  href: string;
  label: string;
}

export interface AltLinkElement {
  el: HTMLAnchorElement;
  /** リンクを出す。null で隠す */
  set(link: AltLink | null): void;
}

/** 隠れた状態のリンクを作る（隣の graph があると分かってから set で出す） */
export function createAltLink(): AltLinkElement {
  const el = h('a', { class: 'alt-link', attrs: { 'data-alt': '' } });
  el.hidden = true;
  return {
    el,
    set(link) {
      el.hidden = !link;
      el.textContent = link?.label ?? '';
      if (link) el.setAttribute('href', link.href);
      else el.removeAttribute('href');
    },
  };
}
