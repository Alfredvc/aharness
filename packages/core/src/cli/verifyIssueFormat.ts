import type { SourceLocation, SourceLocationManifest } from '../loader/cache.js';

export interface FormattableVerifyIssue {
  readonly severity: 'error' | 'warning';
  readonly check: string;
  readonly stateId: string;
  readonly message: string;
  readonly location?: SourceLocation;
}

export function formatVerifyIssue(
  issue: FormattableVerifyIssue,
  opts: { readonly sourceLocations?: SourceLocationManifest | undefined } = {},
): string {
  const location = issue.location ?? stateFallbackLocation(issue.stateId, opts.sourceLocations);
  const prefix = location === undefined ? '' : `${formatSourceLocation(location)} `;
  return `${prefix}[${issue.severity}] ${issue.check} (${issue.stateId}): ${issue.message}`;
}

function stateFallbackLocation(
  stateId: string,
  sourceLocations: SourceLocationManifest | undefined,
): SourceLocation | undefined {
  if (stateId.length === 0) return undefined;
  return sourceLocations?.states[stateId];
}

function formatSourceLocation(location: SourceLocation): string {
  if (location.column !== undefined) {
    return `${location.sourceFile}:${String(location.line)}:${String(location.column)}:`;
  }
  return `${location.sourceFile}:${String(location.line)}:`;
}
