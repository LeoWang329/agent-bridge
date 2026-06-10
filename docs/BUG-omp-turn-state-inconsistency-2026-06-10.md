# Bug — OMP session reports `lastTurn.endedAt` set **while** `status:"running"` (incoherent turn clock)

**Date:** 2026-06-10
**Status:** **FIXED in v0.8.3** (F7 + F8 below). Deterministic regression test: `docs/repro-mcp-hang/repro-turnstate.mjs` (PASS; a negative control with F8 reverted FAILs, confirming the test discriminates). Cross-reviewed by codex + deepseek-v4-pro before implementation.
**Severity:** Minor (observability/contract bug; no crash, no data loss). Independent of the v0.8.1/0.8.2 disconnect fixes — a pre-existing latent bug, surfaced by a backend model that loops.

## Observed

While cross-reviewing with `xiaomi-token-plan-cn/mimo-v2.5` (a model that fell into a tool-call loop), `agent_bridge_status` / `agent_bridge_result` returned a self-contradictory snapshot:

```
status: "running"
lastTurn: { startedAt: …, endedAt: "2026-06-10T07:53:28.208Z", durationMs: 453565 }
charCount: 0, text: null
recentEvents: [
  …,
  { type:"status", status:"idle",    source:"turn_end"   },
  { type:"turn_end" },
  { type:"status", status:"running", source:"turn_start" },   // same millisecond
  { type:"turn_start" }
]
```

`lastTurn.endedAt` (and a computed `durationMs`) are populated **at the same time** as `status:"running"` — a turn cannot be both ended and running. Separately, `charCount` stayed 0 / `text` null despite `messageCount: 88` (heavy tool use).

## Root cause (code)

The OMP turn clock has **split ownership** and the backend-`turn_start` path is incomplete.

- `lastTurnOf()` (**scripts/agent-bridge.mjs:440–446**) derives the turn purely from stamps and **ignores status**:
  ```js
  const endedAt = session.turnEndedAt || null;
  const durationMs = startedAt && endedAt ? new Date(endedAt) - new Date(startedAt) : null;
  ```
- `#applyEvent()` (**1088–1099**):
  - `agent_end`/`turn_end` → `this.turnEndedAt = nowIso()` + status `idle`.
  - `agent_start`/`turn_start` → status `running` + `this.lastAssistantText = ""`, but **does NOT clear `turnEndedAt`** (and does not re-stamp `turnStartedAt`).
- Only `send()` (**1145–1148**) resets the clock for a fresh turn: `turnStartedAt = now; turnEndedAt = null; currentTurnId = …`.

So when an OMP backend autonomously emits a **second** `turn_start` *without* a new `send()` — i.e. a multi-step / tool-loop / re-entering model — the previous `turn_end` has already stamped `turnEndedAt`, and the new `turn_start` flips status back to `running` **without clearing it**. `lastTurnOf` then reports `endedAt` + `durationMs` for a turn that is, by status, currently running.

The `charCount:0` is the same root: every `turn_start` resets `lastAssistantText = ""` (**1090**), so a backend that re-enters turns repeatedly keeps wiping the accumulated answer → nothing to report.

### Why it stayed hidden

Normal backends emit exactly one `agent_start … agent_end` per `send()`, so `turnEndedAt` is only ever read after the (single) turn truly ended, and `send()` clears it before the next one. The incoherence only appears when the **backend re-enters a turn on its own** between bridge sends — which mimo-v2.5's tool loop did.

## Secondary effect — such a backend never settles

`sessionSettled(OmpRpcSession)` = `status === "idle" && turnStarted`. A looping backend flips `idle`→`running` in the **same millisecond** (see events above), so the idle window is ~0 ms and `waitSessions`' 250 ms poll essentially never lands in it → `wait` can only ever time out for that session, never return it as done. This is partly model misbehavior (the loop), but the bridge has no guard/diagnostic for "backend is churning turns without producing text."

