import { z } from "zod";
import type { Config } from "./config.js";
import type { Telemetry } from "./telemetry.js";

const NoulAnswer = z.object({ type: z.literal("noul"), noul: z.number().min(0).max(1) });
const ChoiceAnswer = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  confidence: z.number().min(0).max(1).optional(),
  probabilities: z.record(z.string(), z.number().min(0).max(1)).optional(),
});
const ResponseSchema = z.object({
  id: z.string(),
  model: z.string(),
  provider: z.string().optional(),
  answers: z.record(z.string(), z.union([NoulAnswer, ChoiceAnswer])),
  usage: z.object({
    input_tokens: z.number().nonnegative(),
    output_tokens: z.number().nonnegative(),
    cost: z.number().nonnegative().optional(),
  }),
});

export type JevResponse = z.infer<typeof ResponseSchema>;
export type JevQuestion =
  | { type: "noul"; instructions: string }
  | { type: "choice"; instructions: string; criteria: Record<string, string> };

export class JevError extends Error {
  constructor(message: string, readonly retryable = false) {
    super(message);
    this.name = "JevError";
  }
}

export class JevClient {
  private callCost = 0;

  constructor(
    private readonly config: Config,
    private readonly telemetry: Telemetry,
  ) {}

  async decide(
    state: unknown,
    questions: Record<string, JevQuestion>,
    deadlineAt = Date.now() + this.config.toolTimeoutMs,
  ): Promise<JevResponse> {
    if (!this.config.apiKey) throw new JevError("OPENROUTER_API_KEY is not configured");
    if (Object.keys(questions).length === 0 || Object.keys(questions).length > this.config.batchSize) {
      throw new JevError(`Question count must be 1-${this.config.batchSize}`);
    }
    const payload = { model: this.config.model, state, questions };
    const estimatedTokens = Math.ceil(JSON.stringify(payload).length / 4);
    if (estimatedTokens > this.config.maxInputTokens) {
      throw new JevError(`Estimated input ${estimatedTokens} exceeds ${this.config.maxInputTokens}-token cap`);
    }
    const estimatedCost = (estimatedTokens / 1_000_000) * 0.042;
    if (this.callCost + estimatedCost > this.config.maxCallUsd) {
      throw new JevError("Per-call spend guard reached");
    }
    if ((await this.telemetry.todayCost()) + estimatedCost > this.config.maxDailyUsd) {
      throw new JevError("Daily spend guard reached");
    }

    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const remainingMs = deadlineAt - Date.now();
        if (remainingMs <= 0) throw new JevError("Tool deadline reached");
        const response = await this.request(payload, Math.min(this.config.requestTimeoutMs, remainingMs));
        this.callCost += response.usage.cost ?? estimatedCost;
        return response;
      } catch (error) {
        lastError = error;
        if (!(error instanceof JevError) || !error.retryable || attempt === 1) break;
        const delay = 250 * 2 ** attempt;
        if (Date.now() + delay >= deadlineAt) break;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw lastError;
  }

  totalCost(): number {
    return this.callCost;
  }

  private async request(payload: unknown, timeoutMs: number): Promise<JevResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch("https://openrouter.ai/api/alpha/decisions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
          "X-OpenRouter-Title": "jev-delegate",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        throw new JevError(`Decisions API returned HTTP ${response.status}`, retryable);
      }
      const raw = await response.json();
      const parsed = ResponseSchema.safeParse(raw);
      if (!parsed.success) throw new JevError("Decisions API returned invalid schema");
      return parsed.data;
    } catch (error) {
      if (error instanceof JevError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new JevError("Decisions API timed out", true);
      }
      throw new JevError("Decisions API transport failure", true);
    } finally {
      clearTimeout(timer);
    }
  }
}
