import { fetcher } from '@/lib/fetcher';
import type { DailyTotals } from './types';

export function getDays(month: string): Promise<DailyTotals> {
  return fetcher<DailyTotals>(`/days?month=${month}`);
}
