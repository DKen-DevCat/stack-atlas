"use client";

import { useSession } from "@/hooks/useSession";

export default function Login() {
  const { signIn } = useSession();
  return (
    <main>
      <div data-component="useSession">
        <button onClick={signIn}>Cognito でサインイン</button>
      </div>
    </main>
  );
}
