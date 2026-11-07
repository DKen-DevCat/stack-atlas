import { z } from "zod";

export const EntryInput = z.object({
  raceId: z.string(),
  rank: z.number().int().positive(),
  runner: z.string().min(1),
  time: z.string(),
});
export type EntryInput = z.infer<typeof EntryInput>;
