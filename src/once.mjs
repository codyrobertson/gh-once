#!/usr/bin/env node
// gh-once — an exactly-once barrier, GitHub-native, with no database.
//
// The barrier IS a git ref: `refs/once/<key>`. Creating a ref is atomic on GitHub's
// backend, so the FIRST caller to `gh-once <key>` gets HTTP 201 ("won" — do the work)
// and every caller after gets 422 "already exists" ("done" — skip). That one fact is
// the whole primitive: a durable, distributed "has this happened yet?" flag that many
// machines/agents/CI jobs can race on safely, with nothing to run and nothing to host.
//
// It's the sibling of gh-issue-lease, but PERMANENT: a lease has a TTL and can be
// stolen; a once-barrier never expires and is never stolen. It's the right tool when
// an operation must happen AT MOST ONCE for a given key — deploy a commit, run a
// migration, fire a cron side-effect, send a "welcome" email — no matter how many
// workers try. The key is yours to choose and is what makes it idempotent:
//   gh-once deploy:$(git rev-parse HEAD)   && ./deploy.sh
//   gh-once migrate:2026-07-add-index      && ./run-migration.sh
//
// EXIT CODES make `&&` do the right thing (won == 0 == "run the guarded command"):
//   run <key>    0 won (first — DO IT) · 10 done (already — skip) · 1 gh offline (see below)
//   check <key>  0 done · 10 pending · 1 gh offline    (read-only; never marks)
//   reset <key>  delete the barrier so a FAILED op can retry (0 ok)
//   list         every recorded key with who/when
//
// FAIL-CLOSED BY DEFAULT. If gh can't be reached we CANNOT prove the op hasn't already
// run, so `run` exits 1 and your `&& command` is skipped — because for exactly-once,
// skipping a maybe-duplicate beats risking a double-deploy/double-charge. Pass
// `--degraded-ok` to flip to at-least-once (run anyway when gh is down).
//
// Identity is metadata only (unlike the lease, it's not needed for correctness): the
// record stores AGENT_ID if set, else "unknown". Env: ONCE_NAMESPACE (default "once"),
// GH_ONCE_MAX_RETRY (default 5).

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

const NAMESPACE = (process.env.ONCE_NAMESPACE || "once").replace(/^\/+|\/+$/g, "");
const MAX_RETRY = Number(process.env.GH_ONCE_MAX_RETRY) || 5;

// ---------- pure, unit-tested helpers ----------

// A caller's key can be anything ("deploy:v1.2", "migrate/2026-07"), but the encoded
// form has to survive TWO layers untouched: a git ref name (no `:` `~` `^` `?` `*` `[`
// `\` spaces or `..`) AND a URL path (reads GET `git/ref/<this>`, so `%XX` would get
// decoded by the server and miss). So we escape with `_XX`, keeping only characters
// that BOTH layers leave inert as literals: [A-Za-z0-9-] (plus `_` as the escape lead).
// Position 0 additionally forbids a leading `-` (ref-name caution), so byte 0 keeps
// only [A-Za-z0-9]. Output alphabet is [A-Za-z0-9_-]: no `%`, no `.`, no `/`, no `..`,
// never leading `-`/`.` — one legal, URL-inert ref component. Fully REVERSIBLE.
export function encodeKey(key) {
  const bytes = Buffer.from(String(key), "utf8");
  let out = "";
  bytes.forEach((b, i) => {
    const c = String.fromCharCode(b);
    const literal = i === 0 ? /[A-Za-z0-9]/.test(c) : /[A-Za-z0-9-]/.test(c);
    out += literal ? c : "_" + b.toString(16).toUpperCase().padStart(2, "0");
  });
  return out;
}
export function decodeKey(enc) {
  const s = String(enc);
  const bytes = [];
  for (let i = 0; i < s.length; ) {
    if (s[i] === "_" && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) { bytes.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 3; }
    else { bytes.push(s.charCodeAt(i) & 0xff); i += 1; }
  }
  return Buffer.from(bytes).toString("utf8");
}

export function refShort(key) { return `${NAMESPACE}/${encodeKey(key)}`; }     // for git/ref/<this>
export function refFull(key) { return `refs/${NAMESPACE}/${encodeKey(key)}`; } // for creating

// A key must be non-empty after trimming — it becomes the ref name.
export function normalizeKey(key) {
  const k = String(key ?? "").trim();
  return k.length ? k : null;
}

