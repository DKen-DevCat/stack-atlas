import { fetcher } from '@/lib/fetcher';

export type MonthlyStats = {
  month: string;
  total: number;
  topMerchant: string;
};

// 月の集計は旧システムの API（Go に移す前のもの）が返す
export function getMonthlyStats(month: string): Promise<MonthlyStats> {
  return fetcher<MonthlyStats>(`/stats?month=${month}`);
}
