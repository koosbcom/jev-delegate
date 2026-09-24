import type { Config } from "../src/config.js";

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    apiKey: "test-key",
    model: "typesafe/jev-1.13",
    lowThreshold: 0.5,
    highThreshold: 0.8,
    maxItems: 200,
    batchSize: 50,
    maxRawMatches: 500,
    maxInputTokens: 24_000,
    maxCallUsd: 0.01,
    maxDailyUsd: 0.25,
    requestTimeoutMs: 1_000,
    toolTimeoutMs: 30_000,
    concurrency: 2,
    telemetryEnabled: false,
    telemetryDir: "/private/tmp/jev-delegate-tests",
    ...overrides,
  } as Config;
}
