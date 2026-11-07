import type { TodayView } from '@/feature/spend/types';

export function TotalCard({ view }: { view: TodayView }) {
  return (
    <section data-component="TotalCard">
      <h2>今日の合計</h2>
      <p>{view.totalLabel}</p>
    </section>
  );
}
