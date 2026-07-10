import { Headphones, MoonStars, WifiSlash } from "@phosphor-icons/react/dist/ssr";
import { ReactNode } from "react";

import { BrandMark } from "@/components/brand-mark";

type AuthShellProps = {
  eyebrow: string;
  title: string;
  summary: string;
  children: ReactNode;
};

const principles = [
  { icon: Headphones, label: "One private library" },
  { icon: WifiSlash, label: "Built for offline listening" },
  { icon: MoonStars, label: "Comfortable day or night" },
];

export function AuthShell({ eyebrow, title, summary, children }: AuthShellProps) {
  return (
    <main className="auth-page">
      <section className="auth-context" aria-labelledby="auth-context-title">
        <BrandMark />
        <div className="auth-context-copy">
          <p className="auth-kicker">Your audiobooks, kept simple</p>
          <h1 id="auth-context-title">Listen where you left off.</h1>
          <p>
            Import the MP3 from Epub Listener, keep your chapters, and take the whole book offline.
          </p>
        </div>
        <ul className="auth-principles" aria-label="Product principles">
          {principles.map(({ icon: Icon, label }) => (
            <li key={label}>
              <Icon size={20} weight="duotone" aria-hidden="true" />
              <span>{label}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="auth-panel" aria-labelledby="auth-title">
        <div className="auth-panel-inner">
          <p className="auth-eyebrow">{eyebrow}</p>
          <h2 id="auth-title">{title}</h2>
          <p className="auth-summary">{summary}</p>
          {children}
        </div>
      </section>
    </main>
  );
}
