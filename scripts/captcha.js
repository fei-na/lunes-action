// scripts/captcha.js
// 2Captcha API 集成，支持 reCAPTCHA v2 和 Cloudflare Turnstile

const TWOCAPTCHA_API_BASE = 'http://2captcha.com';
const POLL_INTERVAL = 5000; // 轮询间隔 5 秒
const MAX_WAIT_TIME = 90_000; // 最大等待 90 秒

/**
 * 通过 2Captcha 解决 reCAPTCHA v2
 * @param {string} siteKey - reCAPTCHA 的 sitekey
 * @param {string} pageUrl - 页面 URL
 * @param {string} apiKey - 2Captcha API key
 * @returns {Promise<string>} - 解决后的 token
 */
export async function solveRecaptchaV2(siteKey, pageUrl, apiKey) {
  console.log(`[CAPTCHA] 开始解决 reCAPTCHA v2, siteKey: ${siteKey}`);

  // 提交任务
  const submitUrl = new URL('/in.php', TWOCAPTCHA_API_BASE);
  submitUrl.searchParams.set('key', apiKey);
  submitUrl.searchParams.set('method', 'userrecaptcha');
  submitUrl.searchParams.set('googlekey', siteKey);
  submitUrl.searchParams.set('pageurl', pageUrl);
  submitUrl.searchParams.set('json', '1');

  const submitRes = await fetch(submitUrl.toString(), { method: 'POST' });
  const submitData = await submitRes.json();

  if (submitData.status !== 1) {
    throw new Error(`2Captcha 提交失败: ${submitData.request}`);
  }

  const taskId = submitData.request;
  console.log(`[CAPTCHA] 任务已提交, ID: ${taskId}`);

  // 轮询结果
  return await pollResult(taskId, apiKey);
}

/**
 * 通过 2Captcha 解决 Cloudflare Turnstile
 * @param {string} siteKey - Turnstile 的 sitekey
 * @param {string} pageUrl - 页面 URL
 * @param {string} apiKey - 2Captcha API key
 * @returns {Promise<string>} - 解决后的 token
 */
export async function solveTurnstile(siteKey, pageUrl, apiKey) {
  console.log(`[CAPTCHA] 开始解决 Turnstile, siteKey: ${siteKey}`);

  const submitUrl = new URL('/in.php', TWOCAPTCHA_API_BASE);
  submitUrl.searchParams.set('key', apiKey);
  submitUrl.searchParams.set('method', 'turnstile');
  submitUrl.searchParams.set('sitekey', siteKey);
  submitUrl.searchParams.set('pageurl', pageUrl);
  submitUrl.searchParams.set('json', '1');

  const submitRes = await fetch(submitUrl.toString(), { method: 'POST' });
  const submitData = await submitRes.json();

  if (submitData.status !== 1) {
    throw new Error(`2Captcha 提交失败: ${submitData.request}`);
  }

  const taskId = submitData.request;
  console.log(`[CAPTCHA] 任务已提交, ID: ${taskId}`);

  return await pollResult(taskId, apiKey);
}

/**
 * 轮询获取结果
 */
async function pollResult(taskId, apiKey) {
  const startTime = Date.now();

  while (Date.now() - startTime < MAX_WAIT_TIME) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));

    const resultUrl = new URL('/res.php', TWOCAPTCHA_API_BASE);
    resultUrl.searchParams.set('key', apiKey);
    resultUrl.searchParams.set('action', 'get');
    resultUrl.searchParams.set('id', taskId);
    resultUrl.searchParams.set('json', '1');

    const resultRes = await fetch(resultUrl.toString());
    const resultData = await resultRes.json();

    if (resultData.status === 1) {
      console.log(`[CAPTCHA] 解决成功! 耗时 ${Math.round((Date.now() - startTime) / 1000)}s`);
      return resultData.request;
    }

    if (resultData.request !== 'CAPCHA_NOT_READY') {
      throw new Error(`2Captcha 查询失败: ${resultData.request}`);
    }

    console.log(`[CAPTCHA] 等待中... (${Math.round((Date.now() - startTime) / 1000)}s)`);
  }

  throw new Error('2Captcha 超时（5分钟未返回结果）');
}

/**
 * 在页面中检测并解决 reCAPTCHA v2
 * @param {import('playwright').Page} page - Playwright 页面对象
 * @param {string} apiKey - 2Captcha API key
 * @returns {Promise<boolean>} - 是否成功解决
 */