// Identity here is AUDIT metadata, not a mutex owner, so a fallback is harmless
// (correctness comes from the atomic ref, not from who set it). AGENT_ID or "unknown".
export function resolveActor(env = process.env) {
  const id = (env.AGENT_ID || "").trim();
  return id || "unknown";
}

export function parseOnceMessage(message) {
  try { const m = JSON.parse(message); return { key: m.key ?? null, by: m.by ?? null, at: m.at ?? null }; }
  catch { return { key: null, by: null, at: null }; }
}

// Backoff with jitter so a herd of workers racing the same key self-spaces on retry.
export function backoffMs(attempt, rng = Math.random) {
  const base = Math.min(1000 * 2 ** attempt, 30_000);
  return Math.round(base / 2 + rng() * (base / 2));
}

// ---------- gh plumbing (the only I/O; everything above is pure) ----------

function ghRaw(args, input) {
  const r = spawnSync("gh", args, { input, encoding: "utf8" });
  return { status: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}
function isTransient(err) {
  return /rate limit|secondary rate|abuse|\b5\d\d\b|timeout|timed out|EAI_AGAIN|ECONNRESET|temporarily/i.test(err);
}
function isNotFound(err) { return /not found|\b404\b/i.test(err); }
const sleep = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no SAB → skip */ } };

// `{owner}`/`{repo}` are filled by gh from the current repo — no slug lookup, one
// fewer subprocess on every call.
function gh(method, path, body, { retry = MAX_RETRY } = {}) {
  const args = ["api", "--method", method, `repos/{owner}/{repo}/${path}`];
  if (body) args.push("--input", "-");
  const input = body ? JSON.stringify(body) : undefined;
  let last;
  for (let attempt = 0; attempt <= retry; attempt++) {
    last = ghRaw(args, input);
    if (last.status === 0) return last;
    if (/already exists/i.test(last.err) || isNotFound(last.err)) return last; // terminal business results
    if (!isTransient(last.err) || attempt === retry) return last;
    sleep(backoffMs(attempt));
  }
  return last;
}

let TREE = null;
// Any existing tree works as the barrier commit's tree (it carries no files).
// `commits/HEAD` returns the default branch tip's tree in ONE call.
function baseTree() {
  if (TREE) return TREE;
  const r = gh("GET", "commits/HEAD");
  if (r.status !== 0) throw new Error("gh unavailable");
  return (TREE = JSON.parse(r.out).commit.tree.sha);
}

// Read the record behind a key. null = genuinely absent (404); THROWS on a transient/
// unknown error so callers can tell "not done" apart from "couldn't check".
function getRecord(key) {
  const ref = gh("GET", `git/ref/${refShort(key)}`);
  if (ref.status !== 0) {
    if (isNotFound(ref.err)) return null;
    throw new Error(ref.err || "gh error");
  }
  const sha = JSON.parse(ref.out).object.sha;
  const commit = JSON.parse(gh("GET", `git/commits/${sha}`).out);
  return { ...parseOnceMessage(commit.message), committedAt: commit.committer.date, sha };
}

// ---------- primitive ----------

// mark — atomic claim of the barrier. Returns {result, holder?}:
//   won     : this call created it first → DO the guarded work
//   done    : someone already created it → SKIP (holder = who/when, best effort)
//   degraded: gh offline → caller decides (fail-closed unless --degraded-ok)
export function mark(key, { by = resolveActor() } = {}) {
  const k = normalizeKey(key);
  if (k === null) throw new Error("empty once key");
  let message;
  try { baseTree(); message = JSON.stringify({ v: 1, key: k, by, at: new Date().toISOString() }); }
  catch { return { result: "degraded" }; }
  const c = gh("POST", "git/commits", { message, tree: baseTree() });
  if (c.status !== 0) return { result: "degraded" };
  const sha = JSON.parse(c.out).sha;
  const ref = gh("POST", "git/refs", { ref: refFull(k), sha });
  if (ref.status === 0) return { result: "won" };
  if (/already exists/i.test(ref.err)) {
    let holder = null;
    try { holder = getRecord(k); } catch { /* metadata is best-effort */ }
    return { result: "done", holder };
  }
  return { result: "degraded" };
}

// check — read-only. {result: done|pending|degraded}. Never creates the barrier.
export function check(key) {
  const k = normalizeKey(key);
  if (k === null) throw new Error("empty once key");
  let rec;
  try { rec = getRecord(k); } catch { return { result: "degraded" }; }
  return rec ? { result: "done", holder: rec } : { result: "pending" };
}

