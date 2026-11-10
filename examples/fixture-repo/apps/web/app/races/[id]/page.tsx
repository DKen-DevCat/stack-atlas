import { notFound } from "next/navigation";
import { ResultTable } from "@/components/ResultTable";
import { api } from "@/lib/apiClient";

export const revalidate = 60; // ISR

// ビルド時には何も生成せず、初回アクセスで生成する
export async function generateStaticParams() {
  return [];
}

export default async function RacePage({ params }: { params: { id: string } }) {
  const res = await api.getRace(params.id);
  if (!res.ok) notFound();
  return (
    <main>
      <ResultTable results={res.data.results} />
    </main>
  );
}
