import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.js";
import { JevClient, type JevQuestion, type JevResponse } from "./jev.js";
import { containsSecret, ensureInsideRoot, isDeniedRelativePath } from "./privacy.js";

export type SearchInput = {
  patterns: string[];
  mode: "literal" | "regex";
  include_globs?: string[];
  exclude_globs?: string[];
  relevance_criterion: string;
  top_k: number;
};

export type SearchHit = {
  path: string;
  line: number;
  column: number;
  snippet: string;
  probability?: number;
  status: "included" | "uncertain" | "raw_fallback";
};

type RawHit = Omit<SearchHit, "probability" | "status"> & { deterministicScore: number };

type Usage = {
  model?: string;
  provider?: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
};

export type SearchResult = {
  status: "ok" | "fallback";
  results: SearchHit[];
  raw_match_count: number;
  evaluated_count: number;
  truncated: boolean;
  fallback_reason?: string;
  usage: Usage;
};

function validateGlob(glob: string): void {
  if (path.isAbsolute(glob) || glob.split(/[\\/]/).includes("..")) {
    throw new Error("Globs must stay inside workspace root");
  }
}

function rgArgs(input: SearchInput): string[] {
  const args = ["--json", "--line-number", "--column", "--color", "never", "--max-count", "20", "--max-filesize", "1M"];
  if (input.mode === "literal") args.push("--fixed-strings");
  for (const pattern of input.patterns) args.push("-e", pattern);
  for (const glob of input.include_globs ?? []) {
    validateGlob(glob);
    args.push("--glob", glob);
  }
  for (const glob of input.exclude_globs ?? []) {
    validateGlob(glob);
    args.push("--glob", `!${glob}`);
  }
  args.push(".");
  return args;
}

function scoreHit(hit: Omit<RawHit, "deterministicScore">, patterns: string[]): number {
  const haystack = `${hit.path}\n${hit.snippet}`.toLowerCase();
  return patterns.reduce((score, pattern) => score + (haystack.includes(pattern.toLowerCase()) ? 1 : 0), 0);
}

export async function collectSearchHits(root: string, input: SearchInput, config: Config): Promise<{
  hits: RawHit[];
  total: number;
  truncated: boolean;
}> {
  const canonicalRoot = await realpath(root);
  const child = spawn("rg", rgArgs(input), { cwd: canonicalRoot, stdio: ["ignore", "pipe", "pipe"] });
  let buffer = "";
  let stderr = "";
  let total = 0;
  let truncated = false;
  const byLocation = new Map<string, RawHit>();

  const consume = (jsonLine: string) => {
    if (!jsonLine) return;
    let event: any;
    try {
      event = JSON.parse(jsonLine);
    } catch {
      return;
    }
    if (event.type !== "match") return;
    total += 1;
    if (total > config.maxRawMatches) {
      truncated = true;
      child.kill("SIGTERM");
      return;
    }
    const relativePath = String(event.data?.path?.text ?? "").replace(/^\.\//, "");
    const line = Number(event.data?.line_number ?? 0);
    const column = Number(event.data?.submatches?.[0]?.start ?? 0) + 1;
    const snippet = String(event.data?.lines?.text ?? "").trim().slice(0, 500);
    if (!relativePath || !line || isDeniedRelativePath(relativePath) || containsSecret(snippet)) return;
    const absolute = path.resolve(canonicalRoot, relativePath);
    ensureInsideRoot(canonicalRoot, absolute);
    const key = `${relativePath}:${line}`;
    if (byLocation.has(key)) return;
    const base = { path: relativePath, line, column, snippet };
    byLocation.set(key, { ...base, deterministicScore: scoreHit(base, input.patterns) });
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) consume(line);
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-2_000);
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  consume(buffer);
  if (exitCode !== 0 && exitCode !== 1 && !truncated) {
    throw new Error(`rg failed with code ${exitCode}: ${stderr.trim()}`);
  }

  const hits = [...byLocation.values()]
    .sort((a, b) => b.deterministicScore - a.deterministicScore || a.path.localeCompare(b.path) || a.line - b.line)
    .slice(0, config.maxItems);
  return { hits, total: Math.min(total, config.maxRawMatches), truncated };
}

function chunks<T>(items: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < items.length; index += size) output.push(items.slice(index, index + size));
  return output;
}

async function mapLimit<T, R>(items: T[], limit: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function sumUsage(responses: JevResponse[], client: JevClient): Usage {
  return {
    model: responses.at(-1)?.model,
    provider: responses.at(-1)?.provider,
    input_tokens: responses.reduce((sum, response) => sum + response.usage.input_tokens, 0),
    output_tokens: responses.reduce((sum, response) => sum + response.usage.output_tokens, 0),
    cost_usd: client.totalCost(),
  };
}

export async function searchAndRank(
  root: string,
  input: SearchInput,
  config: Config,
  client: JevClient,
): Promise<SearchResult> {
  const collected = await collectSearchHits(root, input, config);
  if (collected.hits.length === 0) {
    return {
      status: "ok",
      results: [],
      raw_match_count: collected.total,
      evaluated_count: 0,
      truncated: collected.truncated,
      usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0 },
    };
  }

  const responses: JevResponse[] = [];
  try {
    const deadlineAt = Date.now() + config.toolTimeoutMs;
    const batchResults = await mapLimit(chunks(collected.hits, config.batchSize), config.concurrency, async (batch) => {
      const state = {
        relevance_criterion: input.relevance_criterion,
        candidates: batch.map(({ path: file, line, snippet }) => ({ file, line, snippet })),
      };
      const questions: Record<string, JevQuestion> = {};
      batch.forEach((_hit, index) => {
        questions[`candidate_${index}`] = {
          type: "noul",
          instructions:
            `Does state.candidates[${index}] satisfy state.relevance_criterion? ` +
            "Judge only supplied evidence. Missing evidence means false.",
        };
      });
      const response = await client.decide(state, questions, deadlineAt);
      const evaluated: SearchHit[] = [];
      batch.forEach((hit, index) => {
        const answer = response.answers[`candidate_${index}`];
        if (!answer || answer.type !== "noul") throw new Error("Jev omitted a relevance answer");
        if (answer.noul < config.lowThreshold) return;
        evaluated.push({
          path: hit.path,
          line: hit.line,
          column: hit.column,
          snippet: hit.snippet,
          probability: answer.noul,
          status: answer.noul >= config.highThreshold ? "included" : "uncertain",
        });
      });
      return { response, evaluated };
    });
    responses.push(...batchResults.map((result) => result.response));
    const evaluated = batchResults.flatMap((result) => result.evaluated);
    evaluated.sort((a, b) => (b.probability ?? 0) - (a.probability ?? 0));
    return {
      status: "ok",
      results: evaluated.slice(0, input.top_k),
      raw_match_count: collected.total,
      evaluated_count: collected.hits.length,
      truncated: collected.truncated,
      usage: sumUsage(responses, client),
    };
  } catch (error) {
    return {
      status: "fallback",
      results: collected.hits.slice(0, input.top_k).map(({ deterministicScore: _score, ...hit }) => ({
        ...hit,
        status: "raw_fallback",
      })),
      raw_match_count: collected.total,
      evaluated_count: 0,
      truncated: collected.truncated,
      fallback_reason: error instanceof Error ? error.message : "Unknown Jev failure",
      usage: sumUsage(responses, client),
    };
  }
}
