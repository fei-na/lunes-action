# Lunes 多账户保机（GitHub Actions + 飞书通知）

本项目通过 **GitHub Actions** 自动登录 [Lunes 控制台](https://ctrl.lunes.host/auth/login)，使用 **2Captcha** 自动解决 reCAPTCHA 人机验证，并将结果通过 **飞书机器人** 通知。

---

## ✅ 快速使用

### 1. Fork 本仓库
点击右上角 **Fork**，将本项目复制到你的 GitHub 账户。

---

### 2. 配置 GitHub Secrets
进入仓库 **Settings → Secrets and variables → Actions → New repository secret**，依次添加如以下Secret：

| Secret 名称             | 值示例                        |
|-------------------------|--------------------------------|
| `USERNAME_AND_PASSWORD`        | `{"your_account1@example.com": "your_password1","your_account2@example.com": "your_password2"}`      |
| `FEISHU_WEBHOOK`        | `https://open.feishu.cn/open-apis/bot/v2/hook/xxx`        |
| `TWOCAPTCHA_API_KEY`    | `abc123def456...`             |

#### USERNAME_AND_PASSWORD
```
// 格式如下：
{
  "your_account1@example.com": "your_password1",
  "your_account2@example.com": "your_password2"
}
```
> **获取飞书 Webhook 方法：**  
> 在飞书群聊 → 设置 → 群机器人 → 添加机器人 → 自定义机器人，获取 Webhook 地址。

> **获取 2Captcha API Key：**  
> 在 [2captcha.com](https://2captcha.com/) 注册并充值，在 Dashboard 获取 API Key。reCAPTCHA v2 每次解决约 $0.002-0.003。
--

### 3. 触发 Workflow
有两种方式运行：

- **手动执行：**  
  打开仓库 → `Actions` → `Lunes Auto Login` → `Run workflow` → 点击绿色按钮运行。

- **自动执行：**  
  Workflow 默认每10天运行一次，时间在 `login.yml` 中配置（UTC 时区，北京时间早上8点）。

---

### 4. 查看运行结果
- **飞书通知：**  
  登录成功、失败或出现验证，会通过飞书机器人发送消息和截图到你的群聊。
- **GitHub Artifact：**  
  登录过程截图保存在 Actions 的 `Artifacts`，可以下载查看。

---

## ⚠️ 注意事项
- 不要把账号密码写在代码里，请务必使用 GitHub Secrets。
- 脚本会自动通过 2Captcha 解决 reCAPTCHA v2 人机验证（invisible 模式）。
- 如需修改运行频率，编辑 `.github/workflows/login.yml` 的 `cron` 表达式。
- 2Captcha 余额不足时会通知失败，请关注飞书消息。

## 鸣谢
本项目基于
https://github.com/gansweet/BetaDash-lunes-host-autoLogin-Sweet-
二次修改

---

## ✅ 完成
配置完成后，你可以立即手动运行工作流，或等待定时任务自动运行。
