# pi-overthink-warning

监控推理模型的思考块大小，检测 overthinking。渐进式提醒用户，不干预、不终止模型。

## 为什么需要

部分推理模型（DeepSeek V4/V4.1 Flash、GLM-5.3 Flash）在相同 effort level 下，产生的思考块远大于正常模型。Prompt 工程无法控制这一点——推理预算由 API 的 `reasoning_effort` 参数硬性决定，prompt 里的"别想太多"对 reasoning_content 不起作用。

这个插件实时监控思考块大小，在模型 overthinking 时提醒用户，让用户自行决定降级 effort 或切换模型。

## 工作原理

插件监控两种 overthinking 模式：

### 1. 纵向深挖（单个超大块）

每次 assistant `message_end` 时，插件测量消息中最大的思考块长度，与三级阈值对比：

| 级别 | 阈值 | 含义 | 动作 |
|------|------|------|------|
| warn | 5,000 字符 | 超过正常模型 p95（2,608） | `ctx.ui.notify()`（黄色警告） |
| alert | 8,000 字符 | 超过正常模型 p99（6,672） | `ctx.ui.notify()` + 持续状态栏 |
| critical | 12,000 字符 | 确认 overthinking | `ctx.ui.notify()`（红色错误）+ 持续状态栏 |

### 2. 横向铺开（块多但都小，累积量大）

部分模型不产生单个超大块，而是把 overthinking 分散到很多小块里。插件追踪 session 累计块数和总字符数：

| 级别 | 块数 | 总字符 | 动作 |
|------|------|--------|------|
| warn | 50+ | 或 50,000+ | `ctx.ui.notify()`（黄色警告） |
| alert | 80+ | 或 100,000+ | `ctx.ui.notify()` + 持续状态栏 |

任一指标触发阈值就告警。

插件只升级不降级——一旦在某一级别告警过，就不会再对同级或更低级别重复通知。它不会中断模型、不会 steer 对话、不会修改 reasoning content。

### 提醒文案

**单块 warn（5,000+）**：
```
Thinking block {n} chars. Normal models stay under 5000 (p95). May be overthinking — consider switching model or lowering reasoning effort if available.
```

**单块 alert（8,000+）**：
```
Thinking block {n} chars. Normal models stay under 8000 (p99). Likely overthinking at current effort level. Switch model or lower reasoning effort if available.
```

**单块 critical（12,000+）**：
```
Thinking block {n} chars. Over 12000 confirmed overthinking. Switch model now or lower reasoning effort if available.
```

**横向铺开 warn（50 块或 50k 字符）**：
```
Session total {blocks} thinking blocks ({total} chars). Horizontal spread — may be overthinking. Consider switching model or lowering reasoning effort if available.
```

**横向铺开 alert（80 块或 100k 字符）**：
```
Session total {blocks} thinking blocks ({total} chars). Horizontal spread — likely overthinking at current effort level. Switch model or lower reasoning effort if available.
```

文案以 switch model 为主建议，因为部分模型（如 Devin 里的 DeepSeek V4/V4.1 Flash）最低只能 high，没有降级空间。

## 阈值依据

基于 260 个 session 的分析，对比正常推理模型（GPT-5.6、GLM-5.2、Claude Opus 4.8）与 overthinking 模型（DeepSeek V4/V4.1 Flash、GLM-5.3 Flash）：

### 纵向深挖（单块大小）

- 正常模型 session 平均最大块：3,936 字符
- 问题模型 session 平均最大块：19,045 字符（4.8 倍）
- 正常模型思考块：p95 = 2,608 字符，p99 = 6,672 字符

在 5,000 字符时，只有 1.56% 的正常模型块会触发（1/64）。在 12,000 字符时，只有 0.37% 的正常模型块会触发（1/270）。

### 横向铺开（累积量）

- 正常模型平均每 session：25-35 块，5k-35k 字符
- 问题模型平均每 session：58-88 块，129k-281k 字符

50 块 / 50k 字符是正常模型的上界；80 块 / 100k 字符已进入问题模型区间。

## 安装

```bash
pi install npm:pi-overthink-warning
```

或本地测试：

```bash
pi -e /path/to/pi-overthink-warning/extensions/index.ts
```

## 权限

本插件只读取消息内容（思考块）并使用 `ctx.ui` 发送通知。不写文件、不访问网络、不执行命令。

## 脚本

`scripts/` 目录包含用于阈值分析的脚本：

- `analyze_overthinking.py` — 单 session 特征提取
- `batch_scan.py` — 批量扫描 pi + devin session，按模型分组算指标
- `incident_rate.py` — 合并模型，计算问题率

## License

MIT
