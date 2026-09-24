import { appendFile, mkdir, readFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.js";

export type UsageEvent = {
  timestamp: string;
  tool: "search_and_rank" | "classify_items" | "route_tool";
  status: "ok" | "fallback" | "error";
  latency_ms: number;
  candidate_count: number;
  returned_count: number;
  resolved_model?: string;
  provider?: string;
  input_tokens?: number;
  output_tokens?: number;
  cost_usd?: number;
  fallback_reason?: string;
};

export class Telemetry {
  readonly file: string;

  constructor(private readonly config: Config) {
    this.file = path.join(config.telemetryDir, "usage.jsonl");
  }

  async write(event: UsageEvent): Promise<void> {
    if (!this.config.telemetryEnabled) return;
    await mkdir(this.config.telemetryDir, { recursive: true, mode: 0o700 });
    await this.rotateIfNeeded();
    await appendFile(this.file, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  async todayCost(): Promise<number> {
    if (!this.config.telemetryEnabled) return 0;
    let body: string;
    try {
      body = await readFile(this.file, "utf8");
    } catch {
      return 0;
    }
    const today = new Date().toISOString().slice(0, 10);
    let total = 0;
    for (const line of body.split("\n")) {
      if (!line) continue;
      try {
        const event = JSON.parse(line) as UsageEvent;
        if (event.timestamp.startsWith(today)) total += event.cost_usd ?? 0;
      } catch {
        // Ignore malformed historical telemetry. It never affects tool output.
      }
    }
    return total;
  }

  private async rotateIfNeeded(): Promise<void> {
    try {
      if ((await stat(this.file)).size < 5 * 1024 * 1024) return;
    } catch {
      return;
    }
    for (let index = 3; index >= 1; index -= 1) {
      const source = index === 1 ? this.file : `${this.file}.${index - 1}`;
      const target = `${this.file}.${index}`;
      try {
        await rename(source, target);
      } catch {
        // Missing rotation segments are normal.
      }
    }
  }
}
