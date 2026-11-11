// Fix pack 5 (R08, P28): the India Ministry of Home Affairs UAPA list, CURATED by
// SmartRemit platform staff from the MHA notifications (the First and Fourth
// Schedules of the Unlawful Activities (Prevention) Act). MHA publishes no
// machine-readable feed, so nothing here fetches anything: a platform admin
// uploads a CSV on /admin-dashboard/compliance/sanctions-lists, and the action
// stores it through the same storeList integrity rules as every other list
// (all rows or none, the 0.8 shrink floor, forward-only versions).
//
// Owner steps (index.md): counsel names the lists that apply per corridor, and a
// named person owns this curation (re-checking the notifications and pressing
// "confirm still current" at least every 8 days, LIST_MAX_AGE_MS['in-mha-uapa']).
// Nothing screens against this list unless SANCTIONS_LIST=lists.
//
// The file format (one header row, then one row per designation):
//   id,type,name,aliases,weak_aliases,program,reference
// RFC 4180 CSV (https://www.rfc-editor.org/rfc/rfc4180): fields separated by
// commas, CRLF or LF line ends, a field in double quotes may hold commas, and a
// double quote inside it is written twice. A leading BOM is stripped. aliases
// and weak_aliases are separated by '|'. The list's version (the notification
// date) is NOT read from the file: the upload action supplies it.
//
// Pure, no I/O. Errors carry a row number and a code ONLY, never a value (a
// name in an error would reach the page, the audit row or a log). Never throws.

import { normalizeName } from './normalize';
import { hashEntries } from './ofac-sdn-loader';
import { isBoundedPrintable } from '@/lib/untrusted-text';
import type { SanctionsList, SanctionsListEntry } from './list-source';

export const MHA_SOURCE = 'in-mha-uapa' as const;
export const MHA_MAX_BYTES = 256 * 1024;
export const MHA_MAX_ROWS = 2000;
export const MHA_MIN_ENTRIES = 20;
export const MHA_NAME_MAX = 200;
export const MHA_MAX_ALIASES = 20;

export const MHA_COLUMNS = Object.freeze(['id', 'type', 'name', 'aliases', 'weak_aliases', 'program', 'reference'] as const);

export type MhaRowErrorCode =
  | 'bad_header'
  | 'bad_columns'
  | 'empty_name'
  | 'name_too_short'
  | 'name_too_long'
  | 'too_many_aliases'
  | 'bad_type'
  | 'bad_id'
  | 'duplicate_id'
  | 'bad_text'
  | 'too_many_rows'
  | 'no_rows';

export interface MhaRowError {
  /** The record number in the file, the header being row 1. */
  row: number;
  code: MhaRowErrorCode;
}

export type ParseInMhaResult = { ok: true; list: SanctionsList } | { ok: false; errors: MhaRowError[] };

const ID_RE = /^[A-Za-z0-9._-]{1,40}$/;
const TYPES = new Set(['Individual', 'Entity']);
/** A cell bound for the control-character check only (the name rules bound each name). */
const CELL_MAX = (MHA_NAME_MAX + 1) * (MHA_MAX_ALIASES + 1);
/** P11 finding: a one- or two-letter name or alias would match nearly every India row. */
const MIN_LETTERS = 3;

const charLength = (v: string): number => [...v].length;

/** Letters kept after the screener's own normalisation (digits and spaces do not count). */
const letterCount = (v: string): number => normalizeName(v).replace(/[^\p{L}]/gu, '').length;

interface Rec {
  row: number;
  cells: string[];
  /** An opening quote with no closing one (the rest of the file was swallowed). */
  broken: boolean;
}

