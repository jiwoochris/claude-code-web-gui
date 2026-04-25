"use client";

import { FormEvent, Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") ?? "/";

  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
        credentials: "include",
      });

      if (res.status === 429) {
        setError("너무 많은 시도. 15분 후 다시 시도하세요.");
        setPassword("");
        return;
      }
      if (!res.ok) {
        setError("비밀번호가 올바르지 않습니다.");
        setPassword("");
        return;
      }

      router.replace(next);
      router.refresh();
    } catch {
      setError("로그인 요청에 실패했습니다. 네트워크를 확인하세요.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-shell">
      <form className="login-card" onSubmit={onSubmit} noValidate>
        <h1>Claude Code Web GUI</h1>
        <div className="divider" />
        <label htmlFor="password">비밀번호</label>
        <input
          id="password"
          type="password"
          autoFocus
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-invalid={error !== null}
          aria-describedby="login-error"
          disabled={submitting}
        />
        <button
          type="submit"
          className="submit"
          disabled={submitting || password.length === 0}
          aria-busy={submitting}
        >
          {submitting ? "확인 중…" : "로그인"}
        </button>
        <div id="login-error" className="error" role="alert">
          {error ? `⚠ ${error}` : ""}
        </div>
      </form>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="login-shell" />}>
      <LoginForm />
    </Suspense>
  );
}
