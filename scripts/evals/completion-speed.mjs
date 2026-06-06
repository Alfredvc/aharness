#!/usr/bin/env node
/**
 * Measure aharness shell-completion latency.
 *
 * This intentionally shells out to the real `aharness completion-server`
 * command because that is what the installed tabtab delegate does on every
 * Tab press. Use it before and after completion-path changes:
 *
 *   node scripts/evals/completion-speed.mjs --output /tmp/aharness-completion-before.json
 *   node scripts/evals/completion-speed.mjs --baseline /tmp/aharness-completion-before.json
 *
 * By default it runs the globally resolved `aharness` binary. To measure a
 * local build instead:
 *
 *   pnpm --filter @aharness/core build
 *   node scripts/evals/completion-speed.mjs --command "node packages/core/dist/cli/main.js"
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, platform, release } from 'node:os';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const DEFAULT_ITERATIONS = 20;
const DEFAULT_WARMUP = 3;
const DEFAULT_TIMEOUT_MS = 5_000;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

const fixtures = {
  typed: 'packages/core/test/fixtures/args/typed-input.fsm.ts',
  boolean: 'packages/core/test/fixtures/args/boolean-input.fsm.ts',
  dynamic: 'packages/core/test/fixtures/args/canonical-dynamic-completion.fsm.ts',
};

const CASES = [
  {
    name: 'root.commands.empty',
    description: 'Top-level subcommand completion after `aharness `',
    line: 'aharness ',
    expectAny: ['completion', 'run', 'verify'],
  },
  {
    name: 'root.commands.prefix',
    description: 'Top-level subcommand prefix completion after `aharness r`',
    line: 'aharness r',
    expectAny: ['run'],
  },
  {
    name: 'run.target.empty',
    description: 'Run target completion after `aharness run `',
    line: 'aharness run ',
    expectAny: ['packages', 'docs'],
  },
  {
    name: 'run.target.prefix',
    description: 'Run target path-prefix completion for a fixture FSM',
    line: 'aharness run packages/core/test/fixtures/args/t',
    expectAny: [fixtures.typed],
  },
  {
    name: 'input.flags.empty',
    description: 'Input flag-name completion after an FSM target',
    line: `aharness run ${fixtures.typed} `,
    expectAny: ['--topic:Project slug', '--choice:Branch'],
  },
  {
    name: 'input.flags.prefix',
    description: 'Input flag-name completion after a partial `--`',
    line: `aharness run ${fixtures.typed} --`,
    expectAny: ['--topic:Project slug', '--choice:Branch'],
  },
  {
    name: 'input.static.value',
    description: 'Static value completion from `completion: { values: [...] }`',
    line: `aharness run ${fixtures.typed} --choice `,
    expectAny: ['a', 'b', 'c'],
  },
  {
    name: 'input.boolean.value',
    description: 'Boolean value completion after a partial value',
    line: `aharness run ${fixtures.boolean} --worktree t`,
    expectAny: ['true'],
  },
  {
    name: 'input.dynamic.value',
    description: 'Dynamic callback path; clean exit is the measured contract here',
    line: `aharness run ${fixtures.dynamic} --arrow a`,
    expectAny: [],
  },
];

function usage() {
  process.stderr.write(`usage:
  node scripts/evals/completion-speed.mjs [options]

options:
  --command <cmd>       Command used before "completion-server" (default: aharness)
  --iterations <n>      Measured iterations per case (default: ${DEFAULT_ITERATIONS})
  --warmup <n>          Warmup iterations per case, excluded from stats (default: ${DEFAULT_WARMUP})
  --timeout-ms <n>      Per-invocation timeout (default: ${DEFAULT_TIMEOUT_MS})
  --case <name>         Run one case; repeatable
  --list-cases          Print available cases and exit
  --output <path>       Write JSON result
  --baseline <path>     Compare against a previous JSON result
  --json                Print JSON only
  --help                Print this help

examples:
  node scripts/evals/completion-speed.mjs --output /tmp/before.json
  node scripts/evals/completion-speed.mjs --baseline /tmp/before.json
  node scripts/evals/completion-speed.mjs --iterations 50 --case input.flags.empty
`);
}

function parseArgs(argv) {
  const opts = {
    command: process.env.AHARNESS_COMPLETION_COMMAND ?? 'aharness',
    iterations: DEFAULT_ITERATIONS,
    warmup: DEFAULT_WARMUP,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    cases: [],
    output: null,
    baseline: null,
    json: false,
    listCases: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--list-cases') {
      opts.listCases = true;
    } else if (arg === '--command') {
      opts.command = requireValue(argv, ++i, arg);
    } else if (arg === '--iterations') {
      opts.iterations = parsePositiveInt(requireValue(argv, ++i, arg), arg);
    } else if (arg === '--warmup') {
      opts.warmup = parseNonNegativeInt(requireValue(argv, ++i, arg), arg);
    } else if (arg === '--timeout-ms') {
      opts.timeoutMs = parsePositiveInt(requireValue(argv, ++i, arg), arg);
    } else if (arg === '--case') {
      opts.cases.push(requireValue(argv, ++i, arg));
    } else if (arg === '--output') {
      opts.output = requireValue(argv, ++i, arg);
    } else if (arg === '--baseline') {
      opts.baseline = requireValue(argv, ++i, arg);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function parsePositiveInt(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function parseNonNegativeInt(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer`);
  }
  return parsed;
}

function parseCommand(command) {
  const parts = [];
  let current = '';
  let quote = null;
  let escaped = false;
  for (const ch of command) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        parts.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (escaped) current += '\\';
  if (quote) throw new Error(`unterminated quote in --command: ${command}`);
  if (current) parts.push(current);
  if (parts.length === 0) throw new Error('--command must not be empty');
  return parts;
}

function caseEnv(line) {
  const point = line.length;
  const beforeCursor = line.slice(0, point);
  const trimmed = beforeCursor.trim();
  const words = trimmed ? trimmed.split(/\s+/) : [];
  const cword = beforeCursor.endsWith(' ') ? words.length : Math.max(0, words.length - 1);
  return {
    COMP_CWORD: String(cword),
    COMP_LINE: line,
    COMP_POINT: String(point),
    SHELL: 'zsh',
  };
}

function caseArgv(line) {
  return line.trim().split(/\s+/).filter(Boolean);
}

function runCompletion({ commandParts, line, timeoutMs }) {
  const [bin, ...baseArgs] = commandParts;
  const args = [...baseArgs, 'completion-server', '--', ...caseArgv(line)];
  const env = { ...process.env, ...caseEnv(line) };
  const start = performance.now();
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      const elapsedMs = performance.now() - start;
      resolve({
        elapsedMs,
        exitCode: null,
        signal: null,
        timedOut,
        stdout,
        stderr,
        error: error.message,
      });
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      const elapsedMs = performance.now() - start;
      resolve({ elapsedMs, exitCode, signal, timedOut, stdout, stderr, error: null });
    });
  });
}

function outputLines(stdout) {
  return stdout.split(/\r?\n/).filter((line) => line.length > 0);
}

function validateRun(run, testCase) {
  const lines = outputLines(run.stdout);
  const missing = testCase.expectAny.filter((expected) => !lines.includes(expected));
  return {
    ok: run.exitCode === 0 && !run.timedOut && !run.error && missing.length === 0,
    missing,
    outputLineCount: lines.length,
  };
}

async function measureCase({ commandParts, testCase, iterations, warmup, timeoutMs }) {
  const first = await runCompletion({ commandParts, line: testCase.line, timeoutMs });
  const firstValidation = validateRun(first, testCase);
  const warmups = [];
  for (let i = 0; i < warmup; i++) {
    const run = await runCompletion({ commandParts, line: testCase.line, timeoutMs });
    warmups.push({ ...run, validation: validateRun(run, testCase) });
  }

  const samples = [];
  for (let i = 0; i < iterations; i++) {
    const run = await runCompletion({ commandParts, line: testCase.line, timeoutMs });
    samples.push({ ...run, validation: validateRun(run, testCase) });
  }
  return summarizeCase({ testCase, first, firstValidation, warmups, samples });
}

function summarizeCase({ testCase, first, firstValidation, warmups, samples }) {
  const measured = samples.map((sample) => sample.elapsedMs);
  const failures = samples
    .map((sample, index) => ({ sample, index }))
    .filter(({ sample }) => !sample.validation.ok);
  return {
    name: testCase.name,
    description: testCase.description,
    line: testCase.line,
    expected: testCase.expectAny,
    first: compactRun(first, firstValidation),
    warmup: warmups.map((run) => compactRun(run, run.validation)),
    stats: stats(measured),
    failures: failures.map(({ sample, index }) => ({
      index,
      exitCode: sample.exitCode,
      signal: sample.signal,
      timedOut: sample.timedOut,
      error: sample.error,
      missing: sample.validation.missing,
      stdout: sample.stdout.slice(0, 1_000),
      stderr: sample.stderr.slice(0, 1_000),
    })),
  };
}

function compactRun(run, validation) {
  return {
    elapsedMs: round(run.elapsedMs),
    exitCode: run.exitCode,
    signal: run.signal,
    timedOut: run.timedOut,
    error: run.error,
    outputLineCount: validation.outputLineCount,
    ok: validation.ok,
    missing: validation.missing,
  };
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((acc, value) => acc + value, 0) / Math.max(1, n);
  const variance = sorted.reduce((acc, value) => acc + (value - mean) ** 2, 0) / Math.max(1, n);
  return {
    count: n,
    minMs: round(sorted[0] ?? 0),
    p50Ms: round(percentile(sorted, 0.5)),
    p75Ms: round(percentile(sorted, 0.75)),
    p90Ms: round(percentile(sorted, 0.9)),
    p95Ms: round(percentile(sorted, 0.95)),
    maxMs: round(sorted[n - 1] ?? 0),
    meanMs: round(mean),
    stddevMs: round(Math.sqrt(variance)),
  };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function gitValue(args) {
  const result = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0) return null;
  const value = result.stdout.trim();
  return value || null;
}

function loadBaseline(path) {
  if (!existsSync(path)) throw new Error(`baseline does not exist: ${path}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function buildComparison(current, baseline) {
  const baselineCases = new Map((baseline.cases ?? []).map((entry) => [entry.name, entry]));
  return current.cases.map((entry) => {
    const before = baselineCases.get(entry.name);
    if (!before) return { name: entry.name, missingBaseline: true };
    const beforeP50 = before.stats?.p50Ms ?? 0;
    const beforeP95 = before.stats?.p95Ms ?? 0;
    const afterP50 = entry.stats.p50Ms;
    const afterP95 = entry.stats.p95Ms;
    return {
      name: entry.name,
      beforeP50Ms: beforeP50,
      afterP50Ms: afterP50,
      deltaP50Ms: round(afterP50 - beforeP50),
      changeP50Pct: percentChange(afterP50, beforeP50),
      beforeP95Ms: beforeP95,
      afterP95Ms: afterP95,
      deltaP95Ms: round(afterP95 - beforeP95),
      changeP95Pct: percentChange(afterP95, beforeP95),
    };
  });
}

function percentChange(after, before) {
  if (!before) return null;
  return round(((after - before) / before) * 100);
}

function printCases() {
  for (const testCase of CASES) {
    console.log(`${testCase.name}\t${testCase.description}`);
  }
}

function printTable(result) {
  console.log(`aharness completion speed eval`);
  console.log(`command: ${result.command}`);
  console.log(`iterations: ${result.iterations}, warmup: ${result.warmup}`);
  console.log('');
  console.log(
    [
      'case'.padEnd(25),
      'first'.padStart(9),
      'p50'.padStart(9),
      'p95'.padStart(9),
      'mean'.padStart(9),
      'max'.padStart(9),
      'fail'.padStart(6),
    ].join('  '),
  );
  for (const entry of result.cases) {
    console.log(
      [
        entry.name.padEnd(25),
        formatMs(entry.first.elapsedMs).padStart(9),
        formatMs(entry.stats.p50Ms).padStart(9),
        formatMs(entry.stats.p95Ms).padStart(9),
        formatMs(entry.stats.meanMs).padStart(9),
        formatMs(entry.stats.maxMs).padStart(9),
        String(entry.failures.length + (entry.first.ok ? 0 : 1)).padStart(6),
      ].join('  '),
    );
  }
  if (result.comparison) {
    console.log('');
    console.log('comparison vs baseline');
    console.log(
      [
        'case'.padEnd(25),
        'p50 before'.padStart(11),
        'p50 now'.padStart(9),
        'p50 %'.padStart(8),
        'p95 before'.padStart(11),
        'p95 now'.padStart(9),
        'p95 %'.padStart(8),
      ].join('  '),
    );
    for (const row of result.comparison) {
      if (row.missingBaseline) {
        console.log(`${row.name.padEnd(25)}  ${'missing baseline'.padStart(11)}`);
        continue;
      }
      console.log(
        [
          row.name.padEnd(25),
          formatMs(row.beforeP50Ms).padStart(11),
          formatMs(row.afterP50Ms).padStart(9),
          formatPct(row.changeP50Pct).padStart(8),
          formatMs(row.beforeP95Ms).padStart(11),
          formatMs(row.afterP95Ms).padStart(9),
          formatPct(row.changeP95Pct).padStart(8),
        ].join('  '),
      );
    }
  }
}

function formatMs(value) {
  return `${value.toFixed(2)}ms`;
}

function formatPct(value) {
  if (value === null) return 'n/a';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n`);
    usage();
    process.exit(2);
  }
  if (opts.help) {
    usage();
    return;
  }
  if (opts.listCases) {
    printCases();
    return;
  }

  const unknownCase = opts.cases.find((name) => !CASES.some((testCase) => testCase.name === name));
  if (unknownCase) throw new Error(`unknown case: ${unknownCase}`);
  const selectedCases =
    opts.cases.length === 0
      ? CASES
      : opts.cases.map((name) => CASES.find((testCase) => testCase.name === name));
  const commandParts = parseCommand(opts.command);
  const result = {
    kind: 'aharness.completion-speed',
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    repoRoot,
    git: {
      commit: gitValue(['rev-parse', 'HEAD']),
      branch: gitValue(['rev-parse', '--abbrev-ref', 'HEAD']),
      statusShort: gitValue(['status', '--short']),
    },
    system: {
      node: process.version,
      platform: `${platform()} ${release()}`,
      cpu: cpus()[0]?.model ?? null,
      cpuCount: cpus().length,
    },
    command: opts.command,
    iterations: opts.iterations,
    warmup: opts.warmup,
    timeoutMs: opts.timeoutMs,
    cases: [],
  };

  for (const testCase of selectedCases) {
    result.cases.push(
      await measureCase({
        commandParts,
        testCase,
        iterations: opts.iterations,
        warmup: opts.warmup,
        timeoutMs: opts.timeoutMs,
      }),
    );
  }

  if (opts.baseline) {
    result.baseline = resolve(opts.baseline);
    result.comparison = buildComparison(result, loadBaseline(opts.baseline));
  }
  if (opts.output) {
    writeFileSync(opts.output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  }
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printTable(result);
    if (opts.output) console.log(`\nwrote ${opts.output}`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exit(1);
});
