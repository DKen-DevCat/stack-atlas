import { fetcher } from '@/lib/fetcher';
import type { Today, Entry } from './types';

export function getToday(): Promise<Today> {
  return fetcher<Today>('/today');
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
