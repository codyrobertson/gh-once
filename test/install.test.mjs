// install.test.mjs — proves the PUBLISHED artifact works once installed.
// Packs the real tarball (prepack builds the minified dist), rebuilds npm's exact
// on-disk layout, and drives it: files manifest, symlinked bin, bare import. Unit tests
// run ./src; only this catches packaging faults (missing dist, broken exports, stray files).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const has = (bin) => spawnSync(bin, ["--version"], { encoding: "utf8" }).status === 0;
const skip = !has("npm") || !has("tar");

let TGZ = null, FILES = null, WORK = null;
test.before(() => {
  if (skip) return;
  WORK = mkdtempSync(join(tmpdir(), "ghonce-install-"));
  const r = spawnSync("npm", ["pack", "--json", "--pack-destination", WORK], { cwd: PKG, encoding: "utf8" });
  assert.equal(r.status, 0, `npm pack failed: ${r.stderr}`);
  const meta = JSON.parse(r.stdout)[0];
  TGZ = join(WORK, meta.filename);
  FILES = meta.files.map((f) => f.path);
});
test.after(() => { if (WORK) rmSync(WORK, { recursive: true, force: true }); });

function installTarball() {
  const root = mkdtempSync(join(tmpdir(), "ghonce-consumer-"));
  const nm = join(root, "node_modules");
  const pkgDir = join(nm, "gh-once");
  mkdirSync(pkgDir, { recursive: true });
  const x = spawnSync("tar", ["-xzf", TGZ, "-C", pkgDir, "--strip-components=1"], { encoding: "utf8" });
  assert.equal(x.status, 0, `tar failed: ${x.stderr}`);
  const binDir = join(nm, ".bin");
  mkdirSync(binDir, { recursive: true });
  symlinkSync(join("..", "gh-once", "dist", "once.mjs"), join(binDir, "gh-once"));
  return { root, pkgDir, bin: join(binDir, "gh-once") };
}

test("the tarball ships exactly what's needed and nothing stray", { skip }, () => {
  for (const need of ["package.json", "dist/once.mjs", "README.md", "LICENSE"])
    assert.ok(FILES.includes(need), `published tarball is missing ${need} (files: ${FILES.join(", ")})`);
  for (const f of FILES)
    assert.ok(!/(^|\/)(\.env|node_modules\/|test\/|src\/|\.git\/)/.test(f), `stray file in tarball: ${f}`);
});

test("installed bin runs through npm's symlink (no silent no-op)", { skip }, () => {
  const { root, bin } = installTarball();
  try {
    const r = spawnSync(process.execPath, [bin, "--help"], { encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.match(r.stderr, /gh-once <key>/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("bare-specifier `import` resolves through the exports map", { skip }, () => {
  const { root } = installTarball();
  try {
    const consumer = join(root, "consumer.mjs");
    writeFileSync(consumer, `import * as m from "gh-once";\nprocess.stdout.write([typeof m.mark, typeof m.check, typeof m.encodeKey, typeof m.decodeKey].join(","));\n`);
    const r = spawnSync(process.execPath, [consumer], { cwd: root, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "function,function,function,function");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the minified dist preserves encode/decode round-trips (build didn't corrupt logic)", { skip }, () => {
  const { root } = installTarball();
  try {
    const consumer = join(root, "roundtrip.mjs");
    writeFileSync(consumer, `import { encodeKey, decodeKey } from "gh-once";
const keys = ["deploy:abc", "migrate/2026-07", "café ☕ 42"];
process.stdout.write(String(keys.every(k => decodeKey(encodeKey(k)) === k)));\n`);
    const r = spawnSync(process.execPath, [consumer], { cwd: root, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "true");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
