---
name: jev-delegate
description: Reduce parent-model tokens by using Jev for English bulk classification and ranking many deterministic workspace search hits. Use when search produces over 20 candidates or roughly 4K raw-result tokens, or when classifying many supplied items into fixed labels. Do not use for prose, code, summaries, semantic retrieval, unknown-value extraction, sensitive data, or non-English content.
---

# Jev delegate

Delegate narrow decisions. Jev judges supplied evidence; it does not retrieve or generate.

## Route

- For workspace search, create explicit literal or regex patterns plus one relevance criterion. Call `search_and_rank` when raw results would exceed 20 candidates or about 4K tokens.
- For bulk categorization, define 2-20 mutually distinct labels and criteria. Call `classify_items` with stable item IDs.
- Handle smaller jobs directly. Keep generative, ambiguous, high-impact, sensitive, and non-English work in the parent model.

## Consume results

- Treat `included` or `classified` at `>=0.80` as usable evidence, not ground truth.
- Inspect `uncertain` results before acting. The server drops search relevance below `0.50`.
- On `fallback`, continue with parent tools/model using bounded raw matches or original items. State the fallback when it affects coverage.
- Preserve `truncated` warnings. Narrow patterns or continue deliberately; never imply full coverage.
- Never infer explanations from Jev probabilities. Report only labels, rankings, supplied evidence, and uncertainty.

## Tool routing

In Claude Code the plugin hook routes every tool call through Jev first. When a call is denied with "Jev routed this action to X", retry the same action with X. Repeat the original call only when X cannot do the job; the user is then asked.

## Boundaries

Tools are read-only and limited to the current workspace. They exclude ignored, hidden, binary, credential, key, and secret-like content. A user request for `local only` disables Jev for that task.
