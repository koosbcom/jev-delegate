# Jev Delegate for Codex and Claude Code

Jev Delegate gives Codex and Claude Code two local MCP tools: `search_and_rank` ranks large `rg` result sets, and `classify_items` assigns caller-defined labels to English text. Local search collects candidates; [TypeSafe Jev through OpenRouter](https://openrouter.ai/typesafe/jev-1.13) judges them. It cannot browse, write code, summarize, or act as a general subagent.

Each installation uses its own `OPENROUTER_API_KEY`. No key belongs in this repository or an agent prompt. OpenRouter may charge for requests.

## Install for Codex

Requires Node.js 20+, npm, `rg`, and Codex CLI. Get your own OpenRouter key from [OpenRouter](https://openrouter.ai/settings/keys).

```sh
git clone https://github.com/koosbcom/jev-delegate.git
cd jev-delegate
npm ci
npm run check
codex mcp add jev-delegate -- node "$PWD/dist/server.js"
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
cp -R skills/jev-delegate "${CODEX_HOME:-$HOME/.codex}/skills/"
```

Set the key in the environment that starts Codex. For a Codex CLI session, enter it without putting its value in shell history:

```sh
read -s OPENROUTER_API_KEY
export OPENROUTER_API_KEY
codex
```

For Codex desktop on macOS, set it for the app session, then restart Codex:

```sh
read -s OPENROUTER_API_KEY
launchctl setenv OPENROUTER_API_KEY "$OPENROUTER_API_KEY"
unset OPENROUTER_API_KEY
```

Start a new Codex task after installation. If your MCP client does not expose workspace roots, set `JEV_DELEGATE_WORKSPACE_ROOT` to the project directory in the Codex process environment. Check registration with `codex mcp list`.

## Install for Claude Code

Requires Node.js 20+, npm, `rg`, and Claude Code. Build once:

```sh
git clone https://github.com/koosbcom/jev-delegate.git
cd jev-delegate
npm ci
npm run check
```

Register the MCP server and the skill for every project:

```sh
claude mcp add --scope user jev_delegate -- node "$PWD/dist/server.js"
mkdir -p ~/.claude/skills
cp -R skills/jev-delegate ~/.claude/skills/
```

Or load the repository as a plugin for one session. `.claude-plugin/plugin.json` bundles the skill and the MCP server:

```sh
claude --plugin-dir /path/to/jev-delegate
```

Export `OPENROUTER_API_KEY` in the shell that starts `claude`, as shown above. Claude Code exposes the project directory as the MCP workspace root, so `JEV_DELEGATE_WORKSPACE_ROOT` is not needed. Check registration with `claude mcp list` or `/mcp`. Telemetry goes to the same `~/.codex/state/jev-delegate/usage.jsonl` path unless `JEV_DELEGATE_TELEMETRY_PATH` is set.

### Jev tool routing (Claude Code)

The plugin also installs a `PreToolUse` hook (`hooks/hooks.json` → `dist/route-hook.js`) that sends every tool call to Jev before it runs. Jev sees the latest user request, the proposed tool, and its input (truncated to 4,000 characters), and picks the best-suited tool:

- Jev keeps the proposed tool → no decision; normal Claude Code permissions apply. The hook never auto-approves.
- Jev picks another tool at confidence `>= 0.80` → the call is denied with a redirect, and Claude retries with Jev's tool. Repeating the same call afterwards asks the user instead of looping.
- Jev is unsure, unavailable (no key, timeout, spend guard), or the call looks secret-bearing → the user is asked.

Jev's own tools and task bookkeeping tools skip routing. Set `JEV_DELEGATE_ROUTING=off` to disable it, for example in headless `claude -p` runs without a key, where "ask" blocks the call. With the manual `claude mcp add` install, add the same hook to `~/.claude/settings.json`, replacing `${CLAUDE_PLUGIN_ROOT}` with the repository path. Routing adds one Jev request, with latency, to every tool call and counts toward the daily spend guard; raise `JEV_DELEGATE_MAX_DAILY_USD` for long sessions.

Opening this repository itself in Claude Code also offers the project `.mcp.json` server; it fails to start until `npm run build` has created `dist/`.

## When to use

- `search_and_rank`: more than 20 workspace search hits or roughly 4,000 raw-result tokens. Supply explicit literal or regex patterns and a relevance criterion.
- `classify_items`: many English items with 2–20 distinct labels and clear label criteria.
- Keep small, sensitive, non-English, and open-ended work with the main model.

The server returns confidence, cost metadata, and a bounded raw fallback if Jev fails. Treat decisions as evidence, not proof. The search tool reads only the current workspace, respects ignore rules, excludes common credential paths, and screens snippets for secret-like text. These filters are heuristic; review material before sending it to any external API.

Default spend guards are $0.01 per tool call and $0.25 per day. The server writes local metadata-only telemetry to `~/.codex/state/jev-delegate/usage.jsonl`; set `JEV_DELEGATE_TELEMETRY=off` to disable it. See `src/config.ts` for optional limits.

## Development

```sh
npm ci
npm run check
```

Offline tests and an MCP stdio test run in `npm run check`. An opt-in live test needs your own key: `npm run test:live`. The live API path has not yet been verified against a user's OpenRouter key, so API behavior may need adjustment.

## License

MIT. See [LICENSE](LICENSE).
