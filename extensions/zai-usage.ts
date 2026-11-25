/**
 * zai-usage.ts — show your **real server-side quota** for Zhipu GLM / Z.ai Coding Plan
 * inline in pi's footer status bar.
 *
 * Zhipu/Z.ai actually exposes a quota endpoint (per cc-switch's coding_plan implementation):
 *   GET {base}/api/monitor/usage/quota/limit
 *   Authorization: Bearer <api_key>   ← tested: both the CN site (bare key / Bearer) and the
 *                                       international site accept Bearer; always use Bearer.
 *   Content-Type: application/json
 *   Accept-Language: en-US,en
 * Response data.limits[] (unit semantics from the z.ai frontend source):
 *   - TOKENS_LIMIT unit=3: 5-hour rolling token window (main badge)
 *   - TOKENS_LIMIT unit=6: weekly quota (some plans / international site only; shown in /usage)
 *   - TIME_LIMIT   unit=5: tools/search (monthly)
 * This extension uses TOKENS_LIMIT(unit=3) as the main badge — accurate across devices,
 * with reset countdown.
 * When the API is unreachable, falls back to scanning local session JSONLs for a local
 * approximation (distinguished by a ~ prefix).
 *
 * Rendering: takes over the footer with ctx.ui.setFooter(), **single-line layout**
 * `pwd  stats ···· model`, badge injected between the context-window % and "(auto)":
 *   `~/proj (main)  ↑1k ↓227 0.6%/200K zai 5h 28% (auto)        glm-5.1`
 * setStatus() pins badges to a separate extension status row that can't merge into the
 * stats line — hence setFooter.
 *
 * Environment variables:
 *   PI_USAGE_BASE      quota endpoint host (default auto per provider: zai-coding-cn→bigmodel.cn, else z.ai)
 *   PI_USAGE_WINDOW_H  rolling window hours for the local fallback (default 5)
 *   PI_USAGE_PROVIDER  provider substring match for the local fallback
 *
 * Command:
 *   /usage   toggle the quota detail popup (plan tier / 5h tokens / tool quotas / reset times)
 */
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const WIDGET_KEY = "zai-usage-detail";

// ── Compact number formatting ────────────────────────────────────────────
function fmt(n: number): string {
	if (n < 1000) return `${Math.round(n)}`;
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
	return `${(n / 1_000_000).toFixed(2)}M`;
}
/** Footer token format (mirrors pi's default footer formatTokens) */
function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}
/** cwd → footer display (home replaced with ~) */
function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const resolvedCwd = path.resolve(cwd);
	const resolvedHome = path.resolve(home);
	const rel = path.relative(resolvedHome, resolvedCwd);
	const inside =
		rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
	if (!inside) return cwd;
	return rel === "" ? "~" : `~${path.sep}${rel}`;
}

// ── Server-side quota ──────────────────────────────────────────────
interface LimitTier {
	percentage: number;
	resetMs: number | null;
}
interface Quota {
	level: string | null; // plan tier: lite / pro / ...
	tokens: LimitTier | null; // TOKENS_LIMIT, unit=3 (5h token window) — main badge
	weekly: LimitTier | null; // TOKENS_LIMIT, unit=6 (weekly quota; some plans / intl site only)
	time: LimitTier | null; // TIME_LIMIT, unit=5 (tools/search, monthly)
	timeDetails?: { model: string; usage: number }[];
	queriedAt: number;
}

/** Fetch the quota endpoint; parse TOKENS_LIMIT(unit=3) and TIME_LIMIT. Uses Bearer auth. */
async function fetchQuota(base: string, apiKey: string): Promise<Quota | null> {
	let resp: Response;
	try {
		resp = await fetch(`${base}/api/monitor/usage/quota/limit`, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
				"Accept-Language": "en-US,en",
			},
			signal: AbortSignal.timeout(15000),
		});
	} catch {
		return null;
	}
	if (resp.status === 401 || resp.status === 403) return null;
	if (!resp.ok) return null;
	let body: any;
	try {
		body = await resp.json();
	} catch {
		return null;
	}
	if (body?.success === false) return null;
	const data = body?.data;
	if (!data) return null;

	let tokens: LimitTier | null = null;
	let weekly: LimitTier | null = null;
	let time: LimitTier | null = null;
	let timeDetails: { model: string; usage: number }[] | undefined;
	for (const lim of data.limits ?? []) {
		if (lim.type === "TOKENS_LIMIT" && lim.unit === 3 && !tokens) {
			tokens = { percentage: Number(lim.percentage) || 0, resetMs: lim.nextResetTime ?? null };
		} else if (lim.type === "TOKENS_LIMIT" && lim.unit === 6 && !weekly) {
			weekly = { percentage: Number(lim.percentage) || 0, resetMs: lim.nextResetTime ?? null };
		} else if (lim.type === "TIME_LIMIT" && !time) {
			time = { percentage: Number(lim.percentage) || 0, resetMs: lim.nextResetTime ?? null };
			timeDetails = (lim.usageDetails ?? []).map((d: any) => ({
				model: String(d.modelCode ?? "?"),
				usage: Number(d.usage) || 0,
			}));
		}
	}
	return {
		level: data.level ? String(data.level) : null,
		tokens,
		weekly,
		time,
		timeDetails,
		queriedAt: Date.now(),
	};
}

