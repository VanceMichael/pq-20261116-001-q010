# 滚动新闻快照采集与归档

本服务面向新闻编辑部和数据运营人员：采集经常刷新的新闻目录页面，规范化标题与链接，并在本地 SQLite 中保留每次采集及文章出现历史。一次短暂的页面缺项不会立刻从归档删除新闻；操作者可以查看快照差异、采集健康、审核记录，并导出 CSV。

## 环境

- Node.js `22.23.4`。
- 仅使用 Node 内置模块和 SQLite，无第三方包，不要求网络连接。

## 验收与演示

```sh
npm test
npm run build
npm run demo
```

演示会读取本地合成页面并在临时目录建立数据库，输出一次采集摘要后清理临时文件。生产数据库由 `ARCHIVE_DB` 指定，默认 `./var/archive.sqlite`。默认 HTTP 监听地址为 `127.0.0.1:8080`，可用 `HOST` 和 `PORT` 调整。

## HTTP 接口

- `POST /v1/feeds`：注册来源，提交 `feedId`、`baseUrl`、`allowedHosts`，以及可选的 `minimumItems`、`missingThreshold`。
- `POST /v1/feeds/:feedId/snapshots`：提交已保存的 HTML 页面；可用 `X-Captured-At` 指定采集时间。
- `POST /v1/feeds/:feedId/refresh`：手动抓取已注册来源；仅访问允许列表中的 DNS 主机。来源处于暂停窗口时不会发请求，而是返回 `503` 与 `Retry-After`。
- `GET /v1/feeds/:feedId`：查看 feed 状态、文章统计和采集健康（含当前暂停状态）。
- `GET /v1/feeds/:feedId/items`：分页读取文章；`visibility=visible|quiet` 可过滤状态。
- `GET /v1/feeds/:feedId/runs`：读取近期页面快照接纳/拒绝记录。
- `GET /v1/feeds/:feedId/attempts`：读取抓取请求、重试、失败、暂停跳过和响应审计。
- `GET /v1/feeds/:feedId/changes`：比较最近两次已接纳快照；未达到两次时返回 `409`。
- `GET /v1/feeds/:feedId/health`：读取 24 小时抓取成功率、最近成功时间、异常提示和暂停信息。
- `GET /v1/feeds/:feedId/pause`：读取最近一次暂停片段：原因、失败类型、连续失败次数、下一次允许尝试时间、是否需要人工恢复及恢复人。
- `POST /v1/feeds/:feedId/pause`：人工解除暂停，提交 `operator`（必填）和可选 `note`；返回恢复了哪次故障片段。无活动暂停时返回 `409`。
- `GET /v1/feeds/:feedId/pause-events`：读取暂停生命周期事件（触发、退避重开、单次探测、人工恢复、探测超时回收）。
- `GET /v1/feeds/:feedId/items.csv`：流式导出；限制输出行数并转义表格公式前缀。
- `PATCH /v1/feeds/:feedId/items/:articleId/review`：按修订号更新审核状态，状态为 `unreviewed`、`confirmed` 或 `withdrawn`。
- `GET /v1/feeds/:feedId/items/:articleId/review`：查看审核事件历史。
- `GET /v1/feeds/:feedId/items/:articleId/history`：查看文章在已接纳列表快照中的出现位置和间隔。
- `GET /health`：进程健康检查。

抓取失败、页面异常和正常列表变更有不同记录。相同页面指纹重复提交时不会重复增加文章观察次数。短暂缺失需达到来源配置的连续快照阈值后才转为 `quiet`，重新出现时恢复 `visible`。人工审核状态独立于可见性状态，旧修订号会得到冲突响应而不会覆盖新审核决定。

## 来源暂停与恢复

持续故障时无需反复点击刷新：抓取失败会按类型打开一个持久化在 SQLite 中的“暂停片段”（`feed_pauses`），重启进程后仍然有效，三类故障对应三种下一步：

- **限流（HTTP 429，`rate_limited`）**：遵循来源的 `Retry-After` 提示（受上限约束），否则从 1 分钟起指数退避至 15 分钟；窗口到期后允许一次探测。
- **短暂服务错误（网络/超时、5xx、408/425，`transient`）**：从 30 秒起指数退避至 5 分钟；窗口到期后只放行一次探测，探测成功即恢复，失败则延长退避。
- **明确不可用（HTTP 404/410，`unavailable`）**：暂停 30 分钟且不自动探测，必须由操作员人工恢复，避免把来源永久停用。
- 本地策略问题（allowlist、协议、重定向环等）不属于来源故障，不会触发暂停。

暂停窗口内的刷新不会真正发请求，而是写入一条 `outcome="skipped"`、`attemptCount=0` 的记录并返回 `503`（带 `Retry-After`）。跳过记录与网络失败分开统计，不计入健康成功率的分母，因此不会稀释真实成功率。窗口到期瞬间若有多个调用并发，只有一个能以原子状态转换赢得单次探测，其余得到 `probe_in_progress` 跳过；探测设有截止时间，进程在探测中崩溃后，重启会在截止时间过后回收该探测，避免来源被永久卡住。

每个暂停片段有递增的 `pauseId` 作为隔离令牌。人工恢复后，属于旧片段的迟到失败结果会被识别为过期（`stalePauseResult`）而忽略，不会把已恢复的来源再次关回暂停。人工恢复必须提供 `operator`，事件表记录是谁、在哪次故障片段上、因何备注解除了暂停。暂停原因与 `nextAttemptAt`（下一次允许尝试时间）可通过 `GET /v1/feeds/:feedId/pause`、健康报告和 feed 状态查询。

仓库中的 HTML 样本为本地合成数据，仅用于离线演示和测试。实际部署前请配置准确来源域名，并遵守来源站点的使用条件。本服务不在后台隐式启动定时抓取；由操作者或外部调度器显式触发刷新。
