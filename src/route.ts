import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.js";
import type { JevClient } from "./jev.js";
import { containsSecret } from "./privacy.js";

// Built-in Claude Code tools Jev may route a call to. Tools outside this list
// (MCP tools, newer built-ins) are still routed; Jev sees them by name only.
export const ROUTABLE_TOOLS: Record<string, string> = {
  Read: "Read a known file path (optionally a line range). Best for viewing file contents.",
  Edit: "Replace an exact string in an existing file.",
  Write: "Create a new file or fully overwrite one.",
  Glob: "Find files by name or path pattern.",
  Grep: "Search file contents by regex across the workspace.",
  Bash: "Run a shell command: builds, tests, git, package managers, anything no dedicated tool covers.",
  WebFetch: "Fetch and read one known URL.",
  WebSearch: "Search the web for information not in the workspace.",
  Agent: "Delegate a multi-step or broad research task to a subagent.",
  NotebookEdit: "Edit a Jupyter notebook cell.",
};

// Tools that never go through routing: Jev's own tools and bookkeeping tools
// where there is no alternative to choose.
const EXEMPT = [/^mcp__.*jev_delegate__/, /^Task(Create|Update|Get|List|Stop)$/, /^TodoWrite$/, /^ToolSearch$/, /^AskUserQuestion$/];

export type HookInput = {
  session_id?: string;
  transcript_path?: string;
  tool_name: string;
  tool_input?: unknown;
};

export type RouteDecision =
  | { action: "pass"; reason: string }
  | { action: "ask"; reason: string }
  | { action: "deny"; reason: string; routed_to: string };

const MAX_INPUT_CHARS = 4_000;
const MAX_TASK_CHARS = 2_000;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…[truncated]` : text;
}

export async function lastUserPrompt(transcriptPath: string | undefined): Promise<string> {
  if (!transcriptPath) return "";
  let body: string;
  try {
    body = await readFile(transcriptPath, "utf8");
  } catch {
    return "";
  }
  const lines = body.trimEnd().split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const entry = JSON.parse(lines[index]!) as { type?: string; message?: { content?: unknown } };
      if (entry.type !== "user") continue;
      const content = entry.message?.content;
      if (typeof content === "string" && content.trim()) return content;
      if (Array.isArray(content)) {
        const text = content
          .filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
          .map((block) => block.text)
          .join("\n");
        if (text.trim()) return text;
      }
    } catch {
      // Skip malformed transcript lines.
    }
  }
  return "";
}

function callKey(input: HookInput): string {
  return createHash("sha256").update(`${input.tool_name}\n${JSON.stringify(input.tool_input ?? null)}`).digest("hex");
}

// Remembers calls Jev already redirected, so a repeated call after a redirect
// goes to the user instead of looping.
class RedirectMemory {
  private readonly file: string;

  constructor(config: Config, sessionId: string) {
    const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "_") || "unknown";
    this.file = path.join(config.telemetryDir, "route-state", `${safe}.json`);
  }

  private async load(): Promise<string[]> {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as unknown;
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
    } catch {
      return [];
    }
  }

  async has(key: string): Promise<boolean> {
    return (await this.load()).includes(key);
  }

  async add(key: string): Promise<void> {
    const keys = [...(await this.load()), key].slice(-200);
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await writeFile(this.file, JSON.stringify(keys), { encoding: "utf8", mode: 0o600 });
  }
}

export async function routeToolCall(input: HookInput, config: Config, client: JevClient): Promise<RouteDecision> {
  if (EXEMPT.some((pattern) => pattern.test(input.tool_name))) {
    return { action: "pass", reason: "Tool is exempt from Jev routing" };
  }

  const memory = new RedirectMemory(config, input.session_id ?? "");
  const key = callKey(input);
  if (await memory.has(key)) {
    return { action: "ask", reason: "Jev routed this call to another tool before; confirm to run it anyway" };
  }

  const task = truncate(await lastUserPrompt(input.transcript_path), MAX_TASK_CHARS);
  const proposedInput = truncate(JSON.stringify(input.tool_input ?? {}), MAX_INPUT_CHARS);
  if (containsSecret(task) || containsSecret(proposedInput)) {
    return { action: "ask", reason: "Jev routing skipped: call appears to contain sensitive data" };
  }

  const criteria: Record<string, string> = { ...ROUTABLE_TOOLS };
  if (!(input.tool_name in criteria)) {
    criteria[input.tool_name] = `The tool the agent proposed (${input.tool_name}); keep it when no listed tool fits better.`;
  }

  try {
    const response = await client.decide(
      { task, proposed_tool: input.tool_name, proposed_input: proposedInput },
      {
        route: {
          type: "choice",
          instructions:
            "A coding agent proposes calling state.proposed_tool with state.proposed_input to make progress on state.task. " +
            "Choose the single tool best suited to perform exactly that action. Keep the proposed tool unless another " +
            "listed tool clearly does the same job better (for example Grep instead of Bash grep, Read instead of Bash cat, " +
            "Glob instead of Bash find). Judge only the supplied evidence.",
          criteria,
        },
      },
      // Stay well inside the 30s hook timeout in hooks/hooks.json.
      Date.now() + Math.min(config.toolTimeoutMs, 20_000),
    );
    const answer = response.answers.route;
    if (!answer || answer.type !== "choice" || !(answer.choice in criteria)) {
      return { action: "ask", reason: "Jev returned no usable route" };
    }
    const confidence = answer.confidence ?? 0;
    if (answer.choice === input.tool_name) {
      return { action: "pass", reason: `Jev routed to ${answer.choice} (${confidence.toFixed(2)})` };
    }
    if (confidence >= config.highThreshold) {
      await memory.add(key);
      return {
        action: "deny",
        routed_to: answer.choice,
        reason:
          `Jev routed this action to ${answer.choice} instead of ${input.tool_name} (confidence ${confidence.toFixed(2)}). ` +
          `Retry the same action with ${answer.choice}. If ${input.tool_name} is truly required, repeat the call to ask the user.`,
      };
    }
    return {
      action: "ask",
      reason: `Jev leans toward ${answer.choice} over ${input.tool_name} (confidence ${confidence.toFixed(2)})`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Jev failure";
    return { action: "ask", reason: `Jev routing unavailable (${message})` };
  }
}
