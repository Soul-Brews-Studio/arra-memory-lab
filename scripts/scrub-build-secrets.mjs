import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

const buildRoot = new URL("../dist/", import.meta.url);
const removed = [];

function isEnvironmentFile(name) {
  return name === ".env" || name.startsWith(".env.") || name === ".dev.vars" || name.startsWith(".dev.vars.");
}

async function scrub(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return;
    throw error;
  }

  for (const entry of entries) {
    const path = join(directory.pathname, entry.name);
    if (entry.isDirectory()) {
      await scrub(new URL(`${entry.name}/`, directory));
    } else if (entry.isFile() && isEnvironmentFile(entry.name)) {
      await unlink(path);
      removed.push(path);
    }
  }
}

await scrub(buildRoot);
console.log(`Build secret scrub: removed ${removed.length} environment file(s).`);
