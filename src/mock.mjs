/**
 * 模拟模型：不联网、不要 key，用来验证压缩逻辑本身。
 *
 * mockAgentLlm：按脚本调用工具 N 次，最后回答。
 * mockSummarizer：确定性的「摘要器」——从记录里抽出「事实:」行，按固定格式输出。
 *   它验证的是管道（摘要有没有被正确放回、旧摘要的事实有没有被继承、凭据有没有被挡住），
 *   不是摘要质量。摘要质量要用真实模型 + 评测集验证，见 README。
 */
export function mockAgentLlm({ steps = 30, tool = 'read_file' } = {}) {
    let n = 0;
    return async ({ messages }) => {
        n++;
        if (n > steps) {
            return { stop_reason: 'end_turn', content: [{ type: 'text', text: `完成，共 ${steps} 步，最终上下文 ${messages.length} 条消息` }] };
        }
        return {
            stop_reason: 'tool_use',
            content: [
                { type: 'text', text: `第 ${n} 步：读取下一个文件` },
                { type: 'tool_use', id: `tu_${n}`, name: tool, input: { path: `src/file${n}.js` } },
            ],
        };
    };
}

export function mockSummarizer({ failTimes = 0, badFormatTimes = 0 } = {}) {
    let calls = 0;
    const fn = async (prompt) => {
        calls++;
        fn.prompts.push(prompt);
        if (calls <= failTimes) throw new Error('摘要模型超时（模拟）');
        if (calls <= failTimes + badFormatTimes) return '好的，这是摘要：做了很多事。';
        const facts = [...new Set(prompt.match(/事实:[^\n]*/g) || [])].map((f) => f.slice(3).trim());
        // 继承上一次摘要的关键事实（真实模型靠 prompt 里「仍然成立的必须保留」这条规则做到）
        const prev = prompt.split('【上一次的摘要】')[1]?.split('【要压缩的交互记录】')[0] || '';
        const prevFacts = (prev.split('## 关键事实')[1]?.split('##')[0] || '').split('\n').filter((l) => l.startsWith('- ') && l !== '- 无').map((l) => l.slice(2));
        facts.unshift(...prevFacts.filter((f) => !facts.includes(f)));
        const goal = (prev.match(/## 目标\n([^\n]+)/) || prompt.match(/user: ([^\n]+)/) || [, '（未知）'])[1];
        return `[COMPACT_SUMMARY]
## 目标
${goal}
## 已完成
- 读取了若干文件
## 待办
- 继续读取剩余文件
## 关键事实
${facts.map((f) => `- ${f}`).join('\n') || '- 无'}
## 失败的尝试
- 无
[/COMPACT_SUMMARY]`;
    };
    fn.prompts = [];
    return fn;
}

/** 模拟工具：每次返回一大段内容，里面夹一条可验证的事实，偶尔夹一个假凭据 */
export function bigFileTool({ chars = 8000, secretEvery = 7 } = {}) {
    return {
        description: '读取文件内容',
        input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        run: async ({ path }) => {
            const n = Number((path.match(/\d+/) || [0])[0]);
            const secret = n % secretEvery === 0 ? `\nconst config = { api_key: "sk-FAKE${'x'.repeat(24)}${n}" };\n` : '';
            return `// ${path}\n事实: ${path} 导出函数 handler${n}，超时 ${n * 100}ms\n${secret}${'// 填充代码行 '.repeat(Math.ceil(chars / 8)).slice(0, chars)}`;
        },
    };
}
