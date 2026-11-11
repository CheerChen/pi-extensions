import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ── Metric ─────────────────────────────────────────────────────────────────
// Reasoning tokens per assistant reply. Visible thinking text is not a common
// unit: Claude returns the raw reasoning, OpenAI Responses models only a
// summary (Codex: a <200-char title) next to an encrypted item. Token counts
// from usage.reasoning are comparable across providers, but some
// OpenAI-compatible providers report 0 for replies that carry thousands of
// chars of visible thinking, so a reply counts as whichever is larger: the
// reported count or the visible text at CHARS_PER_TOKEN (the median ratio on
// those providers; Claude's text is denser, but Claude always reports usage).
const CHARS_PER_TOKEN = 4;

// ── Thresholds ─────────────────────────────────────────────────────────────
// From local pi sessions (scripts/token_baseline.py). Normal reasoning models
// (GPT-5.6/6.1, Claude, GLM-5.2/5.3, Grok) vs overthinking ones (DeepSeek
// V4/V4.1 Flash, GLM-5.3 Flash); normal replies: p99 = 2,120, p99.9 = 6,054.

// Single reply (vertical: one huge chain of thought).
const REPLY_WARN = 4_000; // 0.2% of normal replies
const REPLY_ALERT = 8_000; // 0.04% of normal replies
const REPLY_CRITICAL = 12_000; // one normal reply ever

// Sliding window over the last replies (horizontal: many medium chains). A
// window, not a session total: a total grows with session length, so long
// normal sessions would cross any fixed line.
const WINDOW_REPLIES = 20;
const WINDOW_WARN = 20_000; // normal session-max window: p95 = 13,542
const WINDOW_ALERT = 30_000; // above every normal session seen (max 28,252)

// ── Messages ────────────────────────────────────────────────────────────────

const MSG_WARN =
  "Reply used {n} reasoning tokens. Normal replies stay under 4,000. May be overthinking — consider switching model or lowering reasoning effort if available.";

const MSG_ALERT =
  "Reply used {n} reasoning tokens. Normal replies stay under 8,000. Likely overthinking at current effort level. Switch model or lower reasoning effort if available.";

const MSG_CRITICAL =
  "Reply used {n} reasoning tokens. Over 12,000 is confirmed overthinking. Switch model now or lower reasoning effort if available.";

const MSG_WINDOW_WARN =
  "Last {replies} replies used {n} reasoning tokens. Sustained heavy reasoning — may be overthinking. Consider switching model or lowering reasoning effort if available.";

const MSG_WINDOW_ALERT =
  "Last {replies} replies used {n} reasoning tokens. Sustained heavy reasoning — likely overthinking at current effort level. Switch model or lower reasoning effort if available.";

const STATUS_KEY = "overthink-warning";
const STATUS_TTL_MS = 10_000;

type ReplyLevel = "none" | "warn" | "alert" | "critical";
type WindowLevel = "none" | "warn" | "alert";
const RANK = { none: 0, warn: 1, alert: 2, critical: 3 } as const;

// ── State ──────────────────────────────────────────────────────────────────

let maxReply = 0;
let replyLevel: ReplyLevel = "none";
let recent: number[] = []; // last WINDOW_REPLIES replies
let windowLevel: WindowLevel = "none";
let totalTokens = 0;
let replyCount = 0;

let statusTimer: ReturnType<typeof setTimeout> | undefined;

// ── Helpers ────────────────────────────────────────────────────────────────

function reasoningTokens(message: unknown): number {
  if (typeof message !== "object" || message === null) return 0;
  const m = message as Record<string, unknown>;
  const usage = m.usage as Record<string, unknown> | undefined;
  const reported = typeof usage?.reasoning === "number" ? usage.reasoning : 0;
  let chars = 0;
  if (Array.isArray(m.content)) {
    for (const block of m.content as Record<string, unknown>[]) {
      if (block?.type === "thinking" && typeof block.thinking === "string") chars += block.thinking.length;
    }
  }
  return Math.max(reported, Math.ceil(chars / CHARS_PER_TOKEN));
}

function replyLevelFor(n: number): ReplyLevel {
  if (n >= REPLY_CRITICAL) return "critical";
  if (n >= REPLY_ALERT) return "alert";
  if (n >= REPLY_WARN) return "warn";
  return "none";
}

function windowLevelFor(n: number): WindowLevel {
  if (n >= WINDOW_ALERT) return "alert";
  return n >= WINDOW_WARN ? "warn" : "none";
}

const windowSum = () => recent.reduce((a, b) => a + b, 0);

