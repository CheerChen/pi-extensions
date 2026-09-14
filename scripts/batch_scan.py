#!/usr/bin/env python3
"""Batch scan pi + devin sessions for overthinking indicators, grouped by model."""
import json, os, glob, re, collections

BRANCH = re.compile(r'\b(options|alternative|hmm|actually|wait|but |or |let me think|consider|maybe|could|perhaps|wonder if)\b', re.I)
REVERSAL = re.compile(r'\b(wait|actually|no,|i was wrong|let me reconsider|scratch that|hold on|oops|mistake)\b', re.I)
DECISION = re.compile(r'\b(decide|chose|choose|go with|let.s do|i.ll use|decision is|final answer|verdict)\b', re.I)
PRECISION = re.compile(r'\d+\.\d{2,}\s*[=*/]\s*\d+\.\d{2,}')
PATCH = re.compile(r"(sed -i|python -c|python3 -c|<<'EOF'|<<'PY'|<<'py')")
CORRECTION = re.compile(r'(不对|重新|服了|不是|别|没变|到底|怎么|错了|不行|搞什么)')

def metrics_from_thinks(thinks):
    if not thinks:
        return None
    total = sum(len(t) for t in thinks)
    branch = sum(len(BRANCH.findall(t)) for t in thinks)
    reversal = sum(len(REVERSAL.findall(t)) for t in thinks)
    decision = sum(len(DECISION.findall(t)) for t in thinks)
    precision = sum(len(PRECISION.findall(t)) for t in thinks)
    return {
        'n_thinks': len(thinks),
        'total_chars': total,
        'max_block': max(len(t) for t in thinks),
        'branch': branch,
        'reversal': reversal,
        'decision': decision,
        'precision': precision,
        'dec_branch_ratio': decision / max(1, branch),
    }

def scan_pi(path):
    model = '?'
    thinks, tools, users, asst_texts = [], [], [], []
    first_output_idx = None
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
                if ct == 'thinking':
                    thinks.append(c.get('thinking',''))
                elif ct == 'text' and role == 'user':
                    users.append(c.get('text',''))
                elif ct == 'text' and role == 'assistant':
                    asst_texts.append(c.get('text',''))
                elif ct == 'toolCall':
                    a = c.get('arguments',{})
                    cmd = a.get('command','') or a.get('path','') or str(a)
                    tools.append(cmd)
                    if first_output_idx is None and re.search(r'read.*\.(png|jpg|webp)|view_image|preview|screenshot|snapshot', cmd, re.I):
                        first_output_idx = len(tools)
    patches = sum(1 for c in tools if PATCH.search(c))
    corrections = sum(1 for m in users if CORRECTION.search(m))
    tm = metrics_from_thinks(thinks)
    return {
        'model': model,
        'n_thinks': len(thinks),
        'n_tools': len(tools),
        'n_users': len(users),
        'patches': patches,
        'corrections': corrections,
        'first_output_idx': first_output_idx,
        'tm': tm,
    }

def scan_devin(path):
    try:
        d = json.load(open(path))
    except:
        return None
    model = d.get('agent',{}).get('model_name','?')
    steps = d.get('steps',[])
    thinks, tools, users = [], [], []
    first_output_idx = None
    for s in steps:
        rc = s.get('reasoning_content') or s.get('extra',{}).get('reasoning_content')
        if rc: thinks.append(rc)
        msg = s.get('message',{})
        if isinstance(msg, dict):
            role = msg.get('role')
            content = msg.get('content', '')
            if role == 'user':
                users.append(str(content))
            # tool calls
            tc = msg.get('tool_calls', [])
            if isinstance(tc, list):
                for c in tc:
                    fn = c.get('function',{}) if isinstance(c, dict) else {}
                    args = fn.get('arguments','') if isinstance(fn, dict) else ''
                    tools.append(str(args))
                    if first_output_idx is None and re.search(r'browser_preview|screenshot|snapshot|read.*\.(png|jpg)', str(args), re.I):
                        first_output_idx = len(tools)
        # also check extra for tool calls
        ex = s.get('extra',{})
        if isinstance(ex, dict):
            tc = ex.get('tool_calls', ex.get('toolCall', []))
            if isinstance(tc, list):
                for c in tc:
                    tools.append(str(c))
    patches = sum(1 for c in tools if PATCH.search(c))
    corrections = sum(1 for m in users if CORRECTION.search(m))
    tm = metrics_from_thinks(thinks)
    return {
        'model': model,
        'n_thinks': len(thinks),
        'n_tools': len(tools),
        'n_users': len(users),
        'patches': patches,
        'corrections': corrections,
        'first_output_idx': first_output_idx,
        'tm': tm,
    }

