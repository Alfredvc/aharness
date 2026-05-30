#!/usr/bin/env node
// scripts/check-no-stale-stateless-contracts.mjs
//
// Enforces the final stateless-runs and fresh-clear public contract.
// The check scans current user-facing docs and shipped source surfaces for
// stale framework resume, durable pending-clear, callable ops.clear(), and
// rollback-backed clear guidance.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE_TARGETS = [
  'README.md',
  'CLAUDE.md',
  'docs/architecture.md',
  'docs/reference.md',
  'docs/troubleshooting.md',
  'examples/DEMOS.md',
  'packages/core/README.md',
  'packages/core/scripts/browserGoldenServer.mjs',
  'packages/core/src/events.ts',
  'packages/core/src/index.ts',
  'packages/core/src/snapshot.ts',
  'packages/core/src/cli/runCli.ts',
  'packages/core/src/state/aharnessOps.ts',
  'packages/core/src/runtime/freshClear.ts',
];

const DIRECTORY_TARGETS = ['packages/core/src/ui', 'packages/web-ui/src'];

const ROOT_EXAMPLE_DIR = 'examples';

const SCANNED_EXTENSIONS = new Set(['.css', '.html', '.js', '.jsx', '.md', '.mjs', '.ts', '.tsx']);

const RULES = [
  {
    id: 'framework-resume-guidance',
    pattern:
      /\baharness\s+<[^>\n]+>\s+--resume\b|\bresume with:?\s+aharness\b|\bsnapshot\/resume\b|\bthread\/resume\b|\bwarm-resume\b|\bcrash recovery\b/i,
  },
  {
    id: 'framework-recovery-promise',
    pattern:
      /\bstate recovery is from\b|\bactor recovery\b|\bresume-from-snapshot\b|\bcreateActor\(machine,\s*\{\s*snapshot\b/i,
  },
  {
    id: 'durable-pending-clear',
    pattern: /\bpendingClear\b|\bpending clear\b|\bdurable pending\b/i,
    allowNegated: true,
  },
  {
    id: 'legacy-ops-clear',
    pattern: /\bops\.clear\s*\(/,
    allowNegated: true,
  },
  {
    id: 'rollback-backed-clear',
    pattern: /\bthread\/rollback\b|\brolling back\b|\bRollback\b|\brollback-backed\b/i,
    allowNegated: true,
  },
  {
    id: 'snapshot-current-source',
    pattern:
      /\bsnapshot\.json\b.*\b(current inspection state|source of truth|authoritative|UI-facing|reconstruct|replay|history)\b|\b(current inspection state|source of truth|authoritative|UI-facing|reconstruct|replay|history)\b.*\bsnapshot\.json\b/i,
    allowNegated: true,
  },
  {
    id: 'flat-browser-routes-current',
    pattern:
      /\/api\/(?:state|stream|reply)\b.*\b(compatibility|browser source|production browser|remain|served|route)\b|\b(browser source|production browser|compatibility|remain|served|route)\b.*\/api\/(?:state|stream|reply)\b/i,
    allowNegated: true,
  },
];

const NEGATION =
  /\b(no|not|never|without|instead of|rather than|does not|do not|is not|are not|no longer)\b/i;

function pathExists(path) {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function extensionOf(path) {
  const basename = path.split('/').pop() ?? path;
  const dot = basename.lastIndexOf('.');
  return dot >= 0 ? basename.slice(dot) : '';
}

function shouldScanFile(path) {
  if (!SCANNED_EXTENSIONS.has(extensionOf(path))) return false;
  if (path.includes('/src/ui/static/')) return false;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(path)) return false;
  return true;
}

function walk(dir, files) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const info = statSync(full);
    if (info.isDirectory()) {
      walk(full, files);
      continue;
    }
    if (info.isFile() && shouldScanFile(full)) {
      files.push(full);
    }
  }
}

function rootExampleFiles(repoRoot) {
  const examplesDir = resolve(repoRoot, ROOT_EXAMPLE_DIR);
  if (!pathExists(examplesDir)) {
    return [];
  }

  return readdirSync(examplesDir)
    .filter((entry) => entry.endsWith('.fsm.ts'))
    .map((entry) => join(examplesDir, entry))
    .filter((path) => statSync(path).isFile());
}

function configuredScanFiles(repoRoot) {
  const files = [];

  for (const relPath of FILE_TARGETS) {
    const full = resolve(repoRoot, relPath);
    let info;
    try {
      info = statSync(full);
    } catch {
      throw new Error(`scan target does not exist: ${relPath}`);
    }
    if (!info.isFile()) {
      throw new Error(`scan target is not a file: ${relPath}`);
    }
    files.push(full);
  }

  files.push(...rootExampleFiles(repoRoot));

  for (const relPath of DIRECTORY_TARGETS) {
    const full = resolve(repoRoot, relPath);
    let info;
    try {
      info = statSync(full);
    } catch {
      throw new Error(`scan target does not exist: ${relPath}`);
    }
    if (!info.isDirectory()) {
      throw new Error(`scan target is not a directory: ${relPath}`);
    }
    walk(full, files);
  }

  return [...new Set(files)].sort();
}

function isAllowed(rule, line) {
  return rule.allowNegated === true && NEGATION.test(line);
}

function scanFile(path, found) {
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const rule of RULES) {
      const match = rule.pattern.exec(line);
      if (!match || isAllowed(rule, line)) {
        continue;
      }
      found.push({ path, line: i + 1, ruleId: rule.id, match: match[0] });
    }
  }
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = process.argv[2] ? resolve(process.argv[2]) : resolve(here, '..');

  let files;
  try {
    files = configuredScanFiles(repoRoot);
  } catch (err) {
    process.stderr.write(`check-no-stale-stateless-contracts: ${err.message}\n`);
    process.exit(1);
  }

  const found = [];
  for (const file of files) {
    scanFile(file, found);
  }

  if (found.length > 0) {
    for (const hit of found) {
      const rel = relative(process.cwd(), hit.path);
      process.stderr.write(`${rel}:${hit.line}:${hit.ruleId}:${hit.match}\n`);
    }
    process.stderr.write(
      `\ncheck-no-stale-stateless-contracts: ${found.length} disallowed occurrence(s) found.\n`,
    );
    process.exit(1);
  }
  process.exit(0);
}

main();
