"use client";

import { ArrowRight, LockKey, UserPlus } from "@phosphor-icons/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

import { authClient } from "@/lib/auth-client";

type AuthFormProps = {
  mode: "login" | "register";
};

export function AuthForm({ mode }: AuthFormProps) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);

    const formData = new FormData(event.currentTarget);
    const email = String(formData.get("email") ?? "").trim();
    const password = String(formData.get("password") ?? "");

    const result =
      mode === "register"
        ? await authClient.signUp.email({
            name: String(formData.get("name") ?? "").trim(),
            email,
            password,
          })
        : await authClient.signIn.email({ email, password });

    if (result.error) {
      setError(result.error.message || "We could not complete that request.");
      setPending(false);
      return;
    }

    router.replace("/library");
    router.refresh();
  }

  const registering = mode === "register";

  return (
    <form className="auth-form" onSubmit={handleSubmit} aria-busy={pending}>
      {registering && (
        <label className="field">
          <span>Name</span>
          <input name="name" autoComplete="name" required maxLength={160} />
        </label>
      )}

      <label className="field">
        <span>Email</span>
        <input name="email" type="email" autoComplete="email" required maxLength={320} />
      </label>

      <label className="field">
        <span>Password</span>
        <input
          name="password"
          type="password"
          autoComplete={registering ? "new-password" : "current-password"}
          required
          minLength={12}
          maxLength={128}
          aria-describedby={registering ? "password-help" : undefined}
        />
        {registering && <small id="password-help">Use at least 12 characters.</small>}
      </label>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <button className="primary-button" type="submit" disabled={pending}>
        {registering ? <UserPlus size={20} weight="bold" /> : <LockKey size={20} weight="bold" />}
        <span>{pending ? "Please wait" : registering ? "Create account" : "Sign in"}</span>
        {!pending && <ArrowRight size={18} weight="bold" aria-hidden="true" />}
      </button>

      <p className="auth-switch">
        {registering ? "Already have an account?" : "New to Chapterline?"}{" "}
        <Link href={registering ? "/login" : "/register"}>
          {registering ? "Sign in" : "Create account"}
        </Link>
        {!registering && (
          <>
            {" · "}
            <Link href="/forgot-password">Forgot password?</Link>
          </>
        )}
      </p>
    </form>
  );
}
