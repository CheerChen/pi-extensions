import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Thresholds ─────────────────────────────────────────────────────────────
// Derived from a 260-session analysis (pi + devin + copilot) comparing normal
// reasoning models (GPT-5.6, GLM-5.2, Claude Opus 4.8) against overthinking
// models (DeepSeek V4/V4.1 Flash, GLM-5.3 Flash).  Normal-model block sizes:
//   p95 = 2,608 chars,  p99 = 6,672 chars,  session-max p95 = 14,676 chars
// Thresholds are rounded to clean numbers for user-facing messages.

const WARN_THRESHOLD = 5_000; // above normal p95
const ALERT_THRESHOLD = 8_000; // above normal p99
const CRITICAL_THRESHOLD = 12_000; // confirmed overthinking territory

// ── Messages ────────────────────────────────────────────────────────────────

const MSG_WARN =
  "Thinking block {n} chars. Normal models stay under 5000 (p95). May be overthinking — consider switching model or lowering reasoning effort if available.";

const MSG_ALERT =
  "Thinking block {n} chars. Normal models stay under 8000 (p99). Likely overthinking at current effort level. Switch model or lower reasoning effort if available.";

const MSG_CRITICAL =
  "Thinking block {n} chars. Over 12000 confirmed overthinking. Switch model now or lower reasoning effort if available.";

const STATUS_KEY = "overthink-warning";

// ── State ──────────────────────────────────────────────────────────────────

// Track the highest level reached this session so we don't spam the same
// notification for every block once we've already alerted the user.
let sessionMaxLevel: "none" | "warn" | "alert" | "critical" = "none";
let sessionMaxBlock = 0;

// ── Helpers ────────────────────────────────────────────────────────────────

interface ThinkingBlock {
  thinking: string;
}

function isThinkingBlock(block: unknown): block is ThinkingBlock {
  return (
    typeof block === "object" &&
    block !== null &&
    (block as Record<string, unknown>).type === "thinking" &&
    typeof (block as Record<string, unknown>).thinking === "string"
  );
}

function getThinkingBlocks(message: unknown): string[] {
  if (typeof message !== "object" || message === null) return [];
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return [];
  return content.filter(isThinkingBlock).map((b) => b.thinking);
}

function levelFor(size: number): "none" | "warn" | "alert" | "critical" {
  if (size >= CRITICAL_THRESHOLD) return "critical";
  if (size >= ALERT_THRESHOLD) return "alert";
  if (size >= WARN_THRESHOLD) return "warn";
  return "none";
}

function fillTemplate(template: string, n: number): string {
  return template.replace("{n}", String(n));
}

// ── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Reset session state on new session.
  pi.on("session_start", async () => {
    sessionMaxLevel = "none";
    sessionMaxBlock = 0;
  });

  // Check thinking block sizes when each assistant message completes.
  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;

    const blocks = getThinkingBlocks(event.message);
    if (blocks.length === 0) return;

    const maxBlock = Math.max(...blocks.map((b) => b.length));
    if (maxBlock <= sessionMaxBlock) return; // no new record
    sessionMaxBlock = maxBlock;

    const level = levelFor(maxBlock);
    if (level === "none") return;

    // Only escalate — don't re-notify at the same or lower level.
    const order = { none: 0, warn: 1, alert: 2, critical: 3 };
    if (order[level] <= order[sessionMaxLevel]) return;
    sessionMaxLevel = level;

    const n = maxBlock;
    const msg = fillTemplate(
      level === "critical"
        ? MSG_CRITICAL
        : level === "alert"
          ? MSG_ALERT
          : MSG_WARN,
      n,
    );

    // Always notify the user.
    ctx.ui.notify(msg, level === "critical" ? "error" : "warning");

    // alert and critical: persistent status bar.
    if (level === "alert" || level === "critical") {
      ctx.ui.setStatus(STATUS_KEY, msg);
    }

    // critical: confirm dialog prompting user action.
    if (level === "critical" && ctx.hasUI) {
      await ctx.ui.confirm(
        "Overthinking detected",
        "Switch model now or lower reasoning effort if available.",
      );
      ctx.ui.setStatus(STATUS_KEY, "");
    }
  });
}
