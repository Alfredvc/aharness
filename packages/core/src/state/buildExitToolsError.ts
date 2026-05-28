/**
 * Typed error thrown by `buildExitTools` (`state.ts`) when the schema
 * sidecar lacks an entry for a declared submit exit. The verifier should
 * have caught this earlier — reaching `buildExitTools` with the gap means
 * the runtime skipped verification, and we want a hard, structured error
 * rather than registering a tool with no schema.
 *
 * Code is closed-world (`'no-sidecar-entry'`) for now; extend the union
 * when new failure modes are added.
 */
export type BuildExitToolsErrorCode = 'no-sidecar-entry';

export class BuildExitToolsError extends Error {
  readonly code: BuildExitToolsErrorCode;
  readonly stateId: string;
  readonly exitName: string;

  constructor(code: BuildExitToolsErrorCode, stateId: string, exitName: string, message: string) {
    super(message);
    this.name = 'BuildExitToolsError';
    this.code = code;
    this.stateId = stateId;
    this.exitName = exitName;
  }
}
