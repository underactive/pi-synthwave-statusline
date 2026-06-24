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
	SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { CustomEditor, estimateTokens } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, KeybindingsManager, TUI } from "@earendil-works/pi-tui";
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

// ── Shimmer effect constants (Codex-style light sweep) ──────
const SHIMMER_INTERVAL = 80;          // ms (~12.5fps)
const SHIMMER_CYCLES = 3;             // number of full L→R sweeps before stopping
const SHIMMER_SWEEP_S = 2.0;          // seconds per full L→R sweep
const SHIMMER_BAND_HALF = 5.0;        // half-width of highlight band in chars
const SHIMMER_PADDING = 10;           // extra sweep padding so band enters/exits smoothly
const SHIMMER_BASE: [number, number, number] = [255, 0, 255];       // magenta (model text)
const SHIMMER_HIGHLIGHT: [number, number, number] = [155, 252, 250]; // light cyan (sweep band)

// ── Compaction progress constants ─────────────────────────────
const COMPACT_INTERVAL = 80;          // ms (~12.5fps)
const COMPACT_COMPLETE_MS = 400;      // ms to show 100% before clearing
const COMPACT_MIN_ESTIMATE_MS = 8_000;
const COMPACT_MAX_ESTIMATE_MS = 120_000;
const COMPACT_PROGRESS_CAP = 95;      // asymptotic cap until session_compact
const COMPACT_PRE_PHASE_CAP = 5;      // fake progress cap while waiting for session_before_compact
const COMPACT_PRE_ESTIMATE_MS = 15_000; // exponential ease toward 5%, then hold until main phase
const COMPACT_PRE_MAX_WAIT_MS = 120_000;  // stop pre-phase if session_before_compact never arrives

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
const CONTEXT_YELLOW_THRESHOLD = 40;
const CONTEXT_RED_THRESHOLD = 70;

function generateDots(percent: number): string {
	const filled = Math.min(NUM_DOTS, Math.max(0, Math.round((percent * NUM_DOTS) / 100)));
	let bar = "";
	for (let i = 0; i < filled; i++) bar += segColor(i, NUM_DOTS) + "\u258b"; // ▋
	bar += C.RESET + "\x1b[2m"; // dim
	for (let i = filled; i < NUM_DOTS; i++) bar += "\u2591"; // ░
	bar += C.RESET;
	return bar;
}

/** Magenta compaction bar — distinct from context usage thresholds */
function generateCompactionDots(percent: number): string {
	const filled = Math.min(NUM_DOTS, Math.max(0, Math.round((percent * NUM_DOTS) / 100)));
	let bar = "";
	for (let i = 0; i < filled; i++) bar += C.MAGENTA + "\u258b";
	bar += C.RESET + "\x1b[2m";
	for (let i = filled; i < NUM_DOTS; i++) bar += "\u2591";
	bar += C.RESET;
	return bar;
}

function estimateCompactionMs(preparation: SessionBeforeCompactEvent["preparation"]): number {
	const msgCount = preparation.messagesToSummarize.length + preparation.turnPrefixMessages.length;
	const parallelFactor = preparation.isSplitTurn && preparation.turnPrefixMessages.length > 0 ? 1.35 : 1;
	return Math.min(
		COMPACT_MAX_ESTIMATE_MS,
		Math.max(COMPACT_MIN_ESTIMATE_MS, (5_000 + msgCount * 400) * parallelFactor),
	);
}

/** Eased progress toward cap — real completion arrives via session_compact */
function compactionProgress(elapsedMs: number, estimatedMs: number, cap = COMPACT_PROGRESS_CAP): number {
	const t = 1 - Math.exp(-elapsedMs / (estimatedMs / 2.5));
	return Math.min(cap, Math.max(0, Math.round(t * cap)));
}

function preCompactionProgress(elapsedMs: number): number {
	if (elapsedMs >= COMPACT_PRE_ESTIMATE_MS) return COMPACT_PRE_PHASE_CAP;
	return compactionProgress(elapsedMs, COMPACT_PRE_ESTIMATE_MS, COMPACT_PRE_PHASE_CAP);
}

function isManualCompactCommand(text: string): boolean {
	const trimmed = text.trim();
	return trimmed === "/compact" || trimmed.startsWith("/compact ");
}

