#!/usr/bin/env python3
"""Replay local sessions through the spread-alert rule, old vs new.

old: blocks OR chars fire on their own. new: block count only escalates to alert.

Mirrors packages/overthink-warning/index.ts: only blocks >= 200 chars count, counters only grow,
so the level reached at session end is the highest level ever shown.
"""
import collections, glob, json, os

SUBSTANTIVE = 200
BLOCK_WARN, BLOCK_ALERT = 50, 80  # BLOCK_WARN: old rule only
TOTAL_WARN, TOTAL_ALERT = 50_000, 100_000


def normalize(name):
    n = (name or '?').lower()
    for key, label in [('glm-5.3', 'GLM-5.3 Flash'), ('glm-5.2', 'GLM-5.2'),
                       ('deepseek-v4.1', 'DS v4.1 Flash'), ('deepseek-v4', 'DS v4 Flash'),
                       ('gpt-5.6', 'GPT-5.6'), ('gpt', 'GPT other'), ('claude', 'Claude'),
                       ('opus', 'Claude'), ('gemini', 'Gemini'), ('qwen', 'Qwen')]:
        if key in n:
            return label
    return name


def pi_sessions():
    for f in glob.glob(os.path.expanduser('~/.pi/agent/sessions/**/*.jsonl'), recursive=True):
        model, thinks = None, []
        for line in open(f, errors='replace'):
            try:
                o = json.loads(line)
            except ValueError:
                continue
            if o.get('type') == 'model_change' and model is None:
                model = o.get('modelId')
            m = o.get('message') or {}
            if o.get('type') == 'message' and m.get('role') == 'assistant':
                model = model or m.get('model')
                for c in m.get('content') or []:
                    if isinstance(c, dict) and c.get('type') == 'thinking':
                        thinks.append(c.get('thinking') or '')
        if thinks:
            yield 'pi', normalize(model), thinks, f


def devin_sessions():
    for f in glob.glob(os.path.expanduser('~/.local/share/devin/cli/transcripts/*.json')):
        try:
            d = json.load(open(f))
        except ValueError:
            continue
        thinks = [s['reasoning_content'] for s in d.get('steps', []) if s.get('reasoning_content')]
        if thinks:
            yield 'devin', normalize(d.get('agent', {}).get('model_name')), thinks, f


def levels(thinks):
    sub = [t for t in thinks if len(t) >= SUBSTANTIVE]
    n, total = len(sub), sum(map(len, sub))
    alert = n >= BLOCK_ALERT or total >= TOTAL_ALERT
    old = 'alert' if alert else 'warn' if (n >= BLOCK_WARN or total >= TOTAL_WARN) else '-'
    new = 'alert' if total >= TOTAL_ALERT or (n >= BLOCK_ALERT and total >= TOTAL_WARN) else \
          'warn' if total >= TOTAL_WARN else '-'
    return n, total, old, new


stats = collections.defaultdict(lambda: collections.Counter())
flipped = []
for src, model, thinks, f in list(pi_sessions()) + list(devin_sessions()):
    n, total, old, new = levels(thinks)
    s = stats[model]
    s['sessions'] += 1
    s['old_hit'] += old != '-'
    s['new_hit'] += new != '-'
    if old != new:
        flipped.append((model, n, total, old, new, os.path.basename(f)[:40]))

print(f"{'model':<18}{'sessions':>9}{'old hit':>9}{'new hit':>9}")
for model, s in sorted(stats.items(), key=lambda kv: -kv[1]['sessions']):
    if s['sessions'] < 3:
        continue
    print(f"{model:<18}{s['sessions']:>9}{s['old_hit']:>9}{s['new_hit']:>9}")
print(f"\nchanged ({len(flipped)}):")
for row in sorted(flipped):
    print('  {:<16} blocks={:<4} chars={:<8} {} -> {}  {}'.format(*row))
