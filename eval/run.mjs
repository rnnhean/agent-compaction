/**
 * 评测（真实模型）。不使用任何 mock。
 *
 * 评测的不是「模型答得好不好」，而是压缩这个机制是否守住了三条底线：
 *   1. 压缩后真正发给模型的上下文不超过窗口（否则真实 API 直接 400）
 *   2. 任务仍然能跑完
 *   3. 被归档的内容还能按关键词召回
 *
 * 每个场景跑两种配置：
 *   baseline   —— 窗口开到无限，不压缩，用来看「不压缩会到什么程度」
 *   compacted  —— 窗口设成场景值，触发分级压缩
 *
 * 为了让每个场景真的产生 N 轮工具调用（而不是赌模型自觉），前 N 次请求用
 * tool_choice 强制调用 read_file；第 N+1 次放开，让模型给最终答复。
 *
 * 用法：
 *   node eval/run.mjs                # 全部场景
 *   node eval/run.mjs --only=long
 *   AGENT_ENV_FILE=... node eval/run.mjs
 * 退出码：任一判定失败 = 1。真实调用会产生费用，场景规模刻意压得很小。
 */
import fs from 'node:fs';
import path from 'node:path';

import { runAgent } from '../src/agent-loop.mjs';
import { Archive } from '../src/archive.mjs';
import { anthropicLlm, asSummarizer } from '../src/llm-anthropic.mjs';
import { loadEnvFile, mapAnthropicToLlm } from '../scripts/load-env.mjs';

const SCENARIOS = [
    // 窗口取现实值（真实模型 128k–200k，这里用 40k/16k 已足够小）。
    // 不要用 4k 这种窗口：工具定义 + 系统提示本身就是固定开销，
    // 窗口比开销还小时，压缩在数学上不可能达标，测出来的只是「窗口设错了」。
    { id: 'short', rounds: 2, size: 800, window: 40_000, expectCompact: false, note: '短任务，不该触发压缩' },
    { id: 'medium', rounds: 6, size: 8_000, window: 16_000, expectCompact: true, note: '中等长度，应触发 L1/L2' },
    { id: 'long', rounds: 10, size: 12_000, window: 16_000, expectCompact: true, note: '长任务，应触发 L1/L3' },
];

const env = loadEnvFile();
if (!env.ok) {
    console.error(env.reason);
    process.exit(2);
}
const mapped = mapAnthropicToLlm();
if (!mapped.ok) {
    console.error(mapped.reason);
    process.exit(2);
}

const base = anthropicLlm({
    model: process.env.ANTHROPIC_MODEL,
    baseUrl: process.env.LLM_BASE_URL,
    keyEnv: 'LLM_API_KEY',
    maxTokens: 2048,
});
const summarize = asSummarizer(base);

/** 前 rounds 次强制调工具；之后明确要求收尾，避免模型继续调工具把步数耗光 */
function forcedToolLlm(rounds) {
    let calls = 0;
    return async (req) => {
        calls++;
        if (calls <= rounds) {
            return base({ ...req, toolChoice: { type: 'tool', name: 'read_file' } });
        }
        return base({
            ...req,
            system: `${req.system}\n\n【重要】文件已全部读完，不要再调用任何工具，直接用一句话总结。`,
        });
    };
}

function bigFileTool(chars) {
    return {
        description: '读取仓库里的一个文件，返回其完整内容',
        input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        run: async ({ path: p }) => {
            const n = Number(String(p).match(/\d+/)?.[0] || 1);
            return `// ${p}\n事实: 文件 ${p} 导出了 handler${n}，超时 ${n * 100}ms，依赖 module${n}\n${'// 代码行 '.repeat(Math.ceil(chars / 6)).slice(0, chars)}`;
        },
    };
}

