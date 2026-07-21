import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentDefinition, AgentRunContext, AutoskAPI, StepTarget } from "@autosk/sdk";

import { CodexTurn, type CodexCommandOptions, type McpConnection } from "./driver.ts";
import { kickbackMessage, rejectionMessage, renderInitialPrompt } from "./prompt.ts";

interface SandboxId {
  projectRoot: string;
  taskId: string;
}

export interface AgentSandbox {
  workspace(id: SandboxId): Promise<{ cwd: string }>;
  wrap(cmd: string[], options: { cwd: string; env?: Record<string, string>; id: SandboxId }): string[];
  endpointFor(port: number): string;
  stop(id: SandboxId): Promise<void>;
}

export interface CodexAgentOptions extends CodexCommandOptions {
  firstMessage?: string;
  firstMessageFile?: string;
  maxCorrections?: number;
  autoskTools?: boolean;
  sandbox?: AgentSandbox;
  /** Transition labels this agent may see and submit. Defaults to every workflow target. */
  allowedTransitions?: string[];
}

interface LiveSession {
  send(message: string): Promise<void>;
  stop(): void;
}

const liveSessions = new Map<string, LiveSession>();

export function codexAgent(options: CodexAgentOptions = {}): AgentDefinition {
  const maxCorrections = options.maxCorrections ?? 3;
  let firstMessageOnce: Promise<string> | null = null;
  const firstMessage = (): Promise<string> => (firstMessageOnce ??= resolveFirstMessage(options));

  return {
    async onRun(ctx): Promise<void> {
      if (ctx.mode === "interactive") {
        await runChat(ctx, options);
        return;
      }
      await runTask(ctx, options, await firstMessage(), maxCorrections);
    },
    onSteer: (ctx, message) => forward(ctx, message),
    onFollowup: (ctx, message) => forward(ctx, message),
    async onAbort(ctx): Promise<void> {
      liveSessions.get(ctx.session.id)?.stop();
      if (options.sandbox && ctx.mode === "task") {
        await options.sandbox
          .stop({ projectRoot: ctx.projectRoot, taskId: ctx.tasks.currentId })
          .catch(() => {});
      }
    },
  };
}

async function runTask(
  ctx: AgentRunContext,
  options: CodexAgentOptions,
  firstMessage: string,
  maxCorrections: number,
): Promise<void> {
  const id = { projectRoot: ctx.projectRoot, taskId: ctx.tasks.currentId };
  const workspace = options.sandbox ? await options.sandbox.workspace(id) : { cwd: ctx.cwd };
  const mcpServer = options.autoskTools === false ? null : await ctx.newMCPServer();
  const mcp = mcpServer
    ? {
        url: options.sandbox ? options.sandbox.endpointFor(mcpServer.port) : mcpServer.url,
        tokenEnvVar: "AUTOSK_MCP_TOKEN",
      }
    : undefined;
  const env = autoskEnv(ctx, mcpServer?.token);

  const task = await ctx.tasks.current();
  const targets = filterTargets(ctx.workflows.current.targets, options.allowedTransitions);
  if (targets.length === 0) {
    throw new Error("codex agent has no allowed workflow transitions");
  }
  const comments = await ctx.tasks.comments();
  let prompt = renderInitialPrompt({
    firstMessage,
    agentName: ctx.workflows.current.step,
    workflow: ctx.workflows.current.workflow,
    step: ctx.workflows.current.step,
    task,
    targets,
    comments,
  });
  let threadId: string | undefined;
  let corrections = 0;

  try {
    for (;;) {
      const wrap = options.sandbox
        ? (command: string[]) => options.sandbox!.wrap(command, { cwd: workspace.cwd, env, id })
        : undefined;
      const turn = new CodexTurn(ctx, options, workspace.cwd, targets, mcp, threadId, wrap);
      const result = await turn.run(prompt, env);
      if (ctx.signal.aborted) return;
      if (!result.threadId) throw new Error("codex did not emit a thread.started event");
      threadId = result.threadId;
      if (result.code !== 0 || !result.completed) {
        throw new Error(`codex exec failed (code=${result.code}, turn_completed=${result.completed})`);
      }

      if (result.target) {
        const rejection = await commitTransit(ctx, result.target);
        if (!rejection) return;
        if (corrections >= maxCorrections) return;
        corrections++;
        prompt = rejectionMessage(result.target, rejection, targets, corrections, maxCorrections);
        continue;
      }

      if (corrections >= maxCorrections) return;
      corrections++;
      prompt = kickbackMessage(task.id, targets, corrections, maxCorrections);
    }
  } finally {
    if (mcpServer) await mcpServer.close().catch(() => {});
  }
}

