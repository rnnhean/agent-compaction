import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compact, toGroups, normalize, readSummary, validSummary } from '../src/compactor.mjs';
import { Archive } from '../src/archive.mjs';
import { redact } from '../src/redact.mjs';
import { messagesTokens } from '../src/tokens.mjs';
import { mockSummarizer, bigFileTool } from '../src/mock.mjs';

// ---------------------------------------------------------------- 工具函数

const GOAL = '把 src 下所有文件的超时配置整理成一张表';

/** 造 n 轮「读文件」交互，每轮 = assistant(tool_use) + user(tool_result) */
async function conversation(n, chars = 8000) {
    const tool = bigFileTool({ chars });
    const ms = [{ role: 'user', content: GOAL }];
    for (let i = 1; i <= n; i++) {
        ms.push({ role: 'assistant', content: [{ type: 'text', text: `读 file${i}` }, { type: 'tool_use', id: `tu_${i}`, name: 'read_file', input: { path: `src/file${i}.js` } }] });
        ms.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu_${i}`, content: await tool.run({ path: `src/file${i}.js` }) }] });
    }
    return ms;
}

/** 不变量检查：首条是目标、角色交替、每个 tool_result 都能找到它前一条消息里的 tool_use */
function assertInvariants(ms) {
    assert.equal(ms[0].role, 'user', '首条必须是 user');
    const first = typeof ms[0].content === 'string' ? ms[0].content : ms[0].content.map((b) => b.text || '').join('');
    assert.ok(first.includes(GOAL), '任务目标必须保留');
    for (let i = 1; i < ms.length; i++) assert.notEqual(ms[i].role, ms[i - 1].role, `第 ${i} 条角色没有交替`);
    for (let i = 0; i < ms.length; i++) {
        if (!Array.isArray(ms[i].content)) continue;
        for (const b of ms[i].content) {
            if (b.type !== 'tool_result') continue;
            const prev = ms[i - 1];
            const ok = prev && Array.isArray(prev.content) && prev.content.some((x) => x.type === 'tool_use' && x.id === b.tool_use_id);
            assert.ok(ok, `tool_result ${b.tool_use_id} 和它的 tool_use 被拆开了`);
        }
    }
}

const ctx = (extra = {}) => ({ window: 20_000, archive: new Archive(), summarize: mockSummarizer(), keepRecentGroups: 2, ...extra });

// ---------------------------------------------------------------- 测试

test('分组：tool_use 和 tool_result 绑成一组', async () => {
    const g = toGroups(await conversation(3));
    assert.equal(g.length, 4); // 目标 + 3 组
    assert.equal(g[1].length, 2);
});

test('normalize 合并相邻同角色消息', () => {
    const out = normalize([{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }, { role: 'assistant', content: 'c' }]);
    assert.equal(out.length, 2);
    assert.equal(out[0].content.length, 2);
});

test('低于预警线：原样返回，不调用摘要', async () => {
    const ms = await conversation(1, 500);
    const c = ctx();
    const { messages, report } = await compact(ms, c);
    assert.equal(report.level, 0);
    assert.deepEqual(messages, ms);
    assert.equal(c.summarize.prompts.length, 0);
});

test('L1：旧工具结果进归档，最近的和目标不动，归档能取回原文', async () => {
    const ms = await conversation(4, 3000);
    const c = ctx({ softRatio: 0.3, hardRatio: 0.99, emergencyRatio: 0.995 });
    const { messages, report } = await compact(ms, c);
    assert.equal(report.level, 1);
    assert.ok(report.after < report.before);
    assertInvariants(messages);
    const results = messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === 'tool_result');
    assert.match(results[0].content, /^\[已归档 A\d+/);       // 第 1 组被归档
    assert.doesNotMatch(results[3].content, /^\[已归档/);      // 最近一组原样
    const id = results[0].content.match(/A\d+/)[0];
    assert.match(c.archive.recall(id), /handler1，超时 100ms/);
});

test('L1 够用时不调摘要模型（能轻处理就不花钱、不冒摘要失真的风险）', async () => {
    const ms = await conversation(10);
    // 估算现在按 4/3 保守放大，同一份内容算出来更大；给足窗口，让 L1 仍能独立压到线以下，
    // 这样测的才是「L1 够用时不升级到 L2」这个意图，而不是在测窗口够不够。
    const c = ctx({ window: 36_000 });
    const { report } = await compact(ms, c);
    assert.equal(report.level, 1);
    assert.equal(c.summarize.prompts.length, 0);
    assert.ok(report.after < c.window * 0.75);
});

// 下面几条单独验证 L2：把 L1 线抬高跳过 L1，把 L2 线压低保证触发
const L2_ONLY = { softRatio: 0.99, hardRatio: 0.5, emergencyRatio: 0.995 };

test('L2：旧交互压成结构化摘要，不变量成立，大小降到预警线以下', async () => {
    const ms = await conversation(10);
    const c = ctx(L2_ONLY);
    const { messages, report } = await compact(ms, c);
    assert.equal(report.level, 2);
    assertInvariants(messages);
    const summary = readSummary(messages[0]);
    assert.ok(validSummary(summary));
    assert.match(summary, /handler1，超时 100ms/, '早期事实应在摘要里');
    assert.ok(report.after < c.window * 0.6, `压缩后 ${report.after} 应低于预警线`);
});

test('L2 连续两次：上一次摘要里的事实不丢', async () => {
    const c = ctx(L2_ONLY);
    let { messages } = await compact(await conversation(10), c);
    // 继续追加 10 轮再压一次
    const more = (await conversation(20)).slice(21);
    ({ messages } = await compact([...messages, ...more], c));
    assertInvariants(messages);
    const summary = readSummary(messages[0]);
    assert.match(summary, /handler1，超时 100ms/, '第一次压缩的事实必须被继承');
    assert.match(summary, /handler15，超时 1500ms/, '第二次压缩的新事实也在');
    assert.equal(c.summarize.prompts.length, 2, '两次都应调用摘要');
    assert.equal((JSON.stringify(messages).match(/\[COMPACT_SUMMARY\]/g) || []).length, 1, '只能有一份摘要');
});

test('凭据：不进摘要模型的输入、不进摘要、不进归档', async () => {
    const c = ctx(L2_ONLY);
    const ms = await conversation(10);
    // L1 只处理工具结果；工具调用参数和普通文本里的凭据只能靠摘要前的那层脱敏挡住
    ms[3].content.push({ type: 'tool_use', id: 'tu_auth', name: 'http_get', input: { headers: { authorization: 'Bearer sk-FAKEINPUTxxxxxxxxxxxxxxxx' } } });
    ms[4].content.push({ type: 'tool_result', tool_use_id: 'tu_auth', content: '200 OK' });
    ms[5].content.unshift({ type: 'text', text: '用户给的口令 password=hunter2hunter2，先记下' });
    const { messages } = await compact(ms, c);
    assert.ok(c.summarize.prompts.length > 0, '必须真的调用了摘要，否则这条测试是空过');
    const leaked = /sk-FAKE|hunter2/;
    for (const p of c.summarize.prompts) assert.doesNotMatch(p, leaked, '摘要模型收到了凭据');
    assert.doesNotMatch(readSummary(messages[0]), leaked);
    for (const it of c.archive.items) assert.doesNotMatch(it.text, leaked, '归档里有凭据');
});

test('摘要格式不合格会被拒绝，重试成功则采用', async () => {
    const c = ctx({ ...L2_ONLY, summarize: mockSummarizer({ badFormatTimes: 1 }) });
    const { messages, report } = await compact(await conversation(10), c);
    assert.ok(report.actions.some((a) => a.includes('格式不合格')));
    assert.ok(validSummary(readSummary(messages[0])));
});

test('摘要模型两次都失败：走 L3 兜底，目标保留，不变量成立', async () => {
    const c = ctx({ summarize: mockSummarizer({ failTimes: 2 }), softRatio: 0.95, hardRatio: 0.5, emergencyRatio: 0.6 });
    const { messages, report } = await compact(await conversation(10), c);
    assert.equal(report.level, 3);
    assertInvariants(messages);
    assert.ok(report.after < c.window * 0.6);
    assert.match(JSON.stringify(messages), /上下文过载/);
});

test('单个工具结果超大：L3 截断它而不是把整组丢掉', async () => {
    const ms = await conversation(1, 120_000);
    const c = ctx();
    const { messages, report } = await compact(ms, c);
    assertInvariants(messages);
    assert.ok(messagesTokens(messages) < c.window);
    assert.ok(report.actions.some((a) => a.includes('截断超大工具结果')));
    assert.equal(messages.length, 3, '目标 + tool_use + tool_result 都在');
});

test('redact：常见凭据形态都被抹掉', () => {
    const cases = [
        'api_key=sk-FAKE-TEST-VALUE-NOT-A-REAL-KEY',
        'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
        '{"token": "abc123def456"}',
        '{\\"password\\":\\"hunter2hunter2\\"}',
        'sid 0123456789abcdef0123456789abcdef',
        'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
    ];
    for (const s of cases) {
        const r = redact(s);
        assert.match(r, /«redacted»|«hex32»/, `没脱敏: ${s}`);
        assert.doesNotMatch(r, /abcdefghijklmnop123|eyJhbGci|abc123def456|hunter2|0123456789abcdef0123|ghp_ABCD/);
    }
});
