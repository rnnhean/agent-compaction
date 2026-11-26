import { useState } from 'react';

/** 与后端 /api/compact 的返回结构保持一致 */
interface CompactResponse {
  messages?: Array<{ role: string; content: unknown }>;
  report?: { before: number; after: number; level: number; overhead: number; actions: string[] };
  summaryDisabled?: boolean;
  note?: string;
  error?: string;
  inputTokens?: number;
  trigger?: string | null;
}

/** 四种预置场景：分别对应「不该压」「刚触发 L1」「压到 L2」「撑爆 L3」 */
const PRESETS = {
  small: { label: '短会话（不该触发）', groups: 4, chars: 600, window: 80000 },
  medium: { label: '中等（触发 L1）', groups: 20, chars: 3000, window: 12000 },
  large: { label: '长会话（压到 L2）', groups: 30, chars: 4000, window: 10000 },
  huge: { label: '超长（撑到 L3）', groups: 40, chars: 3000, window: 4000 },
} as const;

type PresetKey = keyof typeof PRESETS;

/** 生成 Anthropic 形状的消息：交替的 tool_use / tool_result，最接近真实 agent 会话 */
function buildMessages(groups: number, chars: number) {
  const filler = '/** 业务代码片段 */ '.repeat(Math.ceil(chars / 12)).slice(0, chars);
  const msgs: Array<{ role: 'user' | 'assistant'; content: unknown }> = [
    { role: 'user', content: '把仓库里的模块逐个读完，最后给结论。' },
  ];
  for (let i = 1; i <= groups; i++) {
    msgs.push({
      role: 'assistant',
      content: [
        { type: 'text', text: `第 ${i} 步：读取 module${i}.ts` },
        { type: 'tool_use', id: `tu_${i}`, name: 'read_file', input: { path: `src/module${i}.ts` } },
      ],
    });
    msgs.push({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: `tu_${i}`,
          content: `// src/module${i}.ts\n事实: module${i} 导出 handler${i}，超时 ${i * 100}ms、依赖 module${i}\n${filler}`,
        },
      ],
    });
  }
  return msgs;
}

const levelName = (lv: number) =>
  lv === 0 ? '未压缩' : lv === 1 ? 'L1 归档旧工具结果' : lv === 2 ? 'L2 结构化摘要' : 'L3 紧急截断';

const levelClass = (lv: number) => (lv === 0 ? 'idle' : lv === 1 ? 'l1' : lv === 2 ? 'l2' : 'l3');

export default function App() {
  const [preset, setPreset] = useState<PresetKey>('medium');
  const [window_, setWindow] = useState<number>(PRESETS.medium.window);
  const [busy, setBusy] = useState(false);
  const [resp, setResp] = useState<CompactResponse | null>(null);
  const [raw, setRaw] = useState<string>('');

  const cfg = PRESETS[preset];

  async function run() {
    setBusy(true);
    setResp(null);
    setRaw('');
    try {
      const messages = buildMessages(cfg.groups, cfg.chars);
      const r = await fetch('/api/compact', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages,
          window: window_,
          softRatio: 0.5,
          hardRatio: 0.7,
          emergencyRatio: 0.9,
          keepRecentGroups: 3,
          toolResultKeepChars: 300,
        }),
      });
      const j = (await r.json()) as CompactResponse;
      if (!r.ok) {
        setResp({ error: j.error || `HTTP ${r.status}` });
      } else {
        setResp({ ...j, inputTokens: messages.length });
        setRaw(JSON.stringify(j.messages?.slice(0, 3), null, 2));
      }
    } catch (e) {
      setResp({ error: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const ratio = resp?.report ? resp.report.after / Math.max(1, resp.report.before) : 0;

  return (
    <>
      <header>
        <h1>Agent Compaction</h1>
        <span className={`dot ${resp && !resp.error ? 'on' : ''}`} aria-hidden />
        <span className="muted">四级上下文压缩 · 无损优先</span>
      </header>

      <main>
        <section className="card span12">
          <h2>场景</h2>
          <div className="chips">
            {(Object.keys(PRESETS) as PresetKey[]).map((k) => (
              <button
                key={k}
                className={`chip ${preset === k ? 'active' : ''}`}
                onClick={() => {
                  setPreset(k);
                  setWindow(PRESETS[k].window);
                  setResp(null);
                }}
                data-testid={`preset-${k}`}
              >
                {PRESETS[k].label}
              </button>
            ))}
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <label className="field">
              <span>窗口 token</span>
              <input type="number" value={window_} onChange={(e) => setWindow(Number(e.target.value))} aria-label="窗口 token" />
            </label>
            <label className="field">
              <span>组数</span>
              <input value={cfg.groups} readOnly aria-label="组数" />
            </label>
            <label className="field">
              <span>每组字符</span>
              <input value={cfg.chars} readOnly aria-label="每组字符" />
            </label>
            <button onClick={run} disabled={busy} data-testid="run" style={{ alignSelf: 'end' }}>
              {busy ? '压缩中…' : '执行压缩'}
            </button>
          </div>
        </section>

        {resp?.error && (
          <section className="card span12">
            <h2>错误</h2>
            <pre className="bad">{resp.error}</pre>
          </section>
        )}

        {resp?.report && (
          <>
            <section className="card span4">
              <h2>压缩结果</h2>
              <div className="big">
                <span className={levelClass(resp.report.level)} data-testid="level">
                  {levelName(resp.report.level)}
                </span>
              </div>
              <table>
                <tbody>
                  <tr><td className="muted">压缩前</td><td data-testid="before">{Math.round(resp.report.before)} tok</td></tr>
                  <tr><td className="muted">压缩后</td><td data-testid="after">{Math.round(resp.report.after)} tok</td></tr>
                  <tr><td className="muted">压缩比</td><td>{(ratio * 100).toFixed(1)}%</td></tr>
                  <tr><td className="muted">窗口</td><td>{window_} tok</td></tr>
                  <tr><td className="muted">校准差额</td><td>{Math.round(resp.report.overhead)}</td></tr>
                </tbody>
              </table>
              <div className="bar" style={{ marginTop: 12 }}>
                <i style={{ width: `${Math.min(100, ratio * 100)}%` }} />
              </div>
            </section>

            <section className="card span8">
              <h2>处理动作（{resp.report.actions.length}）</h2>
              {resp.report.actions.length === 0 ? (
                <div className="muted">未触发任何压缩：当前上下文仍在预算内。</div>
              ) : (
                <ul className="actions" data-testid="actions">
                  {resp.report.actions.map((a, i) => (
                    <li key={i}>{a}</li>
                  ))}
                </ul>
              )}
              {resp.summaryDisabled && <div className="warn" style={{ marginTop: 10 }}>未配置摘要模型，L2 已跳过（只做 L1/L3）。</div>}
            </section>

            <section className="card span12">
              <h2>压缩后的前几条消息</h2>
              <pre data-testid="preview">{raw}</pre>
            </section>
          </>
        )}
      </main>
    </>
  );
}
