"""Rebuild the Program Ledger library: cited passages (corpus/*), findings (findings/*) and meta/docs.

Usage: python3 scripts/tracker/build-corpus.py <repo> <out_dir> [<phase-plan.md> ...]
Writes one JSON file per db document into <out_dir> plus batch-N.json files (each < 900 KB,
<= 50 writes) for the ArtifactData "batch" action. Fix/phase/PR/event status is NOT rebuilt here:
the ledger database is the source of truth for status; /tracker-sync updates it.
Passes text through scrub(): masks phone numbers (except +1555 test numbers), non-org emails, tokens."""
import json, re, os, sys, pathlib, hashlib
REPO = pathlib.Path(sys.argv[1]); OUT = pathlib.Path(sys.argv[2]); EXTRA_PLANS = [pathlib.Path(p) for p in sys.argv[3:]]
VERSIONS = json.load(open(os.environ['LEDGER_VERSIONS'])) if os.environ.get('LEDGER_VERSIONS') else {}
OUT.mkdir(parents=True, exist_ok=True)
for f in OUT.glob('*.json'): f.unlink()

def scrub(t):
    t = re.sub(r'\+(?!1555)(\d{6,13})(\d{4})\b', lambda m: '+' + '•'*len(m.group(1)) + m.group(2), t)
    t = re.sub(r'\b([A-Za-z0-9._%+-]+)@(?!smartremit\.ai\b|example\.com\b|testing\.com\b)([A-Za-z0-9.-]+\.[a-z]{2,})\b', lambda m: m.group(1)[:1] + '…@' + m.group(2), t)
    for pat in (r'sk-[A-Za-z0-9]{20,}', r'gh[pos]_[A-Za-z0-9]{20,}', r'EAA[A-Za-z0-9]{30,}', r'xox[bp]-[A-Za-z0-9-]{20,}'):
        t = re.sub(pat, '<redacted-token>', t)
    return t

# ---------- corpus ----------
if not list(REPO.glob('CLAUDE-SECURITY-*/CLAUDE-SECURITY-RESULTS.md')):
    sys.exit('No CLAUDE-SECURITY-*/ results in the repo root (git-ignored). Run from the main checkout that holds the scan output.')
DOCS = [
  ('audit', 'Ground-truth audit (2026-09-14)', REPO/'docs/AUDIT-2026-09-14.md'),
  ('security', 'Security scan results (claude-security)', sorted(REPO.glob('CLAUDE-SECURITY-*/CLAUDE-SECURITY-RESULTS.md'))[-1]),
  ('spec', 'Upgrade program design (approved)', REPO/'docs/superpowers/specs/2026-09-14-upgrade-program-design.md'),
  ('plan-p0', 'Phase 0 plan: unblock and close the doors', REPO/'docs/superpowers/plans/2026-09-14-phase0-unblock-and-close-doors.md'),
  ('verify-p0', 'Phase 0 verification run (Chrome checks)', REPO/'docs/verification/2026-09-15-phase0-chrome-verification.md'),
  ('review-p0', 'Phase 0 whole-branch review', REPO/'docs/verification/2026-09-15-phase0-whole-branch-review.md'),
  ('components', 'Component map (13 anchors)', REPO/'docs/COMPONENTS.md'),
  ('architecture', 'System architecture', REPO/'docs/SYSTEM-ARCHITECTURE.md'),
  ('bot', 'How the bot works', REPO/'docs/HOW-THE-BOT-WORKS.md'),
  ('agentic', 'Agentic architecture', REPO/'docs/AGENTIC-ARCHITECTURE.md'),
  ('overview', 'Platform overview', REPO/'docs/SMARTREMIT-PLATFORM-OVERVIEW.md'),
  ('roadmap', 'Roadmap', REPO/'docs/ROADMAP.md'),
]
for n, p in enumerate(EXTRA_PLANS, start=1):
    m = re.search(r'phase(\d)(?:-wave(\d))?', p.name)
    # Wave 1 keeps the historical key plan-p1; later waves get plan-p<phase>-w<wave> so they never collide.
    key = (f'plan-p{m.group(1)}' + (f'-w{m.group(2)}' if m.group(2) and m.group(2) != '1' else '')) if m else f'plan-x{n}'
    DOCS.append((key, f'Plan: {p.stem}' + ('' if str(p).startswith(str(REPO/"docs")) else ' (DRAFT, uncommitted)'), p))
