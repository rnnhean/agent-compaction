import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../src/agent-loop.mjs';
import { mockAgentLlm, mockSummarizer, bigFileTool } from '../src/mock.mjs';
import { messagesTokens } from '../src/tokens.mjs';

test('agent 跑 200 步：每一步发给模型的上下文都在窗口内，最终完成', async () => {
    const window = 30_000;
    const sizes = [];
    // 包一层，记录模型实际收到的上下文大小
    const inner = mockAgentLlm({ steps: 200 });
    const llm = async (req) => {
        sizes.push(messagesTokens(req.messages, req.system));
        return inner(req);
    };
    const r = await runAgent({
        llm,
        summarize: mockSummarizer(),
        system: '你是代码审查助手',
        goal: '读完 src 下 200 个文件，汇总每个文件的超时配置',
        tools: { read_file: bigFileTool({ chars: 6000 }) },
        maxSteps: 300,
        compactOptions: { window },
    });
    assert.ok(r.done, '应该正常结束');
    assert.equal(r.steps, 201);
    const max = Math.max(...sizes);
    assert.ok(max < window * 0.92, `最大上下文 ${max} 超过了红线 ${window * 0.92}`);
    assert.ok(r.log.some((s) => s.level === 2), '过程中应发生过 L2 摘要');
    assert.ok(!r.log.some((s) => s.level === 3), '摘要正常时不应走到 L3');
});

test('recall_archive：被归档的原文能按关键词取回', async () => {
    const r = await runAgent({
        llm: mockAgentLlm({ steps: 40 }),
        summarize: mockSummarizer(),
        system: 's',
        goal: 'g',
        tools: { read_file: bigFileTool({ chars: 6000 }) },
        compactOptions: { window: 30_000 },
    });
    const hit = r.archive.recall('handler3');
    assert.match(hit, /handler3，超时 300ms/);
});

test('工具结果在进上下文前就截断（L0）', async () => {
    let seen = '';
    const llm = async ({ messages }) => {
        const last = messages[messages.length - 1];
        if (Array.isArray(last.content) && last.content[0].type === 'tool_result') {
            seen = last.content[0].content;
            return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] };
        }
        return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'big1.js' } }] };
    };
    await runAgent({ llm, summarize: mockSummarizer(), system: 's', goal: 'g', tools: { read_file: bigFileTool({ chars: 50_000 }) }, maxToolResultChars: 5000 });
    assert.ok(seen.length < 5300, `模型看到了 ${seen.length} 字`);
    assert.match(seen, /已截断，全文归档为 A1/);
});
