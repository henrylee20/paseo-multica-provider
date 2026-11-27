import { readdir, rm, rmdir } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export async function removePlaceholderTree(scope: string, preserved: readonly string[]) {
  const root = resolve(scope);
  const kept = preserved.map(directory => resolve(directory));
  const inside = (target: string) => { const path = relative(root, resolve(target)); return !!path && !path.startsWith("..") && !isAbsolute(path); };
  const clean = async (directory: string) => {
    if (kept.includes(directory)) return;
    for (const entry of await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; })) {
      const target = resolve(directory, entry.name);
      if (!inside(target)) throw new Error("Unsafe placeholder removal target");
      if (kept.includes(target)) continue;
      if (entry.isDirectory() && kept.some(path => path.startsWith(target + sep))) {
        await clean(target);
      } else await rm(target, { recursive: true, force: true });
    }
    await rmdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error; });
  };
  await clean(root);
}
