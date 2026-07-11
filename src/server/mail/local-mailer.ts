import "server-only";

import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export async function capturePasswordReset(email: string, url: string): Promise<void> {
  const directory = path.resolve(".data/mail");
  await mkdir(directory, { recursive: true });
  await removeExpiredCaptures(directory);

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

async function removeExpiredCaptures(directory: string) {
  const cutoff = Date.now() - 60 * 60_000;
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && Number(entry.name.split("-")[0]) < cutoff)
      .map((entry) => rm(path.join(directory, entry.name), { force: true })),
  );
}
