/**
 * Top-level aharness CLI verbs and flags. The runtime warning emitted by
 * `runCli` after `loadFsm` checks each loaded `inputFlags` field's
 * kebab-case form against this set. A collision means the field is
 * unreachable from the user-facing `aharness <file> --<flag>` command line
 * (the dispatcher consumes framework verbs before `inputArgs` collection);
 * the warning surfaces that ergonomics gap.
 *
 * Embedded children's inputs are NOT subject to this check (they never
 * reach the user-facing CLI). Only the root FSM's input fields are checked.
 *
 * Future top-level flags update this constant; the warning logic re-runs
 * against existing FSMs at next boot. The set includes top-level verbs and
 * runtime-owned flags such as `--yolo`, which the dispatcher consumes before
 * `inputArgs` reach author input parsing.
 */
export const RESERVED_CLI_FLAGS: ReadonlySet<string> = new Set([
  'verify',
  'doctor',
  'completion',
  'init',
  'yolo',
]);

/**
 * Pure helper. Iterates loaded `inputFlags` field names, kebab-cases each,
 * and writes a single-line warning per collision to `stderr`. Extracted as
 * a pure function so unit tests can exercise it without spinning up
 * `runCli` or stubbing the loader. `runCli` calls this once after
 * `loadFsm` resolves.
 */
export function emitReservedFlagWarnings(
  inputFlags: Readonly<Record<string, unknown>> | undefined,
  stderr: NodeJS.WritableStream,
): void {
  if (!inputFlags) return;
  for (const fieldName of Object.keys(inputFlags)) {
    const kebab = fieldName.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
    if (RESERVED_CLI_FLAGS.has(kebab)) {
      stderr.write(
        `aharness: warning: input field '${fieldName}' shadows framework flag --${kebab}; ` +
          `it will be unreachable from the CLI (it can still be set via --input <json>).\n`,
      );
    }
  }
}
