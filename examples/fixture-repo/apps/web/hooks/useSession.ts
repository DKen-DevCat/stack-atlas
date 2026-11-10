"use client";

import { useEffect, useState } from "react";
import type { Session } from "@race/types";

/** Cognito の id_token Cookie をデコードしてセッションを返す */
export function useSession(): {
  user: Session | null;
  signIn(): void;
} {
  const [user, setUser] = useState<Session | null>(null);

  useEffect(() => {
    const token = document.cookie.match(/(?:^|; )id_token=([^;]+)/)?.[1];
    if (!token) return;
    const claims = JSON.parse(atob(token.split(".")[1]!));
    setUser({
      sub: claims.sub,
      name: claims.name ?? claims.email,
      groups: claims["cognito:groups"] ?? [],
    });
  }, []);

  const signIn = () => {
    window.location.href = process.env.NEXT_PUBLIC_COGNITO_LOGIN_URL!;
  };

  return { user, signIn };
}
