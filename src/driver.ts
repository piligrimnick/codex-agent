import type {
  AgentRunContext,
  AssistantMessage,
  ChildHandle,
  StepTarget,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "@autosk/sdk";

import { parseTarget } from "./prompt.ts";

export interface CodexCommandOptions {
  codexBin?: string;
  model?: string;
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  profile?: string;
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  /** Allow outbound network access while retaining the workspace-write filesystem boundary. */
  networkAccess?: boolean;
  dangerouslyBypassApprovalsAndSandbox?: boolean;
  ignoreUserConfig?: boolean;
  ignoreRules?: boolean;
  skipGitRepoCheck?: boolean;
  /** Codex stderr capture. Default `"errors"` keeps warnings/errors and drops verbose tracing. */
  stderrMode?: "errors" | "all" | "none";
  extraArgs?: string[];
}

export interface McpConnection {
  url: string;
  tokenEnvVar: string;
}

export interface TurnResult {
  threadId: string;
  target: StepTarget | null;
  code: number | null;
  completed: boolean;
}

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function buildCodexCommand(
  options: CodexCommandOptions,
  run: { cwd: string; threadId?: string; mcp?: McpConnection },
): string[] {
  const binary = options.codexBin ?? process.env.AUTOSK_CODEX_BIN ?? "codex";
  const args = run.threadId ? [binary, "exec", "resume"] : [binary, "exec"];

  args.push("--json");
  if (options.model) args.push("--model", options.model);
  if (options.reasoningEffort) {
    args.push("--config", `model_reasoning_effort=${JSON.stringify(options.reasoningEffort)}`);
  }
  if (options.profile) args.push("--profile", options.profile);
  if (options.networkAccess) {
    args.push("--config", "sandbox_workspace_write.network_access=true");
  }
  if (options.dangerouslyBypassApprovalsAndSandbox) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else if (!run.threadId) {
    args.push("--sandbox", options.sandboxMode ?? "workspace-write");
  }
  if (options.ignoreUserConfig) args.push("--ignore-user-config");
  if (options.ignoreRules) args.push("--ignore-rules");
  if (options.skipGitRepoCheck) args.push("--skip-git-repo-check");
  if (!run.threadId) args.push("--cd", run.cwd);

  if (run.mcp) {
    args.push(
      "--config",
      `mcp_servers.autosk.url=${JSON.stringify(run.mcp.url)}`,
      "--config",
      `mcp_servers.autosk.bearer_token_env_var=${JSON.stringify(run.mcp.tokenEnvVar)}`,
      "--config",
      "mcp_servers.autosk.required=true",
      "--config",
      'mcp_servers.autosk.default_tools_approval_mode="approve"',
      "--config",
      'mcp_servers.autosk.tools.transit.approval_mode="approve"',
      "--config",
      'mcp_servers.autosk.tools.task.approval_mode="approve"',
      "--config",
      'mcp_servers.autosk.tools.comment.approval_mode="approve"',
    );
  }
  args.push(...(options.extraArgs ?? []));
  if (run.threadId) args.push(run.threadId);
  args.push("-");
  return args;
}

/** Drives one finite `codex exec` turn and maps its JSONL stream to autosk. */
export class CodexTurn {
  private threadId = "";
  private target: StepTarget | null = null;
  private completed = false;
  private usageLogged = false;
  private child: ChildHandle | null = null;
  private stderrLevel: CodexLogLevel | null = null;
  private readonly startedToolCalls = new Set<string>();

  constructor(
    private readonly ctx: AgentRunContext,
    private readonly options: CodexCommandOptions,
    private readonly cwd: string,
    private readonly targets: StepTarget[],
    private readonly mcp: McpConnection | undefined,
    private readonly existingThreadId?: string,
    private readonly wrap?: (command: string[]) => string[],
  ) {}

  async run(prompt: string, env: Record<string, string>): Promise<TurnResult> {
    this.logUser(prompt);
    const baseCommand = buildCodexCommand(this.options, {
      cwd: this.cwd,
      threadId: this.existingThreadId,
      mcp: this.mcp,
    });
    const command = this.wrap ? this.wrap(baseCommand) : baseCommand;
    const child = this.ctx.spawn(command, { cwd: this.cwd, env });
    this.child = child;
    child.onStdout((line) => this.onLine(line));
    child.onStderr((line) => this.onStderr(line));

    const abort = () => child.kill();
    this.ctx.signal.addEventListener("abort", abort, { once: true });
    try {
      const bytes = new TextEncoder().encode(prompt);
      await child.stdin.write(bytes);
      await child.stdin.close();
      const { code } = await child.exited;
      if (!this.usageLogged) this.logUsage(null);
      const threadId = this.threadId || this.existingThreadId || "";
      return { threadId, target: this.target, code, completed: this.completed };
    } finally {
      this.ctx.signal.removeEventListener("abort", abort);
      this.child = null;
    }
  }

  kill(): void {
    this.child?.kill();
  }

  private onLine(line: string): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.ctx.log.custom("codex:warn", { message: "invalid JSONL line", line });
      return;
    }

    const type = stringValue(event.type);
    if (type === "thread.started") {
      this.threadId = stringValue(event.thread_id);
      this.ctx.log.custom("codex:thread", { thread_id: this.threadId });
      return;
    }
    if (type === "turn.completed") {
      this.completed = true;
      this.logUsage(normaliseUsage(event.usage));
      return;
    }
    if (type === "turn.failed" || type === "error") {
      this.ctx.log.custom("codex:error", event);
      return;
    }
    if (!type.startsWith("item.")) return;

    const item = recordValue(event.item);
    if (!item) return;
    if (type === "item.started") this.onStartedItem(item);
    else if (type === "item.completed") this.onCompletedItem(item);
  }

  private onStartedItem(item: Record<string, unknown>): void {
    if (stringValue(item.type) === "command_execution") this.logCommandCall(item);
  }

  private onStderr(line: string): void {
    if (!line.trim() || this.options.stderrMode === "none") return;
    if (this.options.stderrMode === "all") {
      this.ctx.log.custom("codex:stderr", { line });
      return;
    }

    const level = codexLogLevel(line);
    if (level) this.stderrLevel = level;
    const effectiveLevel = level ?? this.stderrLevel;
    if (effectiveLevel === "TRACE" || effectiveLevel === "DEBUG" || effectiveLevel === "INFO") return;
    if (effectiveLevel === "WARN") {
      this.ctx.log.custom("codex:warn", { line });
      return;
    }
    if (effectiveLevel === "ERROR") {
      this.ctx.log.custom("codex:error", { line });
      return;
    }

    // Untagged CLI diagnostics (for example a startup WARNING) are useful and
    // do not belong to a known verbose tracing record.
    this.ctx.log.custom("codex:stderr", { line });
  }

  private onCompletedItem(item: Record<string, unknown>): void {
    const type = stringValue(item.type);
    if (type === "agent_message") {
      const text = stringValue(item.text);
      if (text) this.logAssistant([{ type: "text", text }], "stop");
      return;
    }
    if (type === "reasoning") {
      const text = stringValue(item.text);
      if (text) this.logAssistant([{ type: "thinking", thinking: text }], "stop");
      return;
    }
    if (type === "mcp_tool_call") {
      this.onMcpToolCall(item);
      return;
    }
    if (type === "command_execution") {
      this.onCommandCompleted(item);
      return;
    }
    this.ctx.log.custom(`codex:${type || "item"}`, item);
  }

  private logCommandCall(item: Record<string, unknown>): void {
    const id = stringValue(item.id) || `codex-command-${Date.now()}`;
    if (this.startedToolCalls.has(id)) return;
    this.startedToolCalls.add(id);
    this.logAssistant(
      [{ type: "toolCall", id, name: "bash", arguments: { command: stringValue(item.command) } }],
      "toolUse",
    );
  }

  private onCommandCompleted(item: Record<string, unknown>): void {
    const id = stringValue(item.id) || `codex-command-${Date.now()}`;
    if (!this.startedToolCalls.has(id)) this.logCommandCall({ ...item, id });
    const exitCode = optionalNumberValue(item.exit_code);
    const status = stringValue(item.status);
    const output = stringValue(item.aggregated_output) || stringValue(item.output);
    const result: ToolResultMessage = {
      role: "toolResult",
      toolCallId: id,
      toolName: "bash",
      content: [{ type: "text", text: output }],
      details: { exitCode, status },
      isError: status === "failed" || (exitCode !== null && exitCode !== 0),
      timestamp: Date.now(),
    };
    this.ctx.log.message(result);
  }

  private onMcpToolCall(item: Record<string, unknown>): void {
    const id = stringValue(item.id) || `codex-tool-${Date.now()}`;
    const name = stringValue(item.tool) || stringValue(item.name) || stringValue(item.tool_name);
    const args = parseArguments(item.arguments ?? item.input);
    this.logAssistant([{ type: "toolCall", id, name: name || "mcp_tool_call", arguments: args }], "toolUse");

    const error = item.error;
    const result = error ?? item.result ?? item.output ?? "completed";
    const toolResult: ToolResultMessage = {
      role: "toolResult",
      toolCallId: id,
      toolName: name || "mcp_tool_call",
      content: [{ type: "text", text: stringify(result) }],
      isError: error !== undefined && error !== null,
      timestamp: Date.now(),
    };
    this.ctx.log.message(toolResult);

    const server = stringValue(item.server) || stringValue(item.server_name);
    if ((server === "" || server === "autosk") && name === "transit" && !toolResult.isError) {
      const to = stringValue(args.to);
      const target = parseTarget(to, this.targets);
      if (target) this.target = target;
      else this.ctx.log.custom("codex:warn", { message: "transit used an invalid target", to });
    }
  }

  private logUser(text: string): void {
    const message: UserMessage = { role: "user", content: text, timestamp: Date.now() };
    this.ctx.log.message(message);
  }

  private logUsage(usage: Record<string, number> | null): void {
    this.usageLogged = true;
    this.ctx.log.custom("codex:usage", usage);
  }

  private logAssistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): void {
    const message: AssistantMessage = {
      role: "assistant",
      content,
      provider: "openai",
      model: this.options.model ?? "codex-default",
      usage: ZERO_USAGE,
      stopReason,
      timestamp: Date.now(),
    };
    this.ctx.log.message(message);
  }
}

