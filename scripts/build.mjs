import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Paseo installs source directories and compiles both entry points itself. Keep
// the npm lockfile: npm pack excludes package-lock.json, but the manifest uses ci.
const root = fileURLToPath(new URL("../", import.meta.url));
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw new Error("Invalid release version");
const name = `paseo-multica-provider-${version}`;
const dist = join(root, "dist");
await mkdir(dist, { recursive: true });
const temporary = await mkdtemp(join(dist, ".build-"));
try {
  const directory = join(temporary, name);
  await mkdir(directory);
  for (const file of ["paseo-plugin.json", "package.json", "package-lock.json", "index.client.tsx", "index.server.ts",
    "client", "server", "shared", "scripts", "tests", "tsconfig.json", "vitest.config.mjs", "README.md", "GLOSSARY.md", "AGENTS.md", "docs"]) {
    await cp(join(root, file), join(directory, file), { recursive: true, dereference: false });
  }
  const archive = `${name}.tar.gz`;
  const result = spawnSync("tar", ["-czf", join(temporary, archive), "-C", temporary, name], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`tar exited with status ${result.status}`);
  const hash = createHash("sha256").update(await readFile(join(temporary, archive))).digest("hex");
  await rm(join(dist, name), { recursive: true, force: true });
  await rename(directory, join(dist, name));
  await rm(join(dist, archive), { force: true });
  await rename(join(temporary, archive), join(dist, archive));
  await writeFile(join(dist, `${archive}.sha256`), `${hash}  ${archive}\n`);
  console.log(`Install directory: dist/${name}`);
  console.log(`Archive: dist/${archive}`);
  console.log(`SHA-256: ${hash}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
