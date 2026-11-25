/**
 * 校准与归档容量的测试。
 *
 * 这两块都是"出问题时才看得见"的部件：校准错了不会报错，只会让压缩时机偏掉；
 * 归档裁剪错了不会报错，只会让 recall 悄悄拿不到东西。所以用测试钉住行为。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Archive } from '../src/archive.mjs';
import { runAgent } from '../src/agent-loop.mjs';
import { messagesTokens, TokenCalibrator } from '../src/tokens.mjs';

test('校准器：稳定偏差会收敛到真实差额', () => {
    const c = new TokenCalibrator();
    assert.equal(c.adjusted(1000), 1000, '没有观测前不修正');
    for (let i = 0; i < 5; i++) c.observe(1000, 1300);
    assert.ok(Math.abs(c.adjusted(1000) - 1300) <= 1, `收敛到 1300，实际 ${c.adjusted(1000)}`);
    assert.equal(c.samples, 5);
});

test('校准器：估算偏大时差额为负，且不会把结果压到 1 以下', () => {
    const c = new TokenCalibrator();
    for (let i = 0; i < 5; i++) c.observe(1000, 800);
    assert.ok(c.overhead < 0, '差额为负');
    assert.ok(c.adjusted(10) >= 1, '调整后不小于 1');
});

test('校准器：单次异常观测被夹到上限，不污染后续判断', () => {
    const c = new TokenCalibrator({ maxOverhead: 500 });
    c.observe(100, 10_000_000);
    assert.equal(Math.round(c.overhead), 500);
});

test('校准器：无效 usage 被忽略', () => {
    const c = new TokenCalibrator();
    c.observe(1000, 0);
    c.observe(1000, NaN);
    c.observe(0, 1200);
    assert.equal(c.samples, 0);
});

test('归档：超过容量后丢最旧，ID 单调递增，被清理的 ID 会明确告知', () => {
    const a = new Archive(null, { maxItems: 3 });
    const ids = ['内容1', '内容2', '内容3', '内容4', '内容5'].map((t) => a.put('test', t));
    assert.deepEqual(ids, ['A1', 'A2', 'A3', 'A4', 'A5'], 'ID 不因裁剪而重复');
    assert.equal(a.items.length, 3);
    assert.equal(a.evicted, 2);
    assert.match(a.recall('A1'), /已被清理/);
    assert.equal(a.recall('A5').startsWith('内容5'), true, '保留最近的');
});

test('归档：不影响未超限时的召回行为', () => {
    const a = new Archive(null, { maxItems: 100 });
    const id = a.put('tool_result', '订单 A1001 的物流状态是运输中');
    assert.match(a.recall(id), /运输中/);
    assert.match(a.recall('物流'), /运输中/, '关键词召回仍然可用');
});

test('循环：真实 usage 会被用来校准估算', async () => {
    const OVERHEAD = 500;
    const llm = async ({ system, messages }) => ({
        content: [{ type: 'text', text: '完成' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: messagesTokens(messages, system) + OVERHEAD, output_tokens: 10 },
    });

    const r = await runAgent({
        llm,
        summarize: async () => '',
        system: 'sys',
        goal: '只跑一轮',
        maxSteps: 3,
        compactOptions: { window: 1_000_000 },
    });

    assert.equal(r.done, true);
    assert.equal(r.usage.input > 0, true, '用量被累计');
    assert.ok(Math.abs(r.calibration.overhead - OVERHEAD) <= 1, `校准差额≈${OVERHEAD}，实际 ${r.calibration.overhead}`);
    assert.equal(r.log[0].usage.input_tokens > 0, true, '每步都记录真实 usage');
});
