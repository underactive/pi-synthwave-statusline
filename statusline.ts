/**
 * pi-jojo-statusline
 *
 * Ports Claude Code's statusline to Pi, with a context progress bar
 * and pipe-separated columns. Removes the current/weekly rate limit bars.
 *
 * Layout (single Claude-inspired line):
 *   context: ●●○○○○○○○○○○○○   5% (50k / 1M) |  55k   212  󰮆 4k  󰃨 50k  | 0.90  | (provider) model · normal
 *
 * - Dots are soft yellow (filled) / dim gray (empty)
 * - Percentages in bright cyan
 * - Tokens in blue, cache in hot pink
 * - Cost in green
 * - Model name in magenta
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ── Claude-ported ANSI colors ──────────────────────────────────
const C = {
	CYAN: "\x1b[38;2;54;249;246m", // electric cyan (branch name) — Synthwave 84
	CYAN_LIGHT: "\x1b[38;2;155;252;250m", // light electric cyan (branch icon)
YELLOW: "\x1b[38;2;254;222;93m", // sunset yellow (dir) — Synthwave 84
	YELLOW_LIGHT: "\x1b[38;2;255;239;174m", // light sunset yellow (folder icon)
	GREEN: "\x1b[38;2;114;241;184m", // neon green (cost) — Synthwave 84
	GREEN_LIGHT: "\x1b[38;2;185;248;217m", // light neon green (cost icon)
MAGENTA: "\x1b[38;2;255;0;255m", // bright magenta (model name)
	MAGENTA_LIGHT: "\x1b[38;2;204;0;204m", // dim hot pink (provider) — same hue as MAGENTA but dimmer
ORANGE: "\x1b[38;2;255;139;57m", // burnt orange (thinking level) — Synthwave 84
	ORANGE_LIGHT: "\x1b[38;2;255;189;155m", // light burnt orange (thinking icon)
	RESET: "\x1b[0m", // reset

	// Context bar
	CTX: "\x1b[38;2;238;238;238m", // near-white (context icon, progress bar, percentage)

	// Tokens
	TOK: "\x1b[38;2;68;138;255m", // blue (token values)
	TOK_LIGHT: "\x1b[38;2;166;196;255m", // light blue (token icons)

	// Cache
	CAC: "\x1b[38;2;255;105;180m", // hot pink (cache values)
	CAC_LIGHT: "\x1b[38;2;255;180;218m", // light hot pink (cache icons)

	// Times
	TIM: "\x1b[38;2;255;185;120m", // pastel orange (session time)
	TIM_LIGHT: "\x1b[38;2;255;220;188m", // bright orange (time icon)
	API: "\x1b[38;2;178;255;89m", // lime green (api time)
	API_LIGHT: "\x1b[38;2;217;255;172m", // bright lime (api time icon)

	// Icons
	ICO: "\x1b[38;2;255;255;255m", // white (stat icons)

	// Tokens/sec — synthwave bright yellow
	TPS: "\x1b[38;2;254;222;93m", // sunset yellow (matches YELLOW)
	TPS_ICON: "\x1b[38;2;214;182;53m", // dim sunset yellow for the ⚡ icon
} as const;

// ── Nerd Font icons (decoded from ~/.claude/statusline-command.sh printf escapes) ──
const ICON_BRANCH = "\u{E725}"; //  (devicon: git-branch)
const ICON_INPUT = "\u{F103}"; //  (bash: \xEF\x84\x83)
const ICON_OUTPUT = "\u{F102}"; //  (bash: \xEF\x84\x82)
const ICON_CACHE_READS = "\u{F0B86}"; // 󰮆 — cache reads (like "R" in Pi)
const ICON_CACHE_HITS = "\u{F00E8}"; // 󰃨 — cache hit % (like "CH%" in Pi)
const ICON_FOLDER = "\u{F4D3}"; //  (folder)
const ICON_COST = "\u{F155}"; //  (bash: \xEF\x85\x95)
// · (middot, unused but kept for reference)

// ── Context dot progress bar ───────────────────────────────────
const NUM_DOTS = 20;

function generateDots(percent: number): string {
	const filled = Math.min(NUM_DOTS, Math.max(0, Math.round((percent * NUM_DOTS) / 100)));
	let bar = "";
	for (let i = 0; i < filled; i++) bar += segColor(i, NUM_DOTS) + "\u258b"; // ▋
	bar += C.RESET + "\x1b[2m"; // dim
	for (let i = filled; i < NUM_DOTS; i++) bar += "\u2591"; // ░
	bar += C.RESET;
	return bar;
}

// ── Helpers ────────────────────────────────────────────────────

/** Color for a segment at position i (0-indexed) out of NUM_DOTS.
 *  <50% white, 50-84% yellow, 85%+ red
 */
