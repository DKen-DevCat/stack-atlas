import { fetcher } from '@/lib/fetcher';
import type { Today, Entry } from './types';

// date（YYYY-MM-DD）は任意。空ならサーバーが今日の分を返す
export function getToday(date?: string): Promise<Today> {
  return fetcher<Today>(`/today?date=${date ?? ''}`);
}

export function getEntries(): Promise<Entry[]> {
  return fetcher<Entry[]>('/entries');
}

export function createTransaction(body: Entry): Promise<void> {
  return fetcher<void>('/transactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
