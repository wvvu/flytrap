# Flytrap v0.3 研发进度跟踪

## 里程碑交付状态

- [x] **M1 — 运维与死信治愈 (DLQ & Recovery)**
  - [x] 在 `src/db/repos/jobs.ts` 中实现 `retryJob`、`retryAllDeadJobs` 与 `listJobsWithDetails`。
  - [x] 提供 `GET /v1/jobs?status=...` 详实错误与邮件主题联表查询。
  - [x] 提供 `POST /v1/jobs/:id/retry` 与 `POST /v1/jobs/retry-all` 重入队救回死信。
  - [x] 单元测试 `test/api.test.ts` 覆盖率 100%。
- [x] **M2 — 原生 Gemini 与多 Key 轮换池 (Robust AI)**
  - [x] 编写 `src/ai/gemini.ts` 原生直连 Google GenAI REST 端点。
  - [x] 实现 Multi-Key Pool 轮询负载均衡与 429/503 自动熔断冷却（60s Cooldown）及无感故障转移。
  - [x] 默认模型锚定 `gemini-2.5-flash`，规避 503 兼容层排队。
  - [x] 提供 `GET /v1/ai/status` 实时查看 Key 池健康与活动模型。
  - [x] 单元测试 `test/gemini.test.ts` 覆盖率 100%。
- [x] **M3 — 现代化三列工作台全面重构 (Farewell to Olive Green)**
  - [x] 告别灰绿，重构为符合现代邮件客户端（Infomaniak 质感）的三列式布局：
    - 第一列（Icon Rail）：收件箱、死信队列、AI 策略、收件画像、统计态势、深浅色一键切换、退出。
    - 第二列（Stream）：快捷搜索、标签胶囊过滤、邮件流卡片（发件人、主题、时间、威胁徽章与置信度）。
    - 第三列（Workspace）：全维度研判舞台（4-Tab：AI 智能研判、安全沙箱 HTML 预览、纯文本正文、RFC822 原文）。
  - [x] 原生沙箱 `iframe sandbox=""`（独立源，不授予脚本）+ 页面 CSP，默认拦截外链图片与信标，提供“允许加载图片”开关。
  - [x] 严格遵循零 `innerHTML` 规范，杜绝 DOM XSS 风险。
  - [x] 键盘快捷键支持：`j` 下一封、`k` 上一封、`r` 刷新。
- [x] **M4 — 在线提示词与收件画像管理**
  - [x] 提供 `GET /v1/prompts`、`GET /v1/prompts/:id` 与 `PUT /v1/prompts/:id` 在线热更新 System Prompt。
  - [x] 收件画像（Mailbox Posture）在线维护与查询。
- [x] **Docker & 本地 WSL 预览环境**
  - [x] WSL Ubuntu Docker 构建链路调通。
  - [x] 镜像打标 `flytrap:0.3.0` 并通过 `docker compose up -d` 成功启动容器。
  - [x] 编写 `scripts/seed-mock-emails.mjs`，向 SMTP 2525 成功灌入 4 封典型实战邮件（钓鱼、GitHub 通知、商业垃圾、工资条税单）。
  - [x] Windows 宿主机可直接在浏览器打开 `http://localhost:8080` 实时预览！