/** Sum chars/4 heuristic over session messages — matches pi's estimatedTokensAfter after compaction */
function estimateMessagesTokenCount(messages: AgentMessage[]): number {
	let tokens = 0;
	for (const message of messages) {
		tokens += estimateTokens(message);
	}
	return tokens;
}

interface ResolvedContextUsage {
	percent: number;
	tokens: number;
	contextWindow: number;
	isEstimated: boolean;
}

/** Authoritative usage when available; otherwise estimate from branch messages (post-compaction gap). */
function resolveContextUsage(ctx: {
	getContextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
	model?: { contextWindow: number } | null;
	sessionManager: { buildSessionContext(): { messages: AgentMessage[] } };
}, streamingTokenBonus = 0): ResolvedContextUsage {
	const contextUsage = ctx.getContextUsage();
	const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;

	if (contextUsage?.percent != null && contextUsage.tokens != null) {
		return {
			percent: contextUsage.percent,
			tokens: contextUsage.tokens,
			contextWindow,
			isEstimated: false,
		};
	}

	if (contextWindow <= 0) {
		return { percent: 0, tokens: 0, contextWindow, isEstimated: false };
	}

	const { messages } = ctx.sessionManager.buildSessionContext();
	const tokens = estimateMessagesTokenCount(messages) + streamingTokenBonus;
	const percent = Math.min(100, (tokens / contextWindow) * 100);
	return { tokens, percent, contextWindow, isEstimated: true };
}

/** Intercept /compact on Enter submit — Editor.onSubmit is a class field, so setter wrapping does not work */
class CompactAwareEditor extends CustomEditor {
	private onCompactSubmit: () => void;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		onCompactSubmit: () => void,
	) {
		super(tui, theme, keybindings);
		this.onCompactSubmit = onCompactSubmit;
	}

	override handleInput(data: string): void {
		if (
			!this.disableSubmit
			&& this.keybindings.matches(data, "tui.input.submit")
			&& isManualCompactCommand(this.getText())
		) {
			this.onCompactSubmit();
		}
		super.handleInput(data);
	}
}

// ── Helpers ────────────────────────────────────────────────────

/** Color for a segment at position i (0-indexed) out of NUM_DOTS.
 *  <yellow threshold = white, yellow threshold to <red threshold = yellow, red threshold+ = red
 */
function segColor(pos: number, total: number): string {
	const segPct = ((pos + 1) / total) * 100;
	if (segPct >= CONTEXT_RED_THRESHOLD) return "\x1b[38;2;255;105;180m"; // hot pink (Synthwave 84)
	if (segPct >= CONTEXT_YELLOW_THRESHOLD) return "\x1b[38;2;54;249;246m"; // electric cyan (Synthwave 84)
	return C.CTX;
}

