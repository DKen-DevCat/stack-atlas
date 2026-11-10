"use client";

import { EntryInput } from "@race/types";

export function EntryForm({ action }: { action: (v: EntryInput) => Promise<void> }) {
  const onSubmit = (v: EntryInput) => action(EntryInput.parse(v));
  return (
    <form
      data-component="EntryForm"
      onSubmit={(ev) => {
        ev.preventDefault();
        const f = new FormData(ev.currentTarget);
        void onSubmit({
          raceId: String(f.get("raceId")),
          rank: Number(f.get("rank")),
          runner: String(f.get("runner")),
          time: String(f.get("time")),
        });
      }}
    >
      <input name="raceId" placeholder="大会ID" />
      <input name="rank" type="number" placeholder="順位" />
      <input name="runner" placeholder="選手名" />
      <input name="time" placeholder="タイム" />
      <button type="submit">保存</button>
    </form>
  );
}
