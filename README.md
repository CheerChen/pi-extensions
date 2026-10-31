# pi-overthink-warning

Detect overthinking in reasoning models by monitoring thinking block size. Warns the user progressively — does not interrupt or steer the model.

## Why

Some reasoning models (DeepSeek V4/V4.1 Flash, GLM-5.3 Flash) produce thinking blocks far larger than normal models at the same effort level. Prompt engineering cannot control this — the reasoning budget is set by the API `reasoning_effort` parameter, not by instructions in the prompt.

This extension monitors thinking block sizes in real time and warns the user when a model is overthinking, so they can lower the effort level or switch models.

## How it works

The extension monitors two overthinking patterns:

### 1. Vertical overthinking (single huge block)

On each assistant `message_end`, the extension measures the largest thinking block in the message and compares it against three thresholds:

| Level | Threshold | Meaning | Action |
|-------|-----------|---------|--------|
| warn | 5,000 chars | Above normal-model p95 (2,608) | `ctx.ui.notify()` (warning) |
| alert | 8,000 chars | Above normal-model p99 (6,672) | `ctx.ui.notify()` + persistent status bar |
| critical | 12,000 chars | Confirmed overthinking | `ctx.ui.notify()` (error) + persistent status bar |

### 2. Horizontal spread (many blocks, huge total)

Some models don't produce one huge block but instead spread overthinking across many small blocks. The extension tracks cumulative blocks and total chars per session:

| Level | Block count | Total chars | Action |
|-------|-----------|-------------|--------|
| warn | 50+ | or 50,000+ | `ctx.ui.notify()` (warning) |
| alert | 80+ | or 100,000+ | `ctx.ui.notify()` + persistent status bar |

Only blocks with at least 200 chars of visible thinking count toward either cumulative metric. Models that expose reasoning as an encrypted `thinkingSignature` (e.g. OpenAI Responses models, where `thinking` holds a ~20-70 char summary title) would otherwise trip the thresholds on any long session.

Either metric crossing a threshold triggers the warning.

The extension only escalates — once it has alerted at a given level, it won't re-notify at the same or lower level. It never interrupts the model, never steers the conversation, and never modifies the reasoning content.

The persistent status bar entry stays for the rest of the session and is cleared when a new session starts.

## Thresholds

Derived from a 260-session analysis comparing normal reasoning models (GPT-5.6, GLM-5.2, Claude Opus 4.8) against overthinking models (DeepSeek V4/V4.1 Flash, GLM-5.3 Flash):

### Vertical overthinking (single block size)

- Normal-model session avg max block: 3,936 chars
- Problem-model session avg max block: 19,045 chars (4.8x)
- Normal-model thinking blocks: p95 = 2,608 chars, p99 = 6,672 chars

At 5,000 chars, only 1.56% of normal-model blocks trigger (1 in 64). At 12,000 chars, only 0.37% of normal-model blocks trigger (1 in 270).

### Horizontal spread (cumulative per session)

- Normal models average: 25-35 blocks, 5k-35k chars per session
- Problem models average: 58-88 blocks, 129k-281k chars per session

50 blocks / 50k chars is the normal-model ceiling; 80 blocks / 100k chars enters the problem-model range.

## Installation

```bash
pi install npm:pi-overthink-warning
```

Or test locally:

```bash
pi -e /path/to/pi-overthink-warning/extensions/index.ts
```

## Permissions

This extension only reads message content (thinking blocks) and uses `ctx.ui` for notifications. It does not write files, access the network, or execute commands.

## License

MIT
