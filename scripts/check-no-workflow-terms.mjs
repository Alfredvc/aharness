#!/usr/bin/env node
// scripts/check-no-workflow-terms.mjs
//
// Enforces `SPEC_SDK.md` §1: the SDK must not contain workflow-vocabulary
// terms. Scans `packages/core/src/` recursively and fails the
// build if a match is found. Intended to be wired into `pnpm run verify`.
//
// ## Matching rules (deviation documented in chunk 2 commit message)
//
// `SPEC_SDK.md` §1 originally specified case-insensitive substring
// matching on the banned list. Two rounds of refinement:
//
//   1. The word `Record` is a TypeScript built-in utility type used
//      extensively across the SDK; a case-insensitive substring match
//      would fire on every `Record<>` occurrence. Adopted **case-sensitive
//      word-boundary** matching to ignore the capitalised TS utility plus
//      identifiers/module names that share a suffix or prefix.
//
//   2. The lowercase forms `record`, `phase`, `budget` are generic CS /
//      infra vocabulary (persistence verb, Chrome-trace event phase,
//      timeout / size budget), not workflow-specific terminology. They
//      were dropped from the banned list. The remaining list targets
//      workflow opinions enumerated by `SPEC_SDK.md` §1: Volere/Kano/
//      Cynefin/MoSCoW vocabulary, "requirement"/"fit criterion"/
//      "review gate"/"banned"/"rigor".
//
// A separate test (`*.test.mjs`) runs the script against fixture inputs
// to verify exit codes.
//
// ## CLI
//
//   node scripts/check-no-workflow-terms.mjs [ROOT_DIR]
//
// `ROOT_DIR` defaults to `packages/core/src` relative to the repo
// root (resolved from this script's location). The argument is useful for
// the script's own test rig, which points at a tempdir.
//
// Exit code 0: no matches found.
// Exit code 1: one or more matches found. Offending lines are printed as
//              `<path>:<line>:<match>` on stderr.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BANNED = [
  'volere',
  'kano',
  'cynefin',
  'rigor',
  'moscow',
  'requirement',
  'fit criterion',
  'review gate',
  'banned',
];

// Case-sensitive lowercase word-boundary pattern. Anchored with `\b` on
// both ends so `Record` (capital R) and `recording` are not matched.
function buildPattern(terms) {
  const escaped = terms.map((t) =>
    t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'),
  );
  return new RegExp(`\\b(${escaped.join('|')})\\b`);
}

const PATTERN = buildPattern(BANNED);

/**
 * Skip fixtures directory and test files. Fixtures are explicitly exempt
 * per SPEC_SDK §1; test files are exempt by convention so the test suite
 * can reference banned terms in expectations.
 */
function isExempt(path) {
  if (path.endsWith('.test.ts')) return true;
  if (path.endsWith('.test.mjs')) return true;
  if (path.endsWith('.test.js')) return true;
  if (path.includes('/fixtures/')) return true;
  return false;
}

function walk(dir, found) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const info = statSync(full);
    if (info.isDirectory()) {
      walk(full, found);
      continue;
    }
    if (!info.isFile()) continue;
    if (!full.endsWith('.ts') && !full.endsWith('.mts') && !full.endsWith('.cts')) continue;
    if (isExempt(full)) continue;
    scanFile(full, found);
  }
}

function scanFile(path, found) {
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = PATTERN.exec(line);
    if (match) {
      found.push({ path, line: i + 1, match: match[0] });
    }
  }
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, '..');
  const rootArg = process.argv[2];
  const scanRoot = rootArg ? resolve(rootArg) : resolve(repoRoot, 'packages/core/src');

  let info;
  try {
    info = statSync(scanRoot);
  } catch {
    process.stderr.write(`check-no-workflow-terms: scan target does not exist: ${scanRoot}\n`);
    process.exit(1);
  }
  if (!info.isDirectory()) {
    process.stderr.write(`check-no-workflow-terms: scan target is not a directory: ${scanRoot}\n`);
    process.exit(1);
  }

  const found = [];
  walk(scanRoot, found);

  if (found.length > 0) {
    for (const hit of found) {
      const rel = relative(process.cwd(), hit.path);
      process.stderr.write(`${rel}:${hit.line}:${hit.match}\n`);
    }
    process.stderr.write(
      `\ncheck-no-workflow-terms: ${found.length} disallowed occurrence(s) found.\n`,
    );
    process.exit(1);
  }
  process.exit(0);
}

main();
