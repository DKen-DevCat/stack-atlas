import type { Race } from "./race";

export type RaceResult = {
  raceId: Race["id"];
  rank: number;
  runner: string;
  time: string;
};
