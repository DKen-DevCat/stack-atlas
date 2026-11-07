/** Phase 0 の仮画面。Phase 1 でプロトタイプの描画に置き換える */
export const PLACEHOLDER_MESSAGE = 'ビューアは準備中です（Phase 1 でプロトタイプを移植します）。';

export function renderPlaceholder(root: HTMLElement): void {
  const h1 = document.createElement('h1');
  h1.textContent = 'Stack Atlas';
  const p = document.createElement('p');
  p.textContent = PLACEHOLDER_MESSAGE;
  root.replaceChildren(h1, p);
}
