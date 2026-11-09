# pi-extensions

Extensions for the [pi](https://github.com/earendil-works/pi) coding agent, one package per directory under `packages/`.

| Package | What it does |
|---|---|
| [`overthink-warning`](packages/overthink-warning) | Warns when thinking blocks get too large or too many; `/overthink` shows the distance to each line |
| [`subscription-usage`](packages/subscription-usage) | Status-bar meter and `/quotas` for Codex, Claude and Grok subscription usage |

Load everything from a checkout by adding the repo root to `packages` in pi's `settings.json`; the root manifest globs `packages/*/index.ts`. To load one, point at its package directory.

TypeScript is loaded directly by pi (jiti); there is no build step.
