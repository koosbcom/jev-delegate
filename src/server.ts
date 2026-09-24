#!/usr/bin/env node
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";
import { classifyItems } from "./classify.js";
import { loadConfig } from "./config.js";
import { JevClient } from "./jev.js";
import { containsSecret } from "./privacy.js";
import { searchAndRank } from "./search.js";
import { Telemetry } from "./telemetry.js";

const config = loadConfig();
const telemetry = new Telemetry(config);
const server = new McpServer({ name: "jev-delegate", version: "0.1.0" });

const UsageSchema = z.object({
  model: z.string().optional(),
  provider: z.string().optional(),
  input_tokens: z.number(),
  output_tokens: z.number(),
  cost_usd: z.number(),
});

const SearchResultSchema = z.object({
  status: z.enum(["ok", "fallback"]),
  results: z.array(
    z.object({
      path: z.string(),
      line: z.number(),
      column: z.number(),
      snippet: z.string(),
      probability: z.number().optional(),
      status: z.enum(["included", "uncertain", "raw_fallback"]),
    }),
  ),
  raw_match_count: z.number(),
  evaluated_count: z.number(),
  truncated: z.boolean(),
  fallback_reason: z.string().optional(),
  usage: UsageSchema,
});

const ClassificationResultSchema = z.object({
  status: z.enum(["ok", "fallback"]),
  classifications: z.array(
    z.object({
      id: z.string(),
      status: z.enum(["classified", "uncertain", "blocked_sensitive", "fallback"]),
      label: z.string().optional(),
      confidence: z.number().optional(),
      probabilities: z.record(z.string(), z.number()).optional(),
    }),
  ),
  fallback_reason: z.string().optional(),
  usage: UsageSchema,
});

async function workspaceRoot(): Promise<string> {
  try {
    const listed = await server.server.listRoots(undefined, { timeout: 2_000 });
    const fileRoot = listed.roots.find((root) => root.uri.startsWith("file:"));
    if (fileRoot) return realpath(fileURLToPath(fileRoot.uri));
  } catch {
    // Older clients may not expose roots. Explicit operator config is the only fallback.
  }
  const configured = process.env.JEV_DELEGATE_WORKSPACE_ROOT;
  if (!configured) throw new Error("MCP client did not expose a workspace root; set JEV_DELEGATE_WORKSPACE_ROOT");
  return realpath(configured);
}

function toolText(result: unknown): string {
  return JSON.stringify(result);
}

server.registerTool(
  "search_and_rank",
  {
    title: "Search workspace and rank matches with Jev",
    description:
      "Run read-only ripgrep inside the current workspace, then use Jev to return only relevant matches. " +
      "Use automatically when raw search would exceed 20 candidates or about 4K tokens. English judgments only.",
    inputSchema: {
      patterns: z.array(z.string().min(1).max(256)).min(1).max(10),
      mode: z.enum(["literal", "regex"]).default("literal"),
      include_globs: z.array(z.string().min(1).max(256)).max(20).optional(),
      exclude_globs: z.array(z.string().min(1).max(256)).max(20).optional(),
      relevance_criterion: z.string().min(1).max(2_000),
      top_k: z.number().int().min(1).max(25).default(10),
    },
    outputSchema: SearchResultSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: true },
  },
  async (input) => {
    if (containsSecret(input.relevance_criterion) || input.patterns.some(containsSecret)) {
      throw new Error("Search request appears to contain sensitive data");
    }
    const started = Date.now();
    const root = await workspaceRoot();
    const client = new JevClient(config, telemetry);
    const result = await searchAndRank(root, input, config, client);
    await telemetry.write({
      timestamp: new Date().toISOString(),
      tool: "search_and_rank",
      status: result.status,
      latency_ms: Date.now() - started,
      candidate_count: result.evaluated_count || result.raw_match_count,
      returned_count: result.results.length,
      resolved_model: result.usage.model,
      provider: result.usage.provider,
      input_tokens: result.usage.input_tokens,
      output_tokens: result.usage.output_tokens,
      cost_usd: result.usage.cost_usd,
      fallback_reason: result.fallback_reason,
    });
    return { content: [{ type: "text", text: toolText(result) }], structuredContent: result };
  },
);

server.registerTool(
  "classify_items",
  {
    title: "Classify supplied items with Jev",
    description:
      "Assign exactly one caller-supplied label to each item using Jev typed decisions. " +
      "Adds other and insufficient_context labels. Use for English bulk classification, not prose generation.",
    inputSchema: {
      items: z
        .array(
          z.object({
            id: z.string().min(1).max(256),
            text: z.string().min(1).max(8_000),
            metadata: z
              .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
              .optional(),
          }),
        )
        .min(1)
        .max(200),
      labels: z
        .record(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), z.string().min(1).max(1_000))
        .refine((labels) => Object.keys(labels).length >= 2 && Object.keys(labels).length <= 20, {
          message: "Supply 2-20 labels",
        })
        .refine((labels) => !("other" in labels) && !("insufficient_context" in labels), {
          message: "other and insufficient_context are reserved",
        }),
      instructions: z.string().min(1).max(2_000),
    },
    outputSchema: ClassificationResultSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: true },
  },
  async (input) => {
    if (containsSecret(input.instructions) || containsSecret(JSON.stringify(input.labels))) {
      throw new Error("Classification request appears to contain sensitive data");
    }
    const started = Date.now();
    const client = new JevClient(config, telemetry);
    const result = await classifyItems(input, config, client);
    await telemetry.write({
      timestamp: new Date().toISOString(),
      tool: "classify_items",
      status: result.status,
      latency_ms: Date.now() - started,
      candidate_count: input.items.length,
      returned_count: result.classifications.length,
      resolved_model: result.usage.model,
      provider: result.usage.provider,
      input_tokens: result.usage.input_tokens,
      output_tokens: result.usage.output_tokens,
      cost_usd: result.usage.cost_usd,
      fallback_reason: result.fallback_reason,
    });
    return { content: [{ type: "text", text: toolText(result) }], structuredContent: result };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
