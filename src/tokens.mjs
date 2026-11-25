/**
 * token 估算。
 *
 * 这是估算，不是精确计数：中日韩字符按 1 字 ≈ 1 token，其余按 4 字符 ≈ 1 token。
 * 估算只用来决定「要不要压缩」，偏差 10%~20% 不影响决策——阈值本身就留了余量（70% 预警、95% 红线）。
 * 要精确就用模型返回的 usage.input_tokens 校准（见 README「校准」一节）。
 */
const CJK = /[　-〿㐀-鿿豈-﫿＀-￯]/g;

export function estimateTokens(x) {
    if (x == null) return 0;
    const s = typeof x === 'string' ? x : JSON.stringify(x);
    const cjk = (s.match(CJK) || []).length;
    return Math.ceil(cjk + (s.length - cjk) / 4);
}

/** 整个请求的估算 token：system + 每条消息（每条另加 4 个 token 的角色/分隔开销） */
export function messagesTokens(messages, system = '') {
    return estimateTokens(system) + messages.reduce((n, m) => n + 4 + estimateTokens(m.content), 0);
}

/**
 * 估算校准器。
 *
 * 为什么需要：估算公式算不到的东西是真实存在的——工具定义、图片/附件、网关自己注入的
 * system 段、以及各家 tokenizer 对中英文的切分差异。只靠估算，要么压缩得太晚（真的 400），
 * 要么压缩得太早（白丢信息）。
 *
 * 怎么校准：每次 API 返回 usage.input_tokens，和本轮估算比较，维护两者的**固定差**
 * （actual - estimate）而不是比率。理由是工具定义这类开销每轮都一样，是常数项；
 * 用比率会把「消息很短时开销占比大」算成「所有东西都膨胀」，把窗口撑爆。
 *
 * 边界：差值为负（估算偏大）时保留，避免压缩得过于保守；单次观测最多修正到 0，
 * 防止一次异常 usage 把后续判断带偏。
 */
export class TokenCalibrator {
    /**
     * @param {object} [o]
     * @param {number} [o.alpha=0.3] 指数移动平均系数，越大越激进
     * @param {number} [o.maxOverhead=20000] 差值上限，防止异常值
     */
    constructor({ alpha = 0.3, maxOverhead = 20_000 } = {}) {
        this.alpha = alpha;
        this.maxOverhead = maxOverhead;
        this.overhead = 0;
        this.samples = 0;
    }

    /** @param {number} estimated 本轮估算 @param {number} actual API 返回的真实 input_tokens */
    observe(estimated, actual) {
        if (!Number.isFinite(actual) || actual <= 0) return this;
        // 估算为 0（空消息）时没有可比性，跳过
        if (!Number.isFinite(estimated) || estimated <= 0) return this;
        const raw = actual - estimated;
        const clamped = Math.min(this.maxOverhead, Math.max(-this.maxOverhead, raw));
        this.overhead = this.samples === 0 ? clamped : this.overhead * (1 - this.alpha) + clamped * this.alpha;
        this.samples++;
        return this;
    }

    /** 把估算换成「估计的真实值」，用于和窗口阈值比较 */
    adjusted(estimated) {
        return Math.max(1, Math.round(estimated + this.overhead));
    }

    toJSON() {
        return { overhead: Math.round(this.overhead), samples: this.samples };
    }
}
