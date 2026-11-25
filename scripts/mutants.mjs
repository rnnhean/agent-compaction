// 变异测试：逐个施加「植入的 bug」，跑测试，确认测试会变红。用完自动还原源码。
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const FILE = 'src/compactor.mjs';
const MUTANTS = [
    ['拆开 tool_use/tool_result 配对', 'if (isToolResultMsg(m) && groups.length) groups[groups.length - 1].push(m);', 'if (false) groups[0].push(m);'],
    ['摘要输入不脱敏', "return redact(lines.join('\\n'));", "return lines.join('\\n');"],
    ['不继承旧摘要', 'const prev = readSummary(goal);', "const prev = '';"],
    ['不校验摘要格式', 'if (validSummary(s)) summary', 'if (true) summary'],
    ['L3 不保留目标', 'out = normalize([{ role: \'user\', content: [...blocks(head), notice] }, ...keep]);', 'out = normalize([{ role: \'user\', content: [notice] }, ...keep]);'],
    ['最近组也被归档', 'if (gi === 0 || gi >= groups.length - keepRecent) return g;', 'if (gi === 0) return g;'],
];

const orig = fs.readFileSync(FILE, 'utf8');
let killed = 0;
try {
    for (const [name, from, to] of MUTANTS) {
        if (!orig.includes(from)) { console.log(`⚠ ${name}：源码里找不到要替换的片段，跳过`); continue; }
        fs.writeFileSync(FILE, orig.replace(from, to));
        const r = spawnSync('node', ['--test', 'test/'], { encoding: 'utf8' });
        const fail = Number((r.stdout.match(/^# fail (\d+)/m) || [, 0])[1]);
        if (fail > 0) killed++;
        console.log(`${fail > 0 ? '✅ 被抓住' : '❌ 存活  '} ${name}（${fail} 个测试失败）`);
    }
} finally {
    fs.writeFileSync(FILE, orig);
}
console.log(`\n${killed}/${MUTANTS.length} 个变异被测试抓住`);
process.exit(killed === MUTANTS.length ? 0 : 1);
