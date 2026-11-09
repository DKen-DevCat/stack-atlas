'use client';

import { useEffect, useState } from 'react';
import { getWeather, type Weather } from '@/feature/weather/request';

export function WeatherBadge() {
  const [weather, setWeather] = useState<Weather | null>(null);

  useEffect(() => {
    getWeather().then((w) => setWeather(w));
  }, []);

  return (
    <span data-component="WeatherBadge">
      {weather ? `${weather.condition} ${weather.temperature}℃` : '…'}
    </span>
  );
}