export async function detectAndSolveRecaptcha(page, apiKey) {
  // 检测 reCAPTCHA - 多种方式
  const recaptchaIframeCount = await page.locator('iframe[src*="recaptcha"], iframe[src*="google.com/recaptcha"]').count();
  const gRecaptchaDiv = await page.locator('.g-recaptcha, [data-sitekey]').count();
  const gRecaptchaTextarea = await page.locator('#g-recaptcha-response, textarea[name="g-recaptcha-response"]').count();

  console.log(`[CAPTCHA] 检测结果: iframe=${recaptchaIframeCount}, div=${gRecaptchaDiv}, textarea=${gRecaptchaTextarea}`);

  if (recaptchaIframeCount === 0 && gRecaptchaDiv === 0 && gRecaptchaTextarea === 0) {
    console.log('[CAPTCHA] 未检测到 reCAPTCHA');
    return false;
  }

  // 提取 sitekey - 多种方式，带详细日志
  let siteKey = await page.evaluate(() => {
    // 方式1: 从 g-recaptcha 的 div 属性中提取
    const recaptchaDiv = document.querySelector('.g-recaptcha, [data-sitekey]');
    if (recaptchaDiv) {
      const key = recaptchaDiv.getAttribute('data-sitekey');
      if (key) return { key, method: 'data-sitekey div' };
    }

    // 方式2: 从 iframe src 中提取
    const iframes = document.querySelectorAll('iframe');
    for (const iframe of iframes) {
      const src = iframe.src || '';
      if (src.includes('recaptcha') || src.includes('google.com/recaptcha')) {
        const match = src.match(/k=([^&]+)/);
        if (match) return { key: match[1], method: `iframe src (${src.substring(0, 80)}...)` };
      }
    }

    // 方式3: 从页面 script 中提取
    const scripts = document.querySelectorAll('script');
    for (const script of scripts) {
      const text = script.textContent || '';
      // 匹配各种格式: sitekey: "xxx", sitekey='xxx', "sitekey":"xxx"
      const match = text.match(/['"]?sitekey['"]?\s*[:=]\s*['"]([0-9A-Za-z_-]{20,})['"]/);
      if (match) return { key: match[1], method: 'script content' };
    }

    // 方式4: 从全局变量中提取
    if (window.___grecaptcha_cfg) {
      const cfg = window.___grecaptcha_cfg;
      // 遍历 clients 对象查找 sitekey
      if (cfg.clients) {
        for (const clientId in cfg.clients) {
          const client = cfg.clients[clientId];
          const sitekey = findSitekeyInObject(client);
          if (sitekey) return { key: sitekey, method: 'grecaptcha_cfg.clients' };
        }
      }
    }

    function findSitekeyInObject(obj, depth = 0) {
      if (depth > 5 || !obj || typeof obj !== 'object') return null;
      for (const key in obj) {
        if (key === 'sitekey' && typeof obj[key] === 'string' && obj[key].length > 20) {
          return obj[key];
        }
        if (typeof obj[key] === 'object') {
          const found = findSitekeyInObject(obj[key], depth + 1);
          if (found) return found;
        }
      }
      return null;
    }

    return null;
  });

  if (siteKey?.key) {
    console.log(`[CAPTCHA] 找到 siteKey: ${siteKey.key} (通过 ${siteKey.method})`);
    siteKey = siteKey.key;
  } else if (!siteKey) {
    // 尝试从 Playwright 层面提取 - 遍历所有 iframe（包括 challenge iframe）
    console.log('[CAPTCHA] evaluate 未找到 sitekey，尝试 Playwright 层面提取...');
    const iframeLocators = page.locator('iframe[src*="recaptcha"], iframe[src*="google.com/recaptcha"], iframe[src*="recaptcha.net"]');
    const iframeCount = await iframeLocators.count();
    console.log(`[CAPTCHA] 找到 ${iframeCount} 个 reCAPTCHA 相关 iframe`);
    for (let i = 0; i < iframeCount; i++) {
      const src = await iframeLocators.nth(i).getAttribute('src').catch(() => null);
      if (src) {
        const match = src.match(/k=([^&]+)/);
        if (match) {
          siteKey = match[1];
          console.log(`[CAPTCHA] 从 iframe[${i}] src 提取: ${siteKey}`);
          break;
        }
      }
    }
  }

  if (!siteKey) {
    console.log('[CAPTCHA] 无法提取 siteKey，跳过自动解决');
    return false;
  }

  console.log(`[CAPTCHA] 最终 siteKey: ${siteKey}`);
  console.log(`[CAPTCHA] 页面 URL: ${page.url()}`);

  // 调用 2Captcha 解决
  const solveStartTime = Date.now();
  const token = await solveRecaptchaV2(siteKey, page.url(), apiKey);
  const solveTime = Date.now() - solveStartTime;
  console.log(`[CAPTCHA] 获得 token (前20字符): ${token.substring(0, 20)}... (耗时: ${Math.round(solveTime / 1000)}s, 长度: ${token.length})`);

  // 先重置 reCAPTCHA 状态（清除之前的错误状态）
  await page.evaluate(() => {
    try {
      if (window.grecaptcha) {
        // 重置所有 widget
        const widgets = document.querySelectorAll('.g-recaptcha');
        for (let i = 0; i < (widgets.length || 1); i++) {
          try { window.grecaptcha.reset(i); } catch (e) { /* 忽略 */ }
        }
      }
    } catch (e) { /* 忽略 */ }
  });
  await page.waitForTimeout(500);

  // 注入 token 并触发回调
  const injectionResult = await page.evaluate((token) => {
    const result = { textareaSet: false, callbackFound: null, callbackTriggered: false };

    // 方式1: 注入到所有 textarea
    const textareas = document.querySelectorAll('#g-recaptcha-response, textarea[name="g-recaptcha-response"]');
    for (const textarea of textareas) {
      // 使用 native setter 确保 React/Vue 等框架能检测到变化
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      if (nativeInputValueSetter) {
        nativeInputValueSetter.call(textarea, token);
      } else {
        textarea.value = token;
      }
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
      result.textareaSet = true;
    }

    // 方式2: 查找 data-callback 属性
    const callbackNames = [];
    const recaptchaElements = document.querySelectorAll('[data-callback], .g-recaptcha, [data-sitekey]');
    for (const el of recaptchaElements) {
      const cb = el.getAttribute('data-callback');
      if (cb) callbackNames.push(cb);
    }

    // 方式3: 从 ___grecaptcha_cfg 深度搜索所有函数
    if (window.___grecaptcha_cfg && window.___grecaptcha_cfg.clients) {
      for (const clientId in window.___grecaptcha_cfg.clients) {
        const client = window.___grecaptcha_cfg.clients[clientId];
        searchForCallbacks(client, callbackNames, 0);
      }
    }

    // 方式4: 常见的回调名
    const commonNames = [
      'onRecaptchaSuccess', 'recaptchaCallback', 'captchaCallback',
      'onCaptchaVerified', 'verifyCallback', 'onVerify', 'captchaVerified',
      'onRecaptcha', 'recaptchaVerified', 'grecaptchaCallback'
    ];
    callbackNames.push(...commonNames);

    // 触发所有找到的回调
    for (const name of callbackNames) {
      if (typeof window[name] === 'function') {
        try {
          window[name](token);
          result.callbackTriggered = true;
          result.callbackFound = name;
        } catch (e) { /* 忽略 */ }
      }
    }

    // 方式5: 从 ___grecaptcha_cfg 中直接调用找到的函数
    if (window.___grecaptcha_cfg && window.___grecaptcha_cfg.clients) {
      for (const clientId in window.___grecaptcha_cfg.clients) {
        const client = window.___grecaptcha_cfg.clients[clientId];
        triggerCallbacksDeep(client, token, 0, result);
      }
    }

    function searchForCallbacks(obj, names, depth) {
      if (depth > 8 || !obj || typeof obj !== 'object') return;
      // 跳过浏览器安全限制的对象
      const skipTypes = ['CSSStyleSheet', 'CSSStyleDeclaration', 'CSSRule', 'CSSRuleList',
        'StyleSheet', 'StyleSheetList', 'DOMStringMap', 'NamedNodeMap', 'DOMTokenList'];
      if (obj.constructor && skipTypes.includes(obj.constructor.name)) return;
      try {
        for (const key in obj) {
          try {
            if (typeof obj[key] === 'function' && !key.startsWith('__')) {
              if (key === 'callback' || key.includes('Callback') || key.includes('callback')) {
                names.push(null); // 标记需要直接调用
              }
            }
            if (typeof obj[key] === 'object' && obj[key] !== null && key !== 'prototype' && key !== '__proto__') {
              searchForCallbacks(obj[key], names, depth + 1);
            }
          } catch (e) { /* 跳过不可访问的属性 */ }
        }
      } catch (e) { /* 跳过不可枚举的对象 */ }
    }

    function triggerCallbacksDeep(obj, token, depth, result) {
      if (depth > 8 || !obj || typeof obj !== 'object') return;
      const skipTypes = ['CSSStyleSheet', 'CSSStyleDeclaration', 'CSSRule', 'CSSRuleList',
        'StyleSheet', 'StyleSheetList', 'DOMStringMap', 'NamedNodeMap', 'DOMTokenList'];
      if (obj.constructor && skipTypes.includes(obj.constructor.name)) return;
      try {
        for (const key in obj) {
          try {
            if (typeof obj[key] === 'function' && !key.startsWith('__')) {
              if (key === 'callback' || key.includes('Callback') || key.includes('callback') ||
                  key === 'success' || key === 'onSuccess') {
                try {
                  obj[key](token);
                  result.callbackTriggered = true;
                  result.callbackFound = `obj.${key}`;
                } catch (e) { /* 忽略 */ }
              }
            }
            if (typeof obj[key] === 'object' && obj[key] !== null && key !== 'prototype' && key !== '__proto__') {
              triggerCallbacksDeep(obj[key], token, depth + 1, result);
            }
          } catch (e) { /* 跳过不可访问的属性 */ }
        }
      } catch (e) { /* 跳过不可枚举的对象 */ }
    }

    return result;
  }, token);

  console.log(`[CAPTCHA] 注入结果: textarea=${injectionResult.textareaSet}, 回调=${injectionResult.callbackFound || '未找到'}, 触发=${injectionResult.callbackTriggered}`);

  // 验证注入结果
  const verifyResult = await page.evaluate(() => {
    const textarea = document.getElementById('g-recaptcha-response');
    const textareaLen = textarea ? textarea.value?.length : 0;
    let grecaptchaResponse = 'no grecaptcha';
    try {
      if (window.grecaptcha) {
        const resp = window.grecaptcha.getResponse(0);
        grecaptchaResponse = resp ? `ok(${resp.length} chars)` : 'empty';
      }
    } catch (e) {
      grecaptchaResponse = `error: ${e.message}`;
    }
    return { textareaLen, grecaptchaResponse };
  });
  console.log(`[CAPTCHA] 验证 - textarea长度: ${verifyResult.textareaLen}, grecaptcha: ${verifyResult.grecaptchaResponse}`);

  return true;
}

/**
 * 在页面中检测并解决 Cloudflare Turnstile
 * @param {import('playwright').Page} page - Playwright 页面对象
 * @param {string} apiKey - 2Captcha API key
 * @returns {Promise<boolean>} - 是否成功解决
 */
export async function detectAndSolveTurnstile(page, apiKey) {
  // 检测 Turnstile
  const turnstileIframe = page.locator('iframe[src*="challenges.cloudflare.com"]');
  const hasTurnstile = await turnstileIframe.count() > 0;

  if (!hasTurnstile) {
    console.log('[CAPTCHA] 未检测到 Turnstile');
    return false;
  }

  // 提取 sitekey
  let siteKey = await page.evaluate(() => {
    const turnstileDiv = document.querySelector('[data-sitekey]');
    if (turnstileDiv) return turnstileDiv.getAttribute('data-sitekey');

    // 从 input 中提取
    const input = document.querySelector('input[name="cf-turnstile-response"], input[name="g-recaptcha-response"]');
    if (input?.parentElement) {
      return input.parentElement.getAttribute('data-sitekey');
    }

    return null;
  });

  if (!siteKey) {
    console.log('[CAPTCHA] 检测到 Turnstile 但无法提取 sitekey');
    return false;
  }

  console.log(`[CAPTCHA] 找到 Turnstile siteKey: ${siteKey}`);

  const token = await solveTurnstile(siteKey, page.url(), apiKey);

  // 注入 token
  await page.evaluate((token) => {
    // Turnstile 的 response 字段
    const cfInput = document.querySelector('input[name="cf-turnstile-response"]');
    if (cfInput) cfInput.value = token;

    // 也可能用 g-recaptcha-response
    const recaptchaInput = document.querySelector('input[name="g-recaptcha-response"]');
    if (recaptchaInput) recaptchaInput.value = token;

    // 尝试触发回调
    if (window.turnstile && window.turnstile.getResponse) {
      // Turnstile widget 回调
      const callbacks = document.querySelectorAll('[data-callback]');
      for (const el of callbacks) {
        const cbName = el.getAttribute('data-callback');
        if (typeof window[cbName] === 'function') {
          window[cbName](token);
        }
      }
    }
  }, token);

  console.log('[CAPTCHA] Turnstile Token 已注入页面');
  return true;
}
