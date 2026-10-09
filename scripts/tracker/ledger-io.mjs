// Program Ledger v2: shared file I/O for the thin CLIs (collect.mjs, curate.mjs, seed-v2.mjs,
// note.mjs). No logic about the ledger lives here; the pure cores do that.
//
// Node built-ins only (the routine runs this without npm install).
//
// ---------- the dump layout ----------
// ArtifactData list/get with out_dir saves <db>/<collection>/<doc_id>.json holding the doc's data
// only; the version is in the tool result text, not in the file. So the routine (or a session)
// records every version it read in <db>/versions.json:
//   {"<collection>/<doc_id>": <version>, ...}   (or {"<collection>": {"<doc_id>": <version>}})
// A doc file may also be a {data, version} wrapper; its version is used when versions.json has none.
// A CLI never writes an existing doc without its version (planWrites throws).
//
// Several dump dirs can be layered (later dirs win): curate.mjs apply writes the docs it changed
// to <out>/after/ (with predicted versions), and curate.mjs check reads --db plus that overlay.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';

/** Print a JSON error line and exit (2 = bad input, the caller may fix and retry). */
export function fail(msg, code = 2) {
  console.error(JSON.stringify({ error: msg }));
  process.exit(code);
}

/** The value after a flag, or undefined. */
export function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
}
export const hasFlag = (argv, name) => argv.includes(name);

/** JSON from a file; `fallback` when the file is missing; throws on bad JSON. */
export function readJson(path, fallback = undefined) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8'));
}

const isWrapper = (d) => d && typeof d === 'object' && !Array.isArray(d) && d.data && typeof d.data === 'object' && Number.isInteger(d.version);

/** <db>/versions.json, flattened to {"coll/id": n}. */
export function readVersions(db) {
  const raw = readJson(join(db, 'versions.json'), {});
  const out = {};
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (Number.isInteger(v)) out[k] = v;
    else if (v && typeof v === 'object') for (const [id, n] of Object.entries(v)) if (Number.isInteger(n)) out[`${k}/${id}`] = n;
  }
  return out;
}

/**
 * Read collections from one or more dump dirs (later dirs win).
 * @param {string[]} dirs
 * @param {string[]} collections collection names (a nested path such as runs is fine)
 * @param {string[]} warnings
 * @returns {{docs: Record<string, Record<string, any>>, versions: Record<string, number>, ids: Set<string>}}
 */
export function readDump(dirs, collections, warnings = []) {
  const docs = {};
  const versions = {};
  const ids = new Set();
  for (const c of collections) docs[c] = {};
  for (const dir of dirs.filter(Boolean).map((d) => resolve(d))) {
    if (!existsSync(dir)) { warnings.push(`dump dir ${dir} does not exist (skipped)`); continue; }
    Object.assign(versions, readVersions(dir));
    for (const c of collections) {
      const cdir = join(dir, c);
      if (!existsSync(cdir)) continue;
      for (const f of readdirSync(cdir).filter((x) => x.endsWith('.json'))) {
        const id = basename(f, '.json');
        ids.add(`${c}/${id}`);
        try {
          const raw = JSON.parse(readFileSync(join(cdir, f), 'utf8'));
          if (isWrapper(raw)) {
            docs[c][id] = raw.data;
            if (!Number.isInteger(versions[`${c}/${id}`])) versions[`${c}/${id}`] = raw.version;
          } else docs[c][id] = raw;
        } catch {
          warnings.push(`unreadable dump file ${c}/${f} (id still counted as existing)`);
        }
      }
    }
  }
  return { docs, versions, ids };
}

/** Every "<collection>/<id>" under a dump dir (all collections, any depth of one level). */
export function listDumpIds(db) {
  const ids = new Set();
  if (!existsSync(db)) return ids;
  for (const c of readdirSync(db)) {
    const cdir = join(db, c);
    if (!statSync(cdir).isDirectory()) continue;
    for (const f of readdirSync(cdir)) if (f.endsWith('.json')) ids.add(`${c}/${basename(f, '.json')}`);
  }
  return ids;
}

/** Every file under a directory, as {rel (posix), abs}. */
export function walkFiles(dir) {
  const out = [];
  if (!dir || !existsSync(dir)) return out;
  const walk = (d) => {
    for (const f of readdirSync(d).sort()) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else out.push({ rel: relative(dir, p).split(sep).join('/'), abs: p });
    }
  };
  walk(resolve(dir));
  return out;
}

/** Remove the files a previous run of a CLI wrote into `out` (batches, doc files, summaries). */
export function cleanOut(out, extra = []) {
  mkdirSync(out, { recursive: true });
  for (const f of readdirSync(out)) {
    const p = join(out, f);
    if (/^batch-\d+\.json$/.test(f) || /^[A-Za-z0-9._~-]+__.+\.json$/.test(f) || f === 'summary.json' || extra.includes(f)) rmSync(p, { recursive: true, force: true });
  }
}

/**
 * Write batches as ArtifactData batch files: each write's data goes to <out>/<coll>__<id>.json
 * and the batch entry carries file_path instead of data. Returns the batch sizes.
 * @param {string} out
 * @param {Array<Array<{op: string, collection: string, doc_id: string, data: any, if_version?: number}>>} batches
 * @param {string} [prefix]
 */
export function writeBatchFiles(out, batches, prefix = 'batch') {
  const sizes = [];
  batches.forEach((b, i) => {
    const writes = b.map((w) => {
      const file = join(out, `${w.collection.replace(/\//g, '~')}__${w.doc_id}.json`);
      writeFileSync(file, JSON.stringify(w.data));
      const { data: _data, ...rest } = w;
      return { ...rest, file_path: file };
    });
    writeFileSync(join(out, `${prefix}-${i}.json`), JSON.stringify(writes, null, 1));
    sizes.push(writes.length);
  });
  return sizes;
}

/**
 * Write docs as a dump overlay: <dir>/<coll>/<id>.json plus versions.json with the PREDICTED
 * version after the write (existing + 1, new = 1). Used for dry runs and for check.
 */
export function writeOverlay(dir, changes, versions) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const next = {};
  for (const c of changes) {
    mkdirSync(join(dir, c.collection), { recursive: true });
    writeFileSync(join(dir, c.collection, `${c.id}.json`), JSON.stringify(c.data, null, 1));
    const v = versions[`${c.collection}/${c.id}`];
    next[`${c.collection}/${c.id}`] = Number.isInteger(v) ? v + 1 : 1;
  }
  writeFileSync(join(dir, 'versions.json'), JSON.stringify(next, null, 1));
}

/** {"coll/id": data} of an engine (sync.mjs) --out dir: its <coll>__<id>.json doc files. */
export function readEngineDocs(dir) {
  const out = {};
  if (!dir || !existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    const m = f.match(/^([a-z0-9-]+)__(.+)\.json$/);
    if (!m) continue;
    try { out[`${m[1]}/${m[2]}`] = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { /* skip */ }
  }
  return out;
}