# --- scan all pi sessions ---
pi_files = sorted(glob.glob(os.path.expanduser('~/.pi/agent/sessions/**/*.jsonl'), recursive=True))
devin_files = sorted(glob.glob(os.path.expanduser('~/.local/share/devin/cli/transcripts/*.json')))

results = []
for f in pi_files:
    r = scan_pi(f)
    r['source'] = 'pi'
    r['file'] = os.path.basename(f)
    r['dir'] = os.path.basename(os.path.dirname(f))[:40]
    results.append(r)
for f in devin_files:
    r = scan_devin(f)
    if r is None: continue
    r['source'] = 'devin'
    r['file'] = os.path.basename(f)
    r['dir'] = ''
    results.append(r)

# --- filter: only sessions with thinking data ---
with_thinks = [r for r in results if r['n_thinks'] > 0]
print(f'Total sessions: {len(results)}  (pi={len(pi_files)}, devin={len(devin_files)})')
print(f'Sessions with thinking: {len(with_thinks)}')
print()

# --- group by model, compute averages ---
by_model = collections.defaultdict(list)
for r in with_thinks:
    by_model[r['model']].append(r)

print(f'{"Model":<35} {"n":>3} {"avg_thinks":>10} {"avg_chars":>10} {"avg_max":>8} {"dec/br":>7} {"prec":>5} {"patches":>7} {"corr":>5} {"1st_out":>7}')
print('-'*105)
for model, rs in sorted(by_model.items(), key=lambda x: -sum(r['n_thinks'] for r in x[1])):
    avg_thinks = sum(r['n_thinks'] for r in rs)/len(rs)
    avg_chars = sum(r['tm']['total_chars'] for r in rs if r['tm'])/max(1,len([r for r in rs if r['tm']]))
    avg_max = sum(r['tm']['max_block'] for r in rs if r['tm'])/max(1,len([r for r in rs if r['tm']]))
    avg_ratio = sum(r['tm']['dec_branch_ratio'] for r in rs if r['tm'])/max(1,len([r for r in rs if r['tm']]))
    avg_prec = sum(r['tm']['precision'] for r in rs if r['tm'])/max(1,len([r for r in rs if r['tm']]))
    avg_patches = sum(r['patches'] for r in rs)/len(rs)
    avg_corr = sum(r['corrections'] for r in rs)/len(rs)
    outs = [r['first_output_idx'] for r in rs if r['first_output_idx'] is not None]
    avg_out = sum(outs)/max(1,len(outs)) if outs else 0
    print(f'{model:<35} {len(rs):>3} {avg_thinks:>10.1f} {avg_chars:>10.0f} {avg_max:>8.0f} {avg_ratio:>7.3f} {avg_prec:>5.1f} {avg_patches:>7.1f} {avg_corr:>5.1f} {avg_out:>7.1f}')

# --- flag suspicious sessions ---
print('\n' + '='*105)
print('SUSPICIOUS SESSIONS (any indicator flagged)')
print('='*105)
flags = []
for r in with_thinks:
    tm = r['tm']
    if not tm: continue
    f = []
    if tm['max_block'] > 10000: f.append(f"max_block={tm['max_block']}")
    if tm['dec_branch_ratio'] < 0.1 and tm['branch'] > 20: f.append(f"dec/branch={tm['dec_branch_ratio']:.3f}")
    if tm['precision'] > 10: f.append(f"precision={tm['precision']}")
    if r['patches'] > 15: f.append(f"patches={r['patches']}")
    if r['corrections'] > 2: f.append(f"corrections={r['corrections']}")
    if r['first_output_idx'] and r['n_tools'] > 10 and r['first_output_idx'] / r['n_tools'] > 0.5:
        f.append(f"late_output={r['first_output_idx']}/{r['n_tools']}")
    if r['n_thinks'] > 40: f.append(f"n_thinks={r['n_thinks']}")
    if f:
        flags.append((r, f))

flags.sort(key=lambda x: -len(x[1]))
for r, f in flags:
    print(f"[{r['source']:5}] {r['model']:<30} thinks={r['n_thinks']:>3} tools={r['n_tools']:>3} | {' | '.join(f)}")
    print(f"         {r['file'][:60]}  dir={r['dir'][:40]}")
