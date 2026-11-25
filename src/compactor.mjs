/**
 * 上下文压缩器（compaction）。
 *
 * 每次调模型前调用 compact()。按上下文占用从轻到重分四级处理，优先用不丢信息的手段：
 *
 *   L0 入口截断   工具结果在进上下文之前就截断（在 agent-loop 里做，见 admitToolResult）
 *   L1 清旧工具结果  ≥ softRatio：较早轮次的大段工具返回移进归档，原地只留「去哪找」的占位
 *   L2 结构化摘要    ≥ hardRatio：较早轮次整体压成固定格式的摘要，原文进归档
 *   L3 紧急截断      仍 ≥ emergencyRatio（摘要失败或摘要后还太大）：只留目标 + 摘要 + 最近几轮
 *
 * 三条不变量，任何一级都不许破坏（测试逐条覆盖）：
 *   1. 第一条用户消息（任务目标）永远保留；system 和工具定义不在 messages 里，压缩碰不到
 *   2. tool_use 和它的 tool_result 永远同进同出——拆开了 API 直接 400，agent 当场瘫痪
 *   3. 发出去的消息角色交替（user / assistant），首条是 user
 *
 * 消息格式用 Anthropic Messages API 的形状：
 *   { role: 'user' | 'assistant', content: string | Block[] }
 *   Block = {type:'text',text} | {type:'tool_use',id,name,input} | {type:'tool_result',tool_use_id,content}
 */
import { messagesTokens, estimateTokens } from './tokens.mjs';
import { redact } from './redact.mjs';

export const DEFAULTS = {
    window: 200_000,       // 模型上下文窗口（token）
    softRatio: 0.6,        // L1 触发线
    hardRatio: 0.75,       // L2 触发线
    emergencyRatio: 0.92,  // L3 触发线
    keepRecentGroups: 4,   // 最近几「组」交互原样保留（一组 = 一次 tool_use + 它的 tool_result，或一条纯文本消息）
    toolResultKeepChars: 600, // L1 后旧工具结果在原地保留的字数
    overhead: 0,           // 估算校准差额（见 tokens.mjs 的 TokenCalibrator）：工具定义/网关注入等固定开销
};

const SUMMARY_TAG = '[COMPACT_SUMMARY]';
const SUMMARY_END = '[/COMPACT_SUMMARY]';
const REQUIRED = ['目标', '已完成', '待办', '关键事实', '失败的尝试'];

// ---------------------------------------------------------------- 分组

