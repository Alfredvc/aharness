# Security Policy

## Reporting Vulnerabilities

Report suspected vulnerabilities by opening a GitHub issue in this repository.
Include enough detail for a maintainer to reproduce or understand the issue:

- affected package, version, command, or example;
- expected behavior and observed behavior;
- reproduction steps, logs, or sanitized run artifacts;
- whether the issue requires local access, malicious repository content, a
  compromised model/tool response, or browser access to the loopback UI.

Do not include secrets, private transcripts, credentials, or exploit payloads
that would put other users at risk. If a report needs sensitive evidence,
describe what evidence exists and a maintainer will coordinate the next step in
the issue.

## Supported Versions

Security fixes target the current release line. Before the first published
release, that means the `0.1.x` line represented by this repository.

Harness requires:

- Node.js `>=20`
- Codex CLI `>=0.130.0`

Older Node or Codex versions are outside the supported security boundary.

## Threat Model Boundary

Harness constrains workflow control around coding agents. It verifies FSM
structure before runtime, validates structured submissions, routes owner input
and approval requests through Harness-controlled paths, and protects the
loopback browser UI with a per-run token.

Harness does not make untrusted code safe to execute. A run may ask Codex to
edit files, run commands, inspect a repository, or handle content supplied by a
model or local project. Treat those actions with the same care as any local
developer tooling:

- run Harness only in repositories and worktrees you intend the coding agent to
  modify;
- review approval requests before granting file or command access;
- do not paste secrets into model prompts, run artifacts, or issue reports;
- do not expose the loopback UI token outside the local machine;
- treat third-party FSM packages and examples as code that can influence local
  agent behavior.

Security issues inside Codex, Node.js, package managers, shells, editors, or
other tools invoked by a workflow should be reported to those projects unless
Harness incorrectly expands or bypasses their intended boundary.
