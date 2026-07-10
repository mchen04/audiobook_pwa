import "server-only";

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export async function capturePasswordReset(email: string, url: string): Promise<void> {
  const directory = path.resolve(".data/mail");
  await mkdir(directory, { recursive: true });

  const safeEmail = email.toLowerCase().replaceAll(/[^a-z0-9@._-]/g, "_");
  const payload = JSON.stringify(
    {
      type: "password-reset",
      to: email,
      url,
      createdAt: new Date().toISOString(),
    },
    null,
    2,
  );

  await writeFile(path.join(directory, `${Date.now()}-${safeEmail}.json`), payload, {
    encoding: "utf8",
    mode: 0o600,
  });
}
