/**
 * Per-state hook timeouts.
 *
 * The hook-entry `timeout_sec` declared in the `-c hooks.<Kind>=` override
 * caps how long codex waits for the wrapper script to exit. On expiry codex
 * sends SIGKILL via Tokio `kill_on_drop(true)` with no SIGTERM grace
 * (`codex-rs/hooks/src/engine/command_runner.rs:71-100`); the in-flight
 * author Promise is dropped without a cleanup hook. Authors are responsible
 * for staying within the budget.
 */
export const PER_STATE_HOOK_TIMEOUT_SEC = 30;
