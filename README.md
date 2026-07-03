# gh-once

**An exactly-once barrier, GitHub-native, with no database.** The barrier IS a git ref: `refs/once/<key>`. Creating a ref is atomic on GitHub's backend, so the **first** caller to `gh-once <key>` gets `201` ("won" — do the work) and **every caller after** gets `422 already exists` ("done" — skip). That one fact is the whole primitive: a durable, distributed "has this happened yet?" flag that any number of machines, agents, or CI jobs can race on safely — nothing to run, nothing to host.

It's the permanent sibling of [`gh-issue-lease`](https://www.npmjs.com/package/gh-issue-lease): a lease has a TTL and can be stolen; a **once-barrier never expires and is never stolen**. Reach for it when an operation must run **at most once** per key, no matter how many workers try.

```sh
gh-once deploy:$(git rev-parse HEAD)   && ./deploy.sh          # deploy each commit once
gh-once migrate:2026-07-add-index      && ./run-migration.sh   # never double-migrate
gh-once welcome-email:$USER_ID         && ./send-welcome.sh    # one welcome, ever
```

Zero runtime dependencies. One small file. Node ≥18. Needs an authenticated [`gh`](https://cli.github.com/).

---

## The one idea

`POST /git/refs` is atomic and idempotent-hostile: two callers creating the same ref, and exactly one wins with `201`; the loser gets `422`. So the ref's *existence* is your once-flag, stored on the same GitHub you already trust with your code. No Redis, no Postgres advisory lock, no "did the cron already fire?" table.

The **key** is what makes it idempotent — you choose the granularity:

| Key | "Once per…" |
|---|---|
| `deploy:$(git rev-parse HEAD)` | commit |
| `migrate:2026-07-add-index` | named migration |
| `daily-digest:$(date +%F)` | calendar day |
| `charge:$INVOICE_ID` | invoice |

Any string works — `:` `/` spaces, unicode, whatever. It's percent-encoded to a legal, reversible ref name for you.

---

## Exit codes (so `&&` does the right thing)

`run` is built so `gh-once <key> && <command>` runs `<command>` **only on the first success**:

| Command | `0` | `10` | `1` |
|---|---|---|---|
| `gh-once <key>` / `run <key>` | **won** — first, DO IT | **done** — already ran, skip | gh offline (see below) |
| `check <key>` | done | pending | gh offline |
| `reset <key>` | cleared (0) | — | — |
| `list` | prints every recorded key (0) | — | — |

```sh
if gh-once run daily-digest:$(date +%F); then
  ./send-digest.sh
else
  echo "already sent today — nothing to do"
fi
```

### Fail-closed by default

If `gh` can't be reached, `run` **cannot prove the op hasn't already run**, so it exits `1` and your `&& command` is **skipped** — because for exactly-once, skipping a maybe-duplicate beats risking a double-deploy or double-charge.

Pass `--degraded-ok` to flip to **at-least-once** (run anyway when GitHub is down):

```sh
gh-once deploy:$SHA --degraded-ok && ./deploy.sh   # prefer running twice over never
```

---

## Install & use

```sh
npx gh-once <key>          # one-off, no install
npm i -D gh-once           # or as a dev dependency
```

| Command | Effect |
|---|---|
| `gh-once <key>` | Claim the barrier. `0` = you're first (do the work), `10` = already done. |
| `gh-once run <key>` | Explicit form of the above (use when a key collides with a subcommand name). |
| `gh-once check <key>` | Read-only. `0` = done, `10` = pending. Never creates the barrier. |
| `gh-once reset <key>` | **Delete** the barrier so a failed op can run again. Deliberately manual. |
| `gh-once list` | Every recorded barrier, with who marked it and when. |
| `--degraded-ok` | On `run`, proceed even if `gh` is offline (at-least-once instead of at-most-once). |

`ONCE_NAMESPACE` (default `once`) changes the ref namespace if you want to segregate barriers.

### Retrying a failed operation

The barrier is set **before** your command runs, so if the command fails you'll be blocked from retrying — that's the point (exactly-once), but not always what you want. Two patterns:

```sh
# A) mark only on success:
gh-once check migrate:x || { ./migrate.sh && gh-once run migrate:x; }

# B) clear and retry after a failure:
gh-once reset deploy:$SHA && gh-once deploy:$SHA && ./deploy.sh
```

### Programmatic API

```js
import { mark, check, reset, listKeys, encodeKey } from "gh-once";
const r = mark("deploy:" + sha);   // { result: "won" | "done" | "degraded", holder? }
if (r.result === "won") await deploy();
```

---

## Guarantees & edge cases

| Case | Behaviour |
|---|---|
| Two workers race the same key | Exactly one gets `won`; the other gets `done`. Atomic on GitHub's side. |
| Same key run again, ever | `done` — the barrier is permanent (no TTL, never stolen). |
| `gh` offline / unauthed | `run` exits `1` and skips (fail-closed); `--degraded-ok` flips to run-anyway. |
| Op fails after the barrier is set | Blocked from retry until you `reset` (or use the "mark on success" pattern). |
| Key with `:` `/` spaces / unicode | Percent-encoded to a legal, reversible ref name — round-trips exactly. |
| Distinct keys | Never collide after encoding (`deploy:a` ≠ `deploy/a` ≠ `deploy a`). |

## License

MIT © Mackenzie Robertson