MAXC = 1800
def chunk_md(key, label, text):
    lines = text.split('\n'); path = []; buf = []; out = []; in_code = False
    def flush():
        body = '\n'.join(buf).strip()
        if not body: return
        heading = ' › '.join(h for _, h in path) or label
        paras = re.split(r'\n{2,}', body); cur = ''
        for p in paras:
            while len(p) > MAXC:
                if cur: out.append((heading, cur)); cur = ''
                out.append((heading, p[:MAXC])); p = p[MAXC:]
            if len(cur) + len(p) + 2 > MAXC and cur:
                out.append((heading, cur)); cur = p
            else:
                cur = (cur + '\n\n' + p) if cur else p
        if cur: out.append((heading, cur))
    for ln in lines:
        if ln.startswith('```'): in_code = not in_code
        m = None if in_code else re.match(r'^(#{1,4})\s+(.*)', ln)
        if m:
            flush(); buf = []
            lvl = len(m.group(1)); path[:] = [p for p in path if p[0] < lvl] + [(lvl, m.group(2).strip())]
        else:
            buf.append(ln)
    flush()
    return [{'id': f'{key}#{i}', 'doc': key, 'h': h, 't': t} for i, (h, t) in enumerate(out)]

def blueprint_chunks():
    b = json.load(open(REPO/'docs/architecture/smartremit-blueprint-data.json'))
    out = []
    def add(h, obj):
        s = json.dumps(obj, ensure_ascii=False, indent=1)
        for i in range(0, len(s), MAXC):
            out.append((h, s[i:i+MAXC]))
    for k, v in b['components'].items(): add(f'Component › {k}', v)
    for k, v in b['flows'].items(): add(f'Flow › {k}', v)
    for k, v in b['context'].items(): add(f'Context › {k}', v)
    for t in b['erd']['tables']: add(f'Data model › {t.get("name", "table") if isinstance(t, dict) else "table"}', t)
    add('Data model › notes', b['erd']['notes'])
    for k, v in b['pipeline'].items(): add(f'Delivery pipeline › {k}', v)
    add('Security controls', b['security']['controls'])
    return [{'id': f'blueprint#{i}', 'doc': 'blueprint', 'h': h, 't': t} for i, (h, t) in enumerate(out)]

chunks = []; docmeta = []
for key, label, path in DOCS:
    text = scrub(path.read_text())
    c = chunk_md(key, label, text); chunks += c
    docmeta.append({'key': key, 'label': label, 'source': str(path.relative_to(REPO)) if str(path).startswith(str(REPO)) else 'scratchpad (uncommitted draft)', 'chunks': len(c), 'bytes': len(text)})
# Merged program PR descriptions (what changed, why, proof, review changes) so the assistant knows every merge.
def pr_notes():
    import subprocess
    try:
        out = subprocess.run(['gh', 'pr', 'list', '-R', 'Nagavenkatasai7/claude-payments', '--state', 'merged', '--limit', '200',
                              '--search', 'created:>=2026-09-07', '--json', 'number,title,body,mergedAt,headRefName'],
                             capture_output=True, text=True, check=True).stdout
    except Exception as e:
        print('PR notes skipped:', e); return None
    prs = [x for x in json.loads(out) if x['number'] >= 237 and not re.match(r'^(dependabot|loop)/', x['headRefName'])]
    prs.sort(key=lambda x: x['number'])
    md = '# Merged program PRs\n\n' + '\n\n'.join(f"## PR #{x['number']}: {x['title']} (merged {x['mergedAt'][:10]})\n\n{x['body'] or ''}" for x in prs)
    return md

notes = pr_notes()
if notes:
    text = scrub(notes)
    c = chunk_md('prs', 'Merged PR descriptions', text); chunks += c
    docmeta.append({'key': 'prs', 'label': 'Merged PR descriptions', 'source': 'GitHub PR bodies (program PRs #237+)', 'chunks': len(c), 'bytes': len(text)})

bp = blueprint_chunks(); bp = [dict(x, t=scrub(x['t'])) for x in bp]; chunks += bp
docmeta.append({'key': 'blueprint', 'label': 'SmartRemit Blueprint (architecture data)', 'source': 'docs/architecture/smartremit-blueprint-data.json', 'chunks': len(bp), 'bytes': sum(len(x['t']) for x in bp)})

