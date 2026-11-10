import type { CalendarCell } from '@/feature/days/types';

export function CalendarGrid({ cells }: { cells: CalendarCell[] }) {
  return (
    <div data-component="CalendarGrid">
      {cells.map((c) => (
        <span key={c.date}>
          {c.date}: {c.total}
        </span>
      ))}
    </div>
  );
}
