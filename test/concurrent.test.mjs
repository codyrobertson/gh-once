// concurrent.test.mjs — REAL contention against a REAL GitHub repo.
// Opt-in: set GH_LIVE_TEST=1, be `gh auth`'d, and point at a repo (GH_REPO=owner/name,
// or run inside a gh repo). Otherwise these skip so the default `npm test` stays hermetic.
// Each run uses a unique throwaway ONCE_NAMESPACE and deletes every ref it created.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src/once.mjs");
const authed = spawnSync("gh", ["auth", "status"], { encoding: "utf8" }).status === 0;
const skip = process.env.GH_LIVE_TEST === "1" && authed
  ? false
  : "set GH_LIVE_TEST=1, gh auth login, and GH_REPO=owner/name to run live concurrency tests";

const NS = `citest-once-${process.pid}-${Date.now().toString(36)}`;
const env = { ...process.env, ONCE_NAMESPACE: NS };

function run(args, extraEnv) {
  return new Promise((res) => {
    const c = spawn(process.execPath, [SRC, ...args], { env: { ...env, ...extraEnv } });
    let out = "", err = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (err += d));
    c.on("close", (code) => res({ code, out: out.trim(), err: err.trim() }));
  });
}

test.after(() => {
  if (skip) return;
  const r = spawnSync("gh", ["api", `repos/{owner}/{repo}/git/matching-refs/${NS}`, "--jq", ".[].ref"], { env, encoding: "utf8" });
  for (const ref of (r.stdout || "").split("\n").filter(Boolean))
    spawnSync("gh", ["api", "--method", "DELETE", `repos/{owner}/{repo}/git/refs/${ref.replace(/^refs\//, "")}`], { env });
});

test("exactly ONE of N concurrent racers wins the same key", { skip }, async () => {
  const N = 8;
  const key = `race:${Date.now().toString(36)}`;
  const results = await Promise.all(Array.from({ length: N }, (_, i) => run([key], { AGENT_ID: `racer-${i}` })));
  const won = results.filter((r) => r.code === 0).length;
  const done = results.filter((r) => r.code === 10).length;
  assert.equal(won, 1, `expected exactly 1 winner, got ${won}: ${JSON.stringify(results.map((r) => r.code))}`);
  assert.equal(won + done, N, `every racer must resolve won|done; codes=${JSON.stringify(results.map((r) => r.code))}`);
});

test("distinct keys raced together all win independently (no false blocking)", { skip }, async () => {
  const N = 6;
  const stamp = Date.now().toString(36);
  const results = await Promise.all(Array.from({ length: N }, (_, i) => run([`distinct:${stamp}:${i}`], { AGENT_ID: `d-${i}` })));
  assert.equal(results.filter((r) => r.code === 0).length, N, `all distinct keys should win; codes=${JSON.stringify(results.map((r) => r.code))}`);
});

test("a re-run of an already-won key never re-wins under concurrency", { skip }, async () => {
  const key = `rerun:${Date.now().toString(36)}`;
  assert.equal((await run([key], { AGENT_ID: "first" })).code, 0); // establish
  const again = await Promise.all(Array.from({ length: 5 }, (_, i) => run([key], { AGENT_ID: `again-${i}` })));
  assert.ok(again.every((r) => r.code === 10), `every re-run must be 'done'; codes=${JSON.stringify(again.map((r) => r.code))}`);
});
