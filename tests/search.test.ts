import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { JevClient, JevResponse } from "../src/jev.js";
import { collectSearchHits, searchAndRank } from "../src/search.js";
import { testConfig } from "./helpers.js";

describe("workspace search", () => {
  it("uses rg locally while excluding secret paths and values", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "jev-search-"));
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "safe.ts"), "const paymentBug = true;\n");
    await writeFile(path.join(root, ".env"), "PAYMENT_TOKEN=abcdefghijklmnopqrstuvwxyz123456\n");
    const result = await collectSearchHits(
      root,
      {
        patterns: ["payment"],
        mode: "literal",
        relevance_criterion: "Payment bugs",
        top_k: 10,
      },
      testConfig(),
    );
    expect(result.hits.map((hit) => hit.path)).toEqual(["src/safe.ts"]);
  });

  it("ranks by Jev probability and marks uncertainty", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "jev-rank-"));
    await writeFile(path.join(root, "a.txt"), "error in payments\n");
    await writeFile(path.join(root, "b.txt"), "error in profile\n");
    const fakeClient = {
      decide: async (_state: unknown, questions: Record<string, unknown>) => {
        const keys = Object.keys(questions);
        return {
          id: "test",
          model: "typesafe/jev-1.13",
          provider: "TypeSafe",
          answers: {
            [keys[0]!]: { type: "noul", noul: 0.95 },
            [keys[1]!]: { type: "noul", noul: 0.65 },
          },
          usage: { input_tokens: 20, output_tokens: 2, cost: 0.000001 },
        } as JevResponse;
      },
      totalCost: () => 0.000001,
    } as unknown as JevClient;
    const result = await searchAndRank(
      root,
      { patterns: ["error"], mode: "literal", relevance_criterion: "Any errors", top_k: 10 },
      testConfig(),
      fakeClient,
    );
    expect(result.results.map((item) => item.status)).toEqual(["included", "uncertain"]);
  });

  it("rejects globs that escape the workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "jev-glob-"));
    await expect(
      collectSearchHits(
        root,
        {
          patterns: ["x"],
          mode: "literal",
          include_globs: ["../**/*"],
          relevance_criterion: "x",
          top_k: 10,
        },
        testConfig(),
      ),
    ).rejects.toThrow(/inside workspace/);
  });
});
