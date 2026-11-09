import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Thresholds ─────────────────────────────────────────────────────────────
// Derived from a 260-session analysis (pi + devin + copilot) comparing normal
// reasoning models (GPT-5.6, GLM-5.2, Claude Opus 4.8) against overthinking
// models (DeepSeek V4/V4.1 Flash, GLM-5.3 Flash).  Normal-model block sizes:
//   p95 = 2,608 chars,  p99 = 6,672 chars,  session-max p95 = 14,676 chars
// Thresholds are rounded to clean numbers for user-facing messages.

// ── Single-block thresholds (vertical overthinking: one huge block) ─────────
const WARN_THRESHOLD = 5_000; // above normal p95
const ALERT_THRESHOLD = 8_000; // above normal p99
const CRITICAL_THRESHOLD = 12_000; // confirmed overthinking territory

// ── Cumulative thresholds (horizontal spread: many blocks, huge total) ──────
// Normal models average 25-35 blocks / 5k-35k chars per session.
// Problem models average 58-88 blocks / 129k-281k chars.
// Block count alone never fires: it grows with session length, so a long normal
// session (e.g. Opus, 50 blocks / 26k chars) would trip it. It only escalates
// a session that already crossed the char warn line.
const SPREAD_BLOCK_ALERT = 80;
const SPREAD_TOTAL_WARN = 50_000;
const SPREAD_TOTAL_ALERT = 100_000;

// Only blocks with substantive visible thinking feed the cumulative metrics.
// OpenAI Responses models expose reasoning as a ~20-70 char summary title
// plus an encrypted thinkingSignature — one such block per turn would trip
// the spread thresholds on any long session.
const SUBSTANTIVE_BLOCK_CHARS = 200;

// ── Messages ────────────────────────────────────────────────────────────────

const MSG_WARN =
  "Thinking block {n} chars. Normal models stay under 5000 (p95). May be overthinking — consider switching model or lowering reasoning effort if available.";

const MSG_ALERT =
  "Thinking block {n} chars. Normal models stay under 8000 (p99). Likely overthinking at current effort level. Switch model or lower reasoning effort if available.";

const MSG_CRITICAL =
  "Thinking block {n} chars. Over 12000 confirmed overthinking. Switch model now or lower reasoning effort if available.";

const MSG_SPREAD_WARN =
  "Session total {blocks} thinking blocks ({total} chars). Horizontal spread — may be overthinking. Consider switching model or lowering reasoning effort if available.";

const MSG_SPREAD_ALERT =
  "Session total {blocks} thinking blocks ({total} chars). Horizontal spread — likely overthinking at current effort level. Switch model or lower reasoning effort if available.";

const STATUS_KEY = "overthink-warning";

// ── State ──────────────────────────────────────────────────────────────────

// Single-block tracking: highest level reached + largest block seen.
let sessionMaxLevel: "none" | "warn" | "alert" | "critical" = "none";
let sessionMaxBlock = 0;

// Cumulative tracking: total blocks + total chars across the session.
let sessionBlockCount = 0;
let sessionTotalChars = 0;
let sessionSpreadLevel: "none" | "warn" | "alert" = "none";

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

function fillSpreadTemplate(template: string, blocks: number, total: number): string {
  return template.replace("{blocks}", String(blocks)).replace("{total}", String(total));
}

// ── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Reset session state on new session.
  pi.on("session_start", async (_event, ctx) => {
    sessionMaxLevel = "none";
    sessionMaxBlock = 0;
    sessionBlockCount = 0;
    sessionTotalChars = 0;
    sessionSpreadLevel = "none";
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  // Check thinking block sizes when each assistant message completes.
  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;

    const blocks = getThinkingBlocks(event.message);
    if (blocks.length === 0) return;

    // ── Cumulative tracking (horizontal spread) ───────────────────────────
    // Both counters use only substantive blocks — summary-title crumbs would
    // otherwise reach the char totals on a long enough session too.
    const substantive = blocks.filter((b) => b.length >= SUBSTANTIVE_BLOCK_CHARS);
    sessionBlockCount += substantive.length;
    sessionTotalChars += substantive.reduce((sum, b) => sum + b.length, 0);

    const spreadLevel: "none" | "warn" | "alert" =
      sessionTotalChars >= SPREAD_TOTAL_ALERT ||
      (sessionBlockCount >= SPREAD_BLOCK_ALERT && sessionTotalChars >= SPREAD_TOTAL_WARN)
        ? "alert"
        : sessionTotalChars >= SPREAD_TOTAL_WARN
          ? "warn"
          : "none";

    if (spreadLevel !== "none") {
      const order = { none: 0, warn: 1, alert: 2 };
      if (order[spreadLevel] > order[sessionSpreadLevel]) {
        sessionSpreadLevel = spreadLevel;
        const spreadMsg = fillSpreadTemplate(
          spreadLevel === "alert" ? MSG_SPREAD_ALERT : MSG_SPREAD_WARN,
          sessionBlockCount,
          sessionTotalChars,
        );
        ctx.ui.notify(spreadMsg, "warning");
        if (spreadLevel === "alert") {
          ctx.ui.setStatus(STATUS_KEY, spreadMsg);
        }
      }
    }

    // ── Single-block tracking (vertical overthinking) ─────────────────────
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
  });
}