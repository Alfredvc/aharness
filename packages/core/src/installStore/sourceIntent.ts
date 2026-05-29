import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import npa, { type PackageSpecResult } from 'npm-package-arg';

import type { InstallStoreDiagnostic, InstallStoreResult } from './types.js';

const DEFAULT_REGISTRY_ORIGIN = 'https://registry.npmjs.org/';
const TRANSIENT_AUTH_QUERY_FIELDS = new Set([
  '_auth',
  '_authtoken',
  'accesstoken',
  'access_token',
  'auth',
  'authtoken',
  'awsaccesskeyid',
  'expires',
  'googleaccessid',
  'signature',
  'token',
  'x-amz-credential',
  'x-amz-security-token',
  'x-amz-signature',
  'x-goog-credential',
  'x-goog-expires',
  'x-goog-signature',
]);

export interface ResolveLocalDirectorySourceOptions {
  readonly source: string;
  readonly cwd: string;
}

export interface ResolveLocalTarballSourceOptions {
  readonly source: string;
  readonly cwd: string;
}

export async function resolveLocalDirectorySource(
  opts: ResolveLocalDirectorySourceOptions,
): Promise<string | null> {
  const candidate = localDirectoryCandidate(opts.source, opts.cwd);
  if (candidate === null) return null;

  let stat: import('node:fs').Stats;
  try {
    stat = await fs.stat(candidate);
  } catch {
    return null;
  }
  if (!stat.isDirectory()) return null;

  try {
    const packageJsonStat = await fs.stat(path.join(candidate, 'package.json'));
    if (!packageJsonStat.isFile()) return null;
  } catch {
    return null;
  }

  return path.resolve(candidate);
}

export async function computeSourceIntentKey(opts: {
  readonly source: string;
  readonly cwd: string;
}): Promise<InstallStoreResult<string>> {
  const localDirectory = await resolveLocalDirectorySource(opts);
  if (localDirectory !== null) {
    try {
      return { ok: true, value: `local-directory:${await fs.realpath(localDirectory)}` };
    } catch (err) {
      return failure({
        code: 'source-intent-local-realpath-failed',
        path: localDirectory,
        message: `could not resolve local install source realpath: ${errorMessage(err)}`,
      });
    }
  }

  const localTarball = await resolveLocalTarballSource(opts);
  if (!localTarball.ok) return localTarball;
  if (localTarball.value !== null) {
    return { ok: true, value: `local-tarball:${localTarball.value}` };
  }

  const parsed = parseNpmPackageSpec(opts.source, opts.cwd);
  if (!parsed.ok) return parsed;
  const sourceIntent = sourceIntentFromParsedSpec(parsed.value);
  if (sourceIntent.ok) return sourceIntent;

  return failure({
    code: 'source-intent-unsupported',
    field: 'source',
    message: `unsupported npm install source '${opts.source}' for aharness source identity`,
  });
}

export async function computeInstalledSourceIntentKey(opts: {
  readonly source: string;
  readonly cwd: string;
  readonly managedProjectRoot: string;
  readonly dependencyKey: string;
}): Promise<InstallStoreResult<string>> {
  const localDirectory = await resolveLocalDirectorySource(opts);
  if (localDirectory !== null) {
    return computeSourceIntentKey({ source: opts.source, cwd: opts.cwd });
  }

  const localTarball = await resolveLocalTarballSource(opts);
  if (!localTarball.ok) return localTarball;
  if (localTarball.value !== null) {
    return { ok: true, value: `local-tarball:${localTarball.value}` };
  }

  const parsed = parseNpmPackageSpec(opts.source, opts.cwd);
  if (!parsed.ok) return parsed;

  const registryPackageName = registryPackageNameFromParsedSpec(parsed.value);
  if (registryPackageName !== null) {
    const registryOrigin = await readInstalledRegistryOrigin({
      managedProjectRoot: opts.managedProjectRoot,
      dependencyKey: opts.dependencyKey,
    });
    if (!registryOrigin.ok) return registryOrigin;
    return {
      ok: true,
      value: registrySourceIntentKey(registryPackageName, registryOrigin.value),
    };
  }

  const sourceIntent = sourceIntentFromParsedSpec(parsed.value);
  if (sourceIntent.ok) return sourceIntent;

  return failure({
    code: 'source-intent-unsupported',
    field: 'source',
    message: `unsupported npm install source '${opts.source}' for aharness source identity`,
  });
}

