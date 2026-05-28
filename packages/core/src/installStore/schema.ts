import {
  INSTALL_STORE_SCHEMA_VERSION,
  type InstallStoreDiagnostic,
  type InstallStoreResult,
  type TrustedCommandIndexEntry,
  type TrustedCommandMetadata,
  type TrustedCommandsFile,
  type TrustedInstallRecord,
  type TrustedInstallsFile,
} from './types.js';

type MutableDiagnostics = InstallStoreDiagnostic[];

export function validateTrustedInstallsFile(
  value: unknown,
  filePath?: string,
): InstallStoreResult<TrustedInstallsFile> {
  const diagnostics: MutableDiagnostics = [];
  if (!isRecord(value)) {
    pushDiagnostic(diagnostics, filePath, {
      code: 'trusted-file-invalid',
      message: 'trusted install file must contain an object',
    });
    return { ok: false, diagnostics };
  }

  validateSchemaHeader(value, diagnostics, filePath);
  const installsRaw = value['installs'];
  const installs: Record<string, TrustedInstallRecord> = {};
  if (!isRecord(installsRaw)) {
    pushDiagnostic(diagnostics, filePath, {
      code: 'trusted-installs-invalid',
      field: 'installs',
      message: 'trusted install file installs must be an object',
    });
  } else {
    for (const [installKey, installValue] of Object.entries(installsRaw)) {
      const parsed = parseInstallRecord(
        installValue,
        `installs.${installKey}`,
        diagnostics,
        filePath,
      );
      if (parsed) installs[installKey] = parsed;
    }
  }

  const generation = value['generation'];
  if (diagnostics.length > 0 || typeof generation !== 'string' || generation.length === 0) {
    return { ok: false, diagnostics };
  }
  return {
    ok: true,
    value: {
      schemaVersion: INSTALL_STORE_SCHEMA_VERSION,
      generation,
      installs,
    },
  };
}

export function validateTrustedCommandsFile(
  value: unknown,
  filePath?: string,
): InstallStoreResult<TrustedCommandsFile> {
  const diagnostics: MutableDiagnostics = [];
  if (!isRecord(value)) {
    pushDiagnostic(diagnostics, filePath, {
      code: 'trusted-file-invalid',
      message: 'trusted command index file must contain an object',
    });
    return { ok: false, diagnostics };
  }

  validateSchemaHeader(value, diagnostics, filePath);
  const commandsRaw = value['commands'];
  const commands: Record<string, TrustedCommandIndexEntry> = {};
  if (!isRecord(commandsRaw)) {
    pushDiagnostic(diagnostics, filePath, {
      code: 'trusted-commands-invalid',
      field: 'commands',
      message: 'trusted command index commands must be an object',
    });
  } else {
    for (const [identity, commandValue] of Object.entries(commandsRaw)) {
      const parsed = parseCommandIndexEntry(
        commandValue,
        `commands.${identity}`,
        diagnostics,
        filePath,
      );
      if (parsed) commands[identity] = parsed;
    }
  }

  const generation = value['generation'];
  if (diagnostics.length > 0 || typeof generation !== 'string' || generation.length === 0) {
    return { ok: false, diagnostics };
  }
  return {
    ok: true,
    value: {
      schemaVersion: INSTALL_STORE_SCHEMA_VERSION,
      generation,
      commands,
    },
  };
}

function validateSchemaHeader(
  value: Record<string, unknown>,
  diagnostics: MutableDiagnostics,
  filePath: string | undefined,
): void {
  if (value['schemaVersion'] !== INSTALL_STORE_SCHEMA_VERSION) {
    pushDiagnostic(diagnostics, filePath, {
      code: 'trusted-schema-version-invalid',
      field: 'schemaVersion',
      message: `trusted file schemaVersion must be ${INSTALL_STORE_SCHEMA_VERSION}`,
    });
  }

  const generation = value['generation'];
  if (typeof generation !== 'string' || generation.length === 0) {
    pushDiagnostic(diagnostics, filePath, {
      code: 'trusted-generation-invalid',
      field: 'generation',
      message: 'trusted file generation must be a non-empty string',
    });
  }
}