/** Color for the overall percentage label */
function pctColor(pct: number): string {
	if (pct >= CONTEXT_RED_THRESHOLD) return "\x1b[38;2;255;105;180m";
	if (pct >= CONTEXT_YELLOW_THRESHOLD) return "\x1b[38;2;54;249;246m";
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

/** Codex-style light-sweep shimmer: a cosine-falloff highlight band sweeps L→R across text */
function shimmerString(text: string, elapsedMs: number): string {
	const chars = [...text];
	if (chars.length === 0) return "";
	const period = chars.length + SHIMMER_PADDING * 2;
	const elapsedS = elapsedMs / 1000;
	const pos = ((elapsedS % SHIMMER_SWEEP_S) / SHIMMER_SWEEP_S) * period;

	return chars
		.map((ch, i) => {
			const dist = Math.abs((i + SHIMMER_PADDING) - pos);
			const t = dist <= SHIMMER_BAND_HALF
				? 0.5 * (1 + Math.cos(Math.PI * dist / SHIMMER_BAND_HALF))
				: 0;
			const alpha = t * 0.9;
			const r = Math.round(SHIMMER_HIGHLIGHT[0] * alpha + SHIMMER_BASE[0] * (1 - alpha));
			const g = Math.round(SHIMMER_HIGHLIGHT[1] * alpha + SHIMMER_BASE[1] * (1 - alpha));
			const b = Math.round(SHIMMER_HIGHLIGHT[2] * alpha + SHIMMER_BASE[2] * (1 - alpha));
			const bold = t > 0.2 ? "\x1b[1m" : "";
			return `${bold}\x1b[38;2;${r};${g};${b}m${ch}\x1b[22m`;
		})
		.join("") + C.RESET;
}


// ── Extension ──────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (event, ctx) => {
		if (!ctx.hasUI) return;

		// ── Streaming state for live tokens/sec ────────────────────
		let isStreaming = false;
		let streamStartTime = 0;
		let streamOutputTokens = 0;
		let tpsDebounceTimer: ReturnType<typeof setTimeout> | null = null;
		let requestFooterRender: (() => void) | null = null;

		// ── Shimmer state for model name animation ─────────────
		let shimmerActiveSince = 0;
		let shimmerTimer: ReturnType<typeof setInterval> | null = null;

		// ── Compaction progress state ───────────────────────────
		let isCompacting = false;
		let compactionStartMs = 0;
		let compactionEstimatedMs = COMPACT_MIN_ESTIMATE_MS;
		let compactionPct = 0;
		let compactionTimer: ReturnType<typeof setInterval> | null = null;
		let compactionCompleteTimer: ReturnType<typeof setTimeout> | null = null;
		let compactionAbortCleanup: (() => void) | null = null;

		const stopCompactionProgress = () => {
			if (compactionTimer) {
				clearInterval(compactionTimer);
				compactionTimer = null;
			}
			if (compactionCompleteTimer) {
				clearTimeout(compactionCompleteTimer);
				compactionCompleteTimer = null;
			}
			if (compactionAbortCleanup) {
				compactionAbortCleanup();
				compactionAbortCleanup = null;
			}
			isCompacting = false;
			compactionPct = 0;
		};

		const startPreCompactionProgress = () => {
			const entries = ctx.sessionManager?.getEntries() ?? [];
			const messageCount = entries.filter((e) => e.type === "message").length;
			if (messageCount < 2) return;
			// Already in main compaction phase (past the 5% pre-phase)
			if (isCompacting && compactionPct > COMPACT_PRE_PHASE_CAP) return;
			// Already showing pre-phase progress
			if (isCompacting && compactionPct <= COMPACT_PRE_PHASE_CAP) return;

			if (compactionTimer) {
				clearInterval(compactionTimer);
				compactionTimer = null;
			}
			if (compactionCompleteTimer) {
				clearTimeout(compactionCompleteTimer);
				compactionCompleteTimer = null;
			}
			if (compactionAbortCleanup) {
				compactionAbortCleanup();
				compactionAbortCleanup = null;
			}

			isCompacting = true;
			compactionStartMs = Date.now();
			compactionEstimatedMs = COMPACT_PRE_ESTIMATE_MS;
			compactionPct = 0;
			compactionTimer = setInterval(() => {
				const elapsed = Date.now() - compactionStartMs;
				if (elapsed > COMPACT_PRE_MAX_WAIT_MS) {
					stopCompactionProgress();
					requestFooterRender?.();
					return;
				}
				compactionPct = preCompactionProgress(elapsed);
				requestFooterRender?.();
			}, COMPACT_INTERVAL);
			requestFooterRender?.();
		};

		const finishCompactionProgress = () => {
			if (compactionTimer) {
				clearInterval(compactionTimer);
				compactionTimer = null;
			}
			if (compactionAbortCleanup) {
				compactionAbortCleanup();
				compactionAbortCleanup = null;
			}
			isCompacting = true;
			compactionPct = 100;
			requestFooterRender?.();
			compactionCompleteTimer = setTimeout(() => {
				compactionCompleteTimer = null;
				stopCompactionProgress();
				requestFooterRender?.();
			}, COMPACT_COMPLETE_MS);
		};

		const startCompactionProgress = (preparation: SessionBeforeCompactEvent["preparation"]) => {
			const carriedPct = isCompacting ? compactionPct : 0;
			if (compactionTimer) {
				clearInterval(compactionTimer);
				compactionTimer = null;
			}
			if (compactionCompleteTimer) {
				clearTimeout(compactionCompleteTimer);
				compactionCompleteTimer = null;
			}
			isCompacting = true;
			compactionStartMs = Date.now();
			compactionEstimatedMs = estimateCompactionMs(preparation);
			compactionPct = carriedPct;
			compactionTimer = setInterval(() => {
				const elapsed = Date.now() - compactionStartMs;
				const mainPct = compactionProgress(elapsed, compactionEstimatedMs);
				compactionPct = Math.max(carriedPct, mainPct);
				requestFooterRender?.();
			}, COMPACT_INTERVAL);
			requestFooterRender?.();
		};

		pi.on("session_before_compact", async (event: SessionBeforeCompactEvent) => {
			startCompactionProgress(event.preparation);
			const onAbort = () => {
				stopCompactionProgress();
				requestFooterRender?.();
			};
			event.signal.addEventListener("abort", onAbort);
			compactionAbortCleanup = () => event.signal.removeEventListener("abort", onAbort);
		});

		if (ctx.mode === "tui") {
			ctx.ui.setEditorComponent((tui, theme, keybindings) =>
				new CompactAwareEditor(tui, theme, keybindings, startPreCompactionProgress),
			);
		}

		pi.on("input", async (event) => {
			if (isManualCompactCommand(event.text)) startPreCompactionProgress();
		});

		const originalCompact = ctx.compact.bind(ctx);
		ctx.compact = (options) => {
			startPreCompactionProgress();
			originalCompact(options);
		};

		pi.on("session_compact", async () => {
			finishCompactionProgress();
		});

		pi.on("session_shutdown", () => {
			if (tpsDebounceTimer) {
				clearTimeout(tpsDebounceTimer);
				tpsDebounceTimer = null;
			}
			if (shimmerTimer) {
				clearInterval(shimmerTimer);
				shimmerTimer = null;
			}
			ctx.ui.setEditorComponent(undefined);
			stopCompactionProgress();
		});

		/** (Re)start the shimmer sweep — called from setFooter init and model_select */
		const startShimmer = () => {
			shimmerActiveSince = Date.now();
			if (shimmerTimer) clearInterval(shimmerTimer);
			shimmerTimer = setInterval(() => {
				const elapsed = Date.now() - shimmerActiveSince;
				if (elapsed > SHIMMER_CYCLES * SHIMMER_SWEEP_S * 1000) {
					clearInterval(shimmerTimer!);
					shimmerTimer = null;
				}
				requestFooterRender?.();
			}, SHIMMER_INTERVAL);
		};

		pi.on("model_select", () => {
			startShimmer();
		});

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

				// Start shimmer effect for model name on /new and /reload only
				if (event.reason === "new" || event.reason === "reload") {
					startShimmer();
				}


				return {
					dispose: () => {
						unsub();
						if (shimmerTimer) {
							clearInterval(shimmerTimer);
							shimmerTimer = null;
						}
						stopCompactionProgress();
					},
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
						const streamingBonus = contextUsage?.percent == null && (isStreaming || tpsDebounceTimer !== null)
							? streamOutputTokens
							: 0;
						const resolvedContext = resolveContextUsage(ctx, streamingBonus);
						const contextPctValue = resolvedContext.percent;
						const contextWindow = resolvedContext.contextWindow;
						const contextPctStr = `${Math.round(contextPctValue)}%`;

						const usedTokens = resolvedContext.isEstimated
							? resolvedContext.tokens
							: Math.round((contextPctValue / 100) * contextWindow);
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
						const modelRawText = provider ? `(${provider}) ${modelId}` : modelId;
						const isShimmering = shimmerTimer !== null;
						const elapsed = Date.now() - shimmerActiveSince;
						const modelDisplayFinal = isShimmering
							? shimmerString(modelRawText, elapsed)
							: (provider
								? `${color("MAGENTA_LIGHT", `(${provider})`)} ${color("MAGENTA", modelId)}`
								: color("MAGENTA", modelId));
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

						// ── Line 2: context stats, or compaction progress when active ─
						let line2: string;
						if (isCompacting) {
							const compactBar = generateCompactionDots(compactionPct);
							const compactLeft = `${color("MAGENTA_LIGHT", "Compacting")}  ${compactBar}  ${color("MAGENTA", `${compactionPct}%`)}`;
							const costBlock = `${color("GREEN_LIGHT", ICON_COST)}${color("GREEN", costFmt)}`;
							const compactLeftWidth = visibleWidth(compactLeft);
							const costWidth = visibleWidth(costBlock);
							if (compactLeftWidth + costWidth + 2 <= width) {
								line2 = compactLeft + " ".repeat(width - compactLeftWidth - costWidth) + costBlock;
							} else {
								line2 = truncateToWidth(compactLeft, width, "...");
							}
						} else {
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
						if (rightBlockWidth > 0) {
							const pad = combined <= width ? width - combined : 0;
							line2 = leftBlock + " ".repeat(pad) + rightBlock;
						} else {
							line2 = leftBlock + " ".repeat(width - leftBlockWidth);
						}
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
