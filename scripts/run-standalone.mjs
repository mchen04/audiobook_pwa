import { cpSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import nextEnv from "@next/env";

const root = process.cwd();
const output = path.join(root, ".next/standalone");

nextEnv.loadEnvConfig(root);
mkdirSync(path.join(output, ".next"), { recursive: true });
for (const [source, destination] of [
  [path.join(root, ".next/static"), path.join(output, ".next/static")],
  [path.join(root, "public"), path.join(output, "public")],
]) {
  rmSync(destination, { recursive: true, force: true });
  cpSync(source, destination, { recursive: true });
}

await import(path.join(output, "server.js"));