## Fix — SHIPPED in v0.8.3 (F7 + F8; cross-reviewed by codex + deepseek-v4-pro, both confirmed the root cause)

Did **both** of the following — they are complementary, not either/or:

1. **Clear the stamp on re-entry (minimal, direct):** in `#applyEvent`, on `agent_start`/`turn_start` set `this.turnEndedAt = null` (mirror `send()`), so the direct `turn_end → turn_start` path can't leave a stale `endedAt`.
2. **Make `lastTurnOf` status-aware (robust catch-all — do NOT skip this):** only surface `endedAt`/`durationMs` when the session is settled (i.e. not `running`/`starting`). This is the more important of the two: **`state()` is a *second* path** that flips status to `running` (when `get_state` reports `isStreaming`) **without touching `turnEndedAt`** — so patching only `#applyEvent` still lets `state()` re-create the contradiction. Guarding the read closes every present and future write-site slip.
3. **Do NOT re-stamp `turnStartedAt`** on a backend-spontaneous `turn_start` (both reviewers, explicitly). `lastTurn.id`/`startedAt` are minted once per **bridge** `send()`; re-stamping on internal sub-turns would drift the turn's origin and corrupt the "total time for this bridge turn" meaning of `durationMs`. If per-sub-turn timing is ever wanted, add a separate `lastSubTurn*` field — don't overload `turnStartedAt`.

**Not part of this fix (keep separate — do not conflate):**

- **`charCount:0` is a different bug** with the same trigger: `turn_start` resets `lastAssistantText = ""` (line 1090), so a looping backend repeatedly wipes the accumulated answer. Clearing `turnEndedAt` does nothing for it. Improving progress visibility for a churning backend is a separate decision (e.g. keep a "last non-empty assistant text" alongside the live one) — track it on its own, don't advertise the clock fix as a charCount fix.
- **"Never settles" is backend behavior, not a bridge state-machine bug.** `sessionSettled` (`status==="idle" && turnStarted`) is correct; a model that re-enters `running` within ~0 ms of `idle` just means the 250 ms `wait` poll rarely catches the idle window, so `wait` only ever times out for it. A finite multi-step task still settles once it stably idles. Optionally add a **churn diagnostic** (flag a session emitting N `turn_start` within one `send()`, or M turns with no assistant text) so a looping model is *visible* rather than silently "running" — but that is an enhancement, not part of this fix.

**Confirmed no regression** (both reviewers verified against every consumer): the fix touches neither `turnStarted` (so `waitIdle`'s gate is unaffected) nor the `status`/`turnStarted` pair `sessionSettled` reads; `send()` manages its own clock reset; `currentTurnId`/`lastTurnId` are untouched. It only turns a self-contradictory snapshot into a consistent one.

## Repro

`docs/repro-mcp-hang/repro-turnstate.mjs` (+ `fake-omp.mjs` `FAKE_OMP_MODE=turnstate`): the fake backend acks the prompt then churns `turn_start → turn_end → turn_start → turn_end` on its own (no new prompt) and settles on `turn_end` with `get_state` still reporting `isStreaming:true`. The harness then polls `agent_bridge_status` (which drives `state()` → the "second path" that flips status→running) and asserts it **never** observes `status:"running"` together with a non-null `lastTurn.endedAt`. **PASS** on v0.8.3; a negative control that reverts F8 (un-gates `lastTurnOf`) **FAILs** immediately (`running` + `endedAt` set, `durationMs:122`), proving the test discriminates the bug rather than trivially passing.

## Key code locations

`lastTurnOf` 440–446 · `#applyEvent` agent/turn start+end 1088–1099 (no `turnEndedAt` reset on start: 1088–1093; `lastAssistantText=""` at 1090) · `send()` clock reset 1145–1148 · `sessionSettled` (OMP idle+turnStarted gate) ~1903–1907 · `buildSessionResult` 453+.
