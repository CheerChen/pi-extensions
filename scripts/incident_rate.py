#!/usr/bin/env python3
"""Merge same models across pi/devin, compute overthinking incident rate."""
import json, os, glob, re, collections

BRANCH = re.compile(r'\b(options|alternative|hmm|actually|wait|but |or |let me think|consider|maybe|could|perhaps|wonder if)\b', re.I)
DECISION = re.compile(r'\b(decide|chose|choose|go with|let.s do|i.ll use|decision is|final answer|verdict)\b', re.I)
PRECISION = re.compile(r'\d+\.\d{2,}\s*[=*/]\s*\d+\.\d{2,}')
PATCH = re.compile(r"(sed -i|python -c|python3 -c|<<'EOF'|<<'PY'|<<'py')")
CORRECTION = re.compile(r'(不对|重新|服了|不是|别|没变|到底|怎么|错了|不行|搞什么|停|不要|过多|超过)')

# Model normalization map
def normalize_model(name):
    n = name.lower().strip()
    if 'glm-5.3' in n or 'glm5.3' in n: return 'GLM-5.3 Flash'
    if 'glm-5.2' in n or 'glm5.2' in n: return 'GLM-5.2 High'
    if 'deepseek-v4.1' in n or 'deepseek v4.1' in n: return 'DS v4.1 Flash'
    if 'deepseek-v4' in n or 'deepseek v4' in n: return 'DS v4 Flash'
    if 'gpt-5.6-sol' in n or 'gpt-5.6 sol' in n: return 'GPT-5.6 Sol'
    if 'gpt-5.6-luna' in n: return 'GPT-5.6 Luna'
    if 'gpt-5.6-terra' in n: return 'GPT-5.6 Terra'
    if 'gpt-5.4' in n: return 'GPT-5.4'
    if 'claude' in n: return 'Claude Opus 5'
    if 'gemini' in n: return 'Gemini 3.8 Flash'
    if 'ox-alpha' in n: return 'ox-alpha-free'
    if 'qwen' in n: return 'Qwen 3.7 Max'
    return name

def scan_pi(path):
    model = '?'
    thinks, tools, users = [], [], []
    for line in open(path):
        line = line.strip()
        if not line: continue
        try: o = json.loads(line)
        except: continue
        t = o.get('type')
        if t == 'model_change':
            if model == '?': model = o.get('modelId','?')
        elif t == 'message':
            m = o.get('message',{})
            role = m.get('role')
            for c in m.get('content',[]):
                ct = c.get('type')
                if ct == 'thinking': thinks.append(c.get('thinking',''))
                elif ct == 'text' and role == 'user': users.append(c.get('text',''))
                elif ct == 'toolCall':
                    a = c.get('arguments',{})
                    cmd = a.get('command','') or a.get('path','') or str(a)
                    tools.append(cmd)
    patches = sum(1 for c in tools if PATCH.search(c))
    corrections = sum(1 for m in users if CORRECTION.search(m))
    return model, thinks, patches, corrections, len(tools)

def scan_devin(path):
    try: d = json.load(open(path))
    except: return None
    model = d.get('agent',{}).get('model_name','?')
    steps = d.get('steps',[])
    thinks = [s.get('reasoning_content','') for s in steps if s.get('reasoning_content')]
    users = []
    for s in steps:
        if s.get('source') == 'user':
            msg = s.get('message','')
            content = msg.get('content','') if isinstance(msg, dict) else str(msg)
            users.append(str(content))
    corrections = sum(1 for u in users if CORRECTION.search(u))
    return model, thinks, 0, corrections, 0  # devin: patches=0, tools=0 (format limitation)

# --- scan all ---
sessions = []  # (model, thinks, patches, corrections, n_tools, source)
pi_files = sorted(glob.glob(os.path.expanduser('~/.pi/agent/sessions/**/*.jsonl'), recursive=True))
devin_files = sorted(glob.glob(os.path.expanduser('~/.local/share/devin/cli/transcripts/*.json')))

for f in pi_files:
    model, thinks, patches, corrections, n_tools = scan_pi(f)
    if not thinks: continue
    sessions.append((normalize_model(model), thinks, patches, corrections, n_tools, 'pi', os.path.basename(f)))

for f in devin_files:
    r = scan_devin(f)
    if not r: continue
    model, thinks, patches, corrections, n_tools = r
    if not thinks: continue
    sessions.append((normalize_model(model), thinks, patches, corrections, n_tools, 'devin', os.path.basename(f)))

