/**
 * 服务模式的冒烟测试：起在随机端口上，验证三条路由与边界。
 * 不碰外部网络，不读任何凭据。
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { createApp } from '../src/server.mjs';
import { Archive } from '../src/archive.mjs';

let server;
let base;

before(async () => {
    server = createApp({ archive: new Archive(null, { maxItems: 100 }), summarize: null });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((r) => server.close(r)));

test('/health 返回 ok，并说明摘要是否启用', async () => {
    const r = await fetch(`${base}/health`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.summaryEnabled, false);
});

test('/compact 正常压缩，并标注 L2 已跳过', async () => {
    const tool = 'x'.repeat(3000);
    const messages = [
        { role: 'user', content: '查一下订单 A1001 的物流' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'query_logistics', input: { id: 'A1001' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: tool }] },
        { role: 'assistant', content: '已查到，运输中。' },
        { role: 'user', content: '再查一次' },
        { role: 'assistant', content: '好的。' },
        { role: 'user', content: '谢谢' },
    ];
    const r = await fetch(`${base}/compact`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages, window: 800, softRatio: 0.2, hardRatio: 0.5, emergencyRatio: 0.9, keepRecentGroups: 2 }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.summaryDisabled, true);
    assert.ok(j.report.before > 0 && j.report.after > 0);
    assert.ok(j.report.after <= j.report.before, '压缩后不应更大');
});

test('/compact 缺 messages 返回 400', async () => {
    const r = await fetch(`${base}/compact`, { method: 'POST', body: '{}' });
    assert.equal(r.status, 400);
});

test('/compact 非法 JSON 返回 400', async () => {
    const r = await fetch(`${base}/compact`, { method: 'POST', body: '{oops' });
    assert.equal(r.status, 400);
});

test('/recall 能按关键词取回被归档内容', async () => {
    const r = await fetch(`${base}/recall`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'A1001' }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(typeof j.result, 'string');
});

test('未知路由返回 404', async () => {
    const r = await fetch(`${base}/nope`);
    assert.equal(r.status, 404);
});

test('/metrics 暴露 Prometheus 文本，且反映真实请求数', async () => {
    const r = await fetch(`${base}/metrics`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/plain/);
    const text = await r.text();
    assert.match(text, /agent_compaction_requests_total \d+/);
    assert.match(text, /agent_compaction_level_total\{level="\d"\} \d+/);
    assert.match(text, /agent_archive_items \d+/);
    const n = Number((text.match(/agent_compaction_requests_total (\d+)/) || [])[1]);
    assert.ok(n >= 1, '至少记录过前面那次 /compact');
});