writes = []
def put(coll, doc_id, body):
    s = json.dumps(body, ensure_ascii=False)
    assert len(s.encode()) < 240_000, (coll, doc_id, len(s))
    fn = OUT / f'{coll.replace("/", "_")}__{doc_id}.json'; fn.write_text(s)
    w = {'op': 'set', 'collection': coll, 'doc_id': doc_id, 'file_path': str(fn)}
    if VERSIONS.get(f'{coll}/{doc_id}'): w['if_version'] = VERSIONS[f'{coll}/{doc_id}']
    writes.append(w)

part, cur, size = 0, [], 0
for c in chunks:
    b = len(json.dumps(c, ensure_ascii=False).encode())
    if size + b > 228_000 and cur:
        put('corpus', f'part-{part:03d}', {'part': part, 'chunks': cur}); part += 1; cur, size = [], 0
    cur.append(c); size += b
if cur: put('corpus', f'part-{part:03d}', {'part': part, 'chunks': cur}); part += 1

# ---------- findings ----------
A = (REPO/'docs/AUDIT-2026-09-14.md').read_text().split('\n')
sec, sub = '', ''; findings = []
for ln in A:
    m = re.match(r'^# (\d+\.\s.*)', ln)
    if m: sec = m.group(1)
    m = re.match(r'^### (Not working|Degraded|Unknown \(needs access\)|Working \(proven\))', ln)
    if m: sub = m.group(1)
    m = re.match(r'^\| (critical|high|medium|low) \| ([^|]*) \| ([^|]*) \| (.*)\|\s*$', ln)
    if m and sec and not sec.startswith('8.'):
        area_ids = m.group(3).strip(); ids = [x.strip() for x in area_ids.split('/')[-1].split(',')] if '/' in area_ids else []
        cell = m.group(4); tm = re.match(r'\*\*(.+?)\*\*(?:<br>(.*))?', cell.strip())
        title = tm.group(1) if tm else cell.strip()[:200]; detail = (tm.group(2) or '') if tm else ''
        findings.append({'ids': ids, 'severity': m.group(1), 'verdict': m.group(2).strip(), 'area': area_ids.split('/')[0].strip(), 'title': scrub(title), 'summary': scrub(re.sub(r'<br>', ' ', detail))[:600], 'section': sec, 'state': sub, 'source': 'audit'})
for l in open(sorted(REPO.glob('CLAUDE-SECURITY-*/CLAUDE-SECURITY-RESULTS.jsonl'))[-1]):
    d = json.loads(l)
    findings.append({'ids': [d['id']], 'severity': str(d.get('severity', '')).lower(), 'verdict': 'verified (3-voter panel)', 'area': d.get('category', ''), 'title': scrub(d['title']), 'summary': scrub(d.get('impact', ''))[:600], 'section': '8. Security scan', 'state': 'Not working', 'source': 'security-scan', 'file': d.get('file'), 'line': d.get('line')})

# ---------- finding -> fix mapping (from the program manifest) ----------
M = json.load(open(REPO/'docs/superpowers/plans/2026-09-14-program-manifest.json'))
id2fix = {}
for p in M['phases']:
    for f in p['fixes']:
        for i in f['finding_ids']: id2fix.setdefault(i, []).append(f['fix'])
for f in findings:
    f['fixes'] = sorted({x for i in f['ids'] for x in id2fix.get(i, [])})
for i in range(0, len(findings), 120):
    put('findings', f'part-{i//120:02d}', {'part': i//120, 'items': findings[i:i+120]})
put('meta', 'docs', {'docs': docmeta, 'corpusParts': part, 'chunkCount': len(chunks), 'findingsParts': (len(findings)+119)//120, 'findingCount': len(findings)})

json.dump(writes, open(OUT/'writes.json', 'w'), indent=1)
batches, cur, size = [], [], 0
for x in writes:
    b = os.path.getsize(x['file_path']) + 400
    if cur and (size + b > 900_000 or len(cur) == 50): batches.append(cur); cur, size = [], 0
    cur.append(x); size += b
if cur: batches.append(cur)
for i, bt in enumerate(batches): json.dump(bt, open(OUT/f'batch-{i}.json', 'w'))
print('passages', len(chunks), 'corpus docs', part, 'findings', len(findings), 'writes', len(writes), 'batches', [len(b) for b in batches])
print('NOTE: delete stale corpus/part-NNN docs >= corpusParts if the new build has fewer parts.')
