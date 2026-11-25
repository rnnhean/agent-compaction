/**
 * 凭据脱敏。凡是要「离开当前上下文」的文本（发给摘要模型、写进归档、写进摘要）都先过这里。
 *
 * 为什么摘要里不能留 key：摘要会被持久化、会被反复发送、会进日志，等于给凭据多开一条泄漏路径。
 * 后续步骤需要凭据时，应由工具从固定位置读取，而不是靠上下文「记住」它。
 */
const RULES = [
    // 常见前缀的 key
    [/\b(?:sk-[A-Za-z0-9_-]{8,}|fk\d{3,}[A-Za-z0-9._-]*|ghp_[A-Za-z0-9]{20,}|xox[bap]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})/g, '«redacted»'],
    // Authorization: Bearer xxx
    [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer «redacted»'],
    // key=value / "key": "value"，含 JSON 字符串里转义过的 \"key\":\"value\"
    [/((?:\\?")?\b(?:api[_-]?key|access[_-]?key|secret|token|password|passwd|sid|sign|appkey)(?:\\?")?\s*[:=]\s*(?:\\?")?)[^"\\\s,}&]{4,}/gi, '$1«redacted»'],
    // 裸 32 位十六进制（常见的 session / sign）
    [/\b[a-f0-9]{32}\b/gi, '«hex32»'],
];

export function redact(text) {
    let s = String(text ?? '');
    for (const [re, to] of RULES) s = s.replace(re, to);
    return s;
}