export function identifyDirectDependencyKey(opts: {
  readonly before: Readonly<Record<string, string>>;
  readonly after: Readonly<Record<string, string>>;
  readonly source: string;
}): InstallStoreResult<string> {
  const changed = Object.keys(opts.after)
    .filter((key) => opts.before[key] !== opts.after[key])
    .sort();
  if (changed.length === 1) return { ok: true, value: changed[0]! };
  if (changed.length > 1) {
    return failure({
      code: 'direct-dependency-key-ambiguous',
      field: 'dependencies',
      message:
        `npm changed more than one direct dependency while installing '${opts.source}': ` +
        changed.join(', '),
    });
  }

  const parsed = parseDirectDependencyKeyFromSource(opts.source);
  if (parsed && opts.after[parsed] !== undefined) return { ok: true, value: parsed };

  return failure({
    code: 'direct-dependency-key-not-found',
    field: 'dependencies',
    message: `could not identify the direct dependency key npm saved for '${opts.source}'`,
  });
}

export async function identifyDependencyKeyBySourceIntent(opts: {
  readonly source: string;
  readonly sourceCwd: string;
  readonly dependencyCwd: string;
  readonly dependencies: Readonly<Record<string, string>>;
}): Promise<InstallStoreResult<string>> {
  const sourceIntent = await computeSourceIntentKey({
    source: opts.source,
    cwd: opts.sourceCwd,
  });
  if (!sourceIntent.ok) return sourceIntent;

  const matches: string[] = [];
  for (const dependencyKey of Object.keys(opts.dependencies).sort()) {
    const dependencySpec = opts.dependencies[dependencyKey];
    if (dependencySpec === undefined) continue;
    for (const candidate of dependencySourceCandidates(dependencyKey, dependencySpec)) {
      const candidateIntent = await computeSourceIntentKey({
        source: candidate,
        cwd: opts.dependencyCwd,
      });
      if (candidateIntent.ok && candidateIntent.value === sourceIntent.value) {
        matches.push(dependencyKey);
        break;
      }
    }
  }

  if (matches.length === 1) return { ok: true, value: matches[0]! };
  if (matches.length > 1) {
    return failure({
      code: 'direct-dependency-key-ambiguous',
      field: 'dependencies',
      message:
        `more than one direct dependency matches install source '${opts.source}': ` +
        matches.join(', '),
    });
  }

  return failure({
    code: 'direct-dependency-key-not-found',
    field: 'dependencies',
    message: `could not identify a direct dependency matching install source '${opts.source}'`,
  });
}

export async function deriveDependencyKeyFromSource(opts: {
  readonly source: string;
  readonly cwd: string;
}): Promise<InstallStoreResult<string>> {
  const parsed = parseDirectDependencyKeyFromSource(opts.source);
  if (parsed) return { ok: true, value: parsed };

  const localDirectory = await resolveLocalDirectorySource(opts);
  if (localDirectory !== null) {
    const packageJsonPath = path.join(localDirectory, 'package.json');
    let parsedPackage: unknown;
    try {
      parsedPackage = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
    } catch (err) {
      return failure({
        code: 'direct-dependency-package-json-read-failed',
        path: packageJsonPath,
        message: `could not read local install source package.json: ${errorMessage(err)}`,
      });
    }
    if (isRecord(parsedPackage) && typeof parsedPackage['name'] === 'string') {
      return { ok: true, value: parsedPackage['name'] };
    }
    return failure({
      code: 'direct-dependency-package-name-invalid',
      path: packageJsonPath,
      field: 'name',
      message: 'local install source package.json name must be a string',
    });
  }

  return failure({
    code: 'direct-dependency-key-not-found',
    message: `could not infer a direct dependency key for '${opts.source}'`,
  });
}

function parseDirectDependencyKeyFromSource(source: string): string | null {
  const parsed = parseNpmPackageSpec(source);
  if (!parsed.ok) return null;
  if (parsed.value.type === 'alias') return parsed.value.name ?? null;
  if (isRegistryPackageSpec(parsed.value)) return parsed.value.name ?? null;
  return null;
}

