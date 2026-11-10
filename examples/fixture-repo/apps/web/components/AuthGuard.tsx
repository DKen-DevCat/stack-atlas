"use client";

import type { ReactNode } from "react";
import { useSession } from "@/hooks/useSession";

export function AuthGuard({ children }: { children: ReactNode }) {
  const { user } = useSession();
  if (!user) {
    if (typeof window !== "undefined") window.location.replace("/login");
    return null;
  }
  return (
    <>
      <div data-component="AuthGuard" className="auth-bar">
        管理者としてログイン中: {user.name}
      </div>
      {children}
    </>
  );
}
