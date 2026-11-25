/**
 * 真实模型适配器（Anthropic Messages API 格式，任何兼容网关都能用）。
 *
 * 凭据只从环境变量读，本文件不打印、不落盘、不进错误信息。
 * 默认的测试和 demo 都不用它；要接真实模型时由使用者自己设置环境变量后再跑。
 */
export function anthropicLlm({ model, baseUrl = process.env.LLM_BASE_URL || 'https://api.anthropic.com', maxTokens = 4096, keyEnv = 'LLM_API_KEY', temperature = 0 } = {}) {
    // 网关有两种常见写法：https://host 和 https://host/v1，两种都要能接
    const base = String(baseUrl).replace(/\/+$/, '');
    const endpoint = base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`;
    return async ({ system, messages, tools, toolChoice }) => {
        const key = process.env[keyEnv];
        if (!key) throw new Error(`未设置环境变量 ${keyEnv}`);
        const body = {
            model,
            max_tokens: maxTokens,
            temperature,
            system,
            messages,
            ...(tools?.length ? { tools } : {}),
            // 评测里用它保证每轮真的调用工具，不依赖模型自觉
            ...(toolChoice && tools?.length ? { tool_choice: toolChoice } : {}),
        };
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            // 只带状态码，不把响应体（可能回显请求头）塞进错误信息
            throw new Error(`HTTP ${res.status}`);
        }
        const j = await res.json();
        return { content: j.content || [], stop_reason: j.stop_reason, usage: j.usage };
    };
}

/** 把同一个适配器包成摘要函数：summarize(prompt) => string */
export function asSummarizer(llm) {
    return async (prompt) => {
        const r = await llm({ system: '你只输出要求格式的摘要。', messages: [{ role: 'user', content: prompt }] });
        return r.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    };
}
