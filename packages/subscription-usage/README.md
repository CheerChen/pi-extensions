# pi-subscription-usage

Status-bar meter for the active provider's subscription usage, plus a `/quotas` command.

- Providers: Codex, Claude (account subscription windows), Grok.
- Status bar: `Claude 5h █████ 90% left ↻2h20m · wk …`; `~` marks a reading kept from the last success because the latest refresh failed.
- `/quotas` lists every provider; `/quotas refresh` skips the cache.
- Results are cached per provider under `~/.pi/agent/cache/sub-usage` (override with `PI_SUB_USAGE_CACHE_DIR`) and shared by all Pi processes, so N open sessions make at most one request per provider per TTL. A 429 backs every process off.