function filterTargets(targets: StepTarget[], allowed?: string[]): StepTarget[] {
  if (!allowed) return targets;
  const labels = new Set(allowed);
  return targets.filter((target) => labels.has("step" in target ? target.step : target.status));
}

async function runChat(ctx: AgentRunContext, options: CodexAgentOptions): Promise<void> {
  const mcpServer = options.autoskTools === false ? null : await ctx.newMCPServer();
  const mcp: McpConnection | undefined = mcpServer
    ? { url: mcpServer.url, tokenEnvVar: "AUTOSK_MCP_TOKEN" }
    : undefined;
  const env = autoskEnv(ctx, mcpServer?.token);
  let threadId: string | undefined;
  let active: CodexTurn | null = null;
  let queue = Promise.resolve();

  const session: LiveSession = {
    send(message): Promise<void> {
      const next = queue.then(async () => {
        if (ctx.signal.aborted) return;
        ctx.setActivity("busy");
        try {
          active = new CodexTurn(ctx, options, ctx.cwd, [], mcp, threadId);
          const result = await active.run(message, env);
          if (result.code !== 0 || !result.completed) {
            throw new Error(`codex exec failed (code=${result.code}, turn_completed=${result.completed})`);
          }
          if (!result.threadId) throw new Error("codex did not emit a thread.started event");
          threadId = result.threadId;
        } finally {
          active = null;
          ctx.setActivity("idle");
        }
      });
      queue = next.catch((error) => {
        ctx.log.custom("codex:error", { message: error instanceof Error ? error.message : String(error) });
      });
      return next;
    },
    stop(): void {
      active?.kill();
    },
  };

  liveSessions.set(ctx.session.id, session);
  ctx.setActivity("idle");
  try {
    await waitForSignal(ctx.signal);
  } finally {
    liveSessions.delete(ctx.session.id);
    session.stop();
    await queue.catch(() => {});
    if (mcpServer) await mcpServer.close().catch(() => {});
  }
}

function forward(ctx: AgentRunContext, message: string): Promise<void> {
  return liveSessions.get(ctx.session.id)?.send(message) ?? Promise.resolve();
}

async function commitTransit(ctx: AgentRunContext, target: StepTarget): Promise<string | null> {
  try {
    await ctx.transit(target);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function autoskEnv(ctx: AgentRunContext, token?: string): Record<string, string> {
  const cacheRoot = join(tmpdir(), "autosk-codex-cache", ctx.tasks.currentId);
  return {
    AUTOSK_CWD: ctx.projectRoot,
    AUTOSK_AGENT: ctx.workflows.current.step,
    XDG_CACHE_HOME: join(cacheRoot, "xdg"),
    NPM_CONFIG_CACHE: join(cacheRoot, "npm"),
    npm_config_store_dir: join(cacheRoot, "pnpm-store"),
    COREPACK_HOME: join(cacheRoot, "corepack"),
    YARN_CACHE_FOLDER: join(cacheRoot, "yarn"),
    GOCACHE: join(cacheRoot, "go-build"),
    GOMODCACHE: join(cacheRoot, "go-mod"),
    CARGO_HOME: join(cacheRoot, "cargo"),
    PIP_CACHE_DIR: join(cacheRoot, "pip"),
    UV_CACHE_DIR: join(cacheRoot, "uv"),
    ...(token ? { AUTOSK_MCP_TOKEN: token } : {}),
  };
}

function waitForSignal(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

async function resolveFirstMessage(options: CodexAgentOptions): Promise<string> {
  if (options.firstMessage !== undefined) return options.firstMessage;
  if (options.firstMessageFile) return readFile(options.firstMessageFile, "utf8");
  return "";
}

export { CodexTurn, buildCodexCommand } from "./driver.ts";
export { kickbackMessage, parseTarget, rejectionMessage, renderInitialPrompt, targetLabel, targetLabels } from "./prompt.ts";

export default function codexAgentExtension(autosk: AutoskAPI): void {
  autosk.registerAgent({
    name: "@autosk/codex-agent",
    description: "System-wide Codex CLI agent backed by codex exec --json.",
    agent: codexAgent(),
  });
}
