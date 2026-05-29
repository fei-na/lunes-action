// scripts/captcha.js
// 2Captcha API 集成，支持 reCAPTCHA v2 和 Cloudflare Turnstile

const TWOCAPTCHA_API_BASE = 'https://2captcha.com';
const POLL_INTERVAL = 5000;
const MAX_WAIT_TIME = 180_000;

/**
 * 提交 reCAPTCHA v2 任务到 2Captcha
 */
export async function solveRecaptchaV2(siteKey, pageUrl, apiKey) {
  console.log(`[CAPTCHA] siteKey: ${siteKey}, URL: ${pageUrl}`);

  // 提交任务
  const params = new URLSearchParams({
    key: apiKey,
    method: 'userrecaptcha',
    googlekey: siteKey,
    pageurl: pageUrl,
    json: '1',
    soft_id: '3659', // 常用的 soft_id
  });

  console.log(`[CAPTCHA] 提交任务...`);
  const submitRes = await fetch(`${TWOCAPTCHA_API_BASE}/in.php?${params}`, {
    method: 'POST',
    signal: AbortSignal.timeout(30_000),
  });
  const submitData = await submitRes.json();
  console.log(`[CAPTCHA] 提交结果: ${JSON.stringify(submitData)}`);

  if (submitData.status !== 1) {
    throw new Error(`2Captcha 提交失败: ${submitData.request}`);
  }

  const taskId = submitData.request;
  console.log(`[CAPTCHA] 任务 ID: ${taskId}`);

  // 轮询结果
  return await pollResult(taskId, apiKey);
}

/**
 * 提交 Turnstile 任务到 2Captcha
 */
export async function solveTurnstile(siteKey, pageUrl, apiKey) {
  console.log(`[CAPTCHA] 2Captcha 解决 Turnstile, siteKey: ${siteKey}`);

  const params = new URLSearchParams({
    key: apiKey,
    method: 'turnstile',
    sitekey: siteKey,
    pageurl: pageUrl,
    json: '1',
  });

  const submitRes = await fetch(`${TWOCAPTCHA_API_BASE}/in.php?${params}`, {
    method: 'POST',
    signal: AbortSignal.timeout(30_000),
  });
  const submitData = await submitRes.json();

  if (submitData.status !== 1) {
    throw new Error(`2Captcha 提交失败: ${submitData.request}`);
  }

  return await pollResult(submitData.request, apiKey);
}

/**
 * 轮询获取结果
 */
async function pollResult(taskId, apiKey) {
  const startTime = Date.now();

  while (Date.now() - startTime < MAX_WAIT_TIME) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`[CAPTCHA] 轮询... (${elapsed}s)`);

    try {
      const url = `${TWOCAPTCHA_API_BASE}/res.php?key=${apiKey}&action=get&id=${taskId}&json=1`;
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      const data = await res.json();

      if (data.status === 1) {
        console.log(`[CAPTCHA] 成功! 耗时 ${elapsed}s, token 长度: ${data.request.length}`);
        return data.request;
      }

      if (data.request === 'CAPCHA_NOT_READY') {
        continue;
      }

      // 其他错误
      throw new Error(`2Captcha 错误: ${data.request}`);
    } catch (e) {
      if (e.name === 'TimeoutError' || e.name === 'AbortError') {
        console.log(`[CAPTCHA] 请求超时，重试...`);
        continue;
      }
      throw e;
    }
  }

  throw new Error(`2Captcha 超时（${Math.round(MAX_WAIT_TIME / 1000)}秒）`);
}

/**
 * 在页面中检测并解决 reCAPTCHA v2
 */
