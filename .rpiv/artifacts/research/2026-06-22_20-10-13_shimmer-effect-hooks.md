---
date: 2026-06-22T20:10:13-0700
author: Eric Sison
commit: 3232745
branch: main
repository: pi-synthwave-statusline
topic: "Apply model-remind session hooks + shimmer effect to statusline"
tags: [research, statusline, shimmer, animation, session-lifecycle, model-remind]
status: ready
last_updated: 2026-06-22T20:10:13-0700
last_updated_by: Eric Sison
---

# Research: Apply model-remind session hooks + shimmer effect to statusline

## Research Question
Just made a project @../model-remind/ that hooks into some things so it shows a pi notification that outputs the model name when doing a /new or /reload. Apply the same hooks in this repo and apply a shimmering effect (similar to codex's text when it's working) to the model name + provider for 10 seconds after doing a /new or /reload.

## Summary
The model-remind extension is a 25-line fire-and-forget hook on `session_start` that shows a `ctx.ui.notify()` notification with model info. The statusline extension already hooks `session_start` for footer rendering, so no new dependency is needed — we replicate the same pattern. The shimmer effect requires: (a) per-character ANSI color cycling through a Synthwave palette, (b) a `setInterval` timer driving `tui.requestRender()` at ~20fps, (c) state management for shimmer start time and timer handle, (d) cleanup in `session_shutdown` and `dispose()`. The main risk is timer leaks — every `setInterval` must have paired `clearInterval` in session lifecycle handlers.

## Detailed Findings

### Session Lifecycle: How session_start / session_shutdown Work

- `session_start` fires on `/new`, `/reload`, `/resume`, `/fork`, and initial startup (`agent-session-runtime.js:156-175`)
- `session_shutdown` fires reliably before `session.dispose()` on both `/new` and `/reload` (`agent-session-runtime.js:103`, `agent-session.js:1938-1940`)
- Context is still valid during shutdown handlers — invalidation happens inside `dispose()` (`agent-session.js:495-499`)
- Sequential order: shutdown handlers run → context invalidated → new session starts

### Guard Pattern: ctx.hasUI vs ctx.mode !== "tui"

- `ctx.hasUI` (`types.d.ts:214`) — true for TUI and RPC modes; false for json/print
- `ctx.mode !== "tui"` — excludes all non-TUI modes including RPC
- For statusline: `ctx.hasUI` is pragmatically correct because RPC's `setFooter` is a no-op (`rpc-mode.js:136`), so no crash in RPC mode
- model-remind uses `ctx.mode !== "tui"` — strictly more precise but functionally equivalent for statusline
- **Recommendation**: Keep existing `ctx.hasUI` guard in statusline (consistent with established pattern)

### Handler Accumulation Bug (Pre-existing)

- Each `session_start` fires nested `pi.on()` calls for `session_shutdown`, `turn_start`, `turn_end`, `message_update`
- These accumulate in the extension's handler arrays (`loader.js:151-155`) — no `off()` API exists
- After N rapid `/new` calls: N+1 copies of each handler fire per event
- This is a pre-existing issue, not introduced by the shimmer feature
- **Impact**: Redundant render requests during streaming; multiple debounce timers set (only last survives due to shared closure variable)
- **Mitigation**: Not in scope for this change — track separately if needed

### Shimmer Animation Architecture

**State Variables** (inside `session_start` closure, co-located with existing TPS state at `statusline.ts:108-112`):
- `shimmerActiveSince: number` — `Date.now()` when shimmer starts
- `shimmerTimer: ReturnType<typeof setInterval> | null` — animation timer handle

**Color Palette** — 8 Synthwave colors cycling per-character:
1. `#FF00FF` — bright magenta (MAGENTA)
2. `#36F9F6` — electric cyan (CYAN)
3. `#FF69B4` — hot pink (CAC)
4. `#72F1B8` — neon green (GREEN)
5. `#FEDE5D` — sunset yellow (YELLOW)
6. `#FF8B39` — burnt orange (ORANGE)
7. `#B2FF59` — lime green (API)
8. `#9BFCFA` — light cyan (CYAN_LIGHT)

**Per-Character Phase Computation**:
- `getShimmerColor(elapsedMs, charOffset)` — picks color using `(elapsedMs + charOffset * 75) % SHIMMER_CYCLE_MS`
- The `charOffset * 75` creates a per-character phase delay, producing the wave effect
- `SHIMMER_CYCLE_MS = 600` — full color sweep every 600ms

