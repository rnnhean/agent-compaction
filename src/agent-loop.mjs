/**
 * 最小 agent 循环：调模型 → 执行工具 → 追加结果 → 下一轮。每轮调模型前先 compact()。
 *
 * llm(request) => Promise<{ content: Block[], stop_reason, usage? }>，形状同 Anthropic Messages API。
 * tools: { [name]: { description, input_schema, run: async (input) => string } }
 */
import { compact, DEFAULTS } from './compactor.mjs';
import { Archive } from './archive.mjs';
import { messagesTokens, TokenCalibrator } from './tokens.mjs';

/** L0：工具结果进上下文前先截断。超长部分直接归档，模型只看到开头 + 归档 ID */
export function admitToolResult(text, archive, maxChars) {
    const s = String(text);
    if (s.length <= maxChars) return s;
    const id = archive.put('tool_result:oversize', s);
    return `${s.slice(0, maxChars)}…\n[结果共 ${s.length} 字，超过 ${maxChars} 字已截断，全文归档为 ${id}，需要时调用 recall_archive("${id}")]`;
}

export async function runAgent({
    llm,
    summarize,                 // 摘要用的模型调用，可以和主模型不同（便宜的小模型）
    system,
    goal,
    tools = {},
    maxSteps = 50,
    maxToolResultChars = 20_000,
    compactOptions = {},
    archive = new Archive(),
    calibrator = new TokenCalibrator(),
    // 是否把上一轮的 thinking 块从历史里去掉。
    // thinking 是模型的草稿纸，只在「本轮」有意义；留在历史里会让每轮都多带一份，
    // 长循环下是最大的隐性开销。默认 false（保守），评测里开 true 验证兼容性。
    stripThinking = false,
    onStep = () => {},
}) {
    const allTools = {
        ...tools,
        recall_archive: {
            description: '按归档 ID（如 A3）或关键词，取回之前被移出上下文的原文',
            input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
            run: async ({ query }) => archive.recall(query),
        },
    };
    const toolDefs = Object.entries(allTools).map(([name, t]) => ({ name, description: t.description, input_schema: t.input_schema }));
    const sys = `${system}\n\n上下文会被自动压缩：较早的工具结果和交互会被归档，原地留下归档 ID 或摘要。需要原文时调用 recall_archive。`;

    let messages = [{ role: 'user', content: goal }];
    const log = [];
    let usageTotal = { input: 0, output: 0 };

    for (let step = 1; step <= maxSteps; step++) {
        const { messages: compacted, report } = await compact(messages, {
            ...DEFAULTS,
            ...compactOptions,
            system: sys,
            archive,
            summarize,
            // 校准差额来自上一轮的真实 usage；首轮为 0，退化为纯估算
            overhead: calibrator.overhead,
        });
        messages = compacted;

        // 估算必须取「这一轮实际发出去的请求」，不能用追加了回复之后的消息，
        // 否则会把模型回复的长度算进差额里，校准方向反掉
        const requestEstimated = messagesTokens(messages, sys);
        const res = await llm({ system: sys, messages, tools: toolDefs });
        const keepBlocks = stripThinking ? res.content.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking') : res.content;
        messages.push({ role: 'assistant', content: keepBlocks });

        // 用真实 usage 校准估算：只影响「何时压缩」的判断，不改任何内容
        if (res.usage?.input_tokens) {
            calibrator.observe(requestEstimated, res.usage.input_tokens);
            usageTotal.input += res.usage.input_tokens;
            usageTotal.output += res.usage.output_tokens || 0;
        }

        const uses = res.content.filter((b) => b.type === 'tool_use');
        const entry = {
            step,
            tokensBefore: report.before,
            tokensAfter: report.after,
            level: report.level,
            actions: report.actions,
            tools: uses.map((u) => u.name),
            usage: res.usage || null,
            overhead: Math.round(calibrator.overhead),
        };
        log.push(entry);
        onStep(entry);

        if (!uses.length || res.stop_reason === 'end_turn') {
            const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
            return { done: true, steps: step, answer: text, messages, log, archive, usage: usageTotal, calibration: calibrator.toJSON() };
        }

        const results = [];
        for (const u of uses) {
            const t = allTools[u.name];
            let content;
            try {
                content = t ? await t.run(u.input) : `未知工具 ${u.name}`;
            } catch (e) {
                content = `工具出错: ${e.message}`;
            }
            results.push({ type: 'tool_result', tool_use_id: u.id, content: admitToolResult(content, archive, maxToolResultChars) });
        }
        messages.push({ role: 'user', content: results });
    }
    return { done: false, steps: maxSteps, answer: '', messages, log, archive, usage: usageTotal, calibration: calibrator.toJSON(), tokens: messagesTokens(messages, sys) };
}
