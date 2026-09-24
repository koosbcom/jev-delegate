import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { JevClient, JevResponse } from "../src/jev.js";
import { lastUserPrompt, routeToolCall } from "../src/route.js";
import { testConfig } from "./helpers.js";

function clientChoosing(choice: string, confidence: number, seen: unknown[] = []): JevClient {
  return {
    decide: async (state: unknown, questions: unknown) => {
      seen.push({ state, questions });
      return {
        id: "test",
        model: "typesafe/jev-1.13",
        answers: { route: { type: "choice", choice, confidence } },
        usage: { input_tokens: 10, output_tokens: 1, cost: 0.000001 },
      } as JevResponse;
    },
    totalCost: () => 0.000001,
  } as unknown as JevClient;
}

async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "jev-route-"));
  const transcript = path.join(dir, "transcript.jsonl");
  await writeFile(
    transcript,
    [
      JSON.stringify({ type: "user", message: { role: "user", content: "old request" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "find TODOs in src" }] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "x" }] } }),
    ].join("\n"),
  );
  return { config: testConfig({ telemetryDir: dir }), transcript };
}

describe("routeToolCall", () => {
  it("reads the latest user text from the transcript", async () => {
    const { transcript } = await setup();
    expect(await lastUserPrompt(transcript)).toBe("find TODOs in src");
  });

  it("passes when Jev keeps the proposed tool", async () => {
    const { config, transcript } = await setup();
    const seen: unknown[] = [];
    const decision = await routeToolCall(
      { session_id: "s1", transcript_path: transcript, tool_name: "Grep", tool_input: { pattern: "TODO" } },
      config,
      clientChoosing("Grep", 0.9, seen),
    );
    expect(decision.action).toBe("pass");
    expect(seen[0]).toMatchObject({ state: { task: "find TODOs in src", proposed_tool: "Grep" } });
  });

  it("redirects on a confident different route, then asks on repeat", async () => {
    const { config, transcript } = await setup();
    const input = { session_id: "s2", transcript_path: transcript, tool_name: "Bash", tool_input: { command: "grep -r TODO src" } };
    const first = await routeToolCall(input, config, clientChoosing("Grep", 0.93));
    expect(first).toMatchObject({ action: "deny", routed_to: "Grep" });
    const second = await routeToolCall(input, config, clientChoosing("Grep", 0.93));
    expect(second.action).toBe("ask");
  });

  it("asks when Jev is unsure about another tool", async () => {
    const { config, transcript } = await setup();
    const decision = await routeToolCall(
      { session_id: "s3", transcript_path: transcript, tool_name: "Bash", tool_input: { command: "ls" } },
      config,
      clientChoosing("Glob", 0.6),
    );
    expect(decision.action).toBe("ask");
  });

  it("asks when Jev is unavailable", async () => {
    const { config } = await setup();
    const failing = { decide: async () => Promise.reject(new Error("offline")), totalCost: () => 0 } as unknown as JevClient;
    const decision = await routeToolCall({ session_id: "s4", tool_name: "Read", tool_input: { file_path: "a" } }, config, failing);
    expect(decision).toMatchObject({ action: "ask", reason: expect.stringContaining("offline") });
  });

  it("offers MCP tools as a candidate and skips Jev's own tools", async () => {
    const { config } = await setup();
    const seen: unknown[] = [];
    const client = clientChoosing("mcp__github__get_file_contents", 0.9, seen);
    expect((await routeToolCall({ tool_name: "mcp__github__get_file_contents", tool_input: {} }, config, client)).action).toBe("pass");
    expect(JSON.stringify(seen[0])).toContain("mcp__github__get_file_contents");
    const exempt = await routeToolCall({ tool_name: "mcp__plugin_jev-delegate_jev_delegate__classify_items" }, config, client);
    expect(exempt.action).toBe("pass");
    expect(seen).toHaveLength(1);
  });

  it("never sends secret-bearing calls to Jev", async () => {
    const { config } = await setup();
    const seen: unknown[] = [];
    const decision = await routeToolCall(
      { tool_name: "Bash", tool_input: { command: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwx'" } },
      config,
      clientChoosing("Bash", 0.9, seen),
    );
    expect(decision.action).toBe("ask");
    expect(seen).toHaveLength(0);
  });
});
