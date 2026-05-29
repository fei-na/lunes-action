// scripts/captcha.js
// CapSolver API 集成，支持 reCAPTCHA v2 和 Cloudflare Turnstile

const CAPSOLVER_API_BASE = 'https://api.capsolver.com';
const POLL_INTERVAL = 3000; // 轮询间隔 3 秒
const MAX_WAIT_TIME = 180_000; // 最大等待 3 分钟

/**
 * 通用 CapSolver 任务提交和轮询
 */
async function solveWithCapSolver(task, apiKey) {
  console.log(`[CAPTCHA] 提交 CapSolver 任务: ${task.type}`);

  // 1. 创建任务
  const createRes = await fetch(`${CAPSOLVER_API_BASE}/createTask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientKey: apiKey, task }),
    signal: AbortSignal.timeout(30_000),
  });
  const createData = await createRes.json();

  if (createData.errorId !== 0) {
    throw new Error(`CapSolver 创建任务失败: ${createData.errorDescription || createData.errorCode}`);
  }

  const taskId = createData.taskId;
  console.log(`[CAPTCHA] 任务已创建, ID: ${taskId}`);

  // 2. 轮询结果
  const startTime = Date.now();
  while (Date.now() - startTime < MAX_WAIT_TIME) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`[CAPTCHA] 轮询结果... (${elapsed}s)`);

    try {
      const resultRes = await fetch(`${CAPSOLVER_API_BASE}/getTaskResult`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: apiKey, taskId }),
        signal: AbortSignal.timeout(15_000),
      });
      const resultData = await resultRes.json();

      if (resultData.errorId !== 0) {
        throw new Error(`CapSolver 查询失败: ${resultData.errorDescription || resultData.errorCode}`);
      }

      if (resultData.status === 'ready') {
        console.log(`[CAPTCHA] 解决成功! 耗时 ${elapsed}s`);
        return resultData.solution;
      }

      // processing - 继续等待
      console.log(`[CAPTCHA] 处理中...`);
    } catch (e) {
      if (e.name === 'TimeoutError' || e.name === 'AbortError') {
        console.log(`[CAPTCHA] 单次请求超时，重试...`);
        continue;
      }
      throw e;
    }
  }

  throw new Error(`CapSolver 超时（${Math.round(MAX_WAIT_TIME / 1000)}秒未返回结果）`);
}

/**
 * 解决 reCAPTCHA v2
 */
export async function solveRecaptchaV2(siteKey, pageUrl, apiKey) {
  console.log(`[CAPTCHA] 开始解决 reCAPTCHA v2, siteKey: ${siteKey}, URL: ${pageUrl}`);
  const solution = await solveWithCapSolver({
    type: 'ReCaptchaV2TaskProxyLess',
    websiteURL: pageUrl,
    websiteKey: siteKey,
  }, apiKey);

  const token = solution.gRecaptchaResponse;
  console.log(`[CAPTCHA] 获得 token (前20字符): ${token.substring(0, 20)}... (长度: ${token.length})`);
  return token;
}

/**
 * 解决 Cloudflare Turnstile
 */
export async function solveTurnstile(siteKey, pageUrl, apiKey) {
  console.log(`[CAPTCHA] 开始解决 Turnstile, siteKey: ${siteKey}`);
  const solution = await solveWithCapSolver({
    type: 'AntiTurnstileTaskProxyLess',
    websiteURL: pageUrl,
    websiteKey: siteKey,
  }, apiKey);
  return solution.token;
}

/**
 * 在页面中检测并解决 reCAPTCHA v2
 */
export async function detectAndSolveRecaptcha(page, apiKey) {
  // 检测 reCAPTCHA
  const recaptchaIframeCount = await page.locator('iframe[src*="recaptcha"], iframe[src*="google.com/recaptcha"], iframe[src*="recaptcha.net"]').count();
  const gRecaptchaDiv = await page.locator('.g-recaptcha, [data-sitekey]').count();
  const gRecaptchaTextarea = await page.locator('#g-recaptcha-response, textarea[name="g-recaptcha-response"]').count();

  console.log(`[CAPTCHA] 检测结果: iframe=${recaptchaIframeCount}, div=${gRecaptchaDiv}, textarea=${gRecaptchaTextarea}`);

  if (recaptchaIframeCount === 0 && gRecaptchaDiv === 0 && gRecaptchaTextarea === 0) {
    console.log('[CAPTCHA] 未检测到 reCAPTCHA');
    return false;
  }

  // 提取 sitekey
  let siteKey = await page.evaluate(() => {
    // 方式1: data-sitekey div
    const div = document.querySelector('.g-recaptcha, [data-sitekey]');
    if (div?.getAttribute('data-sitekey')) {
      return { key: div.getAttribute('data-sitekey'), method: 'data-sitekey' };
    }

    // 方式2: iframe src
    for (const iframe of document.querySelectorAll('iframe')) {
      if (iframe.src?.includes('recaptcha')) {
        const match = iframe.src.match(/k=([^&]+)/);
        if (match) return { key: match[1], method: 'iframe src' };
      }
    }

    // 方式3: script 内容
    for (const script of document.querySelectorAll('script')) {
      const match = script.textContent?.match(/['"]?sitekey['"]?\s*[:=]\s*['"]([0-9A-Za-z_-]{20,})['"]/);
      if (match) return { key: match[1], method: 'script' };
    }

    // 方式4: ___grecaptcha_cfg
    if (window.___grecaptcha_cfg?.clients) {
      for (const id in window.___grecaptcha_cfg.clients) {
        const key = findKey(window.___grecaptcha_cfg.clients[id], 0);
        if (key) return { key, method: 'grecaptcha_cfg' };
      }
    }

    function findKey(obj, d) {
      if (d > 5 || !obj || typeof obj !== 'object') return null;
      for (const k in obj) {
        if (k === 'sitekey' && typeof obj[k] === 'string' && obj[k].length > 20) return obj[k];
        if (typeof obj[k] === 'object') { const f = findKey(obj[k], d + 1); if (f) return f; }
      }
      return null;
    }

    return null;
  });

  if (siteKey?.key) {
    console.log(`[CAPTCHA] siteKey: ${siteKey.key} (${siteKey.method})`);
    siteKey = siteKey.key;
  } else if (!siteKey) {
    // Playwright 层面提取
    const count = await page.locator('iframe[src*="recaptcha"], iframe[src*="recaptcha.net"]').count();
    for (let i = 0; i < count; i++) {
      const src = await page.locator('iframe[src*="recaptcha"], iframe[src*="recaptcha.net"]').nth(i).getAttribute('src').catch(() => null);
      const match = src?.match(/k=([^&]+)/);
      if (match) { siteKey = match[1]; break; }
    }
  }

  if (!siteKey) {
    console.log('[CAPTCHA] 无法提取 siteKey');
    return false;
  }

  console.log(`[CAPTCHA] 最终 siteKey: ${siteKey}, URL: ${page.url()}`);

  // 调用 CapSolver
  const token = await solveRecaptchaV2(siteKey, page.url(), apiKey);

  // 重置 reCAPTCHA
  await page.evaluate(() => {
    try { window.grecaptcha?.reset(0); } catch (e) {}
  });
  await page.waitForTimeout(500);

  // 注入 token
  const injectionResult = await page.evaluate((token) => {
    const result = { textareaSet: false, callbackTriggered: false, callbackFound: null };

    // 设置 textarea
    for (const ta of document.querySelectorAll('#g-recaptcha-response, textarea[name="g-recaptcha-response"]')) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter ? setter.call(ta, token) : (ta.value = token);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
      result.textareaSet = true;
    }

    // 查找并触发回调
    const cbNames = [];
    for (const el of document.querySelectorAll('[data-callback]')) {
      const cb = el.getAttribute('data-callback');
      if (cb) cbNames.push(cb);
    }

    // 常见回调名
    cbNames.push('onRecaptchaSuccess', 'recaptchaCallback', 'captchaCallback',
      'onCaptchaVerified', 'verifyCallback', 'onVerify', 'captchaVerified');

    // 从 grecaptcha_cfg 搜索
    if (window.___grecaptcha_cfg?.clients) {
      for (const id in window.___grecaptcha_cfg.clients) {
        searchCb(window.___grecaptcha_cfg.clients[id], cbNames, 0);
      }
    }

    // 触发回调
    for (const name of cbNames) {
      if (name && typeof window[name] === 'function') {
        try { window[name](token); result.callbackTriggered = true; result.callbackFound = name; } catch (e) {}
      }
    }

    // 深度搜索并触发
    if (window.___grecaptcha_cfg?.clients) {
      for (const id in window.___grecaptcha_cfg.clients) {
        triggerDeep(window.___grecaptcha_cfg.clients[id], token, 0, result);
      }
    }

    function searchCb(obj, names, d) {
      if (d > 8 || !obj || typeof obj !== 'object') return;
      const skip = ['CSSStyleSheet', 'CSSStyleDeclaration', 'CSSRule', 'StyleSheet'];
      if (obj.constructor?.name && skip.includes(obj.constructor.name)) return;
      try { for (const k in obj) {
        try {
          if (typeof obj[k] === 'function' && (k === 'callback' || k.includes('allback'))) names.push(null);
          if (typeof obj[k] === 'object' && obj[k] !== null) searchCb(obj[k], names, d + 1);
        } catch (e) {}
      }} catch (e) {}
    }

    function triggerDeep(obj, token, d, r) {
      if (d > 8 || !obj || typeof obj !== 'object') return;
      const skip = ['CSSStyleSheet', 'CSSStyleDeclaration', 'CSSRule', 'StyleSheet'];
      if (obj.constructor?.name && skip.includes(obj.constructor.name)) return;
      try { for (const k in obj) {
        try {
          if (typeof obj[k] === 'function' && (k === 'callback' || k.includes('allback') || k === 'success' || k === 'onSuccess')) {
            try { obj[k](token); r.callbackTriggered = true; r.callbackFound = `obj.${k}`; } catch (e) {}
          }
          if (typeof obj[k] === 'object' && obj[k] !== null) triggerDeep(obj[k], token, d + 1, r);
        } catch (e) {}
      }} catch (e) {}
    }

    return result;
  }, token);

  console.log(`[CAPTCHA] 注入: textarea=${injectionResult.textareaSet}, 回调=${injectionResult.callbackFound || '未找到'}, 触发=${injectionResult.callbackTriggered}`);

  // 验证
  const verify = await page.evaluate(() => {
    const ta = document.getElementById('g-recaptcha-response');
    let gr = 'no grecaptcha';
    try { const r = window.grecaptcha?.getResponse(0); gr = r ? `ok(${r.length})` : 'empty'; } catch (e) { gr = `err: ${e.message}`; }
    return { taLen: ta?.value?.length || 0, gr };
  });
  console.log(`[CAPTCHA] 验证 - textarea: ${verify.taLen}, grecaptcha: ${verify.gr}`);

  return true;
}

/**
 * 在页面中检测并解决 Cloudflare Turnstile
 */
export async function detectAndSolveTurnstile(page, apiKey) {
  const has = await page.locator('iframe[src*="challenges.cloudflare.com"]').count();
  if (!has) return false;

  const siteKey = await page.evaluate(() => {
    return document.querySelector('[data-sitekey]')?.getAttribute('data-sitekey') ||
      document.querySelector('input[name="cf-turnstile-response"]')?.parentElement?.getAttribute('data-sitekey') ||
      null;
  });

  if (!siteKey) return false;
  console.log(`[CAPTCHA] Turnstile siteKey: ${siteKey}`);

  const token = await solveTurnstile(siteKey, page.url(), apiKey);

  await page.evaluate((token) => {
    const cf = document.querySelector('input[name="cf-turnstile-response"]');
    if (cf) cf.value = token;
    const gr = document.querySelector('input[name="g-recaptcha-response"]');
    if (gr) gr.value = token;
  }, token);

  return true;
}
