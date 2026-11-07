import type { Today, TodayView } from './types';

export function toTodayView(today: Today): TodayView {
  return {
    totalLabel: `${today.total.toLocaleString()}円`,
    rows: today.entries,
  };
}
