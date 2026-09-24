#!/usr/bin/env node
// Claude Code PreToolUse hook: every tool call is routed by Jev first.
// Jev agrees -> no decision (normal permissions apply). Jev picks another tool
// with high confidence -> deny with a redirect. Anything else -> ask the user.
import { loadConfig } from "./config.js";
import { JevClient } from "./jev.js";
import { type HookInput, type RouteDecision, routeToolCall } from "./route.js";
import { Telemetry } from "./telemetry.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function emit(decision: RouteDecision): void {
  if (decision.action === "pass") return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision.action,
        permissionDecisionReason: decision.reason,
      },
    }),
  );
}

async function main(): Promise<void> {
  if (process.env.JEV_DELEGATE_ROUTING === "off") return;
  let input: HookInput;
  try {
    input = JSON.parse(await readStdin()) as HookInput;
    if (typeof input.tool_name !== "string") throw new Error("missing tool_name");
  } catch {
    emit({ action: "ask", reason: "Jev routing could not parse the hook input" });
    return;
  }
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    emit({ action: "ask", reason: `Jev routing misconfigured (${error instanceof Error ? error.message : error})` });
    return;
  }
  const telemetry = new Telemetry(config);
  const client = new JevClient(config, telemetry);
  const started = Date.now();
  const decision = await routeToolCall(input, config, client);
  if (client.totalCost() > 0 || decision.action !== "pass") {
    await telemetry
      .write({
        timestamp: new Date().toISOString(),
        tool: "route_tool",
        status: decision.reason.startsWith("Jev routing") ? "fallback" : "ok",
        latency_ms: Date.now() - started,
        candidate_count: 1,
        returned_count: 1,
        cost_usd: client.totalCost(),
        fallback_reason: decision.action === "pass" ? undefined : decision.reason,
      })
      .catch(() => undefined);
  }
  emit(decision);
}

await main();
