# Flytrap v0.2 — 施工进度

> 对应 [architecture/v0.2.md §10](architecture/v0.2.md) 的 14 步施工顺序。
> 每完成一步，勾选并记录验证结果。

---

## Git Commit 约定

```
<type>(<scope>): <简述> (step <N>)
```

- **type**: `feat` | `fix` | `test` | `refactor` | `chore` | `docs`
- **scope**: `config` | `db` | `ingest` | `smtp` | `worker` | `auth` | `parse` | `ai` | `api` | `notify` | `docker` | `ui`
- **step**: 对应下方 Step 编号
- Body（可选）写验证命令或测试用例名

---

## Step 1 — config + log + main 骨架
- [x] `config.ts`: zod 解析所有 env，缺必填键 → exit(1)
- [x] `log.ts`: pino logger
- [x] `main.ts`: 读 ROLES，按角色启动
- **验证**: `ACCEPT_DOMAINS= tsx src/main.ts` → 非零退出 + 明确错误

## Step 2 — DB 迁移
- [x] `migrations/001_init.sql`: 全部建表 + 索引
- [x] `db/migrate.ts`: 启动自动迁移，幂等
- **验证**: 启动后 `sqlite3 mail.db ".tables"` 列出全部表

## Step 3 — store-raw（EML 落盘 + 去重）
- [x] `ingest/store-raw.ts`: Buffer → sha256 → zstd 压缩 → 写文件
- [x] 去重：同 sha256 跳过落盘
- [x] 单测 `test/store-raw.test.ts`
- **验证**: `npm test -- --test-name-pattern store` 全绿

## Step 4 — SMTP 服务器
- [x] `smtp/server.ts`: SMTPServer 装配
- [x] `smtp/policy.ts`: 本域 250 / 外域 550 / relay denied
- [x] `smtp/limits.ts`: 连接级限速
- [x] 落盘成功才 250，I/O 失败 451
- [x] 单测/集成测 `test/smtp.test.ts`
- **验证**: `swaks --to test@yourdomain --server 127.0.0.1:2525` → 250

## Step 5 — Worker 调度
- [x] `worker/loop.ts`: 原子抢占 + 指数退避 + 崩溃恢复
- [x] `db/repos/jobs.ts`
- [x] 单测 `test/worker.test.ts`
- **验证**: 插入 mock job → worker 轮转 → status=done

## Step 6 — 邮件认证 (SPF/DKIM/DMARC)
- [x] `mail/auth.ts`: mailauth 封装 + 10s DNS 熔断
- [x] `worker/job-auth.ts`
- **验证**: 用带 DKIM 签名的 fixture EML → auth_result 写入正确

## Step 7 — MIME 解析 + 附件
- [x] `mail/parse.ts`: postal-mime 解析
- [x] `mail/text.ts`: HTML → 纯文本，截断 20KB
- [x] `worker/job-parse.ts`: 解压 raw → 解析 → 附件去重落盘
- [x] 附件写入 `attachments/` + `message_attachments` 关联
- **验证**: `npx tsx --test test/text.test.ts test/worker.test.ts` 全部通过

## Step 8 — AI 类型 + Fake Classifier
- [x] `ai/types.ts`: AiResultV1 zod schema
- [x] `ai/classifier.ts`: Classifier 接口 (含本地 Fake 实现)
- [x] `worker/job-classify.ts`: fake 分类器打通 pipeline
- **验证**: job-classify 完成后 messages.ai_result 写入合法 JSON

## Step 9 — OpenAI Compat 真实现
- [x] `ai/openai-compat.ts`: OpenAI 兼容接口，支持 JSON mode 失败自动降级重试
- [x] `prompts/classify-v1.txt`: 分类 Prompt v1 模板
- **验证**: `npx tsx --test test/classify.test.ts` 校验字段、标签枚举与降级测试全部通过

## Step 10 — HTTP API
- [x] `api/app.ts` + `api/password.ts`: Fastify + 会话 Cookie + CSRF 防御 + 频率限制 + 审计日志
- [x] 健康检查: `/healthz`
- [x] 邮件接口: 列表 (游标分页、不带正文、多维过滤) + 详情 + 重新分类
- [x] 原始邮件下载: `/v1/messages/:id/raw` 路径穿越防御 + 哈希核验
- [x] 管理接口: `/v1/jobs` / `/v1/stats` / `/v1/mailbox-history`
- [x] 单测: `test/api.test.ts` 覆盖未登录拦截、路径穿越防御、防爆破限流
- **验证**: `npx tsx --test test/api.test.ts` 全部通过

## Step 11 — Notifier (Webhook + Telegram)
- [x] `notify/webhook.ts`: Webhook 推送，Bearer Token 脱敏
- [x] `notify/telegram.ts`: Telegram 推送，Bot Token 脱敏
- [x] `worker/job-notify.ts`: 标签与置信度过滤，只推摘要与深链，不带邮件正文
- **验证**: `test/classify.test.ts` 测试用例通过，异常日志不泄露 Token

## Step 12 — Docker
- [x] `Dockerfile`: 多阶段构建，非 root（`USER node`）
- [x] `docker-compose.yml`: smtp `2525:2525` / api `127.0.0.1:8080:8080` / 卷 `mail-data`
- **验证**: 本机没有 docker CLI，未跑 `docker compose up`。镜像内 healthcheck 打 `/healthz` 并探测 SMTP 2525。

## Step 13 — Rebuild
- [x] `main.ts --rebuild`: 扫 raw/ 重建 SQLite，`ai_result IS NULL` 的重入队 auth
- **验证**: `npm test` — `deleting the database and rebuilding restores the raw sha256 set`、`main --rebuild exits after the sha256 set matches raw`

## Step 14 — 最小 UI
- [x] `src/api/public/` 静态页 fetch `/v1/*`，Fastify 托管 `/`、`/app.js`、`/app.css`
- **验证**: `test/ui.test.ts` 通过（未登录列表 401，`GET /` 返回面板）。本机无浏览器，未做点击走查。

---

## 变更日志

| 日期 | Step | Commit | 备注 |
|------|------|--------|------|
| 2026-09-23 | 1-11 | feat(core) (step 1-11) | 核心业务全链路：配置/存储/SMTP/Worker/认证/解析/AI分类/通知/本机API/完整测试 (35 项测试全绿) |
| 2026-09-23 | 12-14 | feat(core) (step 12-14) | Docker 多阶段非 root、`--rebuild`、静态面板。`npm test` 39 项全绿，`npm run typecheck` 通过。本机无 docker / 浏览器 |

