import { describe, expect, it } from "vitest";
import { classifyItems } from "../src/classify.js";
import { loadConfig } from "../src/config.js";
import { JevClient } from "../src/jev.js";
import { Telemetry } from "../src/telemetry.js";

const enabled = process.env.JEV_DELEGATE_LIVE === "1" && Boolean(process.env.OPENROUTER_API_KEY);

describe.skipIf(!enabled)("live Jev contract and accuracy", () => {
  it("classifies at least 90% of clear fixtures", async () => {
    const config = loadConfig();
    const client = new JevClient(config, new Telemetry({ ...config, telemetryEnabled: false }));
    const fixtures = [
      ["b1", "Checkout crashes after pressing Pay", "bug"],
      ["b2", "The settings page renders blank", "bug"],
      ["b3", "Login returns an unexpected 500 error", "bug"],
      ["b4", "CSV export omits the final row", "bug"],
      ["b5", "Password reset link immediately expires", "bug"],
      ["f1", "Please add dark mode", "feature"],
      ["f2", "Can you support SAML login?", "feature"],
      ["f3", "We need PDF export", "feature"],
      ["f4", "Add keyboard shortcuts", "feature"],
      ["f5", "Please build a mobile app", "feature"],
    ] as const;
    const result = await classifyItems(
      {
        items: fixtures.map(([id, text]) => ({ id, text })),
        labels: { bug: "Existing behavior is broken or unexpected", feature: "Request for new capability" },
        instructions: "Classify each product request",
      },
      config,
      client,
    );
    const expected = new Map<string, string>(fixtures.map(([id, _text, label]) => [id, label]));
    const correct = result.classifications.filter((item) => item.label === expected.get(item.id)).length;
    expect(correct / fixtures.length).toBeGreaterThanOrEqual(0.9);
  });
});