// reset — delete the barrier so a FAILED op can be retried. Deliberately manual; a
// once-barrier is permanent by design, so undoing it is an explicit operator action.
export function reset(key) {
  const k = normalizeKey(key);
  if (k === null) return false;
  try { const d = gh("DELETE", `git/refs/${refShort(k)}`); return d.status === 0; }
  catch { return false; }
}

export function listKeys() {
  const out = [];
  for (let page = 1; ; page++) {
    const r = gh("GET", `git/matching-refs/${NAMESPACE}/?per_page=100&page=${page}`);
    if (r.status !== 0) break;
    let batch; try { batch = JSON.parse(r.out); } catch { break; }
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const x of batch) {
      const enc = String(x.ref).replace(`refs/${NAMESPACE}/`, "");
      out.push({ key: decodeKey(enc), sha: x.object?.sha });
    }
    if (batch.length < 100) break;
  }
  return out;
}

// ---------- CLI ----------

const RESERVED = new Set(["run", "check", "list", "reset", "help", "--help", "-h"]);

function doRun(key, { degradedOk }) {
  const r = mark(key);
  if (r.result === "won") { console.log("won"); return 0; }
  if (r.result === "done") {
    const h = r.holder;
    console.error(`↩ already done${h?.by ? ` by ${h.by}` : ""}${h?.at ? ` at ${h.at}` : ""} — skipping.`);
    console.log("done");
    return 10;
  }
  if (degradedOk) { console.error("⚠ gh unavailable — --degraded-ok set, proceeding (at-least-once)."); console.log("degraded"); return 0; }
  console.error("⚠ gh unavailable — can't prove this hasn't run; NOT proceeding. Pass --degraded-ok to run anyway.");
  return 1;
}

function cmdCheck(key) {
  const r = check(key);
  if (r.result === "done") {
    const h = r.holder;
    console.log(`done${h?.by ? ` by ${h.by}` : ""}${h?.at ? ` at ${h.at}` : ""}`);
    return 0;
  }
  if (r.result === "degraded") { console.error("⚠ gh unavailable — can't check."); return 1; }
  console.log("pending");
  return 10;
}

function cmdList() {
  const keys = listKeys();
  if (!keys.length) { console.log("no recorded once-barriers"); return 0; }
  for (const { key } of keys) {
    let rec = null; try { rec = getRecord(key); } catch { /* skip meta */ }
    console.log(`  ${key}${rec?.by ? `  by ${rec.by}` : ""}${rec?.at || rec?.committedAt ? `  at ${rec.at || rec.committedAt}` : ""}`);
  }
  return 0;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const pos = rest.filter((a) => !a.startsWith("--"));
  const degradedOk = rest.includes("--degraded-ok");

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.error("gh-once <key> [--degraded-ok] | run <key> | check <key> | reset <key> | list");
    console.error("  exit: 0 won (do it) · 10 done (skip) · 1 gh offline. Use:  gh-once deploy:$SHA && ./deploy.sh");
    return cmd ? 0 : 2;
  }
  switch (cmd) {
    case "list": return cmdList();
    case "check": {
      if (!pos[0]) { console.error("usage: gh-once check <key>"); return 2; }
      return cmdCheck(pos[0]);
    }
    case "reset": {
      if (!pos[0]) { console.error("usage: gh-once reset <key>"); return 2; }
      return reset(pos[0]) ? (console.log("reset (barrier cleared — the op may run again)"), 0) : (console.log("no barrier to reset"), 0);
    }
    case "run": {
      if (!pos[0]) { console.error("usage: gh-once run <key>"); return 2; }
      return doRun(pos[0], { degradedOk });
    }
    default:
      // Bare form: `gh-once <key>` — cmd itself is the key (unless it's a reserved word).
      if (RESERVED.has(cmd)) { console.error("gh-once: missing <key>"); return 2; }
      return doRun(cmd, { degradedOk });
  }
}

// Run the CLI when invoked directly. npm/pnpm install the bin as a SYMLINK, so a naive
// argv[1]-vs-import.meta.url compare fails and the CLI silently no-ops — realpath both.
function isCliEntry() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isCliEntry()) {
  try { process.exit(main(process.argv.slice(2))); }
  catch (err) { console.error(`gh-once: ${err.message}`); process.exit(1); }
}