function normaliseUsage(value: unknown): Record<string, number> | null {
  const usage = recordValue(value);
  if (!usage) return null;
  const input = optionalTokenCount(usage.input_tokens);
  const output = optionalTokenCount(usage.output_tokens);
  if (input === null || output === null) return null;
  const result: Record<string, number> = { input_tokens: input, output_tokens: output };
  const cachedInput = optionalTokenCount(usage.cached_input_tokens);
  if (cachedInput !== null) result.cached_input_tokens = cachedInput;
  const reasoningOutput = optionalTokenCount(usage.reasoning_output_tokens);
  if (reasoningOutput !== null) result.reasoning_output_tokens = reasoningOutput;
  return result;
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return recordValue(parsed) ?? { value };
    } catch {
      return { value };
    }
  }
  return {};
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function optionalNumberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function optionalTokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function stringify(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

type CodexLogLevel = "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR";

function codexLogLevel(line: string): CodexLogLevel | null {
  const structured = line.match(/^\d{4}-\d{2}-\d{2}T\S+\s+(TRACE|DEBUG|INFO|WARN|ERROR)\b/);
  if (structured) return structured[1] as CodexLogLevel;
  if (/^WARN(?:ING)?\b/i.test(line)) return "WARN";
  if (/^ERROR\b/i.test(line)) return "ERROR";
  return null;
}
