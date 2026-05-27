// scripts/captcha.js
// 2Captcha API 集成，支持 reCAPTCHA v2 和 Cloudflare Turnstile

const TWOCAPTCHA_API_BASE = 'http://2captcha.com';
const POLL_INTERVAL = 5000; // 轮询间隔 5 秒
const MAX_WAIT_TIME = 300_000; // 最大等待 5 分钟

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
  // 检测 reCAPTCHA iframe
  const recaptchaFrame = page.frameLocator('iframe[src*="recaptcha"]').first();
  const recaptchaCheckbox = recaptchaFrame.locator('.recaptcha-checkbox-border');

  const hasRecaptcha = await recaptchaFrame.locator('.recaptcha-checkbox').count() > 0;

  if (!hasRecaptcha) {
    // 尝试检测隐藏的 reCAPTCHA（有些网站把 reCAPTCHA 包在 div 里）
    const gRecaptchaResponse = await page.locator('#g-recaptcha-response').count();
    if (gRecaptchaResponse === 0) {
      console.log('[CAPTCHA] 未检测到 reCAPTCHA');
      return false;
    }
    console.log('[CAPTCHA] 检测到隐藏的 reCAPTCHA');
  }

  // 提取 sitekey
  let siteKey = await page.evaluate(() => {
    // 方式1: 从 g-recaptcha 的 div 属性中提取
    const recaptchaDiv = document.querySelector('.g-recaptcha, [data-sitekey]');
    if (recaptchaDiv) return recaptchaDiv.getAttribute('data-sitekey');

    // 方式2: 从 iframe src 中提取
    const iframe = document.querySelector('iframe[src*="recaptcha"]');
    if (iframe) {
      const match = iframe.src.match(/k=([^&]+)/);
      if (match) return match[1];
    }

    // 方式3: 从页面 script 中提取
    const scripts = document.querySelectorAll('script');
    for (const script of scripts) {
      const match = script.textContent?.match(/sitekey['":\s]+['"]([0-9A-Za-z_-]+)['"]/);
      if (match) return match[1];
    }

    return null;
  });

  if (!siteKey) {
    console.log('[CAPTCHA] 检测到 reCAPTCHA 但无法提取 sitekey，尝试从 iframe 提取...');
    // 从 iframe src 提取
    const iframeSrc = await page.locator('iframe[src*="recaptcha"]').first().getAttribute('src').catch(() => null);
    if (iframeSrc) {
      const match = iframeSrc.match(/k=([^&]+)/);
      if (match) siteKey = match[1];
    }
  }

  if (!siteKey) {
    console.log('[CAPTCHA] 无法提取 siteKey，跳过自动解决');
    return false;
  }

  console.log(`[CAPTCHA] 找到 reCAPTCHA siteKey: ${siteKey}`);

  // 调用 2Captcha 解决
  const token = await solveRecaptchaV2(siteKey, page.url(), apiKey);

  // 注入 token
  await page.evaluate((token) => {
    // 注入到 textarea
    const textarea = document.getElementById('g-recaptcha-response');
    if (textarea) {
      textarea.value = token;
      textarea.style.display = 'block'; // 确保可见
    }

    // 尝试触发回调
    if (window.___grecaptcha_cfg && window.___grecaptcha_cfg.clients) {
      const clients = window.___grecaptcha_cfg.clients;
      for (const key in clients) {
        const client = clients[key];
        if (client?.reCaptchaV2?.callback) {
          client.reCaptchaV2.callback(token);
        }
      }
    }
  }, token);

  console.log('[CAPTCHA] Token 已注入页面');
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
