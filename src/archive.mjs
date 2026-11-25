/**
 * 归档：被移出上下文的原文放这里，agent 通过 recall_archive 工具按 ID 或关键词取回。
 *
 * 检索用的是关键词计数，够演示和小规模使用。量大了换成向量检索（pgvector / Mem0），
 * put / recall 两个接口不变，压缩逻辑不用改。
 */
import fs from 'node:fs';
import { redact } from './redact.mjs';

export class Archive {
    /**
     * @param {string|null} file 传路径则以 JSONL 持久化，进程重启后还能召回
     * @param {object} [o]
     * @param {number} [o.maxItems=20000] 内存条目上限，防止病态循环把内存吃光
     *
     * 为什么默认 20000：demo 里 151 步产生 159 条归档（约 1 条/步），20000 条对应
     * 约两万步的运行，远超任何正常 agent。这个上限是病态循环的保险丝，不是预期路径。
     * 触发时会丢弃最旧的条目，被丢弃的 ID 召回时明确告知「已清理」，不会假装还在。
     */
    constructor(file = null, { maxItems = 20_000 } = {}) {
        this.file = file;
        this.maxItems = maxItems;
        this.evicted = 0;
        this.items = file && fs.existsSync(file)
            ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
            : [];
        // ID 必须单调递增：条目被裁剪后 items.length 会回退，不能再用它生成 ID
        this.seq = this.items.reduce((m, x) => Math.max(m, Number(String(x.id).slice(1)) || 0), 0);
    }

    put(kind, text) {
        if (this.items.length >= this.maxItems) {
            this.items.shift();
            this.evicted++;
        }
        const item = { id: `A${++this.seq}`, kind, text: redact(text), at: new Date().toISOString() };
        this.items.push(item);
        if (this.file) fs.appendFileSync(this.file, JSON.stringify(item) + '\n');
        return item.id;
    }

    recall(query, { maxChars = 4000, k = 3 } = {}) {
        if (!query) return '需要提供归档 ID 或关键词';
        const hit = this.items.find((x) => x.id === query);
        if (hit) return clip(hit.text, maxChars);
        const asId = Number(String(query).replace(/^A/i, ''));
        if (Number.isInteger(asId) && asId > 0 && asId <= this.evicted) {
            return `${query} 已被清理（归档容量上限 ${this.maxItems} 条，保留最近的）`;
        }

        const terms = String(query).toLowerCase().split(/[\s,，、]+/).filter(Boolean);
        const scored = this.items
            .map((x) => ({ x, score: terms.reduce((n, w) => n + x.text.toLowerCase().split(w).length - 1, 0) }))
            .filter((s) => s.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, k);
        if (!scored.length) return `归档里没有找到「${query}」`;
        const per = Math.floor(maxChars / scored.length);
        return scored.map(({ x }) => `[${x.id}] ${snippet(x.text, terms, per)}`).join('\n\n');
    }
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…（共 ${s.length} 字，已截取前 ${n} 字）` : s);

function snippet(text, terms, n) {
    const low = text.toLowerCase();
    const at = Math.min(...terms.map((w) => low.indexOf(w)).filter((i) => i >= 0));
    const start = Math.max(0, at - Math.floor(n / 4));
    return (start > 0 ? '…' : '') + text.slice(start, start + n) + (start + n < text.length ? '…' : '');
}
