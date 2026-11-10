import type { TodayView } from '@/feature/spend/types';

// 新しい合計カード（件数も出す）。機能フラグが 1 のときだけ使う
export function TotalCardV2({ view }: { view: TodayView }) {
  return (
    <section data-component="TotalCardV2">
      <h2>今日の合計</h2>
      <p>{view.totalLabel}</p>
      <small>{view.rows.length} 件</small>
    </section>
  );
}
