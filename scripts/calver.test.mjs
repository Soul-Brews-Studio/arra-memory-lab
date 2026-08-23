import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assertNewer, nextCalver, taggedReleaseVersions } from "./calver.mjs";

const script = fileURLToPath(new URL("./calver.mjs", import.meta.url));

test("formats Bangkok HMM without a leading zero", () => {
  assert.equal(nextCalver(new Date("2026-08-23T02:07:00Z")), "26.8.23-alpha.907");
});

test("uses the Bangkok calendar across UTC day rollover", () => {
  assert.equal(nextCalver(new Date("2026-08-22T17:07:00Z")), "26.8.23-alpha.7");
});

test("rejects a same-minute release and a clock rollback", () => {
  assert.throws(() => assertNewer("26.8.23-alpha.1316", ["26.8.23-alpha.1316"]));
  assert.throws(() => assertNewer("26.8.23-alpha.1315", ["26.8.23-alpha.1316"]));
  assert.doesNotThrow(() => assertNewer("26.8.23-alpha.1317", ["26.8.23-alpha.1316"]));
});

test("walks only lab CalVer tags", () => {
  assert.deepEqual(
    taggedReleaseVersions([
      "v99.1.1",
      "arra-memory-lab-v26.8.23-alpha.1200",
      "arra-memory-lab-vlegacy",
      "arra-memory-lab-v26.8.23-alpha.1310"
    ].join("\n")),
    ["26.8.23-alpha.1200", "26.8.23-alpha.1310"]
  );
});

test("fails closed on unknown, removed-channel, conflicting, and duplicate flags", () => {
  for (const args of [
    ["--unknown"],
    ["--beta"],
    ["--check", "--apply"],
    ["--check", "--check"]
  ]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
    assert.notEqual(result.status, 0, args.join(" "));
  }
});
