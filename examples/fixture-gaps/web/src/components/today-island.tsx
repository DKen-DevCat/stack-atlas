'use client';

import { useEffect, useState } from 'react';
import { getToday } from '@/feature/spend/request';
import { toTodayView } from '@/feature/spend/transformer';
import type { TodayView } from '@/feature/spend/types';
import { TotalCard } from './total-card';
import { TotalCardV2 } from './total-card-v2';
import { EntryList } from './entry-list';
import { WeatherBadge } from './weather-badge';

export function TodayIsland() {
  const [view, setView] = useState<TodayView | null>(null);

  useEffect(() => {
    getToday().then((t) => setView(toTodayView(t)));
  }, []);

  if (!view) return <p data-component="TodayIsland">読み込み中</p>;
  return (
    <div data-component="TodayIsland">
      <WeatherBadge />
      {process.env.NEXT_PUBLIC_FEATURE_NEW_TOTAL === '1' ? (
        <TotalCardV2 view={view} />
      ) : (
        <TotalCard view={view} />
      )}
      <EntryList entries={view.rows} />
    </div>
  );
}