**Timer Configuration**:
- `SHIMMER_INTERVAL = 80ms` (~12.5fps) — well below the TUI's 16ms minimum render interval
- `SHIMMER_DURATION = 10,000ms` (10 seconds)
- Timer starts inside `setFooter` callback where `tui.requestRender()` is available
- Auto-terminates after 10 seconds via elapsed check

**Integration with Existing Model Display**:
- `modelDisplayFinal` at `statusline.ts:231-232` — where static `color("MAGENTA_LIGHT", ...)` / `color("MAGENTA", ...)` calls live
- Replace with conditional: `isShimmering ? shimmerString(rawText, elapsed) : static colors`
- `modelBlock` at `statusline.ts:233` appends thinking level (ORANGE) — this stays static, not shimmered
- `visibleWidth()` compatibility confirmed — ANSI escape codes don't affect layout calculations

### Render Pipeline Performance

- `tui.requestRender()` is async and debounced (`tui.js:498-543`)
- Multiple calls coalesce via `renderRequested` guard (`tui.js:502`)
- Minimum inter-render interval: 16ms (~60fps cap)
- Differential render only writes changed lines to terminal
- 80ms shimmer timer: ~1-6ms per render cycle, ~2-8% CPU at 12.5fps — negligible
- During streaming, `message_update` events already call `requestRender()` at higher frequency — timer and events coalesce correctly

### Timer Cleanup Requirements

- `session_shutdown` handler (`statusline.ts:8-12`) — must clear both `tpsDebounceTimer` and `shimmerTimer`
- `dispose()` return from `setFooter` callback — must clear `shimmerTimer` and call `unsub()`
- Timer callback must NOT reference `ctx` directly — use closure-safe `requestFooterRender` (set inside `setFooter()`)
- Pattern matches existing TPS timer: tracked variable + paired cleanup in shutdown + dispose

## Code References
- `statusline.ts:1-18` — Extension imports and ANSI color palette (C object)
- `statusline.ts:28-66` — Synthwave 84 color constants available for shimmer cycle
- `statusline.ts:82-115` — Helper functions (generateDots, segColor, pctColor, formatTokens, color)
- `statusline.ts:117-126` — Extension default export and session_start handler entry
- `statusline.ts:127-131` — session_shutdown cleanup (tpsDebounceTimer only currently)
- `statusline.ts:133-146` — Streaming state variables and event handlers (turn_start, turn_end, message_update)
- `statusline.ts:148-155` — ctx.ui.setFooter callback entry, requestFooterRender setup
- `statusline.ts:231-233` — modelDisplayFinal construction (shimmer injection point)
- `statusline.ts:235-251` — Line 1 layout: pwdLine + modelBlock with right-alignment and path trimming
- `model-remind/src/index.ts:1-25` — Reference extension: session_start hook → ctx.ui.notify()

## Integration Points

### Inbound References
- `statusline.ts:117` — `pi.on("session_start", ...)` — already hooks session lifecycle
- `statusline.ts:127` — `pi.on("session_shutdown", ...)` — already handles cleanup (needs shimmer timer added)
- `statusline.ts:148` — `ctx.ui.setFooter(...)` — footer rendering entry point

### Outbound Dependencies
- `@earendil-works/pi-ai` — AssistantMessage type for usage stats
- `@earendil-works/pi-coding-agent` — ExtensionAPI, ReadonlyFooterDataProvider types
- `@earendil-works/pi-tui` — truncateToWidth, visibleWidth utilities

### Infrastructure Wiring
- `tui.requestRender()` — async, debounced, coalesced render trigger
- `footerData.onBranchChange()` — branch change subscription for re-render
- `pi.getThinkingLevel()` — reads current thinking level for model block

## Architecture Insights

- **Single file extension**: All code lives in `statusline.ts` — no separate modules, no build step
- **Closure-based state**: Per-session state (streaming, shimmer) lives in the `session_start` callback closure, not in module scope — naturally scoped to session lifetime
- **Timer pattern**: `setInterval` for continuous animation, `setTimeout` for one-shot debounce; both require paired cleanup
- **Render coalescing**: TUI's `requestRender()` deduplicates multiple calls per tick — safe to call from both event handlers and timers
- **Width-aware layout**: `visibleWidth()` handles ANSI escape codes correctly — shimmer output (per-character color wrapping) doesn't affect layout math
- **Priority degradation**: Left-block segments are added right-to-left by importance; TPS is currently the most expendable — shimmer doesn't add new segments, it modifies existing model text

## Precedents & Lessons
5 similar past changes analyzed.

### Precedent: Live tokens/sec with streaming debounce timer
**Commit(s)**: `3232745` — "feat: add live tokens/sec to statusline during streaming" (2026-06-16)
**Blast radius**: 1 file, 1 layer (statusline.ts)
- statusline.ts — added TPS color codes, streaming state, timer management, session_shutdown cleanup

