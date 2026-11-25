/**
 * 服务模式的最小指标集（Prometheus 文本格式）。
 *
 * 选这几个指标的理由——每个都对应一个真实运维问题，不是凑数：
 *
 *   agent_compaction_requests_total   流量。突然归零说明上游没调；突然暴涨要看是不是 agent 死循环。
 *   agent_compaction_errors_total     错误。非 0 就直接告警。
 *   agent_compaction_level_total      各档触发次数。L3 占比高 = 窗口设置不合理或工具返回太大，要调参而不是加机器。
 *   agent_compaction_tokens_total     压缩前后 token 累计。两者的比值就是「省了多少上下文」，是这套机制的核心收益。
 *   agent_compaction_duration_seconds 耗时。压缩本身是同步阻塞的，P99 涨说明归档或摘要拖慢了主链路。
 *   agent_archive_items               归档条目数。持续增长到上限说明要加持久化或调大 maxItems。
 *
 * 刻意不做的：直方图分桶。分桶边界要按真实 P99 定，现在拍一个 0.005/0.01/0.05 是假精确；
 * 先给 sum/count，等有真实流量再定桶。
 */
export class Metrics {
    constructor() {
        this.requests = 0;
        this.errors = 0;
        this.levelCounts = { 0: 0, 1: 0, 2: 0, 3: 0 };
        this.tokensBefore = 0;
        this.tokensAfter = 0;
        this.durationSumSec = 0;
        this.durationCount = 0;
    }

    record(report, durationMs) {
        this.requests++;
        const lv = report?.level ?? 0;
        this.levelCounts[lv] = (this.levelCounts[lv] || 0) + 1;
        if (typeof report?.before === 'number') this.tokensBefore += report.before;
        if (typeof report?.after === 'number') this.tokensAfter += report.after;
        this.durationSumSec += durationMs / 1000;
        this.durationCount++;
    }

    recordError() {
        this.requests++;
        this.errors++;
    }

    /** @param {number} archiveItems 当前归档条目数 */
    render(archiveItems = 0) {
        const lines = [];
        const counter = (name, help, value, labels = '') => {
            lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} counter`, `${name}${labels} ${value}`);
        };
        const gauge = (name, help, value) => {
            lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} ${value}`);
        };

        counter('agent_compaction_requests_total', '收到的压缩请求总数', this.requests);
        counter('agent_compaction_errors_total', '压缩失败的请求数', this.errors);
        lines.push('# HELP agent_compaction_level_total 各压缩档位的触发次数', '# TYPE agent_compaction_level_total counter');
        for (const [lv, n] of Object.entries(this.levelCounts)) {
            lines.push(`agent_compaction_level_total{level="${lv}"} ${n}`);
        }
        counter('agent_compaction_tokens_before_total', '压缩前估算 token 累计', this.tokensBefore);
        counter('agent_compaction_tokens_after_total', '压缩后估算 token 累计', this.tokensAfter);
        counter('agent_compaction_duration_seconds_sum', '压缩耗时累计（秒）', this.durationSumSec.toFixed(6));
        counter('agent_compaction_duration_seconds_count', '压缩耗时采样次数', this.durationCount);
        gauge('agent_archive_items', '当前归档条目数', archiveItems);
        gauge('agent_uptime_seconds', '进程运行时长', Math.round(process.uptime()));

        return lines.join('\n') + '\n';
    }
}
