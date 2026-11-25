/**
 * 真实模型冒烟：用小窗口把四级压缩逼出来，验证「压缩后任务仍然能继续」。
 *
 * 凭据来源：默认读 D:/20260916/allenvs/llm-env.txt（可用 AGENT_ENV_FILE 覆盖）。
 * 安全约束：只把值写进 process.env 供进程内使用；
 *          任何输出都不包含 key、baseUrl、模型原始响应。
 *
 * 用法：
 *   node demo-live.mjs            # 默认 6 步、窗口 6000
 *   STEPS=10 WINDOW=4000 node demo-live.mjs
 */
import fs from 'node:fs';
import { anthropicLlm, asSummarizer } from './src/llm-anthropic.mjs';
import { runAgent } from './src/agent-loop.mjs';
import { redact } from './src/redact.mjs';

const ENV_FILE = process.env.AGENT_ENV_FILE || 'D:/20260916/allenvs/llm-env.txt';

/** 极简 .env 解析：支持 KEY=VALUE / export KEY=VALUE / 引号包裹。只写内存，不打印。 */
function loadEnvFile(file) {
    if (!fs.existsSync(file)) return { ok: false, reason: `找不到 ${file}` };
    const raw = fs.readFileSync(file, 'utf8');
    const n = raw.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).length;
    for (const line of raw.split('\n')) {
        const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (!m) continue;
        let v = m[2].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        if (process.env[m[1]] == null) process.env[m[1]] = v;
    }
    return { ok: true, count: n };
}

const loaded = loadEnvFile(ENV_FILE);
if (!loaded.ok) {
    console.error(loaded.reason);
    process.exit(1);
}

const MODEL = process.env.ANTHROPIC_MODEL;
if (!process.env.ANTHROPIC_AUTH_TOKEN || !MODEL) {
    console.error(`环境变量不全（已读 ${loaded.count} 条），需要 ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL / ANTHROPIC_MODEL`);
    process.exit(1);
}
// 适配器统一用 LLM_* 命名
process.env.LLM_API_KEY = process.env.ANTHROPIC_AUTH_TOKEN;
process.env.LLM_BASE_URL = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';

const llm = anthropicLlm({ model: MODEL, baseUrl: process.env.LLM_BASE_URL, keyEnv: 'LLM_API_KEY', maxTokens: 512 });
const summarize = asSummarizer(llm);

// 两个会返回大段内容的工具，用来把上下文撑爆
const bigDoc = Array.from({ length: 120 }, (_, i) => `第 ${i + 1} 行：订单 A10${i % 9 + 1} 的物流节点，状态正常，时间戳 2026-11-${String((i % 28) + 1).padStart(2, '0')}`).join('\n');
const tools = {
    query_logistics: {
        description: '按订单号查物流轨迹，返回完整节点列表',
        input_schema: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'] },
        run: async ({ orderId }) => `订单 ${orderId} 的物流记录：\n${bigDoc}`,
    },
    query_policy: {
        description: '查询售后政策原文',
        input_schema: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] },
        run: async ({ topic }) => `售后政策（${topic}）原文：\n${bigDoc.replace(/物流节点/g, '条款')}\n补充条款：${bigDoc.replace(/物流节点/g, '细则')}`,
    },
};

const STEPS = Number(process.env.STEPS || 6);
const WINDOW = Number(process.env.WINDOW || 6000);

console.log(`模型已配置（名称不打印）。窗口=${WINDOW} 最多=${STEPS} 步\n`);

const t0 = Date.now();
const r = await runAgent({
    llm,
    summarize,
    system: '你是物流客服助手。需要数据时调用工具；拿到足够信息后用一句话回答。',
    goal: '查订单 A1001 的物流，如果显示异常再查售后政策，最后给一句结论。',
    tools,
    maxSteps: STEPS,
    maxToolResultChars: 2000,
    compactOptions: { window: WINDOW, keepRecentGroups: 2, toolResultKeepChars: 300 },
    onStep: (e) => {
        const lv = e.level ? `L${e.level}` : '-';
        const usage = e.usage ? `实际输入 ${e.usage.input_tokens}` : '无 usage';
        console.log(`第 ${String(e.step).padStart(2)} 步 | ${lv} | 估算 ${e.tokensBefore}→${e.tokensAfter} | ${usage} | 校准差额 ${e.overhead} | 工具 ${e.tools.join(',') || '无'}`);
        for (const a of e.actions) console.log(`         · ${redact(a).slice(0, 110)}`);
    },
});

console.log(`\n完成=${r.done} 步数=${r.steps} 用时=${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`真实用量：输入 ${r.usage.input} / 输出 ${r.usage.output}`);
console.log(`校准结果：${JSON.stringify(r.calibration)}`);
console.log(`归档条目：${r.archive.items.length}`);
console.log(`最终答复（截断 200 字）：\n${redact(String(r.answer || '(空)')).slice(0, 200)}`);
