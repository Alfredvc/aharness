/**
 * `@aharness/core` verifier — barrel.
 *
 * Re-exports the codex-side static verifier. See `./verify.ts` for the check
 * list and the deltas vs. `@aharness/core`'s verifier.
 */
export { verify, type VerifyIssue, type VerifyIssueCheck, type VerifyResult } from './verify.js';
