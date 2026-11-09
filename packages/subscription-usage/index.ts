// Subscription usage for Codex, Claude and Grok. Claude shows account subscription
// windows, which do not by themselves establish how a Pi request is billed.
// Results are cached on disk and shared by every Pi process, so N open sessions
// still make at most one request per provider per TTL; a 429 backs all of them off.
import { Buffer } from "node:buffer";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const STATUS_KEY = "sub-usage";
const TICK_MS = 60_000;
const TTL_MS = { "openai-codex": 5 * 60_000, anthropic: 15 * 60_000, xai: 15 * 60_000 };
const RATE_LIMIT_BACKOFF_MS = 15 * 60_000;
const ERROR_BACKOFF_MS = 5 * 60_000;
const LOCK_STALE_MS = 30_000;
// One file per provider: concurrent refreshes never overwrite each other.
const CACHE_DIR = process.env.PI_SUB_USAGE_CACHE_DIR ?? join(homedir(), ".pi", "agent", "cache", "sub-usage");
const cacheFile = (provider) => join(CACHE_DIR, `${provider}.json`);
const PROVIDERS = ["openai-codex", "anthropic", "xai"];
const NAMES = { "openai-codex": "Codex", anthropic: "Claude", xai: "Grok" };

async function request(url, headers) {
  const res = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    const error = new Error(`HTTP ${res.status}`);
    error.status = res.status;
    error.retryAfterMs = Number(res.headers.get("retry-after")) * 1000 || 0;
    throw error;
  }
  return res.json();
}

async function access(ctx, provider) {
  const token = await ctx.modelRegistry.getApiKeyForProvider(provider);
  if (!token) throw new Error("not logged in");
  return token;
}

function window(label, used, reset, seconds = false) {
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 100) return undefined;
  const timestamp = seconds ? Number(reset) * 1000 : Date.parse(reset);
  return { label, used, reset: Number.isFinite(timestamp) && timestamp > 0 ? timestamp : undefined };
}

function codexLabel(w, fallback) {
  const seconds = w?.limit_window_seconds;
  if (seconds === 18000) return "5h";
  if (seconds === 604800) return "wk";
  if (typeof seconds === "number" && seconds > 0) {
    if (seconds % 86400 === 0) return `${seconds / 86400}d`;
    if (seconds % 3600 === 0) return `${seconds / 3600}h`;
    return `${Math.round(seconds / 60)}m`;
  }
  return fallback;
}

async function fetchUsage(ctx, provider) {
  const token = await access(ctx, provider);
  if (provider === "openai-codex") {
    const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    const id = claims["https://api.openai.com/auth"]?.chatgpt_account_id;
    if (!id) throw new Error("missing account ID");
    const data = await request("https://chatgpt.com/backend-api/wham/usage", {
      Authorization: `Bearer ${token}`, "ChatGPT-Account-Id": id, "User-Agent": "codex_cli_rs",
    });
    const rate = data?.rate_limit;
    const windows = [rate?.primary_window, rate?.secondary_window].map((w, i) =>
      window(codexLabel(w, i === 0 ? "primary" : "secondary"), w?.used_percent, w?.reset_at, true),
    ).filter(Boolean);
    if (!windows.length) throw new Error("no usage windows");
    return { windows, limited: rate?.limit_reached === true };
  }
  if (provider === "anthropic") {
    if (!token.startsWith("sk-ant-oat")) throw new Error("subscription OAuth required");
    const data = await request("https://api.anthropic.com/api/oauth/usage", {
      Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20",
    });
    const windows = [["5h", data?.five_hour], ["wk", data?.seven_day],
      ["Sonnet wk", data?.seven_day_sonnet], ["Opus wk", data?.seven_day_opus]]
      .map(([label, w]) => window(label, w?.utilization, w?.resets_at)).filter(Boolean);
    if (!windows.length) throw new Error("no subscription windows");
    return { windows };
  }
  const data = await request("https://cli-chat-proxy.grok.com/v1/billing?format=credits", {
    Authorization: `Bearer ${token}`,
  });
  const cfg = data?.config;
  const type = cfg?.currentPeriod?.type;
  const label = type === "USAGE_PERIOD_TYPE_WEEKLY" ? "wk" : type === "USAGE_PERIOD_TYPE_MONTHLY" ? "month" : "pool";
  const w = window(label, cfg?.creditUsagePercent, cfg?.currentPeriod?.end ?? cfg?.billingPeriodEnd);
  if (!w) throw new Error("no pool usage");
  return { windows: [w] };
}

function countdown(reset) {
  if (!reset) return "";
  const minutes = Math.ceil((reset - Date.now()) / 60_000);
  if (minutes <= 0) return "↻now";
  if (minutes >= 1440) return `↻${Math.floor(minutes / 1440)}d${Math.floor(minutes % 1440 / 60)}h`;
  if (minutes >= 60) return `↻${Math.floor(minutes / 60)}h${minutes % 60}m`;
  return `↻${minutes}m`;
}

function meter(w, width = 5) {
  const left = 100 - w.used;
  const filled = Math.round(left * width / 100);
  return `${"█".repeat(filled)}${"░".repeat(width - filled)} ${Math.round(left)}% left`;
}

async function readEntry(provider) {
  try {
    return JSON.parse(await readFile(cacheFile(provider), "utf8"));
  } catch {
    return undefined;
  }
}

