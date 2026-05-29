// scripts/login.js
// 多账户登录逻辑：使用 Playwright (Chromium) 依次登录每个账户
// 支持多个账户的JSON格式：{"email1@example.com": "password1", "email2@example.com": "password2"}
// 环境变量（通过 GitHub Secrets 注入）：
//   USERNAME_AND_PASSWORD - 包含所有账户的JSON字符串
//   FEISHU_WEBHOOK - 飞书群机器人 Webhook 地址

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';
import { detectAndSolveRecaptcha, detectAndSolveTurnstile, checkBalance } from './captcha.js';

// 启用 stealth 插件，绕过自动化检测
chromium.use(StealthPlugin());

const LOGIN_URL = 'https://ctrl.lunes.host/auth/login';
const MAX_RETRIES = 0; // 每个账户的最大重试次数（调试阶段先关闭）
const NAVIGATION_TIMEOUT = 60_000; // 导航超时时间（60秒）
const DEFAULT_WAIT_TIME = 5000; // 默认等待时间（5秒）

// 飞书 Webhook 通知
async function notifyFeishu({ ok, stage, msg, screenshotPath, username }) {
  try {
    const webhook = process.env.FEISHU_WEBHOOK;
    if (!webhook) {
      console.log('[WARN] FEISHU_WEBHOOK 未设置，跳过通知');
      return;
    }

    const title = `Lunes 自动登录${username ? ` (${username})` : ''}`;
    const status = ok ? '✅ 成功' : '❌ 失败';
    const lines = [
      `状态：${status}`,
      `阶段：${stage}`,
      msg ? `信息：${msg}` : '',
      `时间：${new Date().toISOString()}`,
      screenshotPath ? '（截图已保存到 GitHub Actions Artifacts）' : ''
    ].filter(Boolean);

    const content = lines.map(line => [{ tag: 'text', text: line }]);

    await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        msg_type: 'post',
        content: {
          post: {
            zh_cn: {
              title,
              content
            }
          }
        }
      })
    });
  } catch (e) {
    console.log('[WARN] 飞书通知失败：', e.message);
  }
}

// 发送汇总通知
async function sendSummaryNotification(results) {
  try {
    const webhook = process.env.FEISHU_WEBHOOK;
    if (!webhook) {
      console.log('[WARN] FEISHU_WEBHOOK 未设置，跳过汇总通知');
      return;
    }

    const successCount = results.filter(r => r.success).length;
    const totalCount = results.length;

    const lines = [
      `总账户数: ${totalCount}`,
      `成功: ${successCount}`,
      `失败: ${totalCount - successCount}`,
      '',
      '详细结果:',
      ...results.map((r, index) => {
        const status = r.success ? '✅ 成功' : '❌ 失败';
        const message = r.message ? ` (${r.message})` : '';
        const retry = r.retries > 0 ? ` [重试: ${r.retries}]` : '';
        return `${index + 1}. ${r.username}: ${status}${message}${retry}`;
      }),
      '',
      ...(totalCount - successCount > 0 ? [
        '💡 失败提示：',
        '• 如果提示人机验证，请手动登录一次后再重试',
        '• 检查截图了解具体错误原因',
        ''
      ] : []),
      `时间: ${new Date().toISOString()}`
    ];

    const content = lines.map(line => [{ tag: 'text', text: line }]);

    await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        msg_type: 'post',
        content: {
          post: {
            zh_cn: {
              title: '📊 Lunes 自动登录汇总报告',
              content
            }
          }
        }
      })
    });
  } catch (e) {
    console.log('[WARN] 飞书汇总通知失败：', e.message);
  }
}

function envOrThrow(name) {
  const v = process.env[name];
  if (!v) throw new Error(`环境变量 ${name} 未设置`);
  return v;
}

// 智能等待函数
async function smartWait(page, condition, timeout = 30000, checkInterval = 1000) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    try {
      const result = await condition();
      if (result) return result;
    } catch (e) {
      // 忽略检查过程中的错误，继续等待
    }
    await page.waitForTimeout(checkInterval);
  }
  return false;
}

