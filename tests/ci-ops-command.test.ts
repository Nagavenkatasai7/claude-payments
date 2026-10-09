import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatOutputs, parseOpsCommand, runCli } from '../scripts/ci/ops-command.mjs';

// scripts/ci/ops-command.mjs: the parser behind .github/workflows/ops-commands.yml.
// The owner comments `/ops <command>` on an issue labelled `ops`; the workflow's
// GITHUB_TOKEN (actions: write) then re-runs, cancels or dispatches a run. The
// comment body is untrusted text, so only an exact first-line grammar passes.

const SHA = '3a37f27c0ffee0123456789abcdef0123456789a';

describe('parseOpsCommand: valid forms', () => {
  it.each([
    ['/ops rerun 123', { cmd: 'rerun', runId: '123' }],
    ['/ops rerun-all 18234567890', { cmd: 'rerun-all', runId: '18234567890' }],
    ['/ops cancel 9', { cmd: 'cancel', runId: '9' }],
    ['/ops smoke', { cmd: 'smoke' }],
    [`/ops smoke ${SHA}`, { cmd: 'smoke', sha: SHA }],
  ])('%s', (body, want) => {
    expect(parseOpsCommand(body)).toEqual(want);
  });

  it('keeps a 20-digit run id as a string (beyond Number precision)', () => {
    expect(parseOpsCommand('/ops rerun 12345678901234567890')).toEqual({ cmd: 'rerun', runId: '12345678901234567890' });
  });

  it('lowercases an upper-case sha', () => {
    expect(parseOpsCommand(`/ops smoke ${SHA.toUpperCase()}`)).toEqual({ cmd: 'smoke', sha: SHA });
  });

  it('tolerates trailing spaces and a CRLF line end', () => {
    expect(parseOpsCommand('/ops cancel 42  \r\nthanks')).toEqual({ cmd: 'cancel', runId: '42' });
    expect(parseOpsCommand('/ops smoke\t')).toEqual({ cmd: 'smoke' });
  });

  it('reads only the first line; later lines are ignored', () => {
    expect(parseOpsCommand('/ops rerun 1\n/ops cancel 2')).toEqual({ cmd: 'rerun', runId: '1' });
    // A newline ends the line: the digits after it never join the run id or reach $GITHUB_OUTPUT.
    expect(parseOpsCommand('/ops rerun 1\n2')).toEqual({ cmd: 'rerun', runId: '1' });
    expect(parseOpsCommand('/ops smoke\nsha=deadbeef\ncmd=cancel')).toEqual({ cmd: 'smoke' });
  });
});

describe('parseOpsCommand: rejects everything else', () => {
  it.each([
    ['empty', ''],
    ['no command', '/ops'],
    ['no command, trailing space', '/ops '],
    ['unknown command', '/ops deploy 123'],
    ['missing run id', '/ops rerun'],
    ['extra words', '/ops rerun 123 please'],
    ['two run ids', '/ops cancel 1 2'],
    ['double space', '/ops  rerun 123'],
    ['tab separator', '/ops\trerun 123'],
    ['leading space', ' /ops rerun 123'],
    ['upper-case prefix', '/OPS rerun 123'],
    ['upper-case command', '/ops RERUN 123'],
    ['prefix glued', '/opsrerun 123'],
    ['command on the second line only', 'hello\n/ops rerun 123'],
    ['semicolon injection', '/ops rerun 123; rm -rf /'],
    ['glued semicolon', '/ops rerun 123;rm'],
    ['command substitution', '/ops rerun $(id)'],
    ['backticks', '/ops rerun `id`'],
    ['substitution after the id', '/ops rerun 1$(id)'],
    ['pipe', '/ops cancel 1 | cat'],
    ['carriage return in the middle', '/ops rerun 1\r2'],
    ['negative id', '/ops rerun -1'],
    ['zero', '/ops rerun 0'],
    ['leading zero', '/ops rerun 0123'],
    ['21 digits', '/ops rerun 123456789012345678901'],
    ['huge number', `/ops rerun ${'9'.repeat(400)}`],
    ['exponent', '/ops rerun 1e9'],
    ['hex id', '/ops rerun 0x1F'],
    ['decimal', '/ops rerun 1.5'],
    ['arabic-indic digits', '/ops rerun ١٢٣'],
    ['fullwidth digits', '/ops rerun １２３'],
    ['devanagari digits', '/ops cancel १२३'],
    ['non-breaking space separator', '/ops rerun 123'],
    ['zero-width space in the id', '/ops rerun 12​3'],
    ['short sha', '/ops smoke 3a37f27'],
    ['41-hex sha', `/ops smoke ${SHA}0`],
    ['39-hex sha', `/ops smoke ${SHA.slice(1)}`],
    ['non-hex sha', `/ops smoke ${'g'.repeat(40)}`],
    ['sha plus words', `/ops smoke ${SHA} now`],
    ['smoke with a branch name', '/ops smoke main'],
    ['smoke with injection', '/ops smoke $(id)'],
    ['rerun with a sha', `/ops rerun ${SHA}`],
  ])('%s', (_name, body) => {
    expect(parseOpsCommand(body)).toBeNull();
  });

  it.each([[undefined], [null], [123], [{}]])('non-string %s', (body) => {
    expect(parseOpsCommand(body as unknown as string)).toBeNull();
  });
});

