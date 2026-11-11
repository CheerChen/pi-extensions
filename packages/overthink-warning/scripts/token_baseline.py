#!/usr/bin/env python3
"""Derive and replay the reasoning-token thresholds used by index.ts.

Mirrors index.ts: a reply's reasoning tokens are max(usage.reasoning, ceil(visible thinking
chars / 4)); the window is the sum over the last 20 assistant replies. Levels only escalate,
so the highest level a session reaches is the highest level ever shown.

Run: uv run --no-project python scripts/token_baseline.py
"""
import collections, glob, json, os

CHARS_PER_TOKEN = 4
WINDOW = 20
REPLY_LINES = (("warn", 4_000), ("alert", 8_000), ("critical", 12_000))
WINDOW_LINES = (("warn", 20_000), ("alert", 30_000))

# Variants that report no reasoning at all; they would only dilute the normal baseline.
NON_REASONING = {"gpt-6-luna", "gpt-6-astra", "gpt-5.3-codex-spark"}


def group(model):
    n = (model or "").lower()
    if n in NON_REASONING:
        return None
    if "deepseek-v4" in n or "glm-5.3-flash" in n:
        return "problem"
    return "normal"


def reply_tokens(m):
    reported = (m.get("usage") or {}).get("reasoning") or 0
    chars = sum(len(c.get("thinking") or "") for c in m.get("content") or []
                if isinstance(c, dict) and c.get("type") == "thinking")
    return max(reported, -(-chars // CHARS_PER_TOKEN))


def level(value, lines):
    reached = "ok"
    for name, at in lines:
        if value >= at:
            reached = name
    return reached


def q(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(p * len(xs)))]


replies = collections.defaultdict(list)
sessions = collections.defaultdict(list)
for f in glob.glob(os.path.expanduser("~/.pi/agent/sessions/**/*.jsonl"), recursive=True):
    seq = collections.defaultdict(list)
    for line in open(f, errors="replace"):
        if '"assistant"' not in line:
            continue
        try:
            m = json.loads(line).get("message") or {}
        except ValueError:
            continue
        if m.get("role") != "assistant" or not (g := group(m.get("model"))):
            continue
        seq[g].append(reply_tokens(m))
    for g, s in seq.items():
        window = max(sum(s[i:i + WINDOW]) for i in range(max(1, len(s) - WINDOW + 1)))
        sessions[g].append((max(s), window))
        replies[g].extend(s)

for g in ("normal", "problem"):
    r, s = replies[g], sessions[g]
    print(f"{g}: {len(r)} replies, {len(s)} sessions")
    print("  reply p50/p95/p99/p99.9/max:", q(r, .5), q(r, .95), q(r, .99), q(r, .999), max(r))
    print("  window p50/p90/p95/max:     ", *(q([w for _, w in s], p) for p in (.5, .9, .95)), max(w for _, w in s))
    reply_hits = collections.Counter(level(mx, REPLY_LINES) for mx, _ in s)
    window_hits = collections.Counter(level(w, WINDOW_LINES) for _, w in s)
    print("  sessions by reply level: ", {n: reply_hits[n] for n in ("ok", *dict(REPLY_LINES))})
    print("  sessions by window level:", {n: window_hits[n] for n in ("ok", *dict(WINDOW_LINES))})