async function runOne({ rounds, size, window, compact }) {
    const archive = new Archive();
    const levels = { 0: 0, 1: 0, 2: 0, 3: 0 };
    let peakAfter = 0;
    let peakBefore = 0;

    const r = await runAgent({
        llm: forcedToolLlm(rounds),
        summarize,
        system: '你是代码审查助手。必须逐个读取文件，读完后用一句话总结。',
        goal: `把仓库里的文件逐个读完（共 ${rounds} 个），最后给一句总结。`,
        tools: { read_file: bigFileTool(size) },
        maxSteps: rounds + 3,
        maxToolResultChars: 200_000,
        archive,
        stripThinking: true,
        compactOptions: compact
            ? { window, softRatio: 0.5, hardRatio: 0.7, emergencyRatio: 0.9, keepRecentGroups: 3, toolResultKeepChars: 300 }
            : { window: 10_000_000 },
        onStep: (e) => {
            levels[e.level] = (levels[e.level] || 0) + 1;
            peakBefore = Math.max(peakBefore, e.tokensBefore);
            peakAfter = Math.max(peakAfter, e.tokensAfter);
        },
    });

    const recall = archive.recall('handler1', { maxChars: 300 });
    const recallOk = recall.includes('handler1') && !/没有找到|已被清理/.test(recall);
    return {
        done: r.done,
        steps: r.steps,
        peak: peakAfter,
        peakBefore,
        levels,
        archiveItems: archive.items.length,
        inputTokens: r.usage.input,
        outputTokens: r.usage.output,
        answer: r.answer,
        recallOk,
    };
}

const only = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1];
const list = only ? SCENARIOS.filter((s) => s.id === only) : SCENARIOS;

const rows = [];
let failed = 0;

for (const s of list) {
    const base_ = await runOne({ ...s, compact: false });
    const comp = await runOne({ ...s, compact: true });

    const withinWindow = comp.peak <= s.window * 0.95;
    const finished = comp.done === true;
    const compacted = comp.levels[1] + comp.levels[2] + comp.levels[3] > 0;
    const triggerOk = s.expectCompact ? compacted : !compacted;
    const recallOk = comp.archiveItems === 0 ? null : comp.recallOk;
    const pass = withinWindow && finished && triggerOk && recallOk !== false;
    if (!pass) failed++;

    rows.push({ s, base: base_, comp, withinWindow, finished, triggerOk, pass });
    console.log(
        `${pass ? '✅' : '❌'} ${s.id.padEnd(7)} ` +
        `不压缩峰值 ${String(base_.peak).padStart(7)} → 压缩后峰值 ${String(comp.peak).padStart(7)} ` +
        `(窗口 ${s.window})  档位 ${JSON.stringify(comp.levels)}  归档 ${comp.archiveItems}  ` +
        `召回 ${recallOk === null ? 'N/A' : (recallOk ? 'OK' : 'FAIL')}  ` +
        `预期 ${triggerOk ? 'OK' : 'FAIL'}  完成 ${finished ? 'OK' : 'FAIL'}  ` +
        `真实用量 输入${comp.inputTokens} 输出${comp.outputTokens}`,
    );
}

const outDir = path.resolve('results');
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
fs.writeFileSync(path.join(outDir, `eval-${stamp}.json`), JSON.stringify(rows.map((r) => ({
    scenario: r.s.id,
    window: r.s.window,
    baselinePeak: r.base.peak,
    compactedPeak: r.comp.peak,
    levels: r.comp.levels,
    archiveItems: r.comp.archiveItems,
    recallOk: r.comp.recallOk,
    finished: r.finished,
    withinWindow: r.withinWindow,
    triggerOk: r.triggerOk,
    pass: r.pass,
    usage: { input: r.comp.inputTokens, output: r.comp.outputTokens },
})), null, 2));

const md = [
    `# 评测结果 ${new Date().toISOString().slice(0, 19)}（真实模型）`,
    '',
    '| 场景 | 窗口 | 不压缩峰值 | 压缩后峰值 | 触发档位 | 归档 | 召回 | 预期 | 完成 | 通过 |',
    '|---|---:|---:|---:|---|---:|---|---|---|---|',
    ...rows.map((r) => `| ${r.s.id} | ${r.s.window} | ${r.base.peak} | ${r.comp.peak} | ${JSON.stringify(r.comp.levels)} | ${r.comp.archiveItems} | ${r.comp.archiveItems === 0 ? 'N/A' : (r.comp.recallOk ? '✅' : '❌')} | ${r.triggerOk ? '✅' : '❌'} | ${r.finished ? '✅' : '❌'} | ${r.pass ? '✅' : '❌'} |`),
    '',
    `合计：${rows.length - failed}/${rows.length} 通过`,
].join('\n');
const mdPath = path.join(outDir, `eval-${stamp}.md`);
fs.writeFileSync(mdPath, md);

console.log(`\n${rows.length - failed}/${rows.length} 通过`);
console.log(`结果已写入 ${path.relative(process.cwd(), mdPath)}`);
process.exit(failed ? 1 : 0);