// Add one reply to every counter; returns the levels this reply reached.
function record(tokens: number): { reply: ReplyLevel; window: WindowLevel } {
  replyCount += 1;
  totalTokens += tokens;
  maxReply = Math.max(maxReply, tokens);
  recent.push(tokens);
  if (recent.length > WINDOW_REPLIES) recent.shift();
  return { reply: replyLevelFor(tokens), window: windowLevelFor(windowSum()) };
}

// Show a status entry that clears itself, so it never squats on the footer.
function flashStatus(ctx: { ui: { setStatus(k: string, v: string | undefined): void } }, msg: string) {
  if (statusTimer) clearTimeout(statusTimer);
  ctx.ui.setStatus(STATUS_KEY, msg);
  statusTimer = setTimeout(() => {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    statusTimer = undefined;
  }, STATUS_TTL_MS);
}

const fmt = (n: number) => n.toLocaleString("en-US");

// Filled share of the scale, like the quota meter but counting up toward a line.
function bar(value: number, max: number, width = 10): string {
  const filled = Math.min(width, Math.round((value / max) * width));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function detail(value: number, current: string, lines: [string, number][]): string {
  const max = lines[lines.length - 1][1];
  const next = lines.find(([, at]) => value < at);
  const tail = next ? `next ${next[0]} ${fmt(next[1])} (−${fmt(next[1] - value)})` : "all lines crossed";
  return `${bar(value, max)} ${fmt(value)} / ${fmt(max)} · ${current} · ${tail}`;
}

const label = (level: string) => (level === "none" ? "ok" : level);

function formatStats(): string {
  const reply = detail(maxReply, label(replyLevel), [
    ["warn", REPLY_WARN],
    ["alert", REPLY_ALERT],
    ["critical", REPLY_CRITICAL],
  ]);
  const window = detail(windowSum(), label(windowLevel), [
    ["warn", WINDOW_WARN],
    ["alert", WINDOW_ALERT],
  ]);
  return [
    "Overthink · this session (reasoning tokens)",
    `  Largest reply    ${reply}`,
    `  Last ${WINDOW_REPLIES} replies  ${window}`,
    `  Session          ${fmt(totalTokens)} over ${fmt(replyCount)} replies`,
  ].join("\n");
}

// ── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Rebuild state from the active branch, silently: no notify, no status.
  // Levels are set to what the history already reached, so only a further
  // escalation fires a new warning.
  const rebuild = (ctx: ExtensionContext) => {
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = undefined;
    ctx.ui.setStatus(STATUS_KEY, undefined);

    maxReply = 0;
    replyLevel = "none";
    recent = [];
    windowLevel = "none";
    totalTokens = 0;
    replyCount = 0;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;
      const reached = record(reasoningTokens(entry.message));
      if (RANK[reached.reply] > RANK[replyLevel]) replyLevel = reached.reply;
      if (RANK[reached.window] > RANK[windowLevel]) windowLevel = reached.window;
    }
  };

  pi.on("session_start", async (_event, ctx) => rebuild(ctx));
  pi.on("session_tree", async (_event, ctx) => rebuild(ctx)); // /tree changes the branch

  // Every reply counts, including ones without visible thinking: Codex and some
  // GLM replies report reasoning tokens but carry no thinking text.
  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;

    const tokens = reasoningTokens(event.message);
    const reached = record(tokens);

    // Only escalate — don't re-notify at the same or lower level.
    if (RANK[reached.window] > RANK[windowLevel]) {
      windowLevel = reached.window;
      const msg = (reached.window === "alert" ? MSG_WINDOW_ALERT : MSG_WINDOW_WARN)
        .replace("{replies}", String(recent.length))
        .replace("{n}", fmt(windowSum()));
      ctx.ui.notify(msg, "warning");
      if (reached.window === "alert") flashStatus(ctx, msg);
    }

    if (RANK[reached.reply] > RANK[replyLevel]) {
      replyLevel = reached.reply;
      const template = reached.reply === "critical" ? MSG_CRITICAL : reached.reply === "alert" ? MSG_ALERT : MSG_WARN;
      const msg = template.replace("{n}", fmt(tokens));
      ctx.ui.notify(msg, reached.reply === "critical" ? "error" : "warning");
      if (reached.reply !== "warn") flashStatus(ctx, msg);
    }
  });

  // On-demand view of the current stats, so a dismissed warning is not lost.
  // Same shape as /quotas: a title, then indented label + meter + detail lines.
  pi.registerCommand("overthink", {
    description: "Show reasoning-token stats and distance to each warning line",
    handler: async (_args, ctx) => {
      ctx.ui.notify(formatStats(), "info");
    },
  });
}
