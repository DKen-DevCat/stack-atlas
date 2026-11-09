import type { CalendarCell, DailyTotals } from './types';

export function toCells(days: DailyTotals): CalendarCell[] {
  return Object.entries(days).map(([date, total]) => ({ date, total }));
}
