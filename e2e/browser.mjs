/**
 * 浏览器端到端：React 控制台的真实交互。
 * 断言的是「打开页面 → 点预置场景 → 执行压缩 → 看到档位与 token 变化」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const OUT = path.resolve('results');
fs.mkdirSync(OUT, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const base = process.env.BASE_URL || 'http://127.0.0.1:8787';

const EXE = ['C:/Users/v-renhan/AppData/Local/ms-playwright/chromium-1255/chrome-win64/chrome.exe']
    .find((p) => fs.existsSync(p));

const checks = [];
const errors = [];
const check = (n, ok, d = '') => {
    checks.push({ n, ok, d });
    console.log(`${ok ? '✅' : '❌'} ${n}${d ? ` — ${d}` : ''}`);
};

const browser = await chromium.launch({ headless: true, ...(EXE ? { executablePath: EXE } : {}) });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));

try {
    const r = await page.goto(base + '/', { waitUntil: 'networkidle', timeout: 30_000 });
    check('页面可打开', r?.status() === 200, `HTTP ${r?.status()}`);
    check('React 已挂载', (await page.locator('#root').count()) === 1);
    check('场景按钮渲染', (await page.locator('[data-testid^="preset-"]').count()) >= 4);

    // 场景一：中等（应触发 L1/L2）
    await page.click('[data-testid="preset-medium"]');
    await page.click('[data-testid="run"]');
    await page.waitForSelector('[data-testid="level"]', { timeout: 60_000 });
    const lv = await page.locator('[data-testid="level"]').innerText();
    const before = await page.locator('[data-testid="before"]').innerText();
    const after = await page.locator('[data-testid="after"]').innerText();
    check('中等场景有压缩档位', lv.trim().length > 0, lv.trim());
    check('显示压缩前 token', /\d/.test(before), before);
    check('压缩后小于压缩前', Number(after.replace(/\D/g, '')) < Number(before.replace(/\D/g, '')), `${before} → ${after}`);
    check('列出了处理动作', (await page.locator('[data-testid="actions"] li').count()) > 0);

    // 场景二：超长（应到 L3）
    await page.click('[data-testid="preset-huge"]');
    await page.click('[data-testid="run"]');
    await page.waitForFunction(() => {
        const el = document.querySelector('[data-testid="level"]');
        return el && String(el.textContent || '').length > 0;
    }, { timeout: 60_000 });
    const lv2 = await page.locator('[data-testid="level"]').innerText();
    check('超长场景升级到更高档位', /L[23]/.test(lv2), lv2.trim());

    // 场景三：短会话（不该压缩）
    await page.click('[data-testid="preset-small"]');
    await page.click('[data-testid="run"]');
    await page.waitForFunction(() => {
        const el = document.querySelector('[data-testid="level"]');
        return el && String(el.textContent || '').length > 0;
    }, { timeout: 60_000 });
    const lv3 = await page.locator('[data-testid="level"]').innerText();
    check('短会话不触发压缩', /未压缩/.test(lv3), lv3.trim());

    await page.screenshot({ path: path.join(OUT, `browser-${stamp}.png`), fullPage: true });
    check('无控制台错误', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (e) {
    check('执行过程', false, String(e.message).slice(0, 160));
    await page.screenshot({ path: path.join(OUT, `browser-${stamp}-fail.png`), fullPage: true }).catch(() => {});
} finally {
    await browser.close();
}

const failed = checks.filter((c) => !c.ok).length;
fs.writeFileSync(path.join(OUT, `browser-${stamp}.json`), JSON.stringify({ base, checks, errors }, null, 2));
console.log(`\n${checks.length - failed}/${checks.length} 通过`);
process.exit(failed ? 1 : 0);