function parseInstallRecord(
  value: unknown,
  fieldPrefix: string,
  diagnostics: MutableDiagnostics,
  filePath: string | undefined,
): TrustedInstallRecord | null {
  if (!isRecord(value)) {
    pushDiagnostic(diagnostics, filePath, {
      code: 'trusted-install-record-invalid',
      field: fieldPrefix,
      message: 'trusted install record must be an object',
    });
    return null;
  }

  const packageName = readRequiredString({
    object: value,
    key: 'packageName',
    field: `${fieldPrefix}.packageName`,
    code: 'trusted-package-name-invalid',
    diagnostics,
    filePath,
  });
  const dependencyKey = readRequiredString({
    object: value,
    key: 'dependencyKey',
    field: `${fieldPrefix}.dependencyKey`,
    code: 'trusted-dependency-key-invalid',
    diagnostics,
    filePath,
  });
  const requestedSpec = readRequiredString({
    object: value,
    key: 'requestedSpec',
    field: `${fieldPrefix}.requestedSpec`,
    code: 'trusted-requested-spec-invalid',
    diagnostics,
    filePath,
  });
  const packageRoot = readRequiredString({
    object: value,
    key: 'packageRoot',
    field: `${fieldPrefix}.packageRoot`,
    code: 'trusted-package-root-invalid',
    diagnostics,
    filePath,
  });
  const sourceIntentKey = readRequiredString({
    object: value,
    key: 'sourceIntentKey',
    field: `${fieldPrefix}.sourceIntentKey`,
    code: 'trusted-source-intent-key-invalid',
    diagnostics,
    filePath,
  });
  const lockFingerprint = readRequiredString({
    object: value,
    key: 'lockFingerprint',
    field: `${fieldPrefix}.lockFingerprint`,
    code: 'trusted-lock-fingerprint-invalid',
    diagnostics,
    filePath,
  });
  const packageVersion = readOptionalString({
    object: value,
    key: 'packageVersion',
    field: `${fieldPrefix}.packageVersion`,
    code: 'trusted-package-version-invalid',
    diagnostics,
    filePath,
  });

  const commandsRaw = value['commands'];
  const commands: Record<string, TrustedCommandMetadata> = {};
  if (!isRecord(commandsRaw)) {
    pushDiagnostic(diagnostics, filePath, {
      code: 'trusted-install-commands-invalid',
      field: `${fieldPrefix}.commands`,
      message: 'trusted install commands must be an object',
    });
  } else {
    for (const [commandKey, commandValue] of Object.entries(commandsRaw)) {
      const parsed = parseCommandMetadata(
        commandValue,
        `${fieldPrefix}.commands.${commandKey}`,
        diagnostics,
        filePath,
      );
      if (parsed) commands[commandKey] = parsed;
    }
  }

  if (
    !packageName ||
    !dependencyKey ||
    !requestedSpec ||
    !packageRoot ||
    !sourceIntentKey ||
    !lockFingerprint
  ) {
    return null;
  }

  return {
    packageName,
    dependencyKey,
    requestedSpec,
    packageRoot,
    ...(packageVersion !== undefined ? { packageVersion } : {}),
    sourceIntentKey,
    lockFingerprint,
    commands,
  };
}

function parseCommandMetadata(
  value: unknown,
  fieldPrefix: string,
  diagnostics: MutableDiagnostics,
  filePath: string | undefined,
): TrustedCommandMetadata | null {
  if (!isRecord(value)) {
    pushDiagnostic(diagnostics, filePath, {
      code: 'trusted-command-metadata-invalid',
      field: fieldPrefix,
      message: 'trusted command metadata must be an object',
    });
    return null;
  }

  const commandName = readRequiredString({
    object: value,
    key: 'commandName',
    field: `${fieldPrefix}.commandName`,
    code: 'trusted-command-name-invalid',
    diagnostics,
    filePath,
    commandName: value['commandName'],
  });
  const entry = readRequiredString({
    object: value,
    key: 'entry',
    field: `${fieldPrefix}.entry`,
    code: 'trusted-command-entry-invalid',
    diagnostics,
    filePath,
    commandName: value['commandName'],
  });
  const description = readOptionalString({
    object: value,
    key: 'description',
    field: `${fieldPrefix}.description`,
    code: 'trusted-command-description-invalid',
    diagnostics,
    filePath,
    commandName: value['commandName'],
  });

  if (!commandName || !entry) return null;
  return {
    commandName,
    entry,
    ...(description !== undefined ? { description } : {}),
  };
}

