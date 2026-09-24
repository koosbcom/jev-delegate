import { describe, expect, it } from "vitest";
import { containsSecret, ensureInsideRoot, isDeniedRelativePath } from "../src/privacy.js";

describe("privacy guard", () => {
  it("blocks credential paths", () => {
    expect(isDeniedRelativePath(".env")).toBe(true);
    expect(isDeniedRelativePath("config/.env.production")).toBe(true);
    expect(isDeniedRelativePath("certs/client.pem")).toBe(true);
    expect(isDeniedRelativePath("src/app.ts")).toBe(false);
  });

  it("detects representative secrets", () => {
    expect(containsSecret("Authorization: Bearer abcdefghijklmnopqrstuvwxyz.1234")).toBe(true);
    expect(containsSecret("api_key=abcdefghijklmnopqrstuvwxyz123456")).toBe(true);
    expect(containsSecret("ordinary source code")).toBe(false);
  });

  it("rejects path traversal", () => {
    expect(() => ensureInsideRoot("/workspace", "/workspace/src/a.ts")).not.toThrow();
    expect(() => ensureInsideRoot("/workspace", "/workspace-other/a.ts")).toThrow(/escapes/);
    expect(() => ensureInsideRoot("/workspace", "/etc/passwd")).toThrow(/escapes/);
  });
});
