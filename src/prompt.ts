import type { Comment, StepTarget, TaskView } from "@autosk/sdk";

export function targetLabel(target: StepTarget): string {
  return "step" in target ? target.step : target.status;
}

export function targetLabels(targets: StepTarget[]): string[] {
  return [...new Set(targets.map(targetLabel))];
}

export function parseTarget(to: string, targets: StepTarget[]): StepTarget | null {
  return targets.find((target) => targetLabel(target) === to) ?? null;
}

interface InitialPromptOptions {
  firstMessage: string;
  agentName: string;
  workflow: string;
  step: string;
  task: TaskView;
  targets: StepTarget[];
  comments: Comment[];
}

export function renderInitialPrompt(options: InitialPromptOptions): string {
  const lines: string[] = [];
  const firstMessage = options.firstMessage.replace(/\n+$/, "");
  if (firstMessage) lines.push(firstMessage, "");

  lines.push(`You are agent "${options.agentName}" on step "${options.step}" of workflow "${options.workflow}".`);
  lines.push(`Task: ${options.task.id}`);
  if (options.task.title) lines.push(`Title: ${options.task.title}`);
  if (options.task.description) lines.push("", "Description:", options.task.description);

  lines.push("", "Available transitions (pick exactly one before you stop):");
  for (const label of targetLabels(options.targets)) lines.push(`  - ${label}`);
  lines.push(
    "",
    "When the work for this step is complete, call the autosk MCP `transit` tool exactly once.",
    `Set \`to\` to one of: ${targetLabels(options.targets).join(", ")}.`,
    "Do not finish the turn before calling `transit`.",
  );

  if (options.comments.length) {
    lines.push("", "Comments (oldest first):");
    for (const comment of options.comments) lines.push(`  [${comment.author}] ${comment.text}`);
  } else {
    lines.push("", "No comments on this task yet.");
  }
  return `${lines.join("\n")}\n`;
}

export function kickbackMessage(taskId: string, targets: StepTarget[], attempt: number, max: number): string {
  return [
    `You finished without calling the autosk MCP \`transit\` tool on task ${taskId}.`,
    `Call it exactly once with \`to\` set to one of: ${targetLabels(targets).join(", ")}.`,
    `This is correction attempt ${attempt} of ${max}.`,
  ].join("\n");
}

export function rejectionMessage(
  rejected: StepTarget,
  error: string,
  targets: StepTarget[],
  attempt: number,
  max: number,
): string {
  return [
    `Your transition to "${targetLabel(rejected)}" was rejected: ${error}`,
    `Choose another target and call the autosk MCP \`transit\` tool: ${targetLabels(targets).join(", ")}.`,
    `This is correction attempt ${attempt} of ${max}.`,
  ].join("\n");
}