function parseCommandIndexEntry(
  value: unknown,
  fieldPrefix: string,
  diagnostics: MutableDiagnostics,
  filePath: string | undefined,
): TrustedCommandIndexEntry | null {
  if (!isRecord(value)) {
    pushDiagnostic(diagnostics, filePath, {
      code: 'trusted-command-index-entry-invalid',
      field: fieldPrefix,
      message: 'trusted command index entry must be an object',
    });
    return null;
  }

  const packageName = readRequiredString({
    object: value,
    key: 'packageName',
    field: `${fieldPrefix}.packageName`,
    code: 'trusted-package-name-invalid',
    diagnostics,
    filePath,
    commandName: value['commandName'],
  });
  const commandName = readRequiredString({
    object: value,
    key: 'commandName',
    field: `${fieldPrefix}.commandName`,
    code: 'trusted-command-name-invalid',
    diagnostics,
    filePath,
    commandName: value['commandName'],
  });
  const entry = readRequiredString({
    object: value,
    key: 'entry',
    field: `${fieldPrefix}.entry`,
    code: 'trusted-command-entry-invalid',
    diagnostics,
    filePath,
    commandName: value['commandName'],
  });
  const packageRoot = readRequiredString({
    object: value,
    key: 'packageRoot',
    field: `${fieldPrefix}.packageRoot`,
    code: 'trusted-package-root-invalid',
    diagnostics,
    filePath,
    commandName: value['commandName'],
  });
  const lockFingerprint = readRequiredString({
    object: value,
    key: 'lockFingerprint',
    field: `${fieldPrefix}.lockFingerprint`,
    code: 'trusted-lock-fingerprint-invalid',
    diagnostics,
    filePath,
    commandName: value['commandName'],
  });
  const packageVersion = readOptionalString({
    object: value,
    key: 'packageVersion',
    field: `${fieldPrefix}.packageVersion`,
    code: 'trusted-package-version-invalid',
    diagnostics,
    filePath,
    commandName: value['commandName'],
  });
  const description = readOptionalString({
    object: value,
    key: 'description',
    field: `${fieldPrefix}.description`,
    code: 'trusted-command-description-invalid',
    diagnostics,
    filePath,
    commandName: value['commandName'],
  });

  if (!packageName || !commandName || !entry || !packageRoot || !lockFingerprint) return null;
  return {
    packageName,
    commandName,
    entry,
    packageRoot,
    ...(packageVersion !== undefined ? { packageVersion } : {}),
    lockFingerprint,
    ...(description !== undefined ? { description } : {}),
  };
}

function readRequiredString(opts: {
  readonly object: Record<string, unknown>;
  readonly key: string;
  readonly field: string;
  readonly code: string;
  readonly diagnostics: MutableDiagnostics;
  readonly filePath: string | undefined;
  readonly commandName?: unknown;
}): string | null {
  const value = opts.object[opts.key];
  if (typeof value === 'string' && value.length > 0) return value;
  pushDiagnostic(opts.diagnostics, opts.filePath, {
    code: opts.code,
    field: opts.field,
    ...(typeof opts.commandName === 'string' ? { commandName: opts.commandName } : {}),
    message: `${opts.field} must be a non-empty string`,
  });
  return null;
}

function readOptionalString(opts: {
  readonly object: Record<string, unknown>;
  readonly key: string;
  readonly field: string;
  readonly code: string;
  readonly diagnostics: MutableDiagnostics;
  readonly filePath: string | undefined;
  readonly commandName?: unknown;
}): string | undefined {
  const value = opts.object[opts.key];
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  pushDiagnostic(opts.diagnostics, opts.filePath, {
    code: opts.code,
    field: opts.field,
    ...(typeof opts.commandName === 'string' ? { commandName: opts.commandName } : {}),
    message: `${opts.field} must be a string when present`,
  });
  return undefined;
}

function pushDiagnostic(
  diagnostics: MutableDiagnostics,
  filePath: string | undefined,
  diagnostic: Omit<InstallStoreDiagnostic, 'path'>,
): void {
  diagnostics.push({
    ...diagnostic,
    ...(filePath !== undefined ? { path: filePath } : {}),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
