// scripts/login.js
// 多账户登录逻辑：使用 Playwright (Chromium) 依次登录每个账户
// 支持多个账户的JSON格式：{"email1@example.com": "password1", "email2@example.com": "password2"}
// 环境变量（通过 GitHub Secrets 注入）：
//   USERNAME_AND_PASSWORD - 包含所有账户的JSON字符串
//   FEISHU_WEBHOOK - 飞书群机器人 Webhook 地址

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';
import { detectAndSolveRecaptcha, detectAndSolveTurnstile } from './captcha.js';

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
  const OVERALL_TIMEOUT = 300_000; // 5 分钟整体超时

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

  // 捕获 JS 控制台错误
  const jsErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') {
      jsErrors.push(msg.text().substring(0, 200));
      console.log(`[${username}] JS 错误: ${msg.text().substring(0, 150)}`);
    }
  });
  page.on('pageerror', err => {
    jsErrors.push(err.message.substring(0, 200));
    console.log(`[${username}] 页面异常: ${err.message.substring(0, 150)}`);
  });

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

    // 先发调试信息到飞书（在 2Captcha 调用之前）
    const debugMsg = [
      `API Key: ${apiKey ? '已配置' : '未配置'}`,
      `iframe 数量: ${debugInfo.iframeCount}`,
      `iframe 列表: ${debugInfo.iframeSrcs.join(' | ')}`,
      `grecaptcha 对象: ${debugInfo.hasGrecaptcha}`,
      `g-recaptcha div: ${JSON.stringify(debugInfo.gRecaptchaDiv)}`,
      `textarea: ${JSON.stringify(debugInfo.textarea)}`,
      `表单: ${JSON.stringify(debugInfo.forms)}`,
      `URL: ${debugInfo.url}`
    ].join('\n');
    await notifyFeishu({
      ok: true,
      stage: '页面状态',
      msg: debugMsg,
      username
    });

    console.log(`[${username}] 检测是否有 reCAPTCHA...`);
    const recaptchaSolved = apiKey ? await detectAndSolveRecaptcha(page, apiKey) : false;

    // 回调可能已经触发了登录跳转！先检查 URL
    const urlAfterRecaptcha = page.url();
    console.log(`[${username}] reCAPTCHA 后 URL: ${urlAfterRecaptcha}`);
    const loginSucceededEarly = !/\/auth\/login/i.test(urlAfterRecaptcha);

    if (loginSucceededEarly) {
      console.log(`[${username}] ✅ 回调触发了登录跳转！`);
      const sp = screenshot('03-login-success-via-callback');
      await page.screenshot({ path: sp, fullPage: true });
      await notifyFeishu({
        ok: true,
        stage: '登录结果',
        msg: `reCAPTCHA 回调直接触发了登录跳转！\nURL: ${urlAfterRecaptcha}`,
        screenshotPath: sp,
        username
      });
      return { success: true, username, message: '登录成功（回调触发跳转）' };
    }

    if (recaptchaSolved) {
      console.log(`[${username}] ✅ reCAPTCHA token 已注入`);

      // 等待回调处理
      await page.waitForTimeout(2000);

      // 详细检查 reCAPTCHA 状态和按钮状态
      const postInjectState = await page.evaluate(() => {
        const btn = document.querySelector('button[type="submit"], button');
        const ta = document.getElementById('g-recaptcha-response');
        let gr = 'unknown';
        try { const r = window.grecaptcha?.getResponse(0); gr = r ? `ok(${r.length})` : 'empty'; } catch (e) { gr = e.message; }

        // 查找页面上的所有函数名（可能包含登录处理函数）
        const globalFuncs = [];
        for (const key of Object.keys(window)) {
          try {
            if (typeof window[key] === 'function' && key.length < 30) {
              globalFuncs.push(key);
            }
          } catch {}
        }

        return {
          btnDisabled: btn?.disabled,
          btnText: btn?.textContent?.trim(),
          taLen: ta?.value?.length || 0,
          grecaptcha: gr,
          globalFuncs: globalFuncs.filter(f =>
            !f.startsWith('__') && !f.startsWith('webkit') &&
            !['toString','valueOf','hasOwnProperty','constructor','toLocaleString','isPrototypeOf','propertyIsEnumerable'].includes(f)
          ).slice(0, 30)
        };
      });
      console.log(`[${username}] 注入后状态: ${JSON.stringify(postInjectState)}`);

      // 飞书发送注入后状态
      await notifyFeishu({
        ok: true,
        stage: 'Token 注入后',
        msg: `按钮 disabled: ${postInjectState.btnDisabled}\n按钮文字: ${postInjectState.btnText}\nta 长度: ${postInjectState.taLen}\ngrecaptcha: ${postInjectState.grecaptcha}\n全局函数: ${postInjectState.globalFuncs.join(', ')}`,
        username
      });

      // 关闭 reCAPTCHA 挑战弹窗（遮罩层）
      await page.evaluate(() => {
        const challenges = document.querySelectorAll('iframe[title*="recaptcha challenge"]');
        challenges.forEach(iframe => {
          let el = iframe;
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

    // 先注入 JS 级别的 fetch/XHR 拦截器（在 Playwright 监听之前）
    const jsInterceptResult = await page.evaluate(() => {
      const result = { intercepted: false, calls: [] };

      // 拦截 fetch
      const origFetch = window.fetch;
      window.fetch = function(...args) {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
        const method = args[1]?.method || 'GET';
        const body = args[1]?.body || '';
        result.calls.push({ type: 'fetch', method, url: url.substring(0, 200), body: String(body).substring(0, 300) });
        result.intercepted = true;
        return origFetch.apply(this, args);
      };

      // 拦截 XMLHttpRequest
      const origXHROpen = XMLHttpRequest.prototype.open;
      const origXHRSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        this._interceptMethod = method;
        this._interceptUrl = url;
        return origXHROpen.call(this, method, url, ...rest);
      };
      XMLHttpRequest.prototype.send = function(body) {
        result.calls.push({ type: 'xhr', method: this._interceptMethod, url: (this._interceptUrl || '').substring(0, 200), body: String(body || '').substring(0, 300) });
        result.intercepted = true;
        return origXHRSend.call(this, body);
      };

      // 存储结果引用
      window.__interceptResult = result;
      return { ok: true };
    });
    console.log(`[${username}] JS 拦截器已注入: ${JSON.stringify(jsInterceptResult)}`);

    // 深度检查 reCAPTCHA 配置，搜索回调函数
    const recaptchaDebug = await page.evaluate(() => {
      const cfg = window.___grecaptcha_cfg;
      if (!cfg) return { hasCfg: false };

      const result = {
        hasCfg: true,
        cfgKeys: Object.keys(cfg),
        clientCount: cfg.clients ? Object.keys(cfg.clients).length : 0,
        callbacks: [],
        deepProperties: []
      };

      // 遍历 clients 的前2层，记录所有属性名和类型
      if (cfg.clients) {
        for (const [cid, client] of Object.entries(cfg.clients)) {
          const level1 = {};
          for (const [k, v] of Object.entries(client)) {
            level1[k] = typeof v;
            if (typeof v === 'function') {
              result.callbacks.push({ path: `clients.${cid}.${k}`, type: 'function' });
            }
            // 检查 level 2
            if (v && typeof v === 'object' && !(v instanceof HTMLElement)) {
              for (const [k2, v2] of Object.entries(v)) {
                if (typeof v2 === 'function') {
                  result.callbacks.push({ path: `clients.${cid}.${k}.${k2}`, type: 'function' });
                }
                // 检查 level 3
                if (v2 && typeof v2 === 'object' && !(v2 instanceof HTMLElement)) {
                  for (const [k3, v3] of Object.entries(v2)) {
                    if (typeof v3 === 'function') {
                      result.callbacks.push({ path: `clients.${cid}.${k}.${k2}.${k3}`, type: 'function' });
                    }
                    if (typeof v3 === 'string' && v3.length < 100) {
                      result.deepProperties.push({ path: `clients.${cid}.${k}.${k2}.${k3}`, value: v3 });
                    }
                  }
                }
              }
            }
          }
          result.deepProperties.push({ path: `clients.${cid}`, keys: Object.keys(level1).join(',') });
        }
      }

      // 也检查顶层的非 client 属性
      for (const [k, v] of Object.entries(cfg)) {
        if (k !== 'clients' && typeof v === 'function') {
          result.callbacks.push({ path: k, type: 'function' });
        }
      }

      return result;
    });
    console.log(`[${username}] reCAPTCHA 配置: ${JSON.stringify(recaptchaDebug).substring(0, 500)}`);

    // 检查表单和按钮的事件监听器
    const formDebug = await page.evaluate(() => {
      const form = document.querySelector('form');
      const btn = document.querySelector('button[type="submit"], button');
      const allInputs = document.querySelectorAll('input');
      const inputInfo = Array.from(allInputs).map(i => ({
        name: i.name, type: i.type, value: i.value?.substring(0, 30),
        id: i.id
      }));

      // 检查按钮的 onclick 属性
      const btnOnclick = btn?.getAttribute('onclick');
      const btnType = btn?.type;
      const btnClasses = btn?.className;

      // 检查表单的 onsubmit
      const formOnsubmit = form?.getAttribute('onsubmit');

      // 检查所有 script 标签的内容（只看前500字符）
      const scripts = Array.from(document.querySelectorAll('script[src]')).map(s => s.src);

      return {
        formAction: form?.action,
        formMethod: form?.method,
        formOnsubmit,
        btnOnclick,
        btnType,
        btnClasses,
        inputs: inputInfo,
        scriptSrcs: scripts.filter(s => !s.includes('recaptcha') && !s.includes('gstatic')).slice(0, 10)
      };
    });
    console.log(`[${username}] 表单详情: ${JSON.stringify(formDebug)}`);

    // 设置 Playwright 级别网络监听
    let loginApiCall = null;
    const allResponses = [];
    const responseHandler = async (response) => {
      const url = response.url();
      try {
        const status = response.status();
        let body = '';
        try { body = await response.text(); } catch {}
        allResponses.push({ url: url.substring(0, 200), status, body: body.substring(0, 300) });
      } catch {}
    };
    page.on('response', responseHandler);

    // 点击登录按钮（用 Playwright 原生点击）
    console.log(`[${username}] 点击登录按钮...`);
    try {
      await loginBtn.click({ timeout: 5_000, force: true });
      console.log(`[${username}] 按钮点击完成`);
    } catch (e) {
      console.log(`[${username}] 按钮点击失败: ${e.message}`);
    }

    // 等待可能的 API 响应
    await page.waitForTimeout(5000);

    // 检查 JS 拦截器捕获的调用
    const jsCalls = await page.evaluate(() => window.__interceptResult?.calls || []);
    console.log(`[${username}] JS 拦截到 ${jsCalls.length} 个调用`);
    for (const c of jsCalls) {
      console.log(`[${username}] JS 调用: ${c.type} ${c.method} ${c.url} body=${c.body?.substring(0, 100)}`);
    }

    const urlAfterClick = page.url();
    console.log(`[${username}] 点击后 URL: ${urlAfterClick}`);

    // 检查是否已经跳转（登录成功）
    if (!/\/auth\/login/i.test(urlAfterClick)) {
      console.log(`[${username}] ✅ 页面已跳转，登录成功！`);
      const sp = screenshot('03-redirect-success');
      await page.screenshot({ path: sp, fullPage: true });
      page.off('response', responseHandler);
      await notifyFeishu({
        ok: true,
        stage: '登录结果',
        msg: `页面已跳转到: ${urlAfterClick}`,
        screenshotPath: sp,
        username
      });
      return { success: true, username, message: '登录成功（页面跳转）' };
    }

    // 如果没有捕获到 API 调用，尝试更多方式
    if (jsCalls.length === 0 && allResponses.filter(r => !r.url.includes('recaptcha') && !r.url.includes('gstatic')).length === 0) {
      console.log(`[${username}] 无 API 调用，尝试其他方式...`);

      // 方式1: 尝试 dispatchEvent submit
      await page.evaluate(() => {
        const form = document.querySelector('form');
        if (form) {
          form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        }
      });
      await page.waitForTimeout(3000);

      // 方式2: 尝试直接调用 form.submit()
      const afterSubmit = await page.evaluate(() => {
        const calls = window.__interceptResult?.calls || [];
        return { calls: calls.length, url: window.location.href };
      });
      console.log(`[${username}] submit 后: ${JSON.stringify(afterSubmit)}`);

      if (afterSubmit.calls === 0) {
        // 方式3: 搜索页面上的所有按钮并尝试点击
        const btns = await page.evaluate(() => {
          return Array.from(document.querySelectorAll('button, input[type="submit"], a[role="button"]')).map(b => ({
            text: b.textContent?.trim()?.substring(0, 30),
            type: b.type,
            disabled: b.disabled,
            classes: b.className?.substring(0, 50)
          }));
        });
        console.log(`[${username}] 所有按钮: ${JSON.stringify(btns)}`);
      }
    }

    // 移除监听器
    page.off('response', responseHandler);

    // 收集所有信息发送飞书
    const finalJSCalls = await page.evaluate(() => window.__interceptResult?.calls || []);
    const nonStaticResponses = allResponses.filter(r =>
      !r.url.includes('recaptcha') && !r.url.includes('gstatic') &&
      !r.url.includes('.js') && !r.url.includes('.css') && !r.url.includes('favicon')
    );

    // 飞书发送详细调试信息
    const apiDebugMsg = [
      `点击后 URL: ${urlAfterClick}`,
      `JS 拦截调用: ${finalJSCalls.length}`,
      ...finalJSCalls.map(c => `  ${c.type} ${c.method} ${c.url} ${c.body?.substring(0, 100) || ''}`),
      `Playwright 响应: ${nonStaticResponses.length}`,
      ...nonStaticResponses.slice(0, 5).map(r => `  ${r.status} ${r.url}`),
      `reCAPTCHA 回调: ${recaptchaDebug.callbacks.length}`,
      ...recaptchaDebug.callbacks.map(c => `  ${c.path}`),
      `reCAPTCHA 属性: ${recaptchaDebug.deepProperties.slice(0, 10).map(p => `${p.path}=${p.value || p.keys || ''}`).join(' | ')}`,
      `表单: action=${formDebug.formAction} method=${formDebug.formMethod} onsubmit=${formDebug.formOnsubmit || '无'}`,
      `按钮: type=${formDebug.btnType} onclick=${formDebug.btnOnclick || '无'} classes=${formDebug.btnClasses}`,
      `输入框: ${formDebug.inputs.map(i => `${i.name}(${i.type})=${i.value}`).join(', ')}`,
      `脚本: ${formDebug.scriptSrcs.join(' | ')}`
    ].join('\n');
    await notifyFeishu({
      ok: finalJSCalls.length > 0 || nonStaticResponses.length > 0,
      stage: 'API 调试',
      msg: apiDebugMsg,
      username
    });

    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(2000);

    // 5) 再次检测是否仍有人机验证（先检查是否已跳转）
    const currentUrl = page.url();
    if (!/\/auth\/login/i.test(currentUrl)) {
      console.log(`[${username}] ✅ 页面已跳转到: ${currentUrl}`);
      const sp = screenshot('03-redirect-success');
      await page.screenshot({ path: sp, fullPage: true });
      await notifyFeishu({
        ok: true,
        stage: '登录结果',
        msg: `页面已跳转到: ${currentUrl}`,
        screenshotPath: sp,
        username
      });
      return { success: true, username, message: '登录成功（页面跳转）' };
    }

    const humanCheckAfterSubmit = await page.locator('text=/Verify you are human|需要验证|安全检查|review the security|Cloudflare|captcha|recaptcha|人机|验证|did not render/i').first();
    const pageContent = await page.locator('body').innerText().catch(() => '');
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
    const jsErrorInfo = jsErrors.length > 0 ? `\n\nJS 错误 (${jsErrors.length}):\n${jsErrors.slice(0, 5).join('\n')}` : '';
    await notifyFeishu({
      ok: false,
      stage: '登录结果',
      msg: errorMsg ? `登录失败: ${errorMsg}${jsErrorInfo}\n\n💡 建议：\n1. 检查账号密码是否正确\n2. 如果提示人机验证，手动登录一次后再试\n3. 查看截图了解详情` : '登录失败（原因未知）\n\n💡 建议：查看截图了解详情',
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