export async function detectAndSolveRecaptcha(page, apiKey) {
  const recaptchaIframeCount = await page.locator('iframe[src*="recaptcha"], iframe[src*="google.com/recaptcha"], iframe[src*="recaptcha.net"]').count();
  const gRecaptchaDiv = await page.locator('.g-recaptcha, [data-sitekey]').count();
  const gRecaptchaTextarea = await page.locator('#g-recaptcha-response, textarea[name="g-recaptcha-response"]').count();

  console.log(`[CAPTCHA] 检测: iframe=${recaptchaIframeCount}, div=${gRecaptchaDiv}, textarea=${gRecaptchaTextarea}`);

  if (recaptchaIframeCount === 0 && gRecaptchaDiv === 0 && gRecaptchaTextarea === 0) {
    console.log('[CAPTCHA] 未检测到 reCAPTCHA');
    return false;
  }

  // 提取 sitekey — 只用简单方式，避免深度遍历
  let siteKey = await page.evaluate(() => {
    // data-sitekey div
    const div = document.querySelector('.g-recaptcha, [data-sitekey]');
    if (div?.getAttribute('data-sitekey')) return div.getAttribute('data-sitekey');

    // iframe src
    for (const f of document.querySelectorAll('iframe')) {
      if (f.src?.includes('recaptcha')) {
        const m = f.src.match(/k=([^&]+)/);
        if (m) return m[1];
      }
    }

    return null;
  });

  if (siteKey) {
    console.log(`[CAPTCHA] siteKey: ${siteKey}`);
  } else {
    const count = await page.locator('iframe[src*="recaptcha"], iframe[src*="recaptcha.net"]').count();
    for (let i = 0; i < count; i++) {
      const src = await page.locator('iframe[src*="recaptcha"], iframe[src*="recaptcha.net"]').nth(i).getAttribute('src').catch(() => null);
      const m = src?.match(/k=([^&]+)/);
      if (m) { siteKey = m[1]; break; }
    }
  }

  if (!siteKey) {
    console.log('[CAPTCHA] 无法提取 siteKey');
    return false;
  }

  console.log(`[CAPTCHA] siteKey: ${siteKey}`);
  console.log(`[CAPTCHA] URL: ${page.url()}`);

  // 调用 2Captcha
  const token = await solveRecaptchaV2(siteKey, page.url(), apiKey);

  // 重置 reCAPTCHA 内部状态（不清 textarea）
  try { window.grecaptcha?.reset(0); } catch (e) {}
  await new Promise(r => setTimeout(r, 500));

  // 注入 token
  const r = await page.evaluate((token) => {
    const result = { ta: false, cb: null, getRes: null, override: false };

    // 1. 设置 textarea
    const ta = document.getElementById('g-recaptcha-response');
    if (ta) {
      ta.value = token;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
      result.ta = true;
    }

    // 2. 覆盖 grecaptcha.getResponse 返回 token
    try {
      if (window.grecaptcha && typeof window.grecaptcha.getResponse === 'function') {
        const orig = window.grecaptcha.getResponse.bind(window.grecaptcha);
        window.grecaptcha.getResponse = function(idx) {
          const ta = document.getElementById('g-recaptcha-response');
          if (ta && ta.value && ta.value.length > 10) return ta.value;
          return orig(idx);
        };
        result.override = true;
      }
    } catch (e) {}

    // 3. 在 ___grecaptcha_cfg 中搜索回调函数（限深3层，避免卡死）
    try {
      const cfg = window.___grecaptcha_cfg;
      if (cfg) {
        const seen = new WeakSet();
        const queue = [{ obj: cfg, depth: 0 }];
        const skipTypes = ['CSSStyleSheet','CSSStyleDeclaration','CSSRule','CSSRuleList',
          'CSSMediaRule','CSSFontFaceRule','CSSKeyframesRule','MediaList','StyleSheetList',
          'NodeList','HTMLCollection','DOMTokenList','NamedNodeMap','Attr',
          'HTMLIFrameElement','HTMLDocument','Document','Window','HTMLHtmlElement','HTMLBodyElement'];

        while (queue.length > 0) {
          const { obj, depth } = queue.shift();
          if (!obj || depth > 3 || seen.has(obj)) continue;
          seen.add(obj);

          const keys = Object.keys(obj);
          for (const key of keys) {
            try {
              const val = obj[key];
              if (typeof val === 'function') {
                const funcStr = val.toString().substring(0, 100);
                // reCAPTCHA 回调通常接收一个 token 参数
                if (funcStr.includes('callback') || funcStr.includes('token') ||
                    funcStr.includes('response') || funcStr.includes('verify') ||
                    key === 'callback' || key === 'done' || key === 'success') {
                  try { val(token); result.cb = `cfg.${key}`; } catch (e) {}
                }
              } else if (val && typeof val === 'object') {
                const type = val.constructor?.name;
                if (!skipTypes.includes(type)) {
                  queue.push({ obj: val, depth: depth + 1 });
                }
              }
            } catch {}
          }
        }
      }
    } catch (e) {}

    // 4. 通过 data-callback 属性查找
    if (!result.cb) {
      for (const el of document.querySelectorAll('[data-callback]')) {
        const name = el.getAttribute('data-callback');
        if (name && typeof window[name] === 'function') {
          try { window[name](token); result.cb = `data-callback:${name}`; } catch (e) {}
        }
      }
    }

    // 5. 尝试常见回调名
    if (!result.cb) {
      const names = ['onRecaptchaSuccess', 'recaptchaCallback', 'captchaCallback',
        'verifyCallback', 'onVerify', 'captchaVerified', 'onCaptchaVerified',
        'handleCaptcha', 'captchaComplete', 'recaptchaVerified'];
      for (const n of names) {
        if (typeof window[n] === 'function') {
          try { window[n](token); result.cb = `window.${n}`; break; } catch (e) {}
        }
      }
    }

    // 6. 验证 getResponse 现在返回 token
    try { result.getRes = window.grecaptcha?.getResponse(0)?.length || 0; } catch (e) { result.getRes = e.message; }

    return result;
  }, token);

  console.log(`[CAPTCHA] 注入: ta=${r.ta}, cb=${r.cb || '无'}, override=${r.override}, getRes=${r.getRes}`);

  // 最终验证
  const v = await page.evaluate(() => {
    const ta = document.getElementById('g-recaptcha-response');
    let gr = 'no';
    try { const r = window.grecaptcha?.getResponse(0); gr = r ? `ok(${r.length})` : 'empty'; } catch (e) { gr = e.message; }
    return { taLen: ta?.value?.length || 0, gr };
  });
  console.log(`[CAPTCHA] 验证: ta=${v.taLen}, gr=${v.gr}`);

  return true;
}

/**
 * 检测并解决 Cloudflare Turnstile
 */
export async function detectAndSolveTurnstile(page, apiKey) {
  const has = await page.locator('iframe[src*="challenges.cloudflare.com"]').count();
  if (!has) return false;

  const siteKey = await page.evaluate(() => {
    return document.querySelector('[data-sitekey]')?.getAttribute('data-sitekey') || null;
  });
  if (!siteKey) return false;

  const token = await solveTurnstile(siteKey, page.url(), apiKey);
  await page.evaluate((t) => {
    const cf = document.querySelector('input[name="cf-turnstile-response"]');
    if (cf) cf.value = t;
  }, token);
  return true;
}
