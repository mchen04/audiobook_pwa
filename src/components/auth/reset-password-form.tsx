"use client";

import { ArrowRight, LockKey } from "@phosphor-icons/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useState } from "react";

import { authClient } from "@/lib/auth-client";

export function ResetPasswordForm() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordFormInner />
    </Suspense>
  );
}

function ResetPasswordFormInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const invalidLink = !token || !!searchParams.get("error");
  if (invalidLink) {
    return (
      <div className="auth-form">
        <p className="form-error" role="alert">
          This reset link is invalid or has expired. Request a new one to continue.
        </p>
        <p className="auth-switch">
          <Link href="/forgot-password">Request a new link</Link>
        </p>
      </div>
    );
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    setError(null);
    setPending(true);
    const newPassword = String(new FormData(event.currentTarget).get("password") || "");
    const result = await authClient.resetPassword({ newPassword, token });
    setPending(false);
    if (result.error) {
      setError(result.error.message || "The password could not be reset.");
      return;
    }
    router.replace("/login");
  }

  return (
    <form className="auth-form" onSubmit={handleSubmit} aria-busy={pending}>
      <label className="field">
        <span>New password</span>
        <input
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
          maxLength={128}
          aria-describedby="password-help"
        />
        <small id="password-help">Use at least 12 characters.</small>
      </label>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <button className="primary-button" type="submit" disabled={pending}>
        <LockKey size={20} weight="bold" />
        <span>{pending ? "Please wait" : "Set new password"}</span>
        {!pending && <ArrowRight size={18} weight="bold" aria-hidden="true" />}
      </button>
    </form>
  );
}
