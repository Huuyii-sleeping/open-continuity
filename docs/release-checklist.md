# Developer Preview release checklist

This checklist separates local release readiness from the external actions that require explicit authorization. Run it from the repository root with Node.js 22.13 or newer.

## 1. Product proof

Run the disposable demo first:

```bash
npm run smoke:demo
```

The command starts two MCP stdio clients with different Agent identities and one temporary SQLite database. Agent A writes a user preference and creates a Handoff Capsule; after Agent A shuts down, Agent B reads the preference and resumes the handoff. The temporary database is deleted even if the demo fails. The command does not initialize OpenContinuity, edit an Agent configuration, or access the user's normal database.

## 2. Local release gate

```bash
npm run release:check
```

The gate performs TypeScript checking, the complete automated test suite, Capture/Injection quality evaluations, a production dependency audit against the public npm registry, a package-content dry run, and an isolated install from the generated tarball. The installed-package smoke runs the two-Agent MCP demo, a fictional Claude Adapter setup/doctor, and the local data-governance status contract.

The complete suite must include `test/trae-adapter-blackbox.test.ts`, which runs the fictional process boundary from idempotent `setup trae` through app-server Capture, candidate approval, the installed Hook executable, and real MCP stdio discovery/recall. It must not read the user's Trae history.

It must also include:

- `test/claude-adapter-blackbox.test.ts` for setup → Stop transcript Capture → candidate review → three UserPromptSubmit Injection rounds → MCP deep recall;
- `test/candidate-review.test.ts` for cross-Agent occurrence merging, exact linking, explicit conflict replacement, and preserved version history;
- `test/data-governance.test.ts` and `test/data-governance-cli.test.ts` for turn-level expiry, pre-import filtering, Receipt bounds, explicit purge, owner-only files, and long-term-memory preservation;
- `npm run test:soak` either locally or in the scheduled Adapter soak workflow before promotion, with its cycle count and result recorded.

Also run a release-sized local performance sample and preserve its raw JSON with the release evidence:

```bash
npm run benchmark:lite -- --memories=10000 --iterations=100
```

Before a public release, also review:

- the complete package file list emitted by `npm pack --dry-run`;
- all source and documentation for credentials, internal addresses, real user data, private paths, and unclear third-party material;
- binary files, files over 1 MiB, symbolic links, nested repositories, submodules, and Git LFS objects;
- [compatibility.md](./compatibility.md), ensuring every claim still matches a current test or an explicitly documented limitation;
- the package name immediately before publish with `npm view open-continuity --registry https://registry.npmjs.org`.

Automated scanning is evidence, not a substitute for source and provenance review. If a required secret scanner is unavailable or fails, do not commit or publish until that gap is resolved.

## 3. Git publication boundary

Repository initialization, staging, commit, remote creation, and push are separate external actions. Before committing, follow the `~/personal/AGENTS.md` checks, use the personal Git identity and hooks, inspect the exact staged diff, and obtain explicit commit authorization. Obtain a second explicit authorization before push, after reviewing the exact reachable history and remote target.

Recommended public repository target:

```text
https://github.com/Huuyii-sleeping/open-continuity
```

Do not assume that the remote name is available merely because a lookup fails; authentication or network policy can make a missing repository indistinguishable from an inaccessible one.

## 4. npm publication boundary

The first public release should be described as a Developer Preview and published under the `beta` dist-tag. Immediately before publishing, verify the npm account, registry, package name, version, packed contents, and two-factor-authentication requirements. Publishing requires its own explicit authorization.

```bash
npm whoami --registry https://registry.npmjs.org
npm publish --tag beta --registry https://registry.npmjs.org
```

After publication, install from the public registry in a new temporary directory and run:

```bash
open-continuity demo
open-continuity init
open-continuity doctor
```

Do not connect a user's real Agent configuration during release verification unless that exact mutation has been approved.

## 5. Promotion evidence

Before announcing the preview, capture only fictional demo output and report the limits prominently:

- MCP tool availability does not guarantee that a third-party Agent will call the tools automatically.
- MCP alone does not expose a client's complete conversation. Experimental Trae Capture reads only app-server-visible content after explicit setup/sync opt-in and stages it locally.
- Trae Injection is opt-in and workspace-scoped; it reads only approved public memory through a bounded `UserPromptSubmit` hook, records a Prompt fingerprint rather than the Prompt body, and fails open on timeout or storage errors.
- Claude Code Capture/Injection is also opt-in and workspace-scoped. It uses the documented `Stop` transcript and `UserPromptSubmit` Hook contracts, filters OpenContinuity's own injected context, and needs a client restart after setup. Until a real installed-client smoke is recorded, describe it as protocol/black-box verified rather than real-client verified.
- Raw Inbox turns expire after 7 days even inside an active long-running conversation and are filtered before re-import; pending candidate evidence defaults to 30 days. Injection receipts default to 30 days and 5000 entries. Verify `data status`, `data cleanup`, and `data purge-transient --yes`, including that the last operation preserves approved long-term memory.
- The capture watch command remains an interruptible foreground polling loop; on macOS, `setup trae` installs/reloads an optional per-user launchd service. Verify the generated plist contains the detected Trae executable directory in its bounded PATH allowlist, then verify pagination bounds, transactional thread/turn/item checkpoints, the single-instance lock, retry behavior, persisted sync status, and service logs. Verify `doctor trae` reports Hook/MCP manual approval boundaries instead of enabling a global bypass.
- Trae has a real app-server read probe plus directed end-to-end tests. Claude Code has a full independent Capture/Injection Adapter and process black-box but still needs an environment-dependent real-client smoke. Codex has a real app-server protocol/metadata probe, an independent process black-box, a real persisted `codex exec` smoke, and a real interactive `/hooks → Trust all → prompt` smoke. The automated injection assertion used the one-shot `--dangerously-bypass-hook-trust`; before release, repeat a fictional turn in a fresh Codex process after reviewing `/hooks`, and verify `capture status`, `capture candidates`, and the next `UserPromptSubmit` output without recording real transcript text.
- The Trae vertical adapter test covers a fictional app-server thread through Capture, candidate approval, light UserPromptSubmit injection, and explicit MCP multi-step retrieval. A separate read-only probe against the installed Trae executable verifies app-server initialization and visible-thread normalization without writing the user's real conversation into the test database. The Codex probe follows the same rule but records only CLI version, initialize result keys, thread-list shape, counts, and field keys; it must never print `thread/read` message text.
- Enterprise, semantic vector retrieval, model-based extraction/reconciliation, conditional preference merging, and graph reasoning are roadmap items. Deterministic sensitive-field redaction, exact candidate merging, conservative similarity-based replacement review, version evolution, and layered transient-data retention are current Lite capabilities.