/** A small RFC 4180 reader: records with their 1-based record numbers. */
function readRecords(text: string): Rec[] {
  const out: Rec[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let i = 0;
  const push = () => {
    cells.push(cell);
    cell = '';
  };
  const end = () => {
    push();
    out.push({ row: out.length + 1, cells, broken: false });
    cells = [];
  };
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      cell += c;
      i += 1;
      continue;
    }
    if (c === '"' && cell === '') {
      quoted = true;
      i += 1;
    } else if (c === ',') {
      push();
      i += 1;
    } else if (c === '\r' && text[i + 1] === '\n') {
      end();
      i += 2;
    } else if (c === '\n') {
      end();
      i += 1;
    } else {
      cell += c;
      i += 1;
    }
  }
  if (quoted) {
    push();
    out.push({ row: out.length + 1, cells, broken: true });
  } else if (cell !== '' || cells.length > 0) {
    end();
  }
  return out;
}

const isBlank = (r: Rec): boolean => !r.broken && r.cells.length === 1 && r.cells[0].trim() === '';

const splitNames = (v: string): string[] =>
  v
    .split('|')
    .map((s) => s.trim())
    .filter((s) => s !== '');

/** Parse a curated MHA CSV. All rows or none: any error -> { ok: false } and no list. */
export function parseInMhaCsv(text: string): ParseInMhaResult {
  const body = typeof text === 'string' ? text.replace(/^﻿/, '') : '';
  const records = readRecords(body);
  const header = records[0];
  if (
    !header ||
    header.broken ||
    header.cells.length !== MHA_COLUMNS.length ||
    header.cells.some((c, i) => c.trim().toLowerCase() !== MHA_COLUMNS[i])
  ) {
    return { ok: false, errors: [{ row: 1, code: 'bad_header' }] };
  }
  const data = records.slice(1).filter((r) => !isBlank(r));
  if (data.length === 0) return { ok: false, errors: [{ row: 2, code: 'no_rows' }] };
  if (data.length > MHA_MAX_ROWS) return { ok: false, errors: [{ row: MHA_MAX_ROWS + 2, code: 'too_many_rows' }] };

  const errors: MhaRowError[] = [];
  const entries: SanctionsListEntry[] = [];
  const seen = new Set<string>();
  for (const rec of data) {
    const codes: MhaRowErrorCode[] = [];
    const add = (code: MhaRowErrorCode) => {
      if (!codes.includes(code)) codes.push(code);
    };
    if (rec.broken || rec.cells.length !== MHA_COLUMNS.length) {
      errors.push({ row: rec.row, code: 'bad_columns' });
      continue;
    }
    // Pack 5 review LD1: U+FFFD is what a lossy decode leaves for a byte that is not UTF-8 (a
    // Windows-1252 or UTF-16 file); a name holding it can never match a payee.
    if (rec.cells.some((c) => !isBoundedPrintable(c, CELL_MAX) || c.includes('�'))) {
      errors.push({ row: rec.row, code: 'bad_text' });
      continue;
    }
    const [id, type, name, aliasCell, weakCell, program] = rec.cells.map((c) => c.trim());
    if (!ID_RE.test(id)) add('bad_id');
    else if (seen.has(id)) add('duplicate_id');
    else seen.add(id);
    if (!TYPES.has(type)) add('bad_type');
    const aliases = splitNames(aliasCell);
    const weak = splitNames(weakCell);
    if (name === '') add('empty_name');
    if (aliases.length + weak.length > MHA_MAX_ALIASES) add('too_many_aliases');
    for (const n of [...(name === '' ? [] : [name]), ...aliases, ...weak]) {
      if (charLength(n) > MHA_NAME_MAX) add('name_too_long');
      else if (letterCount(n) < MIN_LETTERS) add('name_too_short');
    }
    if (codes.length > 0) {
      for (const code of codes) errors.push({ row: rec.row, code });
      continue;
    }
    const entry: SanctionsListEntry = {
      id: `inmha:${id}`,
      type,
      names: [name, ...aliases],
      programs: program === '' ? [] : [program],
    };
    if (weak.length > 0) entry.weakNames = weak;
    entries.push(entry);
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, list: { source: MHA_SOURCE, version: '', hash: hashEntries(entries), entries } };
}
