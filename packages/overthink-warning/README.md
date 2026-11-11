# pi-overthink-warning

Detect overthinking in reasoning models by monitoring reasoning tokens per reply. Warns the user progressively — does not interrupt or steer the model.

## Why

Some reasoning models (DeepSeek V4/V4.1 Flash, GLM-5.3 Flash) reason far more than normal models at the same effort level. Prompt engineering cannot control this — the reasoning budget is set by the API `reasoning_effort` parameter, not by instructions in the prompt.

This extension watches how much each reply reasons and warns the user when a model is overthinking, so they can lower the effort level or switch models.

## What it measures

Reasoning tokens per assistant reply. Visible thinking text cannot be compared across providers: Claude returns the raw reasoning, while OpenAI Responses models return only a summary (Codex: a title under 200 chars) next to an encrypted item, so a character count can never warn on them. `usage.reasoning` is reported by all of them.

Some OpenAI-compatible providers report `reasoning: 0` for replies that carry thousands of chars of visible thinking, so a reply counts as whichever is larger: the reported tokens, or the visible thinking text at 4 chars per token. Replies without visible thinking still count, since Codex and some GLM replies reason without returning any text.

## How it works

### 1. Single reply (vertical: one huge chain of thought)

| Level | Reasoning tokens | Normal replies above it | Action |
|-------|------------------|-------------------------|--------|
| warn | 4,000 | 0.2% | `ctx.ui.notify()` (warning) |
| alert | 8,000 | 0.04% | `ctx.ui.notify()` + status bar |
| critical | 12,000 | one reply ever | `ctx.ui.notify()` (error) + status bar |

### 2. Last 20 replies (horizontal: many medium chains)

| Level | Reasoning tokens in the last 20 replies | Action |
|-------|-----------------------------------------|--------|
| warn | 20,000 | `ctx.ui.notify()` (warning) |
| alert | 30,000 | `ctx.ui.notify()` + status bar |

A sliding window instead of a session total: a total grows with session length, so long normal sessions would cross any fixed line (one 515-reply Claude session reached 127k).

The extension only escalates — once it has warned at a given level, it won't re-notify at the same or lower level. It never interrupts the model, never steers the conversation, and never modifies the reasoning content.

The status-bar entry clears itself after 10 seconds. Run `/overthink` at any time to see the largest reply, the current window, the session total and each level. On start, reload, resume, fork and `/tree`, the stats are rebuilt silently from the active branch, so history never re-fires old warnings.

## Thresholds

From the local pi sessions, replayed by `scripts/token_baseline.py` with the same rules as `index.ts`. Normal reasoning models (GPT-5.6/6.1, Claude, GLM-5.2/5.3, Grok) against overthinking models (DeepSeek V4/V4.1 Flash, GLM-5.3 Flash); non-reasoning variants (`gpt-6-luna`, `gpt-6-astra`) are left out.

| | Normal | Overthinking |
|---|---|---|
| Replies | 7,642 | 9,802 |
| Reply p99 / p99.9 / max | 2,120 / 6,054 / 19,749 | 3,966 / 10,190 / 29,073 |
| Session max window, p95 / max | 13,542 / 28,252 | 44,082 / 50,839 |
| Sessions that get any warning | 12 of 157 | 32 of 70 |

Per reply the two groups overlap: GPT-5.6 Luna reasons as much as the Flash models, and most of the normal-model warnings are Luna sessions. Most of the 38 overthinking-model sessions with no warning are long GLM-5.3 Flash sessions with small replies; they are labelled by model, not by behaviour.

## Installation

```bash
pi install npm:pi-overthink-warning
```

Or test locally:

```bash
pi -e /path/to/pi-extensions/packages/overthink-warning/index.ts
```

## Permissions

This extension only reads assistant messages (usage and thinking blocks) and uses `ctx.ui` for notifications. It does not write files, access the network, or execute commands.

## Scripts

- `token_baseline.py` — derives and replays the thresholds above
- `analyze_overthinking.py`, `batch_scan.py`, `incident_rate.py` — the original per-model analysis that picked which models overthink

## License

MIT