// ── Local fallback: scan session JSONLs ────────────────────────────────
interface LocalTotals {
	total: number;
	input: number;
	output: number;
	cache: number;
}
function computeWindowLocal(globalRoot: string, windowMs: number, providerMatch: string): LocalTotals {
	const cutoff = Date.now() - windowMs;
	let total = 0,
		input = 0,
		output = 0,
		cache = 0;
	let projectDirs: string[] = [];
	try {
		projectDirs = fs
			.readdirSync(globalRoot, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => path.join(globalRoot, d.name));
	} catch {
		return { total, input, output, cache };
	}
	for (const dir of projectDirs) {
		let files: string[] = [];
		try {
			files = fs
				.readdirSync(dir)
				.filter((f) => f.endsWith(".jsonl"))
				.map((f) => path.join(dir, f));
		} catch {
			continue;
		}
		for (const file of files) {
			let stat;
			try {
				stat = fs.statSync(file);
			} catch {
				continue;
			}
			if (stat.mtimeMs < cutoff) continue;
			let content: string;
			try {
				content = fs.readFileSync(file, "utf8");
			} catch {
				continue;
			}
			for (const line of content.split("\n")) {
				const t = line.trim();
				if (!t) continue;
				let e: any;
				try {
					e = JSON.parse(t);
				} catch {
					continue;
				}
				if (e.type !== "message") continue;
				const m = e.message;
				if (!m || m.role !== "assistant") continue;
				if (!(typeof m.provider === "string" && m.provider.includes(providerMatch))) continue;
				const ts =
					typeof e.timestamp === "string"
						? Date.parse(e.timestamp)
						: typeof m.timestamp === "number"
							? m.timestamp
							: 0;
				if (!ts || ts < cutoff) continue;
				const u = m.usage || {};
				input += u.input || 0;
				output += u.output || 0;
				cache += (u.cacheRead || 0) + (u.cacheWrite || 0);
				total += u.totalTokens ?? (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
			}
		}
	}
	return { total, input, output, cache };
}

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | undefined;
	let widgetOpen = false;
	let capturedTui: any;

	const windowH = Number(process.env.PI_USAGE_WINDOW_H ?? 5) || 5;
	const windowMs = windowH * 3600 * 1000;

	let quota: Quota | null = null;
	let local: LocalTotals | null = null; // local fallback
	let lastFetch = 0;
	let fetching = false;
	let autoCompact: boolean | undefined;

	function providerMatch(ctx: any): string {
		return process.env.PI_USAGE_PROVIDER ?? ctx?.model?.provider ?? "zai";
	}
	function globalRoot(ctx: any): string {
		return path.dirname(ctx.sessionManager.getSessionDir());
	}
	function quotaBase(ctx: any): string {
		if (process.env.PI_USAGE_BASE) return process.env.PI_USAGE_BASE;
		const prov = String(ctx?.model?.provider ?? "");
		// zai-coding-cn / contains bigmodel → CN site; otherwise international site
		if (prov.includes("cn") || prov.includes("bigmodel")) return "https://open.bigmodel.cn";
		return "https://api.z.ai";
	}

	async function refreshQuota(ctx: any): Promise<void> {
		if (fetching) return;
		// min 30s between fetches so message_end doesn't hammer the API
		if (Date.now() - lastFetch < 30_000 && quota) return;
		fetching = true;
		lastFetch = Date.now();
		try {
			const provider = ctx?.model?.provider;
			let key: string | undefined;
			try {
				key = await ctx.modelRegistry?.getApiKeyForProvider?.(provider);
			} catch {
				/* ignore */
			}
			if (!key) {
				// fallback: read auth.json directly
				try {
					const auth = JSON.parse(
						fs.readFileSync(path.join(path.dirname(globalRoot(ctx)), "auth.json"), "utf8"),
					);
					key = auth?.[provider]?.key;
				} catch {
					/* ignore */
				}
			}
			if (key) {
				const q = await fetchQuota(quotaBase(ctx), key);
				if (q) quota = q;
			}
			// local fallback is always refreshed (feeds /usage details and the API-failure badge)
			local = computeWindowLocal(globalRoot(ctx), windowMs, providerMatch(ctx));
		} catch {
			/* ignore */
		} finally {
			fetching = false;
			capturedTui?.requestRender();
			if (widgetOpen) renderWidget(ctx);
		}
	}

	function readAutoCompact(ctx: any): boolean {
		if (autoCompact !== undefined) return autoCompact;
		let enabled = true;
		try {
			const agentDir = path.dirname(globalRoot(ctx));
			for (const f of [path.join(agentDir, "settings.json"), path.join(ctx.cwd, ".pi", "settings.json")]) {
				if (fs.existsSync(f)) {
					const s = JSON.parse(fs.readFileSync(f, "utf8"));
					if (s?.compaction?.enabled !== undefined) enabled = !!s.compaction.enabled;
				}
			}
		} catch {
			/* default true */
		}
		autoCompact = enabled;
		return enabled;
	}

	/** Badge (colored) for the stats line; undefined = omit while quota isn't ready */
	function zaiBadge(ctx: any, theme: any): string | undefined {
		if (quota?.tokens) {
			const pct = quota.tokens.percentage;
			const color = pct >= 90 ? "error" : pct >= 70 ? "warning" : "success";
			return theme.fg(color, `zai ${windowH}h ${Math.round(pct)}%`);
		}
		if (local && local.total > 0) return `zai ${windowH}h ~${fmt(local.total)}`; // ~ marks a local estimate
		return undefined; // loading/failed: omit the badge
	}

	/** Single-line footer: `pwd  stats ···· model`; the zai badge goes between the window % and "(auto)" */
	function renderFooter(ctx: any, theme: any, footerData: any, width: number): string[] {
		const state: any = { model: ctx.model, thinkingLevel: ctx.thinkingLevel };
		let inT = 0,
			outT = 0,
			cacheRead = 0,
			cacheWrite = 0,
			cost = 0;
		let latestCacheHitRate: number | undefined;
		try {
			for (const e of ctx.sessionManager.getEntries()) {
				if (e.type === "message" && e.message?.role === "assistant") {
					const u = e.message.usage || {};
					inT += u.input || 0;
					outT += u.output || 0;
					cacheRead += u.cacheRead || 0;
					cacheWrite += u.cacheWrite || 0;
					cost += u.cost?.total || 0;
					const p = (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
					latestCacheHitRate = p > 0 ? ((u.cacheRead || 0) / p) * 100 : undefined;
				} else if (e.type === "message" && e.message?.role === "toolResult" && e.message?.usage) {
					const u = e.message.usage;
					inT += u.input || 0;
					outT += u.output || 0;
					cacheRead += u.cacheRead || 0;
					cacheWrite += u.cacheWrite || 0;
					cost += u.cost?.total || 0;
				} else if ((e.type === "branch_summary" || e.type === "compaction") && e.usage) {
					const u = e.usage;
					inT += u.input || 0;
					outT += u.output || 0;
					cacheRead += u.cacheRead || 0;
					cacheWrite += u.cacheWrite || 0;
					cost += u.cost?.total || 0;
				}
			}
		} catch {
			/* ignore */
		}
		const contextUsage = ctx.getContextUsage?.();
		const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextPercent =
			contextUsage?.percent !== null && contextUsage?.percent !== undefined
				? contextPercentValue.toFixed(1)
				: "?";

		const pwdBase = formatCwdForFooter(ctx.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);
		const branch = footerData.getGitBranch();
		const sessionName = ctx.sessionManager.getSessionName?.();
		const pwdSuffix = `${branch ? ` (${branch})` : ""}${sessionName ? ` • ${sessionName}` : ""}`;

		const statsHead: string[] = [];
		const statsCache: string[] = []; // cache details — dropped first when the line gets tight
		const statsTail: string[] = [];
		if (inT) statsHead.push(`↑${formatTokens(inT)}`);
		if (outT) statsHead.push(`↓${formatTokens(outT)}`);
		if (cacheRead) statsCache.push(`R${formatTokens(cacheRead)}`);
		if (cacheWrite) statsCache.push(`W${formatTokens(cacheWrite)}`);
		if ((cacheRead > 0 || cacheWrite > 0) && latestCacheHitRate !== undefined) {
			statsCache.push(`CH${latestCacheHitRate.toFixed(1)}%`);
		}
		const usingSubscription = state.model ? state.model.provider === "kimi-coding" : false;
		if (cost || usingSubscription) statsTail.push(`$${cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);

		// context percentage: `pct/window [zai] (auto)`
		const autoIndicator = readAutoCompact(ctx) ? " (auto)" : "";
		const windowStr =
			contextPercent === "?"
				? `?/${formatTokens(contextWindow)}`
				: `${contextPercent}%/${formatTokens(contextWindow)}`;
		const badge = zaiBadge(ctx, theme);
		const contextPercentDisplay = badge ? `${windowStr} ${badge}${autoIndicator}` : `${windowStr}${autoIndicator}`;

		let contextPercentStr: string;
		if (contextPercentValue > 90) contextPercentStr = theme.fg("error", contextPercentDisplay);
		else if (contextPercentValue > 70) contextPercentStr = theme.fg("warning", contextPercentDisplay);
		else contextPercentStr = contextPercentDisplay;
		statsTail.push(contextPercentStr);
		if (process.env.PI_EXPERIMENTAL === "1") {
			statsTail.push(`${theme.fg("dim", "•")} ${theme.bold(theme.fg("warning", "xp"))}`);
		}
		let statsLeft = [...statsHead, ...statsCache, ...statsTail].join(" ");
		const statsSlim = [...statsHead, ...statsTail].join(" "); // same line with cache stats dropped

		// right side: model name (+ thinking / provider)
		const modelName = state.model?.id || "no-model";
		let rightSideWithoutProvider = modelName;
		if (state.model?.reasoning) {
			const thinkingLevel = state.thinkingLevel || "off";
			rightSideWithoutProvider =
				thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
		}
		let rightSide = rightSideWithoutProvider;
		if (footerData.getAvailableProviderCount() > 1 && state.model) {
			rightSide = `(${state.model.provider}) ${rightSideWithoutProvider}`;
		}

		// ── single-line footer: `pwd  stats ···· model` ──
		// Degrade progressively when the line is tight — most disposable first:
		//   provider prefix → path detail (full → last 2 segments → last segment) →
		//   thinking suffix → branch/session suffix → whole path → cache stats → model name.
		// Core stats (in/out/cost/context% + zai badge) stay intact; no mid-word "..." —
		// pieces shrink or disappear instead, freeing room for the information that matters.
		const sep = "  ";
		const minPad = 2;
		const fits = (p: string, s: string, r: string) =>
			(p === "" ? 0 : visibleWidth(p) + sep.length) + visibleWidth(s) + minPad + visibleWidth(r) <= width;

		// path-only variants of pwdBase: full → last 2 segments → last segment
		const segs = pwdBase.split(/[\\/]+/).filter(Boolean);
		const psep = pwdBase.includes("\\") ? "\\" : "/";
		const last1 = segs.length ? segs[segs.length - 1] : "";
		const last2 = segs.length > 2 ? segs.slice(-2).join(psep) : "";

		let pwdStr = pwdBase + pwdSuffix;
		// 1) drop provider prefix
		if (!fits(pwdStr, statsLeft, rightSide)) rightSide = rightSideWithoutProvider;
		// 2) shrink path, keeping the branch/session suffix
		if (!fits(pwdStr, statsLeft, rightSide) && last2) pwdStr = last2 + pwdSuffix;
		if (!fits(pwdStr, statsLeft, rightSide)) pwdStr = last1 + pwdSuffix;
		// 3) drop thinking suffix, keep the bare model name
		if (!fits(pwdStr, statsLeft, rightSide) && rightSide !== modelName) rightSide = modelName;
		// 4) drop branch/session suffix
		if (!fits(pwdStr, statsLeft, rightSide)) pwdStr = last1;
		// 5) drop the path entirely — stats get the room
		if (!fits(pwdStr, statsLeft, rightSide)) pwdStr = "";
		// 6) drop cache stats (R/W/CH) before touching the model name
		if (!fits(pwdStr, statsLeft, rightSide) && statsSlim.length < statsLeft.length) statsLeft = statsSlim;
		// 7) still not fitting → truncate/drop the model name
		const leftW = pwdStr === "" ? visibleWidth(statsLeft) : visibleWidth(pwdStr) + sep.length + visibleWidth(statsLeft);
		if (leftW + minPad + visibleWidth(rightSide) > width) {
			const availForRight = width - leftW - minPad;
			rightSide = availForRight > 4 ? truncateToWidth(rightSide, availForRight, "") : "";
		}
		const rightW = visibleWidth(rightSide);

		// coloring: pwd / token stats dim, context % keeps its own color
		const pwdColored = pwdStr === "" ? "" : theme.fg("dim", pwdStr) + sep;
		const statsColored = theme.fg("dim", statsLeft);
		const rightColored = rightW === 0 ? "" : theme.fg("dim", rightSide);
		const pad = " ".repeat(Math.max(minPad, width - leftW - rightW));
		const lines = [pwdColored + statsColored + pad + rightColored];

		const extensionStatuses = footerData.getExtensionStatuses();
		if (extensionStatuses.size > 0) {
			const others = Array.from(extensionStatuses.entries())
				.filter(([key]) => key !== "zai-usage")
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim());
			if (others.length > 0) lines.push(truncateToWidth(others.join(" "), width, theme.fg("dim", "...")));
		}
		return lines;
	}

	function setupFooter(ctx: any): void {
		ctx.ui.setFooter((tui: any, theme: any, footerData: any) => {
			capturedTui = tui;
			const unsub = footerData.onBranchChange(() => tui.requestRender());
			return {
				dispose: unsub,
				invalidate() {},
				render: (width: number) => renderFooter(ctx, theme, footerData, width),
			};
		});
	}

	function renderWidget(ctx: any): void {
		if (!quota && !local) return;
		const th = ctx.ui.theme;
		const lines: string[] = [];
		lines.push(th.fg("accent", `zai · Zhipu GLM Coding Plan quota (${quotaBase(ctx)})`));
		if (quota?.level) lines.push(th.fg("dim", `Plan: ${quota.level}`));
		if (quota?.tokens) {
			const color = quota.tokens.percentage >= 90 ? "error" : quota.tokens.percentage >= 70 ? "warning" : "success";
			lines.push(th.fg(color, `5h token window: ${Math.round(quota.tokens.percentage)}% used`));
			if (quota.tokens.resetMs) {
				const mins = Math.max(0, Math.round((quota.tokens.resetMs - Date.now()) / 60000));
				lines.push(th.fg("dim", `  resets: ${new Date(quota.tokens.resetMs).toLocaleString()} (~${mins} min left)`));
			}
		} else {
			lines.push(th.fg("warning", "5h token window: API unavailable (local estimate only)"));
		}
		if (quota?.weekly) {
			const color = quota.weekly.percentage >= 90 ? "error" : quota.weekly.percentage >= 70 ? "warning" : "success";
			lines.push(th.fg(color, `Weekly quota: ${Math.round(quota.weekly.percentage)}% used`));
			if (quota.weekly.resetMs) {
				const days = Math.max(0, Math.round((quota.weekly.resetMs - Date.now()) / 86400000));
				lines.push(th.fg("dim", `  resets: ${new Date(quota.weekly.resetMs).toLocaleString()} (~${days}d left)`));
			}
		}
		if (quota?.time) {
			const color = quota.time.percentage >= 90 ? "error" : quota.time.percentage >= 70 ? "warning" : "success";
			lines.push(th.fg(color, `Tools/search quota: ${Math.round(quota.time.percentage)}% used`));
			if (quota.timeDetails?.length) {
				lines.push(th.fg("dim", "  " + quota.timeDetails.map((d) => `${d.model} ${d.usage}`).join(" · ")));
			}
		}
		if (local && local.total > 0) {
			lines.push(
				th.fg(
					"dim",
					`Local est. (~): ${fmt(local.total)} tok  in ${fmt(local.input)} out ${fmt(local.output)} cache ${fmt(local.cache)}`,
				),
			);
		}
		lines.push(th.fg("muted", "Source: Zhipu /api/monitor/usage/quota/limit · /usage to close"));
		ctx.ui.setWidget(WIDGET_KEY, lines);
	}

	let lastCtx: any;

	pi.on("session_start", (_e, ctx) => {
		lastCtx = ctx;
		if (ctx.mode !== "tui") return;
		setupFooter(ctx);
		refreshQuota(ctx);
		if (!timer) {
			// periodic refresh: rolling window slides / quota changes over time
			timer = setInterval(() => {
				if (lastCtx) refreshQuota(lastCtx);
			}, 60_000);
		}
	});

	pi.on("message_end", (_e, ctx) => {
		lastCtx = ctx;
		refreshQuota(ctx);
	});

	pi.on("session_shutdown", () => {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
		widgetOpen = false;
	});

	pi.registerCommand("usage", {
		description: "Toggle Zhipu Coding Plan quota details",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("This command is only available in the interactive TUI", "info");
				return;
			}
			widgetOpen = !widgetOpen;
			if (!widgetOpen) {
				ctx.ui.setWidget(WIDGET_KEY, undefined);
				ctx.ui.notify("Quota details closed", "info");
				return;
			}
			await refreshQuota(ctx);
			renderWidget(ctx);
		},
	});
}
