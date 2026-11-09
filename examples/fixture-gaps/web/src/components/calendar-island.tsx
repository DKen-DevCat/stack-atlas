'use client';

import { useEffect, useState } from 'react';
import { getDays } from '@/feature/days/request';
import { toCells } from '@/feature/days/transformer';
import type { CalendarCell } from '@/feature/days/types';
import { getMonthlyStats, type MonthlyStats } from '@/feature/stats/request';
import { CalendarGrid } from './calendar-grid';

export function CalendarIsland({ month }: { month: string }) {
  const [cells, setCells] = useState<CalendarCell[]>([]);
  const [stats, setStats] = useState<MonthlyStats | null>(null);

  useEffect(() => {
    getDays(month).then((d) => setCells(toCells(d)));
    getMonthlyStats(month).then((s) => setStats(s));
  }, [month]);

  return (
    <div data-component="CalendarIsland">
      {stats && (
        <p>
          {stats.month}: {stats.total.toLocaleString()}円（いちばん多い店: {stats.topMerchant}）
        </p>
      )}
      <CalendarGrid cells={cells} />
    </div>
  );
}
