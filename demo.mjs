// 演示：模拟 agent 连续读 150 个大文件，打印每次压缩前后的上下文大小。不联网、不要 key。
import { runAgent } from './src/agent-loop.mjs';
import { mockAgentLlm, mockSummarizer, bigFileTool } from './src/mock.mjs';

const WINDOW = 30_000;
const r = await runAgent({
    llm: mockAgentLlm({ steps: 150 }),
    summarize: mockSummarizer(),
    system: '你是代码审查助手',
    goal: '读完 src 下 150 个文件，汇总每个文件的超时配置',
    tools: { read_file: bigFileTool({ chars: 6000 }) },
    maxSteps: 200,
    compactOptions: { window: WINDOW },
    onStep: (s) => {
        if (s.level) console.log(`第 ${String(s.step).padStart(3)} 步  L${s.level}  ${s.tokensBefore} → ${s.tokensAfter} token（窗口 ${WINDOW}）  ${s.actions.filter((a) => !a.startsWith('L1 归档')).join('；') || `${s.actions.length} 个工具结果归档`}`);
    },
});
const peak = Math.max(...r.log.map((s) => s.tokensAfter));
console.log(`\n完成：${r.steps} 步，压缩后上下文峰值 ${peak} token（${((peak / WINDOW) * 100).toFixed(0)}% 窗口），归档 ${r.archive.items.length} 条`);
console.log(`召回测试 recall_archive("handler3") →\n${r.archive.recall('handler3').slice(0, 120)}…`);