async function writeEntry(provider, entry) {
  await mkdir(CACHE_DIR, { recursive: true });
  const tmp = `${cacheFile(provider)}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(entry), { mode: 0o600 });
  await rename(tmp, cacheFile(provider));
}

// One fetcher per provider across processes; others keep showing the cache.
async function withLock(provider, fn) {
  const lock = `${cacheFile(provider)}.lock`;
  await mkdir(CACHE_DIR, { recursive: true });
  let handle;
  try {
    handle = await open(lock, "wx");
  } catch {
    try {
      if (Date.now() - (await stat(lock)).mtimeMs < LOCK_STALE_MS) return undefined;
      await unlink(lock);
      handle = await open(lock, "wx");
    } catch {
      return undefined;
    }
  }
  try {
    return await fn();
  } finally {
    await handle.close().catch(() => {});
    await unlink(lock).catch(() => {});
  }
}

function fresh(entry, provider, now) {
  return Boolean(entry?.value && now - entry.at < TTL_MS[provider]);
}

function age(ms) {
  const minutes = Math.floor(ms / 60_000);
  return minutes < 1 ? "just now" : minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ago`;
}

export default function (pi) {
  const cache = {};
  let currentContext;
  let currentProvider;
  let timer;
  let stopped = false;

  function windowsText(entry, width) {
    return entry.value.windows.map((w) => {
      const expired = w.reset && w.reset <= Date.now();
      return `${w.label}${width > 5 ? ":" : ""} ${expired ? "—" : meter(w, width)} ${countdown(w.reset)}`.trim();
    });
  }

  function render() {
    const ctx = currentContext;
    if (!ctx?.hasUI) return;
    if (!PROVIDERS.includes(currentProvider)) return ctx.ui.setStatus(STATUS_KEY, undefined);
    const entry = cache[currentProvider];
    const name = NAMES[currentProvider];
    if (!entry) return ctx.ui.setStatus(STATUS_KEY, `${name} loading…`);
    if (!entry.value) return ctx.ui.setStatus(STATUS_KEY, `${name} unavailable (${entry.error})`);
    // "~" marks a reading kept from the last success because the latest refresh failed.
    const stale = entry.error ? " ~" : "";
    const limited = entry.value.limited ? " · limited" : "";
    ctx.ui.setStatus(STATUS_KEY, `${name} ${windowsText(entry, 5).join(" · ")}${limited}${stale}`);
  }

  async function refresh(ctx, provider, force = false) {
    cache[provider] = (await load(ctx, provider, force)) ?? (await readEntry(provider));
    if (!stopped) {
      try { render(); } catch { /* The session may have been replaced during the request. */ }
    }
    return cache[provider];
  }

  async function load(ctx, provider, force) {
    const now = Date.now();
    const cached = await readEntry(provider);
    if (cached?.retryAt > now) return cached;
    if (!force && fresh(cached, provider, now)) return cached;
    return withLock(provider, async () => {
      const latest = await readEntry(provider);
      if (latest?.retryAt > Date.now()) return latest;
      if (!force && fresh(latest, provider, Date.now())) return latest;
      let entry;
      try {
        entry = { value: await fetchUsage(ctx, provider), at: Date.now() };
      } catch (error) {
        const backoff = error?.status === 429
          ? Math.max(error.retryAfterMs ?? 0, RATE_LIMIT_BACKOFF_MS)
          : ERROR_BACKOFF_MS;
        entry = {
          value: latest?.value,
          at: latest?.at,
          error: error instanceof Error ? error.message : String(error),
          retryAt: Date.now() + backoff,
        };
      }
      await writeEntry(provider, entry);
      return entry;
    });
  }

  function activate(ctx) {
    currentContext = ctx;
    currentProvider = ctx.model?.provider;
    render();
    if (PROVIDERS.includes(currentProvider)) void refresh(ctx, currentProvider).catch(() => {});
  }

  pi.registerCommand("quotas", {
    description: "Show Codex, Claude and Grok subscription usage (`/quotas refresh` skips the cache)",
    handler: async (args, ctx) => {
      const force = args.trim() === "refresh";
      const entries = await Promise.all(PROVIDERS.map((provider) => refresh(ctx, provider, force).catch(() => undefined)));
      const lines = [];
      for (let i = 0; i < PROVIDERS.length; i++) {
        const provider = PROVIDERS[i];
        const entry = entries[i];
        const updated = entry?.at ? ` · updated ${age(Date.now() - entry.at)}` : "";
        lines.push(`${NAMES[provider]}${provider === "anthropic" ? " (account subscription)" : ""}${updated}`);
        if (entry?.value) lines.push(...windowsText(entry, 10).map((line) => `  ${line}`));
        if (entry?.value?.limited) lines.push("  limit reached");
        if (entry?.error) {
          const retry = entry.retryAt > Date.now() ? `, next try in ${countdown(entry.retryAt).slice(1)}` : "";
          lines.push(`  last refresh failed: ${entry.error}${retry}`);
        }
        if (!entry) lines.push("  loading…");
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    stopped = false;
    activate(ctx);
    // The tick only re-renders countdowns and re-reads the shared cache;
    // it reaches the network only once that provider's TTL or backoff has passed.
    timer = setInterval(() => {
      if (!currentContext || !PROVIDERS.includes(currentProvider)) return;
      void refresh(currentContext, currentProvider).catch(() => {});
    }, TICK_MS);
    timer.unref?.();
  });
  pi.on("model_select", async (_event, ctx) => activate(ctx));
  pi.on("agent_settled", async (_event, ctx) => activate(ctx));
  pi.on("session_shutdown", async () => {
    stopped = true;
    if (timer) clearInterval(timer);
    currentContext = undefined;
  });
}