function sourceIntentFromParsedSpec(
  spec: PackageSpecResult,
): InstallStoreResult<string> | { readonly ok: false } {
  const registryPackageName = registryPackageNameFromParsedSpec(spec);
  if (registryPackageName !== null) {
    return { ok: true, value: registrySourceIntentKey(registryPackageName) };
  }

  if (spec.type === 'git') {
    const canonical = canonicalGitSource(spec);
    if (canonical !== null) return { ok: true, value: `git:${canonical}` };
    return { ok: false };
  }

  if (spec.type === 'remote' && spec.fetchSpec) {
    const remote = canonicalRemoteTarballSource(spec.fetchSpec);
    if (remote !== null) return { ok: true, value: `remote-tarball:${remote}` };
  }

  return { ok: false };
}

function isRegistryPackageSpec(spec: PackageSpecResult): boolean {
  return (
    spec.registry === true &&
    (spec.type === 'range' || spec.type === 'tag' || spec.type === 'version')
  );
}

function registryPackageNameFromParsedSpec(spec: PackageSpecResult): string | null {
  if (spec.type === 'alias') {
    const target = spec.subSpec;
    return target && isRegistryPackageSpec(target) ? (target.name ?? null) : null;
  }
  return isRegistryPackageSpec(spec) ? (spec.name ?? null) : null;
}

function registrySourceIntentKey(
  packageName: string,
  registryOrigin = DEFAULT_REGISTRY_ORIGIN,
): string {
  return `registry:${registryOrigin}:${packageName}`;
}

