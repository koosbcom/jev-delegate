import type { Config } from "./config.js";
import { JevClient, type JevQuestion, type JevResponse } from "./jev.js";
import { containsSecret } from "./privacy.js";

export type ClassificationItem = { id: string; text: string; metadata?: Record<string, unknown> };
export type ClassificationInput = {
  items: ClassificationItem[];
  labels: Record<string, string>;
  instructions: string;
};

export type Classification = {
  id: string;
  status: "classified" | "uncertain" | "blocked_sensitive" | "fallback";
  label?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
};

export type ClassificationResult = {
  status: "ok" | "fallback";
  classifications: Classification[];
  fallback_reason?: string;
  usage: {
    model?: string;
    provider?: string;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
  };
};

function makeCriteria(labels: Record<string, string>): Record<string, string> {
  return {
    ...labels,
    other: "The item is clear, but none of the supplied labels applies.",
    insufficient_context: "The item lacks enough evidence to choose a supplied label.",
  };
}

function makeBatches(items: ClassificationItem[], maxCount: number): ClassificationItem[][] {
  const batches: ClassificationItem[][] = [];
  let current: ClassificationItem[] = [];
  let characters = 0;
  for (const item of items) {
    const itemCharacters = item.text.length + JSON.stringify(item.metadata ?? {}).length;
    if (current.length > 0 && (current.length >= maxCount || characters + itemCharacters > 60_000)) {
      batches.push(current);
      current = [];
      characters = 0;
    }
    current.push(item);
    characters += itemCharacters;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

async function mapLimit<T, R>(items: T[], limit: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function classifyItems(
  input: ClassificationInput,
  config: Config,
  client: JevClient,
): Promise<ClassificationResult> {
  const seen = new Set<string>();
  for (const item of input.items) {
    if (seen.has(item.id)) throw new Error(`Duplicate item id: ${item.id}`);
    seen.add(item.id);
  }

  const blocked: Classification[] = [];
  const eligible: ClassificationItem[] = [];
  for (const item of input.items) {
    const serialized = `${item.text}\n${JSON.stringify(item.metadata ?? {})}`;
    if (containsSecret(serialized)) blocked.push({ id: item.id, status: "blocked_sensitive" });
    else eligible.push(item);
  }

  const criteria = makeCriteria(input.labels);
  const responses: JevResponse[] = [];
  const classifications: Classification[] = [...blocked];
  try {
    const deadlineAt = Date.now() + config.toolTimeoutMs;
    const batchResults = await mapLimit(makeBatches(eligible, config.batchSize), config.concurrency, async (batch) => {
      const state = { items: batch };
      const questions: Record<string, JevQuestion> = {};
      batch.forEach((_item, index) => {
        questions[`item_${index}`] = {
          type: "choice",
          instructions: `${input.instructions} Classify state.items[${index}]. Judge only supplied evidence.`,
          criteria,
        };
      });
      const response = await client.decide(state, questions, deadlineAt);
      const classified: Classification[] = [];
      batch.forEach((item, index) => {
        const answer = response.answers[`item_${index}`];
        if (!answer || answer.type !== "choice" || !(answer.choice in criteria)) {
          throw new Error("Jev returned an unknown or missing label");
        }
        const confidence = answer.confidence ?? 0;
        classified.push({
          id: item.id,
          status: confidence >= config.highThreshold ? "classified" : "uncertain",
          label: answer.choice,
          confidence,
          probabilities: answer.probabilities ?? {},
        });
      });
      return { response, classified };
    });
    responses.push(...batchResults.map((result) => result.response));
    classifications.push(...batchResults.flatMap((result) => result.classified));
    const order = new Map(input.items.map((item, index) => [item.id, index]));
    classifications.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    return {
      status: "ok",
      classifications,
      usage: {
        model: responses.at(-1)?.model,
        provider: responses.at(-1)?.provider,
        input_tokens: responses.reduce((sum, response) => sum + response.usage.input_tokens, 0),
        output_tokens: responses.reduce((sum, response) => sum + response.usage.output_tokens, 0),
        cost_usd: client.totalCost(),
      },
    };
  } catch (error) {
    const completed = new Set(classifications.map((item) => item.id));
    for (const item of eligible) {
      if (!completed.has(item.id)) classifications.push({ id: item.id, status: "fallback" });
    }
    return {
      status: "fallback",
      classifications,
      fallback_reason: error instanceof Error ? error.message : "Unknown Jev failure",
      usage: {
        model: responses.at(-1)?.model,
        provider: responses.at(-1)?.provider,
        input_tokens: responses.reduce((sum, response) => sum + response.usage.input_tokens, 0),
        output_tokens: responses.reduce((sum, response) => sum + response.usage.output_tokens, 0),
        cost_usd: client.totalCost(),
      },
    };
  }
}
