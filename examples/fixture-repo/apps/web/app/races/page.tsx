"use client";

import { Pagination } from "@/components/Pagination";
import { RaceCard } from "@/components/RaceCard";
import { useRaces } from "@/hooks/useRaces";

export default function Races() {
  const { data, page, setPage } = useRaces();
  return (
    <main>
      {data?.map((r) => <RaceCard key={r.id} race={r} />)}
      <Pagination page={page} onChange={setPage} />
    </main>
  );
}
