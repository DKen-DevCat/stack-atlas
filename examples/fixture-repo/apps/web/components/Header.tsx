"use client";

import { useSession } from "@/hooks/useSession";

export function Header() {
  const { user } = useSession();
  return (
    <header data-component="Header" className="site-header">
      <a href="/">Race Results</a>
      <nav>
        <a href="/races">大会一覧</a>
        <a href="/admin/entry">入稿</a>
      </nav>
      <span>{user?.name}</span>
    </header>
  );
}