const blocks = (m) => (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content);
const isToolResultMsg = (m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result');

/** 把消息切成不可拆分的组：带 tool_use 的 assistant 消息和紧跟的 tool_result 消息绑成一组 */
export function toGroups(messages) {
    const groups = [];
    for (const m of messages) {
        if (isToolResultMsg(m) && groups.length) groups[groups.length - 1].push(m);
        else groups.push([m]);
    }
    return groups;
}

/** 合并相邻同角色消息，保证角色交替 */
export function normalize(messages) {
    const out = [];
    for (const m of messages) {
        const last = out[out.length - 1];
        if (last && last.role === m.role) last.content = [...blocks(last), ...blocks(m)];
        else out.push({ role: m.role, content: m.content });
    }
    return out;
}

// ---------------------------------------------------------------- 摘要块的读写

export function readSummary(goalMsg) {
    for (const b of blocks(goalMsg)) {
        if (b.type === 'text' && b.text.startsWith(SUMMARY_TAG)) return b.text;
    }
    return '';
}

function withSummary(goalMsg, summary) {
    const keep = blocks(goalMsg).filter((b) => !(b.type === 'text' && b.text.startsWith(SUMMARY_TAG)));
    return { role: 'user', content: summary ? [...keep, { type: 'text', text: summary }] : keep };
}

/** 把若干组渲染成给摘要模型看的纯文本（先脱敏：凭据不发给摘要模型，也就不可能出现在摘要里） */
function render(groups) {
    const lines = [];
    for (const g of groups) {
        for (const m of g) {
            for (const b of blocks(m)) {
                if (b.type === 'text') lines.push(`${m.role}: ${b.text}`);
                else if (b.type === 'tool_use') lines.push(`assistant 调用工具 ${b.name}(${JSON.stringify(b.input)})`);
                else if (b.type === 'tool_result') lines.push(`工具返回: ${typeof b.content === 'string' ? b.content : JSON.stringify(b.content)}`);
            }
        }
    }
    return redact(lines.join('\n'));
}

export function summaryPrompt(prevSummary, transcript) {
    return `你是 agent 的上下文压缩器。下面是一段即将从上下文中移除的交互记录${prevSummary ? '，以及上一次的摘要' : ''}。
把它们合并成一份新摘要，严格按以下格式输出，不要输出别的内容：

${SUMMARY_TAG}
## 目标
（用户的最终目标，一句话）
## 已完成
- （每条：做了什么 → 结果/结论）
## 待办
- （还没做的事）
## 关键事实
- （后续步骤会用到的具体值：ID、路径、数字、配置项、用户约束。写原值，不要概括）
## 失败的尝试
- （试过但失败的做法和原因，避免重复踩坑；没有写「无」）
${SUMMARY_END}

规则：
- 上一次摘要里的内容如果仍然成立，必须保留，不许因为这次没提到就丢掉
- 凭据（key、token、密码）一律不写，写「凭据由工具读取」
- 只依据下面的材料，不许补充材料里没有的信息

${prevSummary ? `【上一次的摘要】\n${prevSummary}\n\n` : ''}【要压缩的交互记录】
${transcript}`;
}

export function validSummary(text) {
    if (!text || !text.includes(SUMMARY_TAG)) return false;
    return REQUIRED.every((h) => new RegExp(`^##\\s*${h}`, 'm').test(text));
}

// ---------------------------------------------------------------- 各级

/** L1：较早组里的长工具结果移进归档，原地只留开头 + 归档 ID */
function clearOldToolResults(groups, keepRecent, keepChars, archive, report) {
    const names = new Map();
    for (const g of groups) for (const m of g) for (const b of blocks(m)) if (b.type === 'tool_use') names.set(b.id, b.name);

    return groups.map((g, gi) => {
        if (gi === 0 || gi >= groups.length - keepRecent) return g; // 目标组、最近组不动
        return g.map((m) => {
            if (!isToolResultMsg(m)) return m;
            return {
                role: m.role,
                content: m.content.map((b) => {
                    if (b.type !== 'tool_result') return b;
                    const text = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
                    if (text.length <= keepChars || text.startsWith('[已归档')) return b;
                    const id = archive.put(`tool_result:${names.get(b.tool_use_id) || '?'}`, text);
                    report.actions.push(`L1 归档 ${names.get(b.tool_use_id) || '?'} 的结果 ${text.length} 字 → ${id}`);
                    return {
                        ...b,
                        content: `[已归档 ${id}，原文 ${text.length} 字；需要时调用 recall_archive("${id}")]\n${redact(text.slice(0, keepChars))}…`,
                    };
                }),
            };
        });
    });
}

/**
 * 主入口。
 * @param {object[]} messages 当前消息（messages[0] 必须是任务目标）
 * @param {object} ctx { system, archive, summarize: async (prompt) => string, ...DEFAULTS 覆盖项 }
 * @returns {Promise<{messages, report}>}
 */
/**
 * 强制封顶：保证最终消息不超过 budget。
 *
 * 为什么需要：L1/L2/L3 都是「按级别尽力」，但如果单个工具结果本身就有十几 k token，
 * 截到 hardRatio 的预算后仍然贴着窗口——下一轮再来一条就爆了。级别策略负责「怎么压」，
 * 这一层负责「压到线以下」，是 L3 的硬承诺。
 *
 * 顺序：先截最大的工具结果（保留开头 + 归档 ID），截无可截再丢最旧的一组（目标组除外）。
 */
function enforceCap(messages, budget, size, archive, report) {
    let ms = messages;
    for (let guard = 0; guard < 20; guard++) {
        if (size(ms) <= budget) return ms;
        const groups = toGroups(ms);
        let best = null;
        for (let gi = 1; gi < groups.length; gi++) {
            for (const m of groups[gi]) {
                if (!isToolResultMsg(m)) continue;
                for (const b of m.content) {
                    if (b.type !== 'tool_result') continue;
                    const text = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
                    const tk = estimateTokens(text);
                    if (!best || tk > best.tk) best = { b, text, tk };
                }
            }
        }
        if (best && best.tk > 200) {
            const ratio = budget / Math.max(1, size(ms));
            const keepChars = Math.max(200, Math.floor(best.text.length * ratio * 0.9));
            const id = archive.put('enforce_cap', best.text);
            best.b.content = `${redact(best.text.slice(0, keepChars))}…[为守住窗口已截断，全文归档 ${id}]`;
            report.actions.push(`封顶截断工具结果 ${best.text.length} → ${keepChars} 字，原文 → ${id}`);
            continue;
        }
        // 没有可截的工具结果：丢最旧的一组（第 0 组是任务目标，永不丢）
        if (groups.length <= 1) return ms;
        const dropped = groups[1];
        const id = archive.put('dropped_by_cap', render([dropped]));
        ms = normalize([groups[0][0], ...groups.slice(2).flat()]);
        report.actions.push(`封顶丢弃 1 组（归档 ${id}）`);
    }
    return ms;
}

export async function compact(messages, ctx) {
    const o = { ...DEFAULTS, ...ctx };
    const limit = (r) => Math.floor(o.window * r);
    // 估算 + 校准差额 = 「估计的真实占用」。阈值比较用这个，内容处理仍按估算后的结构做。
    const size = (ms) => messagesTokens(ms, o.system) + (o.overhead || 0);
    const report = { before: size(messages), after: 0, level: 0, overhead: o.overhead || 0, actions: [] };

    // 固定开销（工具定义、系统提示、网关注入）本身接近窗口时，压缩救不了——
    // 这时候该调窗口或精简工具定义，而不是继续往下压。明确报出来，不静默失败。
    if ((o.overhead || 0) >= o.window * 0.5) {
        report.actions.push(
            `固定开销（校准差额 ${Math.round(o.overhead)}）已占窗口 ${o.window} 的一半以上：压缩收益有限，请调大窗口或精简工具定义`,
        );
    }

    let groups = toGroups(messages);
    let out = messages;

    // L1
    if (size(out) >= limit(o.softRatio)) {
        report.level = 1;
        groups = clearOldToolResults(groups, o.keepRecentGroups, o.toolResultKeepChars, o.archive, report);
        out = groups.flat();
    }

    // L2
    if (size(out) >= limit(o.hardRatio) && groups.length > o.keepRecentGroups + 1) {
        report.level = 2;
        const goal = groups[0][0];
        const old = [groups[0].slice(1), ...groups.slice(1, groups.length - o.keepRecentGroups)].filter((g) => g.length);
        const recent = groups.slice(groups.length - o.keepRecentGroups);
        const prev = readSummary(goal);
        const transcript = render(old);
        const archiveId = o.archive.put('transcript', transcript);

        let summary = '';
        for (let attempt = 1; attempt <= 2 && !summary; attempt++) {
            try {
                const s = redact(await o.summarize(summaryPrompt(prev, transcript)));
                if (validSummary(s)) summary = s.slice(s.indexOf(SUMMARY_TAG));
                else report.actions.push(`L2 摘要第 ${attempt} 次格式不合格，丢弃`);
            } catch (e) {
                report.actions.push(`L2 摘要第 ${attempt} 次失败: ${e.message}`);
            }
        }
        if (summary) {
            summary += `\n（被压缩的原始记录已归档为 ${archiveId}，可用 recall_archive 按关键词查原文）`;
            out = normalize([withSummary(goal, summary), ...recent.flat()]);
            report.actions.push(`L2 压缩 ${old.length} 组为摘要（${estimateTokens(summary)} token），原文 → ${archiveId}`);
        } else {
            report.actions.push('L2 摘要不可用，保持 L1 结果，交给 L3 兜底');
        }
    }

    // L3：摘要失败或仍然太大。保留 目标(+旧摘要) + 尽可能多的最近组
    if (size(out) >= limit(o.emergencyRatio)) {
        report.level = 3;
        const g = toGroups(out);
        const head = g[0][0];
        let keep = [];
        for (let i = g.length - 1; i >= 1; i--) {
            if (size([head, ...g[i], ...keep]) >= limit(o.hardRatio)) break;
            keep = [...g[i], ...keep];
        }
        // 最近一组本身就超大（例如单个工具结果巨大）：截它的工具结果，而不是丢掉它
        if (!keep.length) keep = shrinkGroup(g[g.length - 1], limit(o.hardRatio) - size([head]), o.archive, report);
        const keptGroups = toGroups(keep).length;
        const droppedGroups = g.slice(1, g.length - keptGroups);
        const dropped = droppedGroups.length;

        // 被丢弃的内容必须先进归档。否则提示语里「可用 recall_archive 查找」是假的，
        // 而 agent 会照着提示去召回一个不存在的 ID，白白浪费一轮。
        let archiveId = '';
        if (droppedGroups.length) {
            archiveId = o.archive.put('dropped_by_L3', render(droppedGroups));
            report.actions.push(`L3 归档 ${droppedGroups.length} 组被丢弃的交互 → ${archiveId}`);
        }

        const notice = {
            type: 'text',
            text: dropped
                ? `[上下文过载，已丢弃较早的 ${dropped} 组交互，原文归档为 ${archiveId}；需要时调用 recall_archive("${archiveId}") 或按关键词查]`
                : '[上下文过载，已截断超大工具结果]',
        };
        out = normalize([{ role: 'user', content: [...blocks(head), notice] }, ...keep]);
        report.actions.push(`L3 紧急截断，丢弃 ${dropped} 组`);
    }

    // 硬承诺：只要动过压缩（level>0），最终就不许超过 hardRatio。
    // 测试里有一条专门验证「单个超大工具结果也压得下去」。
    if (report.level > 0) {
        out = enforceCap(out, limit(o.hardRatio), size, o.archive, report);
    }

    report.after = size(out);
    return { messages: out, report };
}

function shrinkGroup(group, budgetTokens, archive, report) {
    // 按估算 token 收缩，不按固定字数：中文约 1 字 1 token，英文约 4 字符 1 token，固定比例会截不够
    const budget = Math.max(100, Math.floor(budgetTokens * 0.9));
    const fit = (text) => {
        let n = Math.min(text.length, budget * 4);
        while (n > 200 && estimateTokens(text.slice(0, n)) > budget) n = Math.floor(n * 0.8);
        return n;
    };
    return group.map((m) => {
        if (!isToolResultMsg(m)) return m;
        return {
            role: m.role,
            content: m.content.map((b) => {
                if (b.type !== 'tool_result') return b;
                const text = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
                if (estimateTokens(text) <= budget) return b;
                const id = archive.put('tool_result:oversize', text);
                report.actions.push(`L3 截断超大工具结果 ${text.length} 字 → ${id}`);
                return { ...b, content: `${redact(text.slice(0, fit(text)))}…[截断，全文已归档 ${id}]` };
            }),
        };
    });
}
