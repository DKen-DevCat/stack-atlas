'use client';

import { useEffect, useState } from 'react';
import { getDays } from '@/feature/days/request';
import { toCells } from '@/feature/days/transformer';
import type { CalendarCell } from '@/feature/days/types';
import { CalendarGrid } from './calendar-grid';

export function CalendarIsland({ month }: { month: string }) {
  const [cells, setCells] = useState<CalendarCell[]>([]);

  useEffect(() => {
    getDays(month).then((d) => setCells(toCells(d)));
  }, [month]);

  return (
    <div data-component="CalendarIsland">
      <CalendarGrid cells={cells} />
    </div>
  );
}