async function loginWithAccount(username, password, index) {
  console.log(`\n=== 开始处理账户 ${index + 1}: ${username} ===`);

  try {
    let retryCount = 0;
    let result = null;

    // 重试机制
    while (retryCount <= MAX_RETRIES && !(result?.success)) {
      if (retryCount > 0) {
        console.log(`[${username}] 🔄 第 ${retryCount} 次重试...`);
        await new Promise(resolve => setTimeout(resolve, 5000));
      }

      try {
        result = await attemptLogin(username, password, index, retryCount);
      } catch (e) {
        console.error(`[${username}] 尝试 ${retryCount} 异常: ${e.message}`);
        result = { success: false, username, message: `异常: ${e.message}` };
        // 确保发送飞书通知
        await notifyFeishu({
          ok: false,
          stage: '异常',
          msg: `尝试 ${retryCount + 1} 失败: ${e.message}`,
          username
        });
      }
      retryCount++;

      if (result?.errorType === 'human_check' && !process.env.TWOCAPTCHA_API_KEY) {
        break;
      }
    }

    return { ...result, retries: retryCount - 1 };
  } catch (e) {
    // 最外层兜底
    console.error(`[${username}] 致命错误: ${e.message}`);
    await notifyFeishu({
      ok: false,
      stage: '致命错误',
      msg: e.message,
      username
    }).catch(() => {});
    return { success: false, username, message: `致命错误: ${e.message}`, retries: 0 };
  }
}

async function attemptLogin(username, password, index, retryCount) {
  const OVERALL_TIMEOUT = 240_000; // 4 分钟整体超时

  // 包装整体超时
  return Promise.race([
    attemptLoginCore(username, password, index, retryCount),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('整体超时（2分钟）')), OVERALL_TIMEOUT)
    )
  ]);
}

