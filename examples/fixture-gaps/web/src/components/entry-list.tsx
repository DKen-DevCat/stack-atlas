import type { Entry } from '@/feature/spend/types';

export function EntryList({ entries }: { entries: Entry[] }) {
  return (
    <ul data-component="EntryList">
      {entries.map((e) => (
        <li key={e.id}>
          {e.merchant} {e.amount}
        </li>
      ))}
    </ul>
  );
}
