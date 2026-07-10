"use client";

import { ArrowRight, EnvelopeSimple } from "@phosphor-icons/react";
import Link from "next/link";
import { FormEvent, useState } from "react";

import { authClient } from "@/lib/auth-client";

export function ForgotPasswordForm() {
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const email = String(new FormData(event.currentTarget).get("email") || "").trim();
    const result = await authClient.requestPasswordReset({
      email,
      redirectTo: "/reset-password",
    });
    setPending(false);
    if (result.error) {
      setError(result.error.message || "The reset link could not be requested.");
      return;
    }
    setSent(true);
  }

  if (sent) {
    return (
      <div className="auth-form" role="status">
        <p>
          If that email has an account, a password reset link is on its way. The link works for 30
          minutes.
        </p>
        <p className="auth-switch">
          <Link href="/login">Back to sign in</Link>
        </p>
      </div>
    );
  }

  return (
    <form className="auth-form" onSubmit={handleSubmit} aria-busy={pending}>
      <label className="field">
        <span>Email</span>
        <input name="email" type="email" autoComplete="email" required maxLength={320} />
      </label>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <button className="primary-button" type="submit" disabled={pending}>
        <EnvelopeSimple size={20} weight="bold" />
        <span>{pending ? "Please wait" : "Send reset link"}</span>
        {!pending && <ArrowRight size={18} weight="bold" aria-hidden="true" />}
      </button>

      <p className="auth-switch">
        Remembered it? <Link href="/login">Sign in</Link>
      </p>
    </form>
  );
}
