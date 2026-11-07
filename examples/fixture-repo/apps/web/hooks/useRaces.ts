"use client";

import { useState } from "react";
import useSWR from "swr";
import type { Race } from "@race/types";
import { api } from "@/lib/apiClient";

export function useRaces(q?: { limit?: number }) {
  const [page, setPage] = useState(1);
  const swr = useSWR<Race[]>(
    ["races", q, page],
    async () => {
      const res = await api.getRaces({ ...q, page });
      if (!res.ok) throw new Error(res.error);
      return res.data;
    },
    {
      dedupingInterval: 2000,
      revalidateOnFocus: true,
    },
  );
  return { ...swr, page, setPage };
}
