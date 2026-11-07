"use client";

import { RaceCard } from "@/components/RaceCard";
import { useRaces } from "@/hooks/useRaces";

// 静的シェル + クライアントで SWR
// （注: 実際の Next は "use client" ページでの segment config を許さないが、
//  サンプルの構成を再現するためフィクスチャではそのまま置いている）
export const revalidate = 30;

export default function Home() {
  const { data: races } = useRaces({ limit: 6 });
  return <main className="grid">{races?.map((r) => <RaceCard key={r.id} race={r} />)}</main>;
}
