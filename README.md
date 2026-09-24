# Jev Delegate for Codex

Jev Delegate gives Codex two local MCP tools: `search_and_rank` ranks large `rg` result sets, and `classify_items` assigns caller-defined labels to English text. Local search collects candidates; [TypeSafe Jev through OpenRouter](https://openrouter.ai/typesafe/jev-1.13) judges them. It cannot browse, write code, summarize, or act as a general subagent.

Each installation uses its own `OPENROUTER_API_KEY`. No key belongs in this repository or a Codex prompt. OpenRouter may charge for requests.

## Install

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
