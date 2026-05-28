import { renderPackageBin } from './bin.js';
import { checkPackageSourceConstraints } from './sourceConstraints.js';
import { discoverValidatedPackageCommands, loadValidatedPackageConfig } from './context.js';
import type { FsmPackageConfig, FsmPackageDiagnostic } from './types.js';
import { runVerifyCli } from '../cli/verifyCli.js';

export interface VerifyFsmPackageOptions {
  readonly packageRoot: string;
  readonly log?: (line: string) => void;
}

export interface VerifiedFsmPackage {
  readonly config: FsmPackageConfig;
  readonly renderedBin: string;
  readonly verifiedFsmCount: number;
}

export type VerifyFsmPackageResult =
  | {
      readonly ok: true;
      readonly exitCode: 0;
      readonly value: VerifiedFsmPackage;
    }
  | {
      readonly ok: false;
      readonly exitCode: 1 | 2;
      readonly diagnostics: readonly FsmPackageDiagnostic[];
    };

const SKILLS_DIR = 'skills';

export async function verifyFsmPackage(
  opts: VerifyFsmPackageOptions,
): Promise<VerifyFsmPackageResult> {
  const config = await loadValidatedPackageConfig({ packageRoot: opts.packageRoot });
  if (!config.ok) {
    return { ok: false, exitCode: 2, diagnostics: config.diagnostics };
  }

  const publishFilesDiagnostics = validateSkillsPublishEntry(config.value);
  if (publishFilesDiagnostics.length > 0) {
    return { ok: false, exitCode: 2, diagnostics: publishFilesDiagnostics };
  }

  const discovery = await discoverValidatedPackageCommands({ config: config.value });
  if (!discovery.ok) {
    return { ok: false, exitCode: 2, diagnostics: discovery.diagnostics };
  }

  const sourceConstraints = await checkPackageSourceConstraints({
    packageRoot: config.value.packageRoot,
    fsmsDir: config.value.fsmsDir,
    commands: discovery.value.commands,
  });
  if (!sourceConstraints.ok) {
    return { ok: false, exitCode: 2, diagnostics: sourceConstraints.diagnostics };
  }

  let renderedBin: string;
  try {
    renderedBin = renderPackageBin({
      packageRoot: config.value.packageRoot,
      binPath: config.value.binPath,
    });
  } catch (err) {
    return {
      ok: false,
      exitCode: 2,
      diagnostics: [
        {
          code: 'bin-render-failed',
          field: 'bin',
          path: config.value.binRelativePath,
          message: `could not render generated bin: ${errorMessage(err)}`,
        },
      ],
    };
  }

  const verifierDiagnostics: FsmPackageDiagnostic[] = [];
  let verifierFailed = false;
  for (const command of discovery.value.fsmCommands) {
    try {
      const result = await runVerifyCli({
        fsmPath: command.filePath,
        repoRoot: config.value.packageRoot,
        log: (line) => opts.log?.(`[${command.name}] ${line}`),
      });
      if (result.exitCode !== 0) {
        verifierFailed = true;
        verifierDiagnostics.push({
          code: 'fsm-verify-failed',
          commandName: command.name,
          path: command.filePath,
          message: `FSM command '${command.name}' failed verification`,
        });
      }
    } catch (err) {
      verifierDiagnostics.push({
        code: 'fsm-load-failed',
        commandName: command.name,
        path: command.filePath,
        message: `could not load FSM command '${command.name}': ${errorMessage(err)}`,
      });
    }
  }

  if (verifierDiagnostics.some((diagnostic) => diagnostic.code === 'fsm-load-failed')) {
    return { ok: false, exitCode: 2, diagnostics: verifierDiagnostics };
  }
  if (verifierFailed) {
    return { ok: false, exitCode: 1, diagnostics: verifierDiagnostics };
  }

  return {
    ok: true,
    exitCode: 0,
    value: {
      config: config.value,
      renderedBin,
      verifiedFsmCount: discovery.value.fsmCommands.length,
    },
  };
}

function validateSkillsPublishEntry(config: FsmPackageConfig): FsmPackageDiagnostic[] {
  const files = config.packageJson['files'];
  if (!Array.isArray(files)) return [];

  const hasSkills = files.some((entry) => {
    if (typeof entry !== 'string') return false;
    const normalized = entry.replace(/\\/g, '/').replace(/^\.\//, '');
    return (
      normalized === '.' || normalized === SKILLS_DIR || normalized.startsWith(`${SKILLS_DIR}/`)
    );
  });

  if (hasSkills) return [];
  return [
    {
      code: 'files-missing-entry',
      field: 'files',
      path: SKILLS_DIR,
      message: `package.json files must include bundled skills directory '${SKILLS_DIR}'`,
    },
  ];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
