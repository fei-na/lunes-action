# Lunes 自动保机脚本

通过 GitHub Actions 定期登录 [Lunes](https://ctrl.lunes.host)，保持服务器活跃状态。登录结果通过飞书通知。

---

## 使用方法

### 1. Fork 仓库

### 2. 配置 Secrets
`Settings` → `Secrets` → `Actions`，添加：

| 名称 | 说明 | 示例 |
|------|------|------|
| `USERNAME_AND_PASSWORD` | 账号密码 JSON | `{"email": "pass"}` |
| `FEISHU_WEBHOOK` | 飞书群机器人 Webhook | `https://open.feishu.cn/...` |
| `TWOCAPTCHA_API_KEY` | 验证码服务 Key | 见下方说明 |

> 飞书 Webhook：群聊设置 → 群机器人 → 自定义机器人

> `TWOCAPTCHA_API_KEY`：脚本需要处理页面上的安全验证环节，该项为所需的第三方服务密钥，注册后在 Dashboard 获取。余额消耗极低。

### 3. 运行

- **手动**：`Actions` → `Run workflow`
- **自动**：每 10 天运行一次（北京时间 8:00）

### 4. 结果

飞书收到通知 + GitHub Artifacts 有截图

---

## 注意

- 账号密码务必用 Secrets，不要写在代码里
- 验证码服务余额耗尽会导致失败，留意飞书通知
- 修改频率：编辑 `.github/workflows/login.yml` 的 cron

## 鸣谢
基于 https://github.com/gansweet/BetaDash-lunes-host-autoLogin-Sweet- 二次修改
