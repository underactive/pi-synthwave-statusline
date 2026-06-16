# jojo-statusline

A Pi extension that replaces the default footer with a **Claude Code–inspired statusline**,
featuring the context dot progress bar and pipe-separated column layout.

## Layout

```
Line 1:  main  ~/dev/project                        ← branch icon + dir (Claude-style)
Line 2: context: ●●○○○○○○○○○○○○   5% |  55k   212  󰮆 4k  󰃨 50k  | 0.90  󰔟 42h23m18s  󱂛 2m28s  | (provider) model · used / window · Pi v0.79.4
```

### Columns

| Column | Content | Colors |
|--------|---------|--------|
| Context bar | `context: ●●○○○` + ` 5%` | Soft yellow dots (filled), dim (empty), bright cyan % |
| Tokens / cache | ` input   output  󰮆 cache-writes  󰃨 cache-reads` | Blue icons+values, hot pink cache |
| Cost + times | `$cost  󰔟 session-time  󱂛 api-time` | Green cost, pastel orange session, lime API time |
| Model info | `(provider) model · used / window · Pi vX` | Magenta model, blue context, orange version |

### Differences from Claude statusline

| Claude feature | Status |
|---------------|--------|
| Context dot bar (13 dots) | ✅ Ported |
| Token + cache stats in pipe col | ✅ Ported |
| Cost + session/API time in pipe col | ✅ Ported |
| Model info with context window | ✅ Ported |
| Pi version | ✅ Added (replaces "Claude X") |
| Provider prefix | ✅ Added `(provider) model` |
| Current / weekly rate limit bars | ❌ Removed |
| Effort level | ❌ Removed |
| Output style | ❌ Removed |
| Git staged/modified counts | ❌ Removed |

## Install

```bash
ln -sf "$(pwd)/.pi/extensions/index.ts" ~/.pi/agent/extensions/pi-jojo-statusline.ts
```

`/reload` Pi to activate.

## Uninstall

```bash
rm ~/.pi/agent/extensions/pi-jojo-statusline.ts && /reload
```
