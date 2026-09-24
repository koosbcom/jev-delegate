import { describe, expect, it } from "vitest";
import { classifyItems } from "../src/classify.js";
import type { JevClient, JevResponse } from "../src/jev.js";
import { testConfig } from "./helpers.js";

describe("classifyItems", () => {
  it("blocks secret-bearing items and preserves IDs", async () => {
    const fakeClient = {
      decide: async (_state: unknown, questions: Record<string, unknown>) => {
        const answers = Object.fromEntries(
          Object.keys(questions).map((key) => [
            key,
            { type: "choice", choice: "bug", confidence: 0.95, probabilities: { bug: 0.95, feature: 0.05 } },
          ]),
        );
        return {
          id: "test",
          model: "typesafe/jev-1.13",
          provider: "TypeSafe",
          answers,
          usage: { input_tokens: 10, output_tokens: 1, cost: 0.000001 },
        } as JevResponse;
      },
      totalCost: () => 0.000001,
    } as unknown as JevClient;

    const result = await classifyItems(
      {
        items: [
          { id: "safe", text: "Button crashes on click" },
          { id: "secret", text: "api_key=abcdefghijklmnopqrstuvwxyz123456" },
        ],
        labels: { bug: "Broken behavior", feature: "New capability" },
        instructions: "Classify request",
      },
      testConfig(),
      fakeClient,
    );
    expect(result.classifications).toEqual([
      expect.objectContaining({ id: "safe", status: "classified", label: "bug" }),
      { id: "secret", status: "blocked_sensitive" },
    ]);
  });

  it("falls back without fabricating labels", async () => {
    const fakeClient = {
      decide: async () => {
        throw new Error("offline");
      },
      totalCost: () => 0,
    } as unknown as JevClient;
    const result = await classifyItems(
      {
        items: [{ id: "x", text: "A request" }],
        labels: { bug: "Broken", feature: "New" },
        instructions: "Classify",
      },
      testConfig(),
      fakeClient,
    );
    expect(result.status).toBe("fallback");
    expect(result.classifications).toEqual([{ id: "x", status: "fallback" }]);
  });
});