function segColor(pos: number, total: number): string {
	const segPct = ((pos + 1) / total) * 100;
	if (segPct >= 85) return "\x1b[38;2;254;68;80m"; // neon red (Synthwave 84)
	if (segPct >= 50) return "\x1b[93m"; // bright yellow
	return C.CTX;
}

/** Color for the overall percentage label */
function pctColor(pct: number): string {
	if (pct >= 85) return "\x1b[38;2;254;68;80m";
	if (pct >= 50) return "\x1b[93m";
	return C.CTX;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

function color(k: keyof typeof C, text: string): string {
	return `${C[k]}${text}${C.RESET}`;
}


// ── Extension ──────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		// Clean up any lingering debounce timer on session end
		pi.on("session_shutdown", () => {
			if (tpsDebounceTimer) {
				clearTimeout(tpsDebounceTimer);
				tpsDebounceTimer = null;
			}
		});

		// ── Streaming state for live tokens/sec ────────────────────
		let isStreaming = false;
		let streamStartTime = 0;
		let streamOutputTokens = 0;
		let tpsDebounceTimer: ReturnType<typeof setTimeout> | null = null;
		let requestFooterRender: (() => void) | null = null;

		pi.on("turn_start", () => {
			if (tpsDebounceTimer) {
				clearTimeout(tpsDebounceTimer);
				tpsDebounceTimer = null;
			}
			isStreaming = true;
			streamStartTime = Date.now();
			streamOutputTokens = 0;
		});

		pi.on("turn_end", () => {
			isStreaming = false;
			// Keep tps visible for 2s after streaming stops, then hide
			tpsDebounceTimer = setTimeout(() => {
				tpsDebounceTimer = null;
				requestFooterRender?.();
			}, 2000);
			requestFooterRender?.();
		});

		pi.on("message_update", (event) => {
			if (!isStreaming) return;
			// Count streaming deltas as they arrive; usage.output is only finalized at message_end
			const ev = event.assistantMessageEvent;
			if (ev.type === "text_delta" || ev.type === "thinking_delta") {
				streamOutputTokens += ev.delta.split(/\s+/).filter(Boolean).length;
			}
			requestFooterRender?.();
		});

		ctx.ui.setFooter(
			(tui, _theme, footerData: ReadonlyFooterDataProvider) => {
				requestFooterRender = () => tui.requestRender();
				const unsub = footerData.onBranchChange(() => tui.requestRender());

				return {
					dispose: unsub,
					invalidate() {
						// no-op: render() reads sessionManager directly
					},

					render(width: number): string[] {
						// ── Compute cumulative stats ─────────────
						let totalInput = 0;
						let totalOutput = 0;
						let totalCacheRead = 0;
						let totalCacheWrite = 0;
						let totalCost = 0;

						for (const entry of ctx.sessionManager?.getEntries() ?? []) {
							if (entry.type === "message" && entry.message.role === "assistant") {
								const m = entry.message as AssistantMessage;
								totalInput += m.usage.input;
								totalOutput += m.usage.output;
								totalCacheRead += m.usage.cacheRead;
								// totalCacheWrite intentionally omitted — no longer used in denominator
								totalCost += m.usage.cost.total;
							}
						}

						// ── Context usage ──────────────────────────
						const contextUsage = ctx.getContextUsage();
						const contextWindow =
							contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
						const contextPctValue = contextUsage?.percent ?? 0;
						const contextPctStr = contextUsage == null || contextUsage.percent == null
							? "?%"
							: `${Math.round(contextPctValue)}%`;

						// Compute used abbrev like Claude: (pct/100) * window
						const usedTokens = Math.round((contextPctValue / 100) * contextWindow);
						const usedAbbrev = formatTokens(usedTokens);
						const windowAbbrev = formatTokens(contextWindow);

						const dots = generateDots(contextPctValue);
						const labelPctColor = pctColor(contextPctValue);
						const promptTotal = totalInput + totalCacheRead;
						const cacheHitStr = promptTotal > 0
							? `${color("CAC_LIGHT", ICON_CACHE_HITS)} ${color("CAC", ((totalCacheRead / promptTotal) * 100).toFixed(1) + "%")}`
							: `${color("CAC_LIGHT", ICON_CACHE_HITS)} ${color("CAC", "-")}`;

						const costFmt = totalCost.toFixed(2);

						const model = ctx.model;
						const modelId = model?.id ?? "no-model";
						const provider = model?.provider ?? "";

						const rawCwd = ctx.sessionManager.getCwd();
						let pwd = rawCwd || "";
						const home = process.env.HOME || process.env.USERPROFILE || "";
						if (home && pwd.startsWith(home)) {
							pwd = "~" + pwd.slice(home.length);
						}
						const branch = footerData.getGitBranch();

						const formatPwdLine = (path: string): string => {
							if (branch) {
								return `${color("CYAN_LIGHT", ICON_BRANCH)} ${color("CYAN", branch)}  ${color("YELLOW_LIGHT", ICON_FOLDER)} ${color("YELLOW", path)}`;
							}
							return `${color("YELLOW_LIGHT", ICON_FOLDER)} ${color("YELLOW", path)}`;
						};

						// ── Line 1: path with degradable subdirectory depth
						let pwdLine = formatPwdLine(pwd);

						// Build model display with always-show components
						const modelDisplayFinal = provider
							? `${color("MAGENTA_LIGHT", `(${provider})`)} ${color("MAGENTA", modelId)}`
							: color("MAGENTA", modelId);
						const modelBlock = `${modelDisplayFinal}  ${color("ORANGE_LIGHT", "\u{E28C}")} ${color("ORANGE", " " + pi.getThinkingLevel())}`;

						// Right-align model block on line 1
						const line1Full = pwdLine + "  " + modelBlock;
						if (visibleWidth(line1Full) > width) {
							// Trim subdirectories from the path, rightmost first, until it fits
							let dirParts = pwd.split("/");
							while (dirParts.length > 1) {
								// Remove the leftmost (highest) directory
								dirParts.shift();
								const trimmedPath = dirParts.length === 1 ? dirParts[0] : (dirParts[0] === "~" ? "~/" + dirParts.slice(1).join("/") : dirParts.join("/"));
								const trimmedPwd = formatPwdLine(trimmedPath);
								const testLine = trimmedPwd + "  " + modelBlock;
								if (visibleWidth(testLine) <= width) {
									pwdLine = trimmedPwd;
									break;
								}
							}
						}
						const pwdWidth = visibleWidth(pwdLine);
						const modelWidth = visibleWidth(modelBlock);
						const pwdGap = width - pwdWidth - modelWidth;
						const line1 = pwdGap >= 2
							? pwdLine + " ".repeat(pwdGap) + modelBlock
							: truncateToWidth(pwdLine + "  " + modelBlock, width, "...");

						// ── Line 2: two-column layout with priority degradation ─────
						// Left block: context icon + progress bar + percentage + ratio + tokens + tps
						const leftSegments: { text: string; width: number }[] = [
							// Rightmost in left block = most important (closest to gap)
							// Visual order: context icon, progress bar, percentage, ratio, tokens in, tokens out, ⚡ t/s
							// Hide priority (loop adds from end): tps ← tokens out ← tokens in ← ratio ← pct ← bar ← icon
							{ text: color("CTX", "\u{F0AF0}\u{F0B01}\u{F0B05}"), width: 0 },
							{ text: dots, width: 0 },
							{ text: `${labelPctColor}${contextPctStr}${C.RESET}`, width: 0 },
							{ text: color("TOK", `(${usedAbbrev} / ${windowAbbrev})`), width: 0 },
							{ text: `${color("TOK_LIGHT", ICON_INPUT)} ${color("TOK", formatTokens(totalInput))}`, width: 0 },
							{ text: `${color("TOK_LIGHT", ICON_OUTPUT)} ${color("TOK", formatTokens(totalOutput))}`, width: 0 },
							// ── Live tokens/sec (during streaming + 2s debounce) ──
							// Inline IIFE — returns empty string when hidden, so it consumes no space
							{ text: (() => {
								if (!(isStreaming || tpsDebounceTimer !== null) || streamOutputTokens <= 0) return "";
								const elapsedMs = Date.now() - streamStartTime;
								const seconds = elapsedMs / 1000;
								const tps = seconds > 0
									? (streamOutputTokens / seconds).toFixed(0)
									: "?";
								return `${color("TPS_ICON", "\u26A1")}${color("TPS", `${tps} t/s`)}`;
							})(), width: 0 },
						];

						// Right block: cache reads + cache hits + cost
						// Degradation order (leftmost first = most expendable): cache reads ← cache hits, cost always shown
						const rightSegments: { text: string; width: number }[] = [];
						rightSegments.push({ text: `${color("CAC_LIGHT", ICON_CACHE_READS)} ${color("CAC", formatTokens(totalCacheRead))}`, width: 0 });
						rightSegments.push({ text: cacheHitStr, width: 0 });
						rightSegments.push({ text: `${color("GREEN_LIGHT", ICON_COST)}${color("GREEN", costFmt)}`, width: 0 });

						const sep = " ";

						// Pre-compute widths
						for (const seg of leftSegments) seg.width = visibleWidth(seg.text);
						for (const seg of rightSegments) seg.width = visibleWidth(seg.text);

						// Build left block: add segments right-to-left (most important first) until it fits alongside the right block
						// Start with the full right block width
						const fullRightWidth = rightSegments.reduce((acc, s) => acc + (acc ? sep.length : 0) + s.width, 0);

						let attemptedLeft: { text: string; width: number }[] = [];
						let attemptedLeftWidth = 0;

						for (let i = leftSegments.length - 1; i >= 0; i--) {
							const seg = leftSegments[i];
							const testWidth = (attemptedLeftWidth > 0 ? attemptedLeftWidth + sep.length : 0) + seg.width;
							const combinedWithRight = testWidth + (fullRightWidth > 0 ? sep.length : 0) + fullRightWidth;
							if (combinedWithRight <= width) {
								attemptedLeft.unshift(seg);
								attemptedLeftWidth = testWidth;
							} else {
								break;
							}
						}

						// Now shrink right block if needed
						let activeRight = [...rightSegments];
						let activeRightWidth = activeRight.reduce((acc, s) => acc + (acc ? sep.length : 0) + s.width, 0);
						const totalWidth = attemptedLeftWidth + (attemptedLeftWidth > 0 && activeRightWidth > 0 ? sep.length : 0) + activeRightWidth;

						if (totalWidth > width) {
							// Drop segments from right block, leftmost first (most expendable)
							while (activeRight.length > 1 && totalWidth > width) {
								const removed = activeRight.shift()!;
								activeRightWidth -= removed.width;
								if (activeRight.length > 0) activeRightWidth -= sep.length;
								const newTotal = attemptedLeftWidth + (attemptedLeftWidth > 0 && activeRightWidth > 0 ? sep.length : 0) + activeRightWidth;
								if (newTotal <= width) break;
							}
						}

						const leftBlock = attemptedLeft.map(s => s.text).join(sep);
						const leftBlockWidth = visibleWidth(leftBlock);
						const rightBlock = activeRight.map(s => s.text).join(sep);
						const rightBlockWidth = visibleWidth(rightBlock);

						const combined = leftBlockWidth + rightBlockWidth;
						let line2: string;
						if (rightBlockWidth > 0) {
							const pad = combined <= width ? width - combined : 0;
							line2 = leftBlock + " ".repeat(pad) + rightBlock;
						} else {
							line2 = leftBlock + " ".repeat(width - leftBlockWidth);
						}

						const lines: string[] = [line1, line2];

						// Extension statuses on line 3 if space
						const extStatuses = footerData.getExtensionStatuses();
						if (extStatuses.size > 0) {
							const sorted = Array.from(extStatuses)
								.sort((a, b) => a[0].localeCompare(b[0]))
								.map(([, t]) => t);
							lines.push(truncateToWidth(sorted.join(" "), width, "..."));
						}
						return lines;
					},
				};
			},
		);
	});
}
