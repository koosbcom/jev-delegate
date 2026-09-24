import os from "node:os";
import path from "node:path";

function numberEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig() {
  const lowThreshold = numberEnv("JEV_DELEGATE_RELEVANCE_LOW", 0.5, 0, 1);
  const highThreshold = numberEnv("JEV_DELEGATE_RELEVANCE_HIGH", 0.8, 0, 1);
  if (lowThreshold >= highThreshold) {
    throw new Error("JEV_DELEGATE_RELEVANCE_LOW must be below JEV_DELEGATE_RELEVANCE_HIGH");
  }

  return {
    apiKey: process.env.OPENROUTER_API_KEY ?? "",
    model: process.env.JEV_DELEGATE_MODEL ?? "typesafe/jev-1.13",
    lowThreshold,
    highThreshold,
    maxItems: Math.floor(numberEnv("JEV_DELEGATE_MAX_ITEMS", 200, 1, 200)),
    batchSize: Math.floor(numberEnv("JEV_DELEGATE_BATCH_SIZE", 50, 1, 50)),
    maxRawMatches: Math.floor(numberEnv("JEV_DELEGATE_MAX_RAW_MATCHES", 500, 20, 500)),
    maxInputTokens: Math.floor(numberEnv("JEV_DELEGATE_MAX_INPUT_TOKENS", 24_000, 1_000, 24_000)),
    maxCallUsd: numberEnv("JEV_DELEGATE_MAX_CALL_USD", 0.01, 0.0001, 10),
    maxDailyUsd: numberEnv("JEV_DELEGATE_MAX_DAILY_USD", 0.25, 0.001, 1_000),
    requestTimeoutMs: Math.floor(numberEnv("JEV_DELEGATE_REQUEST_TIMEOUT_MS", 10_000, 1_000, 30_000)),
    toolTimeoutMs: Math.floor(numberEnv("JEV_DELEGATE_TOOL_TIMEOUT_MS", 30_000, 2_000, 60_000)),
    concurrency: Math.floor(numberEnv("JEV_DELEGATE_CONCURRENCY", 2, 1, 2)),
    telemetryEnabled: process.env.JEV_DELEGATE_TELEMETRY !== "off",
    telemetryDir:
      process.env.JEV_DELEGATE_TELEMETRY_PATH ??
      path.join(os.homedir(), ".codex", "state", "jev-delegate"),
  } as const;
}