function canonicalGitSource(spec: PackageSpecResult): string | null {
  if (spec.hosted?.type === 'github' && spec.hosted.user && spec.hosted.project) {
    return `https://github.com/${spec.hosted.user}/${stripGitSuffix(spec.hosted.project)}`;
  }

  const raw = spec.fetchSpec ?? spec.saveSpec ?? spec.raw;
  const withoutRef = raw.split('#', 1)[0] ?? raw;
  const withoutGitPrefix = withoutRef.startsWith('git+')
    ? withoutRef.slice('git+'.length)
    : withoutRef;
  try {
    const url = new URL(withoutGitPrefix);
    url.username = '';
    url.password = '';
    url.hash = '';
    if (url.protocol === 'ssh:' && url.hostname === 'github.com') {
      return `https://github.com/${stripGitSuffix(url.pathname.replace(/^\/+/, ''))}`;
    }
    url.pathname = stripGitSuffix(url.pathname);
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function dependencySourceCandidates(
  dependencyKey: string,
  dependencySpec: string,
): readonly string[] {
  if (dependencySpec.startsWith('npm:')) return [`${dependencyKey}@${dependencySpec}`];
  if (looksLikeStandaloneDependencySpec(dependencySpec)) return [dependencySpec];
  return [`${dependencyKey}@${dependencySpec}`];
}

function looksLikeStandaloneDependencySpec(dependencySpec: string): boolean {
  return (
    dependencySpec.startsWith('file:') ||
    dependencySpec.startsWith('./') ||
    dependencySpec.startsWith('../') ||
    dependencySpec.startsWith('/') ||
    dependencySpec.startsWith('http://') ||
    dependencySpec.startsWith('https://') ||
    dependencySpec.startsWith('git+') ||
    dependencySpec.startsWith('github:') ||
    dependencySpec.startsWith('gitlab:') ||
    dependencySpec.startsWith('bitbucket:')
  );
}

function stripGitSuffix(value: string): string {
  return value.endsWith('.git') ? value.slice(0, -'.git'.length) : value;
}

function canonicalRemoteTarballSource(source: string): string | null {
  try {
    const url = new URL(source);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.username = '';
    url.password = '';
    url.hash = '';

    const keptParams: [string, string][] = [];
    url.searchParams.forEach((value, key) => {
      if (!TRANSIENT_AUTH_QUERY_FIELDS.has(key.toLowerCase())) keptParams.push([key, value]);
    });
    keptParams.sort(([aKey, aValue], [bKey, bValue]) => {
      const keyOrder = aKey.localeCompare(bKey);
      return keyOrder === 0 ? aValue.localeCompare(bValue) : keyOrder;
    });
    url.search = '';
    for (const [key, value] of keptParams) {
      url.searchParams.append(key, value);
    }

    return url.toString();
  } catch {
    return null;
  }
}

export async function resolveLocalTarballSource(
  opts: ResolveLocalTarballSourceOptions,
): Promise<InstallStoreResult<string | null>> {
  const candidate = localPathCandidate(opts.source, opts.cwd);
  if (candidate === null || !isLocalTarballPath(candidate)) return { ok: true, value: null };

  let stat: import('node:fs').Stats;
  try {
    stat = await fs.stat(candidate);
  } catch (err) {
    return failure({
      code: 'source-intent-local-tarball-stat-failed',
      path: candidate,
      message: `could not inspect local tarball install source: ${errorMessage(err)}`,
    });
  }
  if (!stat.isFile()) {
    return failure({
      code: 'source-intent-local-tarball-invalid',
      path: candidate,
      message: 'local tarball install source must be a regular file',
    });
  }

  try {
    return { ok: true, value: await fs.realpath(candidate) };
  } catch (err) {
    return failure({
      code: 'source-intent-local-tarball-realpath-failed',
      path: candidate,
      message: `could not resolve local tarball install source realpath: ${errorMessage(err)}`,
    });
  }
}

async function readInstalledRegistryOrigin(opts: {
  readonly managedProjectRoot: string;
  readonly dependencyKey: string;
}): Promise<InstallStoreResult<string>> {
  const lockfilePath = path.join(opts.managedProjectRoot, 'package-lock.json');
  let parsedLockfile: unknown;
  try {
    parsedLockfile = JSON.parse(await fs.readFile(lockfilePath, 'utf8'));
  } catch (err) {
    return failure({
      code: 'source-intent-registry-lockfile-read-failed',
      path: lockfilePath,
      message: `could not read package-lock.json while deriving registry source identity: ${errorMessage(
        err,
      )}`,
    });
  }

  if (!isRecord(parsedLockfile)) {
    return failure({
      code: 'source-intent-registry-lockfile-invalid',
      path: lockfilePath,
      message: 'package-lock.json must contain an object while deriving registry source identity',
    });
  }

  const packages = parsedLockfile['packages'];
  if (!isRecord(packages)) {
    return failure({
      code: 'source-intent-registry-packages-missing',
      path: lockfilePath,
      field: 'packages',
      message:
        'package-lock.json must contain a packages object while deriving registry source identity',
    });
  }

  const entryKey = `node_modules/${opts.dependencyKey}`;
  const entry = packages[entryKey];
  if (!isRecord(entry)) {
    return failure({
      code: 'source-intent-registry-entry-missing',
      path: lockfilePath,
      field: `packages.${entryKey}`,
      message:
        `package-lock.json is missing direct dependency entry '${entryKey}' while deriving ` +
        'registry source identity',
    });
  }

  const resolved = entry['resolved'];
  if (typeof resolved !== 'string') {
    return failure({
      code: 'source-intent-registry-origin-missing',
      path: lockfilePath,
      field: `packages.${entryKey}.resolved`,
      message:
        `package-lock.json direct dependency entry '${entryKey}' must include a resolved URL ` +
        'while deriving registry source identity',
    });
  }

  const origin = registryOriginFromResolved(resolved);
  if (origin === null) {
    return failure({
      code: 'source-intent-registry-origin-invalid',
      path: lockfilePath,
      field: `packages.${entryKey}.resolved`,
      message:
        `package-lock.json direct dependency entry '${entryKey}' resolved value is not an ` +
        'http or https URL while deriving registry source identity',
    });
  }

  return { ok: true, value: origin };
}

function registryOriginFromResolved(resolved: string): string | null {
  try {
    const url = new URL(resolved);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.username = '';
    url.password = '';
    return `${url.origin}/`;
  } catch {
    return null;
  }
}

function isLocalTarballPath(filePath: string): boolean {
  return filePath.endsWith('.tgz') || filePath.endsWith('.tar.gz') || filePath.endsWith('.tar');
}

function parseNpmPackageSpec(source: string, cwd?: string): InstallStoreResult<PackageSpecResult> {
  try {
    return { ok: true, value: npa(source, cwd) };
  } catch (err) {
    return failure({
      code: 'source-intent-unsupported',
      field: 'source',
      message: `unsupported npm install source '${source}': ${errorMessage(err)}`,
    });
  }
}

function localDirectoryCandidate(source: string, cwd: string): string | null {
  return localPathCandidate(source, cwd);
}

function localPathCandidate(source: string, cwd: string): string | null {
  if (source.startsWith('file://')) {
    try {
      return fileURLToPath(source);
    } catch {
      return null;
    }
  }
  if (source.startsWith('file:')) {
    return path.resolve(cwd, source.slice('file:'.length));
  }
  if (source.startsWith('.') || path.isAbsolute(source)) {
    return path.resolve(cwd, source);
  }
  return null;
}

function failure(diagnostic: InstallStoreDiagnostic): InstallStoreResult<never> {
  return { ok: false, diagnostics: [diagnostic] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