# --- define "problem session" ---
def is_problem(thinks, patches, corrections):
    if not thinks: return False, []
    max_block = max(len(t) for t in thinks)
    n_thinks = len(thinks)
    total = sum(len(t) for t in thinks)
    precision = sum(len(PRECISION.findall(t)) for t in thinks)
    flags = []
    # Rule 1: single massive think block
    if max_block > 10000:
        flags.append(f'max_block={max_block}')
    # Rule 2: horizontal spread — many blocks + huge total
    if n_thinks > 50 and total > 100000:
        flags.append(f'spread(n={n_thinks},total={total})')
    # Rule 3: precision obsession
    if precision > 10:
        flags.append(f'precision={precision}')
    # Rule 4: repeated patching (pi only)
    if patches > 15:
        flags.append(f'patches={patches}')
    # NOTE: corrections removed as standalone trigger — user corrections
    # include normal requirement iteration, not just overthinking fallout.
    # Only count corrections as a secondary signal in the detail view.
    return len(flags) > 0, flags

# --- group by model ---
by_model = collections.defaultdict(list)
for s in sessions:
    by_model[s[0]].append(s)

print(f'{"Model":<20} {"Total":>5} {"Problem":>7} {"Rate":>6} {"avg_max":>8} {"avg_n":>6} {"avg_total":>10} {"avg_prec":>8} {"avg_patch":>8} {"avg_corr":>7}')
print('-' * 105)

model_order = ['GLM-5.2 High', 'GLM-5.3 Flash', 'DS v4 Flash', 'DS v4.1 Flash',
               'GPT-5.6 Sol', 'GPT-5.6 Luna', 'GPT-5.6 Terra', 'Claude Opus 5',
               'Gemini 3.8 Flash', 'Qwen 3.7 Max', 'ox-alpha-free', 'GPT-5.4']

for model in model_order:
    rs = by_model.get(model, [])
    if not rs: continue
    total_sessions = len(rs)
    problems = 0
    all_flags = []
    max_blocks = []
    n_thinks_list = []
    totals = []
    precisions = []
    patches_list = []
    corrections_list = []
    for r in rs:
        _, thinks, patches, corrections, n_tools, source, fname = r
        is_p, flags = is_problem(thinks, patches, corrections)
        if is_p: problems += 1
        all_flags.extend(flags)
        if thinks:
            max_blocks.append(max(len(t) for t in thinks))
            n_thinks_list.append(len(thinks))
            totals.append(sum(len(t) for t in thinks))
            precisions.append(sum(len(PRECISION.findall(t)) for t in thinks))
            patches_list.append(patches)
            corrections_list.append(corrections)
    n = max(1, len(max_blocks))
    rate = problems / total_sessions * 100
    print(f'{model:<20} {total_sessions:>5} {problems:>7} {rate:>5.0f}% {sum(max_blocks)/n:>8.0f} {sum(n_thinks_list)/n:>6.1f} {sum(totals)/n:>10.0f} {sum(precisions)/n:>8.1f} {sum(patches_list)/n:>8.1f} {sum(corrections_list)/n:>7.1f}')

# --- detail: which rules triggered per model ---
print('\n' + '='*80)
print('Rule trigger breakdown by model')
print('='*80)
print(f'{"Model":<20} {"Total":>5} {"max>10k":>8} {"spread":>7} {"prec>10":>8} {"patch>15":>8} {"corr>2":>7}')
print('-'*70)
for model in model_order:
    rs = by_model.get(model, [])
    if not rs: continue
    r1=r2=r3=r4=r5=0
    for s in rs:
        _, thinks, patches, corrections, _, _, _ = s
        if not thinks: continue
        max_b = max(len(t) for t in thinks)
        n_t = len(thinks)
        total = sum(len(t) for t in thinks)
        prec = sum(len(PRECISION.findall(t)) for t in thinks)
        if max_b > 10000: r1 += 1
        if n_t > 50 and total > 100000: r2 += 1
        if prec > 10: r3 += 1
        if patches > 15: r4 += 1
        if corrections > 2: r5 += 1
    print(f'{model:<20} {len(rs):>5} {r1:>8} {r2:>7} {r3:>8} {r4:>8} {r5:>7}')

# --- list problem sessions for key models ---
print('\n' + '='*80)
print('Problem sessions for GLM-5.3 Flash, DS v4/v4.1 Flash')
print('='*80)
for model in ['GLM-5.3 Flash', 'DS v4 Flash', 'DS v4.1 Flash', 'GLM-5.2 High']:
    rs = by_model.get(model, [])
    if not rs: continue
    print(f'\n--- {model} ({len(rs)} sessions) ---')
    for s in rs:
        _, thinks, patches, corrections, n_tools, source, fname = s
        is_p, flags = is_problem(thinks, patches, corrections)
        if is_p:
            max_b = max(len(t) for t in thinks)
            print(f'  [{source}] {fname[:50]} | max={max_b} | {" | ".join(flags)}')
