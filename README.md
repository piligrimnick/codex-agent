# @autosk/codex-agent

An [autosk](https://github.com/wierdbytes/autosk) agent backed by Codex CLI's
headless mode. It starts each turn with `codex exec --json`, reads the JSONL
event stream, and continues correction turns with
`codex exec resume <thread-id> --json`.

Codex does not use `-p` as a headless/print flag: in Codex CLI, `-p` selects a
configuration profile. The supported non-interactive entry point is
`codex exec`.

## Requirements

- `autosk` and `autoskd` installed.
- `codex` on `PATH`, already authenticated (`codex login`), or
  `AUTOSK_CODEX_BIN` pointing to the binary.
- A Codex CLI version that supports `exec --json`, `exec resume`, and HTTP MCP
  servers (tested against `codex-cli 0.144.5`).

## Install locally

During development, link the package so changes are picked up without publishing:

```bash
autosk ext add -l /Users/nikitabogomolov/sites/autosk-codex-agent
```

Restart `autoskd` after changing extension code. The package's default export
registers `@autosk/codex-agent` as a named agent for interactive sessions.

## Use in a workflow

Create a project extension such as `.autosk/extensions/codex-workflow.ts`:

```ts
import { codexAgent } from "@autosk/codex-agent";
import { statusStep, type AutoskAPI } from "@autosk/sdk";

export default function (autosk: AutoskAPI) {
  autosk.registerWorkflow({
    name: "codex-dev",
    firstStep: "dev",
    steps: {
      dev: codexAgent({
        firstMessage: "Implement the task, run focused tests, and review the diff.",
        sandboxMode: "workspace-write",
        // model: "<optional Codex model>",
        // profile: "automation", // equivalent to codex exec -p automation
      }),
      accept: statusStep("human"),
      shipped: statusStep("done"),
    },
    onTransit(_ctx, to) {
      if ("step" in to && to.step !== "accept" && to.step !== "shipped") {
        throw new Error(`unsupported target: ${to.step}`);
      }
    },
  });
}
```

The workflow controls which targets are valid. The initial prompt instructs
Codex to call the temporary autosk MCP `transit` tool exactly once. The adapter
observes that successful MCP call and commits it through `ctx.transit(...)`.
If Codex omits the tool or the workflow rejects the target, the adapter resumes
the same Codex thread with a corrective prompt (three corrections by default).

## Options

```ts
interface CodexAgentOptions {
  model?: string;
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  profile?: string;
  firstMessage?: string;
  firstMessageFile?: string;
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  networkAccess?: boolean;
  dangerouslyBypassApprovalsAndSandbox?: boolean;
  ignoreUserConfig?: boolean;
  ignoreRules?: boolean;
  skipGitRepoCheck?: boolean;
  stderrMode?: "errors" | "all" | "none";
  maxCorrections?: number;
  autoskTools?: boolean;
  allowedTransitions?: string[];
  codexBin?: string;
  extraArgs?: string[];
  sandbox?: AgentSandbox;
}
```

`sandboxMode` is Codex's command-execution policy. `sandbox` is an optional
autosk structural sandbox such as `worktreeSandbox()` or `dockerSandbox()`.
`networkAccess` enables outbound network access inside the `workspace-write`
sandbox for steps that explicitly need it, such as pushing a branch.
`allowedTransitions` restricts both the transition labels shown to Codex and the
MCP transition results accepted by the adapter for that agent step.
Use `dangerouslyBypassApprovalsAndSandbox` only when an external worktree or
container is the actual security boundary.

The MCP bearer token is passed through `AUTOSK_MCP_TOKEN`; it is never placed in
the process argv. The temporary server exposes autosk's `task`, `comment`, and
`transit` tools. All three are explicitly approved for the unattended Codex
turn, and the server is closed after the session.

Codex may emit extensive Rust tracing on stderr when `RUST_LOG` is enabled.
`stderrMode: "errors"` is the default: verbose `TRACE`/`DEBUG`/`INFO` records
and their continuation lines are dropped, while warnings and errors remain in
the autosk transcript. Use `"all"` only for harness diagnostics.

Codex `command_execution` events are mapped to standard pi-format `bash`
`toolCall`/`toolResult` pairs. The GUI therefore shows a compact collapsible
command row, renders stdout/stderr with real line breaks, and marks non-zero
exit codes as errors instead of printing escaped raw JSON.

## Verify

```bash
pnpm install
pnpm run typecheck
pnpm test
```
