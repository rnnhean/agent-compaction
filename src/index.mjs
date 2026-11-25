/**
 * agent-compaction 对外入口。
 *
 * 库用法（推荐）：
 *   import { compact, runAgent, Archive, TokenCalibrator } from 'agent-compaction';
 *
 * 服务用法（非 Node 的 agent 也能用）：
 *   node src/server.mjs   # 见 README「服务模式」
 */
export { compact, DEFAULTS, toGroups, normalize, readSummary, summaryPrompt, validSummary } from './compactor.mjs';
export { runAgent, admitToolResult } from './agent-loop.mjs';
export { Archive } from './archive.mjs';
export { estimateTokens, messagesTokens, TokenCalibrator } from './tokens.mjs';
export { redact } from './redact.mjs';
export { anthropicLlm, asSummarizer } from './llm-anthropic.mjs';