async function attemptLoginCore(username, password, index, retryCount) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
  });

  const page = await context.newPage();

  const screenshot = (name) => `./${name}-${index}-${username.replace(/[@.]/g, '_')}${retryCount > 0 ? `-retry${retryCount}` : ''}.png`;

  try {
    // 1) 打开登录页
    console.log(`[${username}] 打开登录页...`);
    await page.goto(LOGIN_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000
    });

    // 检测并尝试解决 Cloudflare Turnstile（页面级拦截）
    const apiKey = process.env.TWOCAPTCHA_API_KEY;
    const turnstileSolved = apiKey ? await detectAndSolveTurnstile(page, apiKey) : false;
    if (!turnstileSolved) {
      // 如果没有 Turnstile 或解决失败，再检查传统的人机验证文案
      const humanCheckText = await page.locator('text=/Verify you are human|需要验证|安全检查|review the security|Cloudflare/i').first();
      if (await humanCheckText.count()) {
        if (!apiKey) {
          const sp = screenshot('01-human-check');
          await page.screenshot({ path: sp, fullPage: true });
          await notifyFeishu({
            ok: false,
            stage: '打开登录页',
            msg: '检测到人机验证，但未配置 CAPSOLVER_API_KEY，无法自动解决。',
            screenshotPath: sp,
            username
          });
          return { success: false, username, message: '人机验证页面（未配置验证码解决服务）' };
        }
      }
    } else {
      console.log(`[${username}] ✅ Turnstile 已通过 2Captcha 解决`);
    }

    // 2) 等待输入框可见
    console.log(`[${username}] 等待登录表单加载...`);
    const userInput = page.locator('input[name="username"], input[type="email"], input[type="text"]').first();
    const passInput = page.locator('input[name="password"], input[type="password"]').first();

    // 使用智能等待确保元素完全可交互
    await smartWait(page, async () => {
      return await userInput.isVisible() && await passInput.isVisible();
    }, 30000);

    // 填充账户信息
    console.log(`[${username}] 填写登录信息...`);
    
    // 清空并填写用户名
    await userInput.click({ timeout: 10_000 });
    await userInput.evaluate(el => el.value = ''); // 更可靠的清空方式
    await userInput.fill(username, { timeout: 10_000 });
    
    // 清空并填写密码
    await passInput.click({ timeout: 10_000 });
    await passInput.evaluate(el => el.value = ''); // 更可靠的清空方式
    await passInput.fill(password, { timeout: 10_000 });

    // 3) 先解决 reCAPTCHA（按钮因验证码未通过而 disabled）
    const loginBtn = page.locator('button[type="submit"], button:has-text("登录"), button:has-text("Sign in"), button:has-text("Log in")').first();
    await loginBtn.waitFor({ state: 'visible', timeout: 15_000 });

    const spBefore = screenshot('02-before-submit');
    await page.screenshot({ path: spBefore, fullPage: true });

    // 等待 reCAPTCHA 异步加载
    console.log(`[${username}] 等待 reCAPTCHA 加载...`);
    await page.waitForTimeout(3000);

    // 收集页面调试信息
    const debugInfo = await page.evaluate(() => {
      const iframes = document.querySelectorAll('iframe');
      const iframeSrcs = Array.from(iframes).map(f => f.src?.substring(0, 120) || 'no-src');
      const hasGrecaptcha = !!window.grecaptcha;
      const hasCfg = !!window.___grecaptcha_cfg;
      const gRecaptchaDiv = document.querySelector('.g-recaptcha, [data-sitekey]');
      const textarea = document.getElementById('g-recaptcha-response');
      const forms = document.querySelectorAll('form');
      const formData = Array.from(forms).map(f => ({ action: f.action, method: f.method }));
      return {
        iframeCount: iframes.length,
        iframeSrcs,
        hasGrecaptcha,
        hasCfg,
        gRecaptchaDiv: gRecaptchaDiv ? { tag: gRecaptchaDiv.tagName, sitekey: gRecaptchaDiv.getAttribute('data-sitekey')?.substring(0, 20) } : null,
        textarea: textarea ? { id: textarea.id, valueLen: textarea.value?.length } : null,
        forms: formData,
        url: window.location.href
      };
    });
    console.log(`[${username}] 页面调试信息: ${JSON.stringify(debugInfo)}`);

    console.log(`[${username}] 检测是否有 reCAPTCHA...`);
    const recaptchaSolved = apiKey ? await detectAndSolveRecaptcha(page, apiKey) : false;

    // 检查 2Captcha 余额
    let balanceInfo = '未检查';
    if (apiKey) {
      const bal = await checkBalance(apiKey);
      balanceInfo = bal.ok ? `$${bal.balance}` : `错误: ${bal.error}`;
    }

    // 发送调试信息到飞书
    const debugMsg = [
      `2Captcha 余额: ${balanceInfo}`,
      `API Key: ${apiKey ? '已配置' : '未配置'}`,
      `reCAPTCHA 检测: ${recaptchaSolved ? '成功' : '未检测到/失败'}`,
      `iframe 数量: ${debugInfo.iframeCount}`,
      `iframe 列表: ${debugInfo.iframeSrcs.join(' | ')}`,
      `grecaptcha 对象: ${debugInfo.hasGrecaptcha}`,
      `g-recaptcha div: ${JSON.stringify(debugInfo.gRecaptchaDiv)}`,
      `textarea: ${JSON.stringify(debugInfo.textarea)}`,
      `表单: ${JSON.stringify(debugInfo.forms)}`,
      `URL: ${debugInfo.url}`
    ].join('\n');
    await notifyFeishu({
      ok: recaptchaSolved,
      stage: 'reCAPTCHA 检测',
      msg: debugMsg,
      username
    });

    if (recaptchaSolved) {
      console.log(`[${username}] ✅ reCAPTCHA token 已注入`);

      // 等待一下让回调处理完成
      await page.waitForTimeout(2000);

      // 检查 reCAPTCHA 是否真的被标记为已解决
      const isSolved = await page.evaluate(() => {
        try {
          if (window.grecaptcha) {
            const response = window.grecaptcha.getResponse(0);
            if (response && response.length > 0) return { solved: true, len: response.length };
          }
        } catch (e) { /* 忽略 */ }
        const textarea = document.getElementById('g-recaptcha-response');
        if (textarea && textarea.value && textarea.value.length > 0) {
          return { solved: true, len: textarea.value.length, source: 'textarea' };
        }
        return { solved: false };
      });
      console.log(`[${username}] reCAPTCHA 解决状态: ${JSON.stringify(isSolved)}`);

      // 关闭 reCAPTCHA 挑战弹窗（遮罩层）
      await page.evaluate(() => {
        const challenges = document.querySelectorAll('iframe[title*="recaptcha challenge"]');
        challenges.forEach(iframe => {
          let el = iframe;
          // 向上找到包含 iframe 的容器并隐藏
          for (let i = 0; i < 5; i++) {
            if (el.parentElement && el.parentElement !== document.body) {
              el = el.parentElement;
              if (el.style) el.style.display = 'none';
            }
          }
        });
      });
      await page.waitForTimeout(500);
    }

    // 4) 提交登录
    console.log(`[${username}] 提交登录...`);

    // 先检查 form 的 action 和 method
    const formInfo = await page.evaluate(() => {
      const form = document.querySelector('form');
      if (!form) return { hasForm: false };
      return {
        hasForm: true,
        action: form.action,
        method: form.method,
        hasSubmitEvent: !!form.onsubmit
      };
    });
    console.log(`[${username}] 表单信息: ${JSON.stringify(formInfo)}`);

    const navigationPromise = page.waitForNavigation({
      waitUntil: 'networkidle',
      timeout: NAVIGATION_TIMEOUT
    }).catch(e => {
      console.log(`[${username}] 导航等待可能超时: ${e.message}`);
      return null;
    });

    // 方式1: 尝试直接点击按钮（force 绕过遮挡）
    let clicked = false;
    try {
      await loginBtn.click({ timeout: 5_000, force: true });
      clicked = true;
      console.log(`[${username}] 通过按钮点击提交`);
    } catch (e) {
      console.log(`[${username}] 按钮点击失败: ${e.message}`);
    }

    // 方式2: 如果按钮点击失败，用 JS 直接提交表单
    if (!clicked) {
      console.log(`[${username}] 尝试 JS 直接提交表单...`);
      await page.evaluate(() => {
        const form = document.querySelector('form');
        if (form) {
          // 创建并触发表单提交事件
          const submitEvent = new Event('submit', { bubbles: true, cancelable: true });
          form.dispatchEvent(submitEvent);
          // 也直接调用 submit
          form.submit();
        }
      });
    }

    await navigationPromise;

    console.log(`[${username}] 等待页面完全稳定...`);
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(3000);

    // 5) 再次检测是否仍有人机验证
    const humanCheckAfterSubmit = await page.locator('text=/Verify you are human|需要验证|安全检查|review the security|Cloudflare|captcha|recaptcha|人机|验证|did not render/i').first();
    const pageContent = await page.locator('body').innerText().catch(() => '');
    const currentUrl = page.url();
    const hasHumanCheck = await humanCheckAfterSubmit.count() > 0;
    const hasRenderError = pageContent.includes('did not render');

    if ((hasHumanCheck || hasRenderError) && !recaptchaSolved) {
      const sp = screenshot('03-human-check-after-submit');
      await page.screenshot({ path: sp, fullPage: true });
      await notifyFeishu({
        ok: false,
        stage: '登录结果',
        msg: apiKey
          ? `🔐 人机验证未解决\n\nURL: ${currentUrl}\n检测到验证: ${hasHumanCheck}\n渲染错误: ${hasRenderError}`
          : '🔐 未配置 CAPSOLVER_API_KEY',
        screenshotPath: sp,
        username
      });
      return { success: false, username, message: '🔐 触发人机验证，自动解决失败', errorType: 'human_check' };
    }

    if (hasRenderError && recaptchaSolved) {
      const sp = screenshot('03-render-error');
      await page.screenshot({ path: sp, fullPage: true });
      await notifyFeishu({
        ok: false,
        stage: '登录结果',
        msg: `🔐 reCAPTCHA 渲染错误（token 注入后）\n\nURL: ${currentUrl}\n\n这通常意味着：\n1. 服务器拒绝了 2Captcha 的 token\n2. token 已过期\n3. reCAPTCHA 回调未正确触发`,
        screenshotPath: sp,
        username
      });
      return { success: false, username, message: 'reCAPTCHA 渲染错误', errorType: 'human_check' };
    }

    // 5) 判定是否登录成功
    const spAfter = screenshot('04-after-submit');
    await page.screenshot({ path: spAfter, fullPage: true });

    const url = page.url();
    console.log(`[${username}] 当前URL: ${url}`);
    
    // 多种方式检测登录成功
    const successSelectors = [
      'text=/Dashboard|控制台|面板|仪表板/i',
      'text=/Logout|Sign out|退出|登出/i',
      'text=/Welcome|欢迎/i',
      'text=/Account|账户|账号/i',
      'text=/Profile|个人资料/i'
    ];
    
    let successHint = 0;
    for (const selector of successSelectors) {
      const element = page.locator(selector);
      const count = await element.count();
      successHint += count;
      if (count > 0) {
        console.log(`[${username}] 找到成功标识: ${selector}`);
        break;
      }
    }
    
    const stillOnLogin = /\/auth\/login/i.test(url);

    if (!stillOnLogin || successHint > 0) {
      console.log(`[${username}] ✅ 登录成功`);
      await notifyFeishu({
        ok: true,
        stage: '登录结果',
        msg: `判断为成功。当前 URL：${url}`,
        screenshotPath: spAfter,
        username
      });
      return { success: true, username, message: '登录成功' };
    }

    // 若还在登录页，进一步检测错误提示
    const errorSelectors = [
      'text=/Invalid|incorrect|错误|失败|无效|不正确/i',
      'text=/Error|异常|问题/i',
      '.error-message',
      '.alert-error',
      '.text-danger',
      '[class*="error"]',
      '[class*="alert"]',
      '[class*="danger"]'
    ];
    
    let errorMsg = '';
    for (const selector of errorSelectors) {
      const errorElement = page.locator(selector);
      if (await errorElement.count() > 0) {
        errorMsg = await errorElement.first().innerText().catch(() => '');
        if (errorMsg && errorMsg.length > 1) { // 确保不是空字符串或单个字符
          console.log(`[${username}] 找到错误信息: ${errorMsg}`);
          break;
        }
      }
    }

    // 如果没有找到明确的错误信息，或者错误信息太模糊，给出更友好的提示
    if (!errorMsg || errorMsg === 'ERROR' || errorMsg.length < 3) {
      // 检查是否有导航超时（通常意味着页面卡住，可能是人机验证）
      const pageTitle = await page.title();
      const mainContent = await page.locator('body').innerText().catch(() => '');

      if (stillOnLogin) {
        // 仍在登录页，可能是人机验证或网络问题
        errorMsg = '🔐 可能触发了人机验证或网络问题';
      } else if (pageTitle.includes('Error') || mainContent.includes('Error')) {
        errorMsg = '⚠️ 页面显示错误状态';
      } else {
        errorMsg = '❓ 未知原因，请检查截图';
      }
    }

    console.log(`[${username}] ❌ 登录失败: ${errorMsg}`);
    await notifyFeishu({
      ok: false,
      stage: '登录结果',
      msg: errorMsg ? `登录失败: ${errorMsg}\n\n💡 建议：\n1. 检查账号密码是否正确\n2. 如果提示人机验证，手动登录一次后再试\n3. 查看截图了解详情` : '登录失败（原因未知）\n\n💡 建议：查看截图了解详情',
      screenshotPath: spAfter,
      username
    });
    
    return { success: false, username, message: errorMsg || '登录失败' };
  } catch (e) {
    const sp = screenshot('99-error');
    try { await page.screenshot({ path: sp, fullPage: true }); } catch {}
    console.error(`[${username}] 💥 发生异常:`, e.message);
    await notifyFeishu({
      ok: false,
      stage: '异常',
      msg: e?.message || String(e),
      screenshotPath: fs.existsSync(sp) ? sp : undefined,
      username
    });
    return { success: false, username, message: `异常: ${e.message}` };
  } finally {
    await context.close();
    await browser.close();
  }
}

