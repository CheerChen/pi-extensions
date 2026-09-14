#!/usr/bin/env python3
"""Extract overthinking signals from pi/codex session jsonl files."""
import json, re, sys, collections

# --- feature extractors ---

BRANCH_WORDS = re.compile(
    r'\b(options|alternative|hmm|actually|wait|but |or |let me think|consider|maybe|could|perhaps|wonder if)\b',
    re.I)
REVERSAL_WORDS = re.compile(
    r'\b(wait|actually|no,|i was wrong|let me reconsider|scratch that|hold on|oops|mistake)\b',
    re.I)
LOWLEVEL_WORDS = re.compile(
    r'\b(quadratic|cubic|contour|implied|on-curve|off-curve|bezier|rasteriz|glyph|fonttools|pen|path data|vector drawable|svg path|fill rule|even-odd|antialias|supersampl)\b',
    re.I)
DECISION_WORDS = re.compile(
    r'\b(decide|chose|choose|go with|let.s do|i.ll use|decision is|final answer|verdict)\b',
    re.I)
PRECISION_CALC = re.compile(r'\d+\.\d{2,}\s*[=*/]\s*\d+\.\d{2,}')

def analyze_session(path, label, has_thinking=True):
    thinks = []
    tool_calls = []  # (name, args_str)
    user_msgs = []
    asst_texts = []
    events = []  # ordered: 'think' | 'tool' | 'user' | 'asst'
    for line in open(path):
        line = line.strip()
        if not line:
            continue
        try:
            o = json.loads(line)
        except Exception:
            continue
        t = o.get('type')
        if t == 'message':
            m = o.get('message', {})
            role = m.get('role')
            for c in m.get('content', []):
                ct = c.get('type')
                if ct == 'thinking' and has_thinking:
                    tk = c.get('thinking', '')
                    thinks.append(tk)
                    events.append(('think', tk))
                elif ct == 'text' and role == 'user':
                    user_msgs.append(c.get('text', ''))
                    events.append(('user', c.get('text', '')))
                elif ct == 'text' and role == 'assistant':
                    asst_texts.append(c.get('text', ''))
                    events.append(('asst', c.get('text', '')))
                elif ct == 'toolCall':
                    a = c.get('arguments', {})
                    cmd = a.get('command', '') or a.get('path', '') or str(a)
                    tool_calls.append((c.get('name'), cmd))
                    events.append(('tool', cmd))
        elif t == 'response_item':  # codex format
            p = o.get('payload', {})
            it = p.get('type')
            if it == 'custom_tool_call':
                cmd = p.get('input', '')
                tool_calls.append((p.get('name'), cmd))
                events.append(('tool', cmd))
            elif it == 'message':
                role = p.get('role')
                for c in p.get('content', []):
                    ct = c.get('type')
                    if ct == 'input_text' and role == 'user':
                        user_msgs.append(c.get('text', ''))
                        events.append(('user', c.get('text', '')))
                    elif ct == 'output_text' and role == 'assistant':
                        asst_texts.append(c.get('text', ''))
                        events.append(('asst', c.get('text', '')))

    # --- compute features ---
    print(f'\n{"="*70}\n{label}\n{"="*70}')
    print(f'thinking_blocks={len(thinks)} tool_calls={len(tool_calls)} user_msgs={len(user_msgs)} asst_texts={len(asst_texts)}')

    if has_thinking and thinks:
        total = sum(len(t) for t in thinks)
        branch_counts = [len(BRANCH_WORDS.findall(t)) for t in thinks]
        reversal = [len(REVERSAL_WORDS.findall(t)) for t in thinks]
        lowlevel = [len(LOWLEVEL_WORDS.findall(t)) for t in thinks]
        decision = [len(DECISION_WORDS.findall(t)) for t in thinks]
        precision = [len(PRECISION_CALC.findall(t)) for t in thinks]
        print(f'\n-- thinking text features --')
        print(f'total_think_chars={total} avg={total//max(1,len(thinks))} max={max(len(t) for t in thinks)}')
        print(f'branch_words_total={sum(branch_counts)} per_1k_chars={sum(branch_counts)/max(1,total)*1000:.1f}')
        print(f'reversal_words_total={sum(reversal)} per_1k_chars={sum(reversal)/max(1,total)*1000:.1f}')
        print(f'lowlevel_words_total={sum(lowlevel)} per_1k_chars={sum(lowlevel)/max(1,total)*1000:.1f}')
        print(f'decision_words_total={sum(decision)} per_1k_chars={sum(decision)/max(1,total)*1000:.1f}')
        print(f'decision/branch ratio={sum(decision)/max(1,sum(branch_counts)):.2f}')
        print(f'precision_calcs_total={sum(precision)}')

    # consecutive think blocks between tools (idle spin length)
    max_run = 0; cur = 0; runs = []
    for kind, _ in events:
        if kind == 'think':
            cur += 1
        elif kind == 'tool':
            if cur > 0:
                runs.append(cur)
            max_run = max(max_run, cur)
            cur = 0
    if cur > 0:
        runs.append(cur)
    print(f'\n-- behavior sequence --')
    print(f'max_consecutive_think_before_tool={max_run} think_runs={runs}')

    # repeated file patching (sed -i / python -c on same target)
    patch_pattern = re.compile(r"(sed -i|python -c|python3 -c|<<'EOF'|<<'PY'|<<'py')")
    patches = sum(1 for _, c in tool_calls if patch_pattern.search(c))
    print(f'inline_patch_ops={patches}')

    # repeated path exploration
    paths = []
    for name, c in tool_calls:
        m = re.search(r'(?:read|cat|grep|sed -n)\s+([^\s;&|]+)', c)
        if m:
            paths.append(m.group(1))
    path_counts = collections.Counter(paths)
    repeats = {p: n for p, n in path_counts.items() if n > 1}
    print(f'repeated_path_reads={len(repeats)} top={path_counts.most_common(3)}')

    # first visible output (read image / preview png)
    first_output_idx = None
    for i, (name, c) in enumerate(tool_calls):
        if re.search(r'read.*\.(png|jpg|webp)|preview|snapshot|screenshot', c, re.I):
            first_output_idx = i
            break
    print(f'first_visible_output_at_tool_idx={first_output_idx} (of {len(tool_calls)} total)')

    # user correction signals
    correction_words = re.compile(r'(不对|重新|服了|不是|别|没变|到底|怎么|错了|不行|搞什么)', re.I)
    corrections = [m for m in user_msgs if correction_words.search(m)]
    print(f'\n-- user interaction --')
    print(f'user_msgs={len(user_msgs)} correction_msgs={len(corrections)}')
    for m in corrections:
        snippet = m.strip().replace('\n', ' ')[:80]
        print(f'  CORRECTION: {snippet}')

    # tool/think ratio
    if has_thinking:
        print(f'\n-- ratios --')
        print(f'think_chars_per_tool_call={sum(len(t) for t in thinks)//max(1,len(tool_calls))}')
        print(f'think_blocks_per_tool_call={len(thinks)/max(1,len(tool_calls)):.2f}')

# --- run on paths passed as CLI args ---
# Usage: python3 analyze_overthinking.py <label1> <path1> [<label2> <path2> ...]
# Example: python3 analyze_overthinking.py "Session A" ~/.pi/agent/sessions/.../a.jsonl "Session B" ~/.pi/agent/sessions/.../b.jsonl
if __name__ == '__main__':
    args = sys.argv[1:]
    if not args or len(args) % 2 != 0:
        print("Usage: analyze_overthinking.py <label1> <path1> [<label2> <path2> ...]", file=sys.stderr)
        sys.exit(1)
    for i in range(0, len(args), 2):
        label, path = args[i], args[i + 1]
        has_thinking = '.codex' not in path  # codex reasoning is encrypted
        analyze_session(path, label, has_thinking=has_thinking)
