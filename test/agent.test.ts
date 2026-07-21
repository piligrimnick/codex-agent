import { describe, expect, test } from "vitest";
import type { AgentRunContext, ChildHandle, StepTarget, TranscriptMessage } from "@autosk/sdk";

import { buildCodexCommand, codexAgent } from "../src/index.ts";

describe("buildCodexCommand", () => {
  test("builds an initial headless turn with a temporary authenticated MCP server", () => {
    const command = buildCodexCommand(
      {
        codexBin: "/usr/local/bin/codex",
        model: "gpt-test",
        reasoningEffort: "xhigh",
        sandboxMode: "read-only",
        networkAccess: true,
      },
      {
        cwd: "/repo",
        mcp: { url: "http://127.0.0.1:4321/mcp", tokenEnvVar: "AUTOSK_MCP_TOKEN" },
      },
    );

    expect(command.slice(0, 3)).toEqual(["/usr/local/bin/codex", "exec", "--json"]);
    expect(command).toContain("--cd");
    expect(command[command.indexOf("--cd") + 1]).toBe("/repo");
    expect(command[command.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(command).toContain('model_reasoning_effort="xhigh"');
    expect(command).toContain("sandbox_workspace_write.network_access=true");
    expect(command).toContain('mcp_servers.autosk.url="http://127.0.0.1:4321/mcp"');
    expect(command).toContain('mcp_servers.autosk.bearer_token_env_var="AUTOSK_MCP_TOKEN"');
    expect(command).toContain('mcp_servers.autosk.tools.transit.approval_mode="approve"');
    expect(command).toContain('mcp_servers.autosk.tools.task.approval_mode="approve"');
    expect(command).toContain('mcp_servers.autosk.tools.comment.approval_mode="approve"');
    expect(command.join(" ")).not.toContain("secret-token");
    expect(command.at(-1)).toBe("-");
  });

  test("resumes the exact thread and does not repeat initial-only flags", () => {
    const command = buildCodexCommand(
      { codexBin: "codex", sandboxMode: "workspace-write", profile: "automation" },
      { cwd: "/repo", threadId: "thread-123" },
    );

    expect(command.slice(0, 3)).toEqual(["codex", "exec", "resume"]);
    expect(command).toContain("--profile");
    expect(command).not.toContain("--cd");
    expect(command).not.toContain("--sandbox");
    expect(command.slice(-2)).toEqual(["thread-123", "-"]);
  });

  test("supports an explicitly privileged headless turn without adding a sandbox flag", () => {
    const command = buildCodexCommand(
      { codexBin: "codex", dangerouslyBypassApprovalsAndSandbox: true },
      { cwd: "/repo" },
    );

    expect(command).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(command).not.toContain("--sandbox");
  });
});

describe("codexAgent", () => {
  test("uses exec, resumes after kickback, observes MCP transit, and commits it", async () => {
    const commands: string[][] = [];
    const prompts: string[] = [];
    const messages: TranscriptMessage[] = [];
    const customs: Array<{ type: string; data: unknown }> = [];
    const transits: StepTarget[] = [];
    let turn = 0;

    const ctx = fakeContext({
      spawn(command): ChildHandle {
        commands.push(command);
        turn++;
        const events =
          turn === 1
            ? [
                { type: "thread.started", thread_id: "thread-123" },
                { type: "turn.started" },
                {
                  type: "item.started",
                  item: { id: "cmd1", type: "command_execution", command: "printf 'one\\ntwo\\n'", status: "in_progress" },
                },
                {
                  type: "item.completed",
                  item: {
                    id: "cmd1",
                    type: "command_execution",
                    command: "printf 'one\\ntwo\\n'",
                    aggregated_output: "one\ntwo\n",
                    exit_code: 0,
                    status: "completed",
                  },
                },
                { type: "item.completed", item: { id: "a1", type: "agent_message", text: "I forgot." } },
                { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } },
              ]
            : [
                { type: "thread.started", thread_id: "thread-123" },
                { type: "turn.started" },
                {
                  type: "item.completed",
                  item: {
                    id: "mcp1",
                    type: "mcp_tool_call",
                    server: "autosk",
                    tool: "transit",
                    arguments: { to: "done" },
                    status: "completed",
                    result: { content: [{ type: "text", text: "accepted" }] },
                  },
                },
                { type: "turn.completed", usage: { input_tokens: 12, output_tokens: 1 } },
              ];
        const stderrLines =
          turn === 1
            ? [
                "2026-07-16T20:37:37.911Z  INFO codex_http_client: verbose setup",
                "continued info payload that must also be suppressed",
                "2026-07-16T20:37:38.000Z  WARN codex_core: useful warning",
              ]
            : [];
        return fakeChild(events, prompts, stderrLines);
      },
      log: {
        message(message): void {
          messages.push(message);
        },
        custom(type, data): void {
          customs.push({ type, data });
        },
      },
      async transit(target): Promise<void> {
        transits.push(target);
      },
    });

    await codexAgent({ codexBin: "codex", firstMessage: "Implement it.", maxCorrections: 2 }).onRun(ctx);

    expect(commands).toHaveLength(2);
    expect(commands[0]!.slice(0, 3)).toEqual(["codex", "exec", "--json"]);
    expect(commands[1]!.slice(0, 3)).toEqual(["codex", "exec", "resume"]);
    expect(commands[1]).toContain("thread-123");
    expect(prompts[0]).toContain("Implement it.");
    expect(prompts[1]).toContain("finished without calling");
    expect(transits).toEqual([{ status: "done" }]);
    expect(messages.some((message) => message.role === "assistant")).toBe(true);
    expect(
      messages.some(
        (message) =>
          message.role === "assistant" &&
          message.content.some((block) => block.type === "toolCall" && block.id === "cmd1" && block.name === "bash"),
      ),
    ).toBe(true);
    expect(
      messages.some(
        (message) =>
          message.role === "toolResult" &&
          message.toolCallId === "cmd1" &&
          message.content.some((block) => block.type === "text" && block.text === "one\ntwo\n"),
      ),
    ).toBe(true);
    expect(customs.some((entry) => entry.type === "codex:usage")).toBe(true);
    expect(customs.some((entry) => entry.type === "codex:command_execution")).toBe(false);
    expect(customs.some((entry) => entry.type === "codex:warn")).toBe(true);
    expect(customs.some((entry) => JSON.stringify(entry.data).includes("verbose setup"))).toBe(false);
    expect(customs.some((entry) => JSON.stringify(entry.data).includes("continued info payload"))).toBe(false);
  });

  test("keeps the bearer token in the child environment, not argv", async () => {
    let spawnedEnv: Record<string, string> | undefined;
    let spawnedCommand: string[] = [];
    const ctx = fakeContext({
      spawn(command, options): ChildHandle {
        spawnedCommand = command;
        spawnedEnv = options?.env;
        return fakeChild(
          [
            { type: "thread.started", thread_id: "thread-1" },
            {
              type: "item.completed",
              item: { id: "mcp1", type: "mcp_tool_call", server: "autosk", tool: "transit", arguments: '{"to":"done"}', result: "ok" },
            },
            { type: "turn.completed", usage: {} },
          ],
          [],
        );
      },
    });

    await codexAgent().onRun(ctx);

    expect(spawnedEnv?.AUTOSK_MCP_TOKEN).toBe("secret-token");
    expect(spawnedCommand.join(" ")).not.toContain("secret-token");
  });
});

function fakeContext(overrides: Partial<AgentRunContext> = {}): AgentRunContext {
  const controller = new AbortController();
  const task = { id: "ask-1", title: "Test task", description: "Exercise Codex" };
  return {
    session: { id: "session-1" },
    mode: "task",
    cwd: "/repo",
    projectRoot: "/repo",
    signal: controller.signal,
    tasks: {
      currentId: "ask-1",
      async current() {
        return task;
      },
      async get() {
        return task;
      },
      async list() {
        return [task];
      },
      async comments() {
        return [];
      },
    },
    workflows: {
      current: { workflow: "test", step: "dev", targets: [{ status: "done" }] },
      get() {
        return undefined;
      },
      list() {
        return [];
      },
    },
    log: { message() {}, custom() {} },
    partial() {},
    async comment() {},
    async transit() {},
    setActivity() {},
    async exec() {
      return { code: 0, stdout: "", stderr: "" };
    },
    spawn() {
      throw new Error("spawn not stubbed");
    },
    async newMCPServer() {
      return { url: "http://127.0.0.1:4321/mcp", port: 4321, token: "secret-token", async close() {} };
    },
    ...overrides,
  } as unknown as AgentRunContext;
}

function fakeChild(events: unknown[], prompts: string[], stderrLines: string[] = []): ChildHandle {
  const stdout: Array<(line: string) => void> = [];
  const stderr: Array<(line: string) => void> = [];
  let input = "";
  let resolveExit!: (result: { code: number | null }) => void;
  const exited = new Promise<{ code: number | null }>((resolve) => {
    resolveExit = resolve;
  });
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      input += new TextDecoder().decode(chunk);
    },
    close() {
      prompts.push(input);
      queueMicrotask(() => {
        for (const line of stderrLines) {
          for (const callback of stderr) callback(line);
        }
        for (const event of events) {
          const line = JSON.stringify(event);
          for (const callback of stdout) callback(line);
        }
        resolveExit({ code: 0 });
      });
    },
  });
  return {
    stdin: writable.getWriter(),
    onStdout(callback) {
      stdout.push(callback);
    },
    onStderr(callback) {
      stderr.push(callback);
    },
    kill() {
      resolveExit({ code: null });
    },
    exited,
  };
}
