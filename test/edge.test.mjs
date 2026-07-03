// edge.test.mjs — deep edge coverage for the pure core + the gh-offline (degraded) path.
// All hermetic: the pure tests touch no I/O; the degraded block shims `gh` with a stub that
// always fails, so it exercises fail-closed behavior WITHOUT a network or a real repo.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import {
  encodeKey, decodeKey, normalizeKey, resolveActor, parseOnceMessage, backoffMs,
} from "../src/once.mjs";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src/once.mjs");

// ---- encode/decode: reversible for anything a human or agent would pass as a key ----

test("encodeKey/decodeKey round-trips arbitrary keys (unicode, paths, emoji, control)", () => {
  const keys = [
    "simple",
    "feature/x:y",                 // slash + colon (both must escape to survive a URL path)
    "-leading-dash",               // must NOT produce a ref starting with '-'
    ".hidden",                     // git forbids a ref component starting with '.'
    "..",                          // git forbids '..'
    "with space",
    "café/naïve",                  // latin-1 diacritics (multi-byte utf8)
    "日本語",                       // CJK
    "🚀-deploy",                    // emoji (4-byte)
    "a\tb\nc",                     // control chars
    "MixedCASE-123",
    "trailing-",
    "under_score",                 // literal underscore must survive the escape scheme
    "%2F-literal-percent",         // a literal '%' must not be confused with encoding
  ];
  for (const k of keys) assert.equal(decodeKey(encodeKey(k)), k, `round-trip failed for ${JSON.stringify(k)}`);
});

test("encodeKey output is a legal, URL-inert single ref component", () => {
  const keys = ["feature/x", "-x", ".x", "a b", "café", "🚀", "a..b", "a%b", "a?b#c"];
  for (const k of keys) {
    const e = encodeKey(k);
    assert.match(e, /^[A-Za-z0-9_][A-Za-z0-9_-]*$/, `${JSON.stringify(k)} → ${e} has illegal chars or a leading dash`);
    assert.ok(!e.includes("/"), "no slash");
    assert.ok(!e.includes("%"), "no percent (percent breaks the read path)");
    assert.ok(!e.includes(".."), "no ..");
    assert.ok(!e.startsWith("-") && !e.startsWith("."), "never leading - or .");
  }
});

test("encodeKey matches the sibling packages' scheme (feature/x → feature_2Fx)", () => {
  assert.equal(encodeKey("feature/x"), "feature_2Fx");
});

test("decodeKey is robust to malformed _XX escapes (treats them literally)", () => {
  assert.equal(decodeKey("_2"), "_2");        // truncated escape → literal
  assert.equal(decodeKey("_ZZ"), "_ZZ");      // non-hex → literal
  assert.equal(decodeKey("trailing_"), "trailing_");
  assert.equal(decodeKey("plain"), "plain");
  assert.equal(decodeKey("_2Fx"), "/x");      // valid escape still decodes
  assert.equal(decodeKey("_2f"), "/");        // lowercase hex accepted on decode
});

// ---- normalizeKey / resolveActor / parseOnceMessage ----

test("normalizeKey: trims, rejects empty/whitespace, coerces", () => {
  assert.equal(normalizeKey("  x  "), "x");
  assert.equal(normalizeKey("   "), null);
  assert.equal(normalizeKey(""), null);
  assert.equal(normalizeKey(null), null);
  assert.equal(normalizeKey(undefined), null);
  assert.equal(normalizeKey(0), "0");         // a real key value, not "empty"
});

test("resolveActor: AGENT_ID or 'unknown' (never throws, audit-only)", () => {
  assert.equal(resolveActor({ AGENT_ID: "codex-7" }), "codex-7");
  assert.equal(resolveActor({ AGENT_ID: "  spaced  " }), "spaced");
  assert.equal(resolveActor({ AGENT_ID: "" }), "unknown");
  assert.equal(resolveActor({}), "unknown");
});

test("parseOnceMessage tolerates junk and partial records", () => {
  assert.deepEqual(parseOnceMessage(JSON.stringify({ key: "k", by: "me", at: "t" })), { key: "k", by: "me", at: "t" });
  assert.deepEqual(parseOnceMessage("not json"), { key: null, by: null, at: null });
  assert.deepEqual(parseOnceMessage("{}"), { key: null, by: null, at: null });
  assert.deepEqual(parseOnceMessage(""), { key: null, by: null, at: null });
  assert.equal(parseOnceMessage(JSON.stringify({ key: "only" })).by, null);
});

// ---- backoff: bounded, jittered, capped ----

test("backoffMs: floor/ceiling per attempt and a hard 30s cap", () => {
  for (const a of [0, 1, 2, 5]) {
    const base = Math.min(1000 * 2 ** a, 30_000);
    assert.ok(backoffMs(a, () => 0) >= base / 2 - 1, `attempt ${a} floor`);
    assert.ok(backoffMs(a, () => 0.999) <= base + 1, `attempt ${a} ceiling`);
  }
  assert.ok(backoffMs(50, () => 0.999) <= 30_001, "never exceeds the 30s cap even for huge attempts");
});

// ---- degraded gh: `run` fails CLOSED (this is the exactly-once safety property) ----

function withBrokenGh(fn) {
  const dir = mkdtempSync(join(tmpdir(), "once-nogh-"));
  try {
    const shim = join(dir, "gh");
    writeFileSync(shim, "#!/bin/sh\nexit 1\n");     // every gh call fails → simulates offline/unauthed
    chmodSync(shim, 0o755);
    const env = { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}`, AGENT_ID: "edge" };
    fn(env);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("CLI `run` with gh offline exits 1 (fail-closed: can't prove it hasn't run)", () => {
  withBrokenGh((env) => {
    const r = spawnSync(process.execPath, [SRC, "run", "edge-degraded-key"], { env, encoding: "utf8" });
    assert.equal(r.status, 1, "must NOT proceed when it cannot reach the barrier");
    assert.match(r.stderr, /NOT proceeding/);
  });
});

test("CLI `run --degraded-ok` with gh offline exits 0 (opt-in at-least-once)", () => {
  withBrokenGh((env) => {
    const r = spawnSync(process.execPath, [SRC, "run", "edge-degraded-key", "--degraded-ok"], { env, encoding: "utf8" });
    assert.equal(r.status, 0, "--degraded-ok flips to proceed-anyway");
    assert.equal(r.stdout.trim(), "degraded");
  });
});

test("CLI `check` with gh offline exits 1 (can't read the barrier)", () => {
  withBrokenGh((env) => {
    const r = spawnSync(process.execPath, [SRC, "check", "edge-degraded-key"], { env, encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /can't check/);
  });
});
