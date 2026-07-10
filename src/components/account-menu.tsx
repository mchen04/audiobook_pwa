"use client";

import { GearSix, SignOut } from "@phosphor-icons/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { authClient } from "@/lib/auth-client";

type AccountMenuProps = {
  email: string;
};

export function AccountMenu({ email }: AccountMenuProps) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function signOut() {
    setPending(true);
    await authClient.signOut();
    localStorage.removeItem("chapterline:active-user");
    router.replace("/login");
    router.refresh();
  }

  return (
    <div className="account-menu">
      <span title={email}>{email}</span>
      <Link href="/settings" className="icon-text-button">
        <GearSix size={19} aria-hidden="true" />
        <span>Settings</span>
      </Link>
      <button type="button" className="icon-text-button" onClick={signOut} disabled={pending}>
        <SignOut size={19} aria-hidden="true" />
        <span>{pending ? "Signing out" : "Sign out"}</span>
      </button>
    </div>
  );
}
