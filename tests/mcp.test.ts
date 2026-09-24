import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

describe("MCP stdio server", () => {
  it("lists two narrow tools and returns structured fallback", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "jev-mcp-"));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve("dist/server.js")],
      env: {
        PATH: process.env.PATH ?? "",
        JEV_DELEGATE_WORKSPACE_ROOT: workspace,
        JEV_DELEGATE_TELEMETRY: "off",
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "jev-delegate-test", version: "0.1.0" });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual(["classify_items", "search_and_rank"]);
      const result = await client.callTool({
        name: "classify_items",
        arguments: {
          items: [{ id: "1", text: "Checkout crashes" }],
          labels: { bug: "Broken behavior", feature: "New capability" },
          instructions: "Classify request",
        },
      });
      expect(result.structuredContent).toMatchObject({
        status: "fallback",
        classifications: [{ id: "1", status: "fallback" }],
      });
    } finally {
      await client.close();
    }
  });
});