async function main() {
  try {
    const usernameAndPasswordJson = envOrThrow('USERNAME_AND_PASSWORD');
    let accounts;
    
    try {
      accounts = JSON.parse(usernameAndPasswordJson);
    } catch (e) {
      throw new Error('USERNAME_AND_PASSWORD 格式错误，应为有效的 JSON 字符串');
    }

    if (typeof accounts !== 'object' || accounts === null) {
      throw new Error('USERNAME_AND_PASSWORD 应为对象格式');
    }

    const accountEntries = Object.entries(accounts);
    if (accountEntries.length === 0) {
      throw new Error('未找到有效的账户信息');
    }

    console.log(`找到 ${accountEntries.length} 个账户，开始依次处理...`);

    const results = [];
    for (let i = 0; i < accountEntries.length; i++) {
      const [username, password] = accountEntries[i];
      console.log(`\n=== 开始处理账户 ${i + 1}/${accountEntries.length}: ${username} ===`);
      
      const result = await loginWithAccount(username, password, i);
      results.push(result);
      
      console.log(`=== 完成处理账户 ${i + 1}/${accountEntries.length}: ${username} ===`);
      
      // 在账户之间添加延迟，避免请求过于频繁
      if (i < accountEntries.length - 1) {
        const delay = 5000 + Math.random() * 5000; // 5-10秒随机延迟
        console.log(`等待 ${Math.round(delay/1000)} 秒后处理下一个账户...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    // 发送汇总通知
    console.log('所有账户处理完成，发送汇总通知...');
    await sendSummaryNotification(results);

    // 检查是否有失败的登录
    const hasFailure = results.some(r => !r.success);
    if (hasFailure) {
      console.log('⚠️  有部分账户登录失败，请检查日志和通知');
      process.exitCode = 1;
    } else {
      console.log('✅ 所有账户登录成功');
      process.exitCode = 0;
    }

  } catch (e) {
    console.error('[ERROR] 初始化失败:', e.message);
    await notifyFeishu({
      ok: false,
      stage: '初始化',
      msg: e.message,
      username: 'N/A'
    });
    process.exitCode = 1;
  }
}

await main();