describe('formatOutputs', () => {
  it('writes cmd, run_id and sha lines, empty when absent', () => {
    expect(formatOutputs({ cmd: 'rerun', runId: '77' })).toBe('cmd=rerun\nrun_id=77\nsha=\n');
    expect(formatOutputs({ cmd: 'smoke', sha: SHA })).toBe(`cmd=smoke\nrun_id=\nsha=${SHA}\n`);
    expect(formatOutputs({ cmd: 'smoke' })).toBe('cmd=smoke\nrun_id=\nsha=\n');
  });
});

describe('runCli', () => {
  function harness(env: Record<string, string | undefined>) {
    const writes: Array<{ path: string; text: string }> = [];
    const logs: string[] = [];
    const code = runCli({
      env,
      appendFile: (path: string, text: string) => writes.push({ path, text }),
      log: (line: string) => logs.push(line),
    });
    return { code, writes, logs };
  }

  it('appends the outputs to $GITHUB_OUTPUT for a valid command', () => {
    const { code, writes, logs } = harness({ COMMENT_BODY: '/ops cancel 5150', GITHUB_OUTPUT: '/tmp/out' });
    expect(code).toBe(0);
    expect(writes).toEqual([{ path: '/tmp/out', text: 'cmd=cancel\nrun_id=5150\nsha=\n' }]);
    expect(logs.join('\n')).toContain('cancel');
  });

  it('prints "no command", writes nothing and exits 0 for anything else', () => {
    const { code, writes, logs } = harness({ COMMENT_BODY: '/ops rerun 1; rm -rf /', GITHUB_OUTPUT: '/tmp/out' });
    expect(code).toBe(0);
    expect(writes).toEqual([]);
    expect(logs).toEqual(['no command']);
  });

  it('never echoes the comment body', () => {
    const { logs } = harness({ COMMENT_BODY: '/ops rerun $(curl evil)', GITHUB_OUTPUT: '/tmp/out' });
    expect(logs.join('\n')).not.toContain('curl');
  });

  it('treats a missing body as no command', () => {
    expect(harness({ GITHUB_OUTPUT: '/tmp/out' })).toMatchObject({ code: 0, writes: [], logs: ['no command'] });
  });

  it('fails when a valid command has no GITHUB_OUTPUT to write to', () => {
    const { code, writes } = harness({ COMMENT_BODY: '/ops smoke' });
    expect(code).toBe(1);
    expect(writes).toEqual([]);
  });
});

describe('.github/workflows/ops-commands.yml', () => {
  // Text assertions, as in tests/ci-workflow-hardening.test.ts (no YAML parser dependency).
  const wf = readFileSync(join(__dirname, '..', '.github/workflows/ops-commands.yml'), 'utf8');

  it('runs on new issue comments only, with no top-level permissions', () => {
    expect(wf).toMatch(/^on:\n {2}issue_comment:\n {4}types: \[created\]$/m);
    expect(wf).toMatch(/^permissions: \{\}$/m);
  });

  it('gates the job on an owner comment starting with /ops on an ops-labelled issue (not a PR)', () => {
    expect(wf).toContain('!github.event.issue.pull_request');
    expect(wf).toContain("contains(github.event.issue.labels.*.name, 'ops')");
    expect(wf).toContain("github.event.comment.user.login == 'Nagavenkatasai7'");
    expect(wf).toContain("github.event.comment.author_association == 'OWNER'");
    expect(wf).toContain("startsWith(github.event.comment.body, '/ops ')");
  });

  it('grants actions: write, contents: read and issues: write at job level and times out', () => {
    expect(wf).toMatch(/\n {4}permissions:\n {6}actions: write\n {6}contents: read\n {6}issues: write\n/);
    expect(wf).toMatch(/\n {4}timeout-minutes: 5\n/);
  });

  it('checks out without persisting credentials and parses the body from env', () => {
    expect(wf).toMatch(/persist-credentials: false/);
    expect(wf).toMatch(/COMMENT_BODY: \$\{\{ github\.event\.comment\.body \}\}/);
    expect(wf).toMatch(/run: node scripts\/ci\/ops-command\.mjs/);
  });

  it('expands expressions only as env values, never inside a run: script', () => {
    const lines = wf.split('\n').filter((l) => l.includes('${{'));
    expect(lines.length).toBeGreaterThan(3);
    for (const l of lines) expect(l).toMatch(/^ +[A-Z_]+: \$\{\{ [\w.]+ \}\}$/);
    // The untrusted body is read in exactly one place: the parser's env.
    expect(wf.match(/github\.event\.comment\.body/g)).toHaveLength(2); // the job if: and COMMENT_BODY
  });

  it('calls the documented endpoints for each command', () => {
    expect(wf).toContain('actions/runs/$RUN_ID/rerun-failed-jobs');
    expect(wf).toContain('actions/runs/$RUN_ID/rerun"');
    expect(wf).toContain('actions/runs/$RUN_ID/cancel');
    expect(wf).toContain('actions/workflows/smoke.yml/dispatches');
    expect(wf).toContain('issues/comments/$COMMENT_ID/reactions');
    expect(wf).toContain('GH_TOKEN: ${{ github.token }}');
  });
});
