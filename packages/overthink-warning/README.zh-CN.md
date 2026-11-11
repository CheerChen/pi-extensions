# pi-overthink-warning

按每条回复的推理 token 数检测推理模型的 overthinking。渐进式提醒用户，不干预、不终止模型。

## 为什么需要

部分推理模型（DeepSeek V4/V4.1 Flash、GLM-5.3 Flash）在相同 effort level 下，推理量远大于正常模型。Prompt 工程无法控制这一点——推理预算由 API 的 `reasoning_effort` 参数硬性决定，prompt 里的"别想太多"对 reasoning_content 不起作用。

这个插件监控每条回复的推理量，在模型 overthinking 时提醒用户，让用户自行决定降级 effort 或切换模型。

## 指标

每条 assistant 回复的推理 token 数。可见的 thinking 文本在不同 provider 之间没法比：Claude 返回原始推理，OpenAI Responses 系只返回摘要（Codex 只有一句不到 200 字符的标题）加一段加密内容，按字符数永远不会对它们告警。`usage.reasoning` 则每家都报。

部分 OpenAI 兼容 provider 会对带着几千字符可见 thinking 的回复报 `reasoning: 0`，所以一条回复取两者中较大的：上报的 token 数，或可见 thinking 文本按 4 字符/token 折算。没有可见 thinking 的回复同样计入：Codex 和部分 GLM 回复有推理，但不返回任何文本。

## 工作原理

### 1. 单条回复（纵向深挖：一次推理特别长）

| 级别 | 推理 token | 正常回复中超过的比例 | 动作 |
|------|-----------|---------------------|------|
| warn | 4,000 | 0.2% | `ctx.ui.notify()`（黄色警告） |
| alert | 8,000 | 0.04% | `ctx.ui.notify()` + 状态栏 |
| critical | 12,000 | 仅一条 | `ctx.ui.notify()`（红色错误）+ 状态栏 |

### 2. 最近 20 条回复（横向铺开：很多条中等长度的推理）

| 级别 | 最近 20 条回复的推理 token 合计 | 动作 |
|------|-------------------------------|------|
| warn | 20,000 | `ctx.ui.notify()`（黄色警告） |
| alert | 30,000 | `ctx.ui.notify()` + 状态栏 |

用滑动窗口而不是 session 总量：总量随 session 长度增长，长的正常 session 迟早越过任何固定线（一个 515 条回复的 Claude session 累计到了 127k）。

插件只升级不降级——一旦在某一级别告警过，就不会再对同级或更低级别重复通知。它不会中断模型、不会 steer 对话、不会修改 reasoning content。提醒文案以 switch model 为主建议，因为部分模型（如 Devin 里的 DeepSeek V4/V4.1 Flash）最低只能 high，没有降级空间。

状态栏提醒 10 秒后自动消失。随时运行 `/overthink` 查看最大单条回复、当前窗口、session 总量和各级别。启动、reload、resume、fork 和 `/tree` 时，统计会从当前分支静默重算，不会为历史内容重复提醒。

## 阈值依据

来自本地 pi session，由 `scripts/token_baseline.py` 按与 `index.ts` 相同的规则回放。正常推理模型（GPT-5.6/6.1、Claude、GLM-5.2/5.3、Grok）对比 overthinking 模型（DeepSeek V4/V4.1 Flash、GLM-5.3 Flash）；不推理的变体（`gpt-6-luna`、`gpt-6-astra`）不计入。

| | 正常 | overthinking |
|---|---|---|
| 回复数 | 7,642 | 9,802 |
| 单条 p99 / p99.9 / 最大 | 2,120 / 6,054 / 19,749 | 3,966 / 10,190 / 29,073 |
| session 最大窗口 p95 / 最大 | 13,542 / 28,252 | 44,082 / 50,839 |
| 收到任一提醒的 session | 157 个中 12 个 | 70 个中 32 个 |

按单条回复看两组有重叠：GPT-5.6 Luna 的推理量和 Flash 模型相当，正常模型的提醒大多来自 Luna session。未收到提醒的 38 个 overthinking 模型 session 大多是回复都很短的长 GLM-5.3 Flash session；它们是按模型归类的，不是按行为。

## 安装

```bash
pi install npm:pi-overthink-warning
```

或本地测试：

```bash
pi -e /path/to/pi-extensions/packages/overthink-warning/index.ts
```

## 权限

本插件只读取 assistant 消息（usage 和思考块）并使用 `ctx.ui` 发送通知。不写文件、不访问网络、不执行命令。

## 脚本

- `token_baseline.py` — 推导并回放上面的阈值
- `analyze_overthinking.py`、`batch_scan.py`、`incident_rate.py` — 最初判定哪些模型 overthinking 的按模型分析

## License

MIT
