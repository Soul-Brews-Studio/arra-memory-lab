#!/usr/bin/env node

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const D1_NAME = "arra-memory-lab";
const KV_NAME = "arra-memory-lab-oauth";
const D1_BINDING = "DB";
const KV_BINDING = "OAUTH_KV";
const BUILT_CONFIG = join("dist", "arra_memory_lab", "wrangler.json");
const PLACEHOLDER_ID = /^(?:0+|placeholder|example|<.*>)$/i;

function usage() {
  console.log(`Usage: node scripts/deploy.mjs [--dry-run]

Deploy the already-built Arra Memory Lab Worker without committing Cloudflare IDs.

Options:
  --dry-run  Resolve and validate resources, then run wrangler deploy --dry-run.
             Remote D1 migrations are not run.
  --help     Show this help text.

Run this command from the labs/arra-memory-lab directory after npm run build.`);
}

function fail(message) {
  throw new Error(message);
}

function parseArgs(args) {
  let dryRun = false;
  for (const arg of args) {
    if (arg === "--help" || arg === "-h") return { help: true, dryRun: false };
    if (arg === "--dry-run") {
      if (dryRun) fail("Duplicate argument: --dry-run");
      dryRun = true;
      continue;
    }
    fail(`Unknown argument: ${arg}`);
  }
  return { help: false, dryRun };
}

function redact(value) {
  return value
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<redacted-id>")
    .replace(/\b[0-9a-f]{32,}\b/gi, "<redacted-id>")
    .replace(/\bBearer\s+\S+/gi, "Bearer <redacted>")
    .replace(/\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{24,}\b/g, "<redacted-token>");
}

function runWrangler(args, { quiet = false } = {}) {
  const result = spawnSync("npx", ["wrangler", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) fail(`Could not start Wrangler: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = redact(`${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim());
    fail(`Wrangler failed (${args[0]}):${detail ? `\n${detail}` : " no diagnostic output"}`);
  }

  if (!quiet) {
    const warnings = redact(result.stderr?.trim() ?? "");
    if (warnings) console.error(warnings);
  }
  return result.stdout ?? "";
}

function parseJson(label, value) {
  try {
    return JSON.parse(value);
  } catch {
    fail(`${label} did not return valid JSON`);
  }
}

function requireUnique(items, label, name, getName) {
  if (!Array.isArray(items)) fail(`${label} response was not an array`);
  const matches = items.filter((item) => getName(item) === name);
  if (matches.length !== 1) {
    fail(`${label} resource ${JSON.stringify(name)} matched ${matches.length} entries; expected exactly one`);
  }
  return matches[0];
}

function requireId(label, value, pattern) {
  if (typeof value !== "string" || PLACEHOLDER_ID.test(value) || !pattern.test(value)) {
    fail(`${label} returned an absent, placeholder, or malformed ID`);
  }
  return value;
}

function resolvePath(configDir, value, label, expectedType) {
  if (typeof value !== "string" || value.length === 0) fail(`Built config is missing ${label}`);
  const path = isAbsolute(value) ? value : resolve(configDir, value);
  if (!existsSync(path)) fail(`${label} does not exist: ${path}`);
  const stats = statSync(path);
  if (expectedType === "file" && !stats.isFile()) fail(`${label} is not a file: ${path}`);
  if (expectedType === "directory" && !stats.isDirectory()) fail(`${label} is not a directory: ${path}`);
  return path;
}

function replaceBinding(entries, binding, field, value, label) {
  if (!Array.isArray(entries)) fail(`Built config is missing ${label}`);
  const matches = entries.filter((entry) => entry?.binding === binding);
  if (matches.length !== 1) fail(`${label} binding ${binding} matched ${matches.length} entries; expected exactly one`);
  matches[0][field] = value;
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  usage();
  process.exit(0);
}

let temporaryDirectory;
try {
  const packagePath = join(process.cwd(), "package.json");
  if (!existsSync(packagePath)) fail("Run this command from the labs/arra-memory-lab directory");
  const packageJson = parseJson("package.json", readFileSync(packagePath, "utf8"));
  if (packageJson.name !== "arra-memory-lab") fail("Run this command from the labs/arra-memory-lab directory");

  const builtConfigPath = join(process.cwd(), BUILT_CONFIG);
  if (!existsSync(builtConfigPath)) fail(`Missing ${BUILT_CONFIG}; run npm run build first`);
  const builtConfig = parseJson(BUILT_CONFIG, readFileSync(builtConfigPath, "utf8"));
  if (builtConfig.name !== D1_NAME) fail(`Built config Worker name must be ${D1_NAME}`);

  console.log("[resolve] locating exact Cloudflare resources");
  const databases = parseJson("wrangler d1 list --json", runWrangler(["d1", "list", "--json"], { quiet: true }));
  const namespaces = parseJson("wrangler kv namespace list", runWrangler(["kv", "namespace", "list"], { quiet: true }));
  const database = requireUnique(databases, "D1", D1_NAME, (item) => item?.name);
  const namespace = requireUnique(namespaces, "KV", KV_NAME, (item) => item?.title);
  const databaseId = requireId("D1", database.uuid, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
  const namespaceId = requireId("KV", namespace.id, /^[0-9a-f]{32}$/i);
  console.log("[resolve] resources validated");

  const configDirectory = dirname(builtConfigPath);
  builtConfig.main = resolvePath(configDirectory, builtConfig.main, "main", "file");
  if (!builtConfig.assets || typeof builtConfig.assets !== "object") fail("Built config is missing assets");
  builtConfig.assets.directory = resolvePath(configDirectory, builtConfig.assets.directory, "assets.directory", "directory");

  replaceBinding(builtConfig.d1_databases, D1_BINDING, "database_id", databaseId, "D1");
  const d1Binding = builtConfig.d1_databases.find((entry) => entry.binding === D1_BINDING);
  if (d1Binding.database_name !== D1_NAME) fail(`D1 binding database_name must be ${D1_NAME}`);
  d1Binding.migrations_dir = resolvePath(configDirectory, d1Binding.migrations_dir, "migrations_dir", "directory");
  replaceBinding(builtConfig.kv_namespaces, KV_BINDING, "id", namespaceId, "KV");

  temporaryDirectory = mkdtempSync(join(tmpdir(), "arra-memory-lab-release-"));
  const temporaryConfig = join(temporaryDirectory, "wrangler.json");
  writeFileSync(temporaryConfig, `${JSON.stringify(builtConfig)}\n`, { mode: 0o600 });
  console.log(`[config] validated immutable build ${basename(builtConfig.main)}`);

  if (options.dryRun) {
    console.log("[migrate] skipped (--dry-run)");
    console.log("[deploy] running Wrangler dry run");
    runWrangler(["deploy", "--dry-run", "--config", temporaryConfig], { quiet: true });
    console.log("[deploy] dry run complete");
  } else {
    console.log("[migrate] applying remote D1 migrations");
    runWrangler(["d1", "migrations", "apply", D1_BINDING, "--remote", "--config", temporaryConfig], { quiet: true });
    console.log("[migrate] complete");
    console.log("[deploy] publishing immutable build");
    runWrangler(["deploy", "--config", temporaryConfig], { quiet: true });
    console.log("[deploy] complete");
  }
} catch (error) {
  console.error(`[release] ${redact(error instanceof Error ? error.message : String(error))}`);
  process.exitCode = 1;
} finally {
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
}
