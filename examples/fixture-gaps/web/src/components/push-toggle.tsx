'use client';

import { API_DOMAIN } from '@/lib/fetcher/consts';

// fetcher を通さず fetch を直接呼ぶ例（ラッパー検出とは別経路の取りこぼし確認用）
export function PushToggle() {
  const subscribe = async () => {
    await fetch(`${API_DOMAIN}/push/subscriptions`, { method: 'POST' });
  };

  return (
    <button data-component="PushToggle" onClick={subscribe}>
      通知を有効にする
    </button>
  );
}
