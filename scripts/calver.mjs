#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const packagePath = `${root}/package.json`;
const lockPath = `${root}/package-lock.json`;
const calverPattern = /^\d{2}\.\d{1,2}\.\d{1,2}-alpha\.\d{1,4}$/;
const allowedArgs = new Set(["--apply", "--check", "--help"]);

function bangkokParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23"
  }).formatToParts(now);
  return Object.fromEntries(parts.map(({ type, value }) => [type, value]));
}

export function nextCalver(now = new Date()) {
  const { year, month, day, hour, minute } = bangkokParts(now);
  const hhmm = Number(hour) * 100 + Number(minute);
  return `${year.slice(-2)}.${Number(month)}.${Number(day)}-alpha.${hhmm}`;
}

function calverTuple(version) {
  const match = calverPattern.exec(version);
  if (!match) return null;
  const [date, hhmm] = version.split("-alpha.");
  const [year, month, day] = date.split(".").map(Number);
  return [year, month, day, Number(hhmm)];
}

function compareTuple(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

export function taggedReleaseVersions(output) {
  return output
    .trim()
    .split("\n")
    .filter((tag) => tag.startsWith("arra-memory-lab-v"))
    .map((tag) => tag.replace(/^arra-memory-lab-v/, ""))
    .filter((version) => calverPattern.test(version));
}

function releaseVersions(pkgVersion) {
  let tags = [];
  try {
    tags = taggedReleaseVersions(
      execFileSync("git", ["tag", "--list", "arra-memory-lab-v*"], {
        cwd: root,
        encoding: "utf8"
      })
    );
  } catch {
    // A source archive without .git still validates package metadata.
  }
  return [pkgVersion, ...tags].filter((version) => calverPattern.test(version));
}

export function assertNewer(candidate, versions) {
  const candidateTuple = calverTuple(candidate);
  const blocking = versions.find((version) =>
    compareTuple(candidateTuple, calverTuple(version)) <= 0
  );
  if (blocking) {
    throw new Error(
      `CalVer candidate ${candidate} is not newer than ${blocking}; wait for the next Bangkok minute or fix the clock`
    );
  }
}

function readJson(path) {
  return readFile(path, "utf8").then(JSON.parse);
}

function writeJson(path, value) {
  return writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function verify() {
  const [pkg, lock] = await Promise.all([readJson(packagePath), readJson(lockPath)]);
  const versions = [pkg.version, lock.version, lock.packages?.[""]?.version];
  if (!versions.every((version) => version === pkg.version)) {
    throw new Error(`Version metadata is out of sync: ${versions.join(", ")}`);
  }
  if (!calverPattern.test(pkg.version)) {
    throw new Error(`Version is not Bangkok CalVer: ${pkg.version}`);
  }
  process.stdout.write(`${pkg.version}\n`);
}

async function apply() {
  const version = nextCalver();
  const [pkg, lock] = await Promise.all([readJson(packagePath), readJson(lockPath)]);
  assertNewer(version, releaseVersions(pkg.version));
  pkg.version = version;
  lock.version = version;
  lock.packages[""].version = version;
  await Promise.all([writeJson(packagePath, pkg), writeJson(lockPath, lock)]);
  process.stdout.write(`${version}\n`);
}

export async function main(argv = process.argv.slice(2)) {
  const args = new Set(argv);
  const unknownArgs = [...args].filter((arg) => !allowedArgs.has(arg));
  if (unknownArgs.length) {
    throw new Error(`Unknown argument(s): ${unknownArgs.join(", ")}`);
  }
  if (args.size !== argv.length) {
    throw new Error("Duplicate arguments are not allowed");
  }
  const modes = ["--apply", "--check", "--help"].filter((mode) => args.has(mode));
  if (modes.length > 1) {
    throw new Error(`Choose exactly one mode: ${modes.join(", ")}`);
  }
  if (args.has("--help")) {
    process.stdout.write(`Usage: node scripts/calver.mjs [--check|--apply]\n\n`);
    process.stdout.write(`  --check  verify package and lock metadata already use Bangkok CalVer\n`);
    process.stdout.write(`  --apply  set YY.M.D-alpha.HMM using the Asia/Bangkok clock\n`);
    return;
  }

  if (args.has("--apply")) {
    await apply();
  } else if (args.has("--check")) {
    await verify();
  } else {
    const pkg = await readJson(packagePath);
    const version = nextCalver();
    assertNewer(version, releaseVersions(pkg.version));
    process.stdout.write(`${version}\n`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
