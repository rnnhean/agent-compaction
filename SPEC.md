# SPEC — 设计契约

> 代码与本文不一致时，先改文档或先改代码，不能两边各说各的。

## 1. 目标与非目标

### 目标

1. **不溢出**：任意长度会话，实际发给模型的上下文永远不超过窗口。
2. **不丢目标**：压缩后 agent 仍知道自己要做什么。
3. **可找回**：被移出上下文的内容可以通过归档按 ID 或关键词召回。
4. **可证明**：行为由测试和评测钉死，能用数字说明「压了多少、损失了什么」。
5. **可部署**：能作为库嵌入，也能作为 sidecar 服务对外提供；有健康检查和指标。

### 非目标

- 语义检索（本版是关键词计数）
- 多租户、鉴权、分布式
- 摘要质量本身（由摘要模型决定，本项目只保证格式与不变量）
- 多模态内容（图片、音频）

## 2. 数据模型

消息采用 Anthropic Messages API 形状：

```ts
type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: object }
  | { type: 'tool_result'; tool_use_id: string; content: string | Block[] }
  | { type: 'thinking'; thinking: string }      // 只读；stripThinking 时丢弃

interface Message { role: 'user' | 'assistant'; content: string | Block[] }
```

**组（Group）**：一条 assistant 消息 + 紧随的 tool_result 消息构成不可拆分的单位。压缩以组为单位。

```ts
interface CompactionReport {
  before: number;          // 压缩前估算（含 overhead）
  after: number;           // 压缩后估算（含 overhead）
  level: 0 | 1 | 2 | 3;    // 本次实际达到的最高级别
  overhead: number;        // 校准差额
  actions: string[];       // 人可读的处理记录（不含凭据）
}
```

## 3. 分级策略

| 级别 | 触发条件 | 行为 | 信息 | 必须归档 |
|---|---|---|---|---|
| L0 | 单条工具结果 > `maxToolResultChars` | 入场截断 | 可召回 | 是 |
| L1 | 估算 ≥ `window × softRatio`（默认 0.6） | 较早组的工具结果移入归档，原地留 `toolResultKeepChars`（默认 600）字 + 归档 ID | 可召回 | 是 |
| L2 | 估算 ≥ `window × hardRatio`（默认 0.75）且组数 > `keepRecentGroups + 1` | 较早各组 → 五段式摘要；原文归档 | 有损 | 是 |
| L3 | 估算 ≥ `window × emergencyRatio`（默认 0.92） | 只保留目标 + 最近若干组；被丢弃组先归档 | 有损 | **必须** |

不变量（测试逐条覆盖）：

1. `messages[0]` 是任务目标，任何级别不得删除或改写其正文（只允许追加摘要块）。
2. `tool_use.id` 与 `tool_result.tool_use_id` 一一对应，不得分批丢弃。
3. 输出消息角色交替，首条为 `user`。

## 4. 摘要格式

```
[COMPACT_SUMMARY]
## 目标
## 已完成
## 待办
## 关键事实
## 失败的尝试
[/COMPACT_SUMMARY]
```

- 五段缺一即无效，重试 1 次；仍无效则放弃 L2，交由 L3。
- `## 关键事实` 必须写原值（ID、路径、数字），不写概括。
- 上一轮摘要中仍成立的事实必须保留。
- 输入摘要模型前一律 `redact()`。

## 5. Token 估算与校准

```
estimate(s) = CJK 字符数 × 1 + 其余字符数 / 4
messagesTokens = estimate(system) + Σ(4 + estimate(content))
```

校准：

```
差额观测 = 真实 input_tokens − 本轮估算
overhead = EMA(差额, α=0.3)，夹在 ±20000
判定用值 = 估算 + overhead
```

- 用**差额**而非比率：工具定义/网关注入是每轮恒定的常数开销。
- 首轮 overhead = 0（退化为纯估算）。
- 校准只参与阈值判定，不修改消息内容。

## 6. 归档

```ts
interface ArchiveItem { id: string; kind: string; text: string; at: string }
put(kind, text): string      // 返回 ID，ID 单调递增，永不回收
recall(query, {maxChars, k}): string
```

- `maxItems` 默认 20000；超出时丢弃最旧条目，`recalled` 已丢弃 ID 时明确返回「已清理」。
- 条目写入前 `redact()`。
- 传文件路径则 JSONL 持久化，进程重启后可召回。

## 7. 循环

```
for step in 1..maxSteps:
  compact(messages)
  resp = llm(system, messages, tools)
  messages += assistant(resp.content 去掉 thinking（可选）)
  用 resp.usage 校准
  if 无 tool_use 或 stop_reason == end_turn: 返回
  messages += tool_results（每个都过 L0 截断）
超出 maxSteps：返回 done=false
```

## 8. 服务接口

| 方法 | 路径 | 入参 | 出参 |
|---|---|---|---|
| GET | `/health` | — | `{ok, version, summaryEnabled, archiveItems, uptimeSec}` |
| GET | `/metrics` | — | Prometheus 文本 |
| POST | `/compact` | `{messages, window?, softRatio?, ...}` | `{messages, report, summaryDisabled}` |
| POST | `/recall` | `{query, maxChars?}` | `{result}` |

约束：请求体 ≤ 8MB；无鉴权（内网 sidecar）；未配置摘要模型时 L2 跳过并在响应中标注。

## 9. 指标

| 指标 | 类型 | 含义 |
|---|---|---|
| `agent_compaction_requests_total` | counter | 请求数 |
| `agent_compaction_errors_total` | counter | 失败数 |
| `agent_compaction_level_total{level}` | counter | 各档触发数 |
| `agent_compaction_tokens_before_total` | counter | 压缩前累计 |
| `agent_compaction_tokens_after_total` | counter | 压缩后累计 |
| `agent_compaction_duration_seconds_sum/_count` | counter | 耗时 |
| `agent_archive_items` | gauge | 归档条目数 |
| `agent_uptime_seconds` | gauge | 运行时长 |

## 10. 评测

场景（真实模型，禁止 mock）：

| id | 轮数 | 工具结果大小 | 窗口 | 期望压缩 |
|---|---:|---:|---:|---|
| short | 2 | 800 | 40000 | 否 |
| medium | 6 | 2500 | 6000 | 是 |
| long | 10 | 2500 | 4000 | 是 |

判定（全部满足才算通过）：

1. 压缩后峰值 ≤ 窗口 × 95%
2. `done === true`
3. 压缩是否按预期发生
4. 有归档时，早期事实（`handler1`）仍可召回

## 11. 验收标准

外部的人不需要额外解释，就能：

1. `npm test` 全绿
2. `npm run demo` 看到 151 步的分级压缩日志
3. `npm run eval` 得到 3/3 通过并写出 results
4. `docker build && docker run` 后 `/health` 返回 ok
5. `/metrics` 在请求后数值增长
6. 用真实模型跑通 `npm run demo:live`
