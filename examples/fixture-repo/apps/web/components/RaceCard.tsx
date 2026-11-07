import type { Race } from "@race/types";

export function RaceCard({ race }: { race: Race }) {
  return (
    <a data-component="RaceCard" className="race-card" href={"/races/" + race.id}>
      {race.name} / {race.date}
    </a>
  );
}
