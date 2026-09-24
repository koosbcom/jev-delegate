import path from "node:path";

const DENIED_PARTS = new Set([
  ".git",
  ".env",
  ".ssh",
  ".aws",
  ".gnupg",
  "credentials",
  "secrets",
  "id_rsa",
  "id_ed25519",
]);

const DENIED_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx", ".jks", ".keystore"]);

const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i,
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{20,}\b/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bgh[opusr]_[A-Za-z0-9]{30,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*["']?[A-Za-z0-9_./+\-=]{12,}/i,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{16,}=*\b/i,
];

export function isDeniedRelativePath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/");
  const parts = normalized.split("/").map((part) => part.toLowerCase());
  if (parts.some((part) => DENIED_PARTS.has(part) || part.startsWith(".env."))) return true;
  return DENIED_EXTENSIONS.has(path.extname(normalized).toLowerCase());
}

export function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

export function ensureInsideRoot(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    return;
  }
  throw new Error("Resolved path escapes workspace root");
}
