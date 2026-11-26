/**
 * 服务模式：把压缩能力暴露成 HTTP 接口，给非 Node 的 agent 用（Python / Go / Java 都能接）。
 *
 * 设计边界：
 *   - 无状态。归档放在内存里，进程重启即丢；生产上要持久化就传 archiveFile
 *     （单进程单文件够用；多实例需要换共享存储，这是刻意没做的，避免假装支持集群）。
 *   - 默认不做鉴权。它是内网 sidecar，不是公网服务。要暴露到公网必须自己前面加网关。
 *   - L2 摘要需要模型。未配置时自动降级为 L1/L3，并在响应里明确标注 summaryDisabled。
 *
 * 可测试性：createApp() 返回 http.Server 但不 listen，测试里可以 listen(0) 拿随机端口。
 */
import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { compact, DEFAULTS } from './compactor.mjs';
import { Archive } from './archive.mjs';
import { Metrics } from './metrics.mjs';
import { anthropicLlm, asSummarizer } from './llm-anthropic.mjs';

const MAX_BODY = 8 * 1024 * 1024; // 8MB：单次请求的消息体上限，防止被打爆内存

const json = (res, code, body) => {
    const s = JSON.stringify(body);
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(s) });
    res.end(s);
};

// React 控制台构建产物（web/dist）。未构建时给出明确提示，而不是白屏。
const DIST_DIR = [process.env.WEB_DIST_DIR, fileURLToPath(new URL('../web/dist', import.meta.url))].find((d) => {
    try {
        return d && fs.existsSync(path.join(d, 'index.html'));
    } catch {
        return false;
    }
}) || null;
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.json': 'application/json; charset=utf-8',
};

function serveStatic(res, url) {
    if (!DIST_DIR) return json(res, 503, { error: '前端未构建：请在 web/ 下执行 npm install && npm run build' });
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    const target = path.join(DIST_DIR, rel);
    // 防目录穿越：解析后必须仍在 DIST_DIR 内
    const inside = path.resolve(target).startsWith(path.resolve(DIST_DIR));
    const file = inside && fs.existsSync(target) && fs.statSync(target).isFile() ? target : path.join(DIST_DIR, 'index.html');
    if (!fs.existsSync(file)) return json(res, 503, { error: '前端产物缺失' });
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': inside ? 'public, max-age=3600' : 'no-store' });
    res.end(fs.readFileSync(file));
}

const readBody = (req) => new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
            reject(Object.assign(new Error('请求体超过 8MB 上限'), { status: 413 }));
            req.destroy();
            return;
        }
        chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
});

/**
 * @param {object} [o]
 * @param {Archive} [o.archive]
 * @param {((prompt: string) => Promise<string>) | null} [o.summarize] 传 null 表示不做 L2
 * @param {Metrics} [o.metrics] 指标注册表，测试里可注入自己的实例
 */
export function createApp({ archive = new Archive(), summarize = null, metrics = new Metrics() } = {}) {
    return createServer(async (req, res) => {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

        if (req.method === 'GET' && !url.pathname.startsWith('/api/') && url.pathname !== '/health' && url.pathname !== '/metrics') {
            return serveStatic(res, url);
        }

        if (req.method === 'GET' && url.pathname === '/health') {
            return json(res, 200, {
                ok: true,
                version: '0.2.0',
                summaryEnabled: Boolean(summarize),
                archiveItems: archive.items.length,
                uptimeSec: Math.round(process.uptime()),
            });
        }

        if (req.method === 'GET' && url.pathname === '/metrics') {
            res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
            return res.end(metrics.render(archive.items.length));
        }

        // 兼容两种前缀：/compact 与 /api/compact（前端走后者，与其它项目保持一致）
        const isCompact = url.pathname === '/compact' || url.pathname === '/api/compact';
        const isRecall = url.pathname === '/recall' || url.pathname === '/api/recall';

        if (req.method === 'POST' && isCompact) {
            let body;
            try {
                body = JSON.parse(await readBody(req));
            } catch (e) {
                return json(res, e.status || 400, { error: e.message });
            }
            const { messages, ...options } = body || {};
            if (!Array.isArray(messages) || !messages.length) {
                return json(res, 400, { error: 'messages 必须是非空数组' });
            }
            const started = process.hrtime.bigint();
            try {
                const { messages: out, report } = await compact(messages, {
                    ...DEFAULTS,
                    ...options,
                    archive,
                    ...(summarize ? { summarize } : {}),
                });
                metrics.record(report, Number(process.hrtime.bigint() - started) / 1e6);
                return json(res, 200, {
                    messages: out,
                    report,
                    summaryDisabled: !summarize,
                    ...(summarize ? {} : { note: '未配置摘要模型，L2 已跳过；只做 L1/L3' }),
                });
            } catch (e) {
                metrics.recordError();
                return json(res, 500, { error: e.message });
            }
        }

        if (req.method === 'POST' && isRecall) {
            let body;
            try {
                body = JSON.parse(await readBody(req));
            } catch (e) {
                return json(res, e.status || 400, { error: e.message });
            }
            const { query, maxChars } = body || {};
            if (!query) return json(res, 400, { error: 'query 必填' });
            return json(res, 200, { result: archive.recall(query, { maxChars: maxChars || 4000 }) });
        }

        return json(res, 404, { error: 'not found' });
    });
}

/** 从环境变量组装一个生产用的 app。凭据只读不打印。 */
export function fromEnv() {
    const summaryEnabled = process.env.SUMMARY_ENABLED === '1' && Boolean(process.env.LLM_MODEL);
    return createApp({
        archive: new Archive(process.env.ARCHIVE_FILE || null),
        summarize: summaryEnabled
            ? asSummarizer(anthropicLlm({ model: process.env.LLM_MODEL, baseUrl: process.env.LLM_BASE_URL, keyEnv: 'LLM_API_KEY' }))
            : null,
    });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
    const port = Number(process.env.PORT || 8787);
    const server = fromEnv();
    server.listen(port, () => {
        // 只打印可公开的信息，不打印任何环境变量值
        console.log(`agent-compaction listening on :${port} (summary=${process.env.SUMMARY_ENABLED === '1' && process.env.LLM_MODEL ? 'on' : 'off'})`);
    });
    const shutdown = (sig) => {
        console.log(`${sig} received, closing`);
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(1), 5000).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}