**Follow-up fixes**: None yet

**Lessons from docs**:
- `.rpiv/artifacts/plans/2026-06-15_20-57-27_audit-fixes.md` — hasUI guard is the first thing in session_start; timers and event handlers registered inside this guard only exist in TUI mode

**Takeaway**: Any new timer (shimmer) needs its own variable, its own cleanup in session_shutdown, and must not interfere with TPS debounce logic.

### Precedent: hasUI guard and data-accuracy fixes
**Commit(s)**: `8983612` — "fix: address code review findings" (2026-06-15)
**Blast radius**: 1 file, 1 layer (statusline.ts)

**Lessons from docs**:
- `.rpiv/artifacts/designs/2026-06-15_20-38-10_audit-fixes.md` — "ctx.hasUI guard is non-negotiable"

**Takeaway**: Every ctx.ui.* call and every timer that calls tui.requestRender() must be inside hasUI guard.

### Precedent: pi-exit-stats count-up animation
**Commit(s)**: `3253e0f` — "Glow up exit-stats with hacker panel and themes" (2026-05-27, pi-exit-stats repo)
**Blast radius**: 2 files, 1 layer

**Lessons from docs**:
- Uses `sleep(ms)` in a for loop for count-up animation — safe because fire-and-forget in synchronous closure
- Continuous shimmer/cycling cannot use blocking loop — must use setInterval
- Animation is opt-in via config flag

**Takeaway**: For continuous shimmer, use setInterval (not blocking loop). Track timer for cleanup.

### Precedent: pi-mimo-cme timer debounce and ctx invalidation
**Commit(s)**: `1ef809b` — "Harden memory hot paths and subprocess lifecycle" (2026-06-12, pi-mimo-cme repo)
**Blast radius**: 9 files, multiple layers

**Lessons from docs**:
- `.rpiv/artifacts/research/2026-06-18_20-07-11_memory-alive-heartbeat-short-sessions.md` — "ctx objects become invalid across session boundaries; timer callbacks must use live references"

**Takeaway**: Shimmer timer callback must NOT reference ctx directly. Use closure-safe requestFooterRender (set inside setFooter).

### Precedent: model-remind minimal session_start hook
**Commit(s)**: `e5b3a24` — "Initialize model-remind pi extension" (model-remind repo)
**Blast radius**: 1 file, 1 layer

**Lessons from docs**:
- Fire-and-forget: read state at session_start, show notification, done
- No timers, no render loop, no state management
- Can be merged into existing session_start handler in statusline.ts

**Takeaway**: Model-remind's approach is a pattern to replicate, not a dependency to add.

### Composite Lessons
- **Timer leak is #1 risk** — Every setInterval/setTimeout must have paired cleanup in session_shutdown. Missing cleanup causes stale timers to outlive the session.
- **ctx invalidation after session switch** — Timer callbacks must use closure-safe references (requestFooterRender), not captured ctx objects.
- **hasUI guard is non-negotiable** — Every ctx.ui.* call and every timer calling tui.requestRender() must be inside the guard.
- **Only one session_start handler** — Avoid registering a second handler; merge model-remind's pattern into the existing one.
- **Color cycling must stay within Synthwave palette** — Use existing C object colors; don't introduce unrelated ANSI codes.

## Historical Context (from `.rpiv/artifacts/`)
- `.rpiv/artifacts/plans/2026-06-15_20-57-27_audit-fixes.md` — Phase plan for hasUI guard, ?% sentinel, cache-hit ratio fixes
- `.rpiv/artifacts/designs/2026-06-15_20-38-10_audit-fixes.md` — Design document for audit fixes including hasUI guard pattern
- `.rpiv/artifacts/reviews/2026-06-15_20-18-08_commit.md` — Code review of initial commit; flagged dead handler, type assertion, comment issues
- `.rpiv/artifacts/validation/2026-06-15_21-41-56_audit-fixes.md` — Validation report confirming all audit fixes passed
- `.rpiv/artifacts/research/2026-06-18_20-07-11_memory-alive-heartbeat-short-sessions.md` — Research on ctx invalidation pattern in pi-mimo-cme

## Developer Context
(none — no developer checkpoint questions were needed; all findings were self-contained)

## Related Research
- None (first research artifact for this project)

## Open Questions
- Handler accumulation bug: each `session_start` nests new `pi.on()` calls that accumulate without cleanup. Should this be fixed as part of this change or tracked separately? (Pre-existing issue, not introduced by shimmer.)
