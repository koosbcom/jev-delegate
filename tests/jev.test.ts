import { afterEach, describe, expect, it, vi } from "vitest";
import { JevClient, JevError } from "../src/jev.js";
import { Telemetry } from "../src/telemetry.js";
import { testConfig } from "./helpers.js";

const validResponse = {
  id: "gen-dec-test",
  model: "typesafe/jev-1.13-20260917",
  provider: "TypeSafe",
  answers: { q: { type: "noul", noul: 0.91 } },
  usage: { input_tokens: 100, output_tokens: 3, cost: 0.0000042 },
};

afterEach(() => vi.unstubAllGlobals());

describe("JevClient", () => {
  it("parses typed responses without leaking auth", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(validResponse), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const config = testConfig();
    const client = new JevClient(config, new Telemetry(config));
    const result = await client.decide({ text: "bug" }, { q: { type: "noul", instructions: "Is bug?" } });
    expect(result.answers.q).toEqual({ type: "noul", noul: 0.91 });
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.stringify(request.body)).not.toContain(config.apiKey);
  });

  it("retries one transient failure", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(validResponse), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const config = testConfig();
    const client = new JevClient(config, new Telemetry(config));
    await expect(client.decide({}, { q: { type: "noul", instructions: "Check" } })).resolves.toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry malformed responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"answers":{}}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const config = testConfig();
    const client = new JevClient(config, new Telemetry(config));
    await expect(client.decide({}, { q: { type: "noul", instructions: "Check" } })).rejects.toThrow(
      /invalid schema/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails before network when key is absent", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const config = testConfig({ apiKey: "" });
    const client = new JevClient(config, new Telemetry(config));
    await expect(client.decide({}, { q: { type: "noul", instructions: "Check" } })).rejects.toBeInstanceOf(
      JevError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
