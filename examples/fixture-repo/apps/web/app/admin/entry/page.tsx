import { revalidatePath } from "next/cache";
import { AuthGuard } from "@/components/AuthGuard";
import { EntryForm } from "@/components/EntryForm";
import { ResultTable } from "@/components/ResultTable";
import { api } from "@/lib/apiClient";

export const dynamic = "force-dynamic";

// CloudFront のキャッシュ破棄（SDK 呼び出しは省略した疑似実装）
async function invalidateCdn(path: string) {
  await fetch(`${process.env.INVALIDATE_ENDPOINT}`, { method: "POST", body: path });
}

export default async function Entry() {
  const latest = await api.getRace("latest");

  async function save(v: Parameters<typeof api.postResult>[0]) {
    "use server";
    await api.postResult(v);
    revalidatePath("/races/" + v.raceId);
    await invalidateCdn("/races/" + v.raceId);
  }

  return (
    <AuthGuard>
      <EntryForm action={save} />
      <ResultTable results={latest.ok ? latest.data.results : []} editable />
    </AuthGuard>
  );
}
