import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  encodeKey, decodeKey, refShort, refFull, normalizeKey, resolveActor,
  parseOnceMessage, backoffMs,
} from "../src/once.mjs";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src/once.mjs");

test("encodeKey produces a legal, URL-inert single ref component", () => {
  // Only [A-Za-z0-9_-]; no `%` (would be URL-decoded on read); never starts with `-`/`.`;
  // never contains `..`. Keeps mid-key dashes literal for readability.
  for (const k of ["deploy:abc", "daily-digest:x", "migrate/2026-07", "a b.c", "-lead", "email:welcome#42", "unicodé★"]) {
    const enc = encodeKey(k);
    assert.match(enc, /^[A-Za-z0-9_-]+$/, `bad chars in ${enc}`);
    assert.doesNotMatch(enc, /%/);
    assert.doesNotMatch(enc, /\.\./);
    assert.doesNotMatch(enc, /^[-.]/, `leading -/. in ${enc}`);
  }
  assert.equal(encodeKey("daily-digest:x"), "daily-digest_3Ax"); // dash stays readable, ':' escaped
  assert.equal(encodeKey("-lead"), "_2Dlead");                    // leading special is escaped, not literal
});

test("encode/decode round-trips every key exactly (incl. unicode & separators)", () => {
  for (const k of ["deploy:$(git rev-parse HEAD)", "migrate:2026-07-add-index", "a/b/c", "x y z", "café ☕ 42", "100%_done", ""]) {
    assert.equal(decodeKey(encodeKey(k)), k, `round-trip failed for ${JSON.stringify(k)}`);
  }
});

test("distinct keys never collide after encoding", () => {
  const keys = ["deploy:a", "deploy/a", "deploy a", "deploy%a", "deploy:A"];
  const encoded = keys.map(encodeKey);
  assert.equal(new Set(encoded).size, keys.length);
});

test("refShort / refFull place the encoded key under refs/<ns>/", () => {
  assert.equal(refShort("deploy:v1"), "once/deploy_3Av1");
  assert.equal(refFull("deploy:v1"), "refs/once/deploy_3Av1");
});

test("normalizeKey trims and rejects empty/whitespace", () => {
  assert.equal(normalizeKey("  deploy:x "), "deploy:x");
  assert.equal(normalizeKey(""), null);
  assert.equal(normalizeKey("   "), null);
  assert.equal(normalizeKey(null), null);
  assert.equal(normalizeKey(undefined), null);
});

test("resolveActor is AGENT_ID or 'unknown' (metadata only, always resolves)", () => {
  assert.equal(resolveActor({ AGENT_ID: "codex-7" }), "codex-7");
  assert.equal(resolveActor({ AGENT_ID: "  spaced  " }), "spaced");
  assert.equal(resolveActor({}), "unknown");
  assert.equal(resolveActor({ AGENT_ID: "" }), "unknown");
});

test("parseOnceMessage reads {key,by,at}; junk → all-null", () => {
  assert.deepEqual(parseOnceMessage(JSON.stringify({ v: 1, key: "deploy:x", by: "ci", at: "2026-07-03T00:00:00Z" })),
    { key: "deploy:x", by: "ci", at: "2026-07-03T00:00:00Z" });
  assert.deepEqual(parseOnceMessage("not json"), { key: null, by: null, at: null });
});

test("backoffMs grows and stays within [base/2, base]", () => {
  for (const attempt of [0, 1, 3, 10]) {
    const base = Math.min(1000 * 2 ** attempt, 30_000);
    const lo = backoffMs(attempt, () => 0), hi = backoffMs(attempt, () => 0.999999);
    assert.ok(lo >= base / 2 - 1 && hi <= base + 1, `attempt ${attempt} out of band`);
  }
});

test("CLI --help exits 0 and documents the &&-friendly contract", () => {
  const r = spawnSync(process.execPath, [SRC, "--help"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /&& \.\/deploy\.sh/);
});

test("CLI with no args prints usage and exits 2", () => {
  const r = spawnSync(process.execPath, [SRC], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /gh-once <key>/);
});

test("CLI reserved word without a key is a usage error, not a barrier named 'run'", () => {
  const r = spawnSync(process.execPath, [SRC, "run"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: gh-once run <key>/);
});

test("CLI runs through a symlinked bin (npm/pnpm install shape)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ghonce-"));
  try {
    const link = join(dir, "gh-once");
    symlinkSync(SRC, link);
    const r = spawnSync(process.execPath, [link, "--help"], { encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.match(r.stderr, /gh-once <key>/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
