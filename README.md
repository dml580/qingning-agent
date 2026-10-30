# 青柠

一款面向真实生活场景的 **生活助理 Agent**。基于 React 打造高性能前端，Python 后端驱动工具调用与 RAG（检索增强生成），致力于解决日常琐事、文档分析与生活提醒。

## 项目定位

项目不只是聊天界面，而是一个可在本机运行的 AI Agent 应用：

- **Agent 编排**：支持最多 5 步 Skill 调用、可视化执行计划、单步重试和运行轨迹。
- **Human-in-the-loop**：日历写入等有副作用的操作需要用户批准，可拒绝或重试。
- **混合 RAG**：BM25 + 向量召回 + RRF/词面覆盖度重排，用于合同、通知和账单分析。
- **AI 前端**：React 19 + TypeScript，SSE 流式输出、中断/重连、`seq` 去重、Markdown、图片上传与 PWA。
- **本地优先**：FastAPI + SQLite，账号级数据隔离，支持备份/恢复，API Key 不保存在前端。

## 核心功能

- 用户名/密码统一登录注册，HttpOnly Cookie Session。
- 会话、提醒、待办、记忆、文档记录和 Agent 轨迹按账号隔离。
- 生活提醒支持日期/时分、浏览器通知和 macOS / Google / 飞书日历同步。
- 文书图片压缩、相关性审核、OCR 与结构化提取。
- 多模型提供商设置，包括豆包、DeepSeek、OpenAI、硅基流动和自定义兼容接口。
- 当前账号数据导出/事务恢复，备份不包含密码、Cookie 和模型 API Key。

## 内部 Skills

| Skill | 作用 |
|---|---|
| `extract_amounts_dates` | 从文书中抽取金额与日期 |
| `check_missing_clauses` | 检查场景关键条款是否出现 |
| `extract_document` | 文档分类、摘要与结构化提取 |
| `manage_reminder` | 生活提醒查询、新增与同步 |
| `manage_todo` | 通用待办管理 |
| `manage_calendar` | 日历状态、提醒同步与日程创建 |
| `manage_memory` | 当前账号的显式记忆管理 |
| `web_search` | 实时联网搜索 |
| `get_weather` | 城市天气与预报 |
| `get_current_time` | 当前日期、时间与星期 |

## 运行演示

2 分钟完整演示：登录、聊天创建提醒、日历敏感操作确认、上传脱敏文档、结构化详情、RAG 引用与 Agent 执行计划。

<p align="center">
  <a href="docs/demo/qingning-agent-demo.mp4">▶ 播放青柠 Agent 完整运行视频（MP4）</a>
</p>

> 登录、提醒、日历确认、SQLite、RAG 与 Agent 计划均运行真实代码；演示后端仅对固定脱敏图片提供确定性 OCR，避免外部视觉模型波动。运行 `cd web && npm run demo:record` 可重复录制。

## 技术

- 前端：React、TypeScript、Vite
- 通信：SSE（可中断、可重连、`seq` 去重）
- 后端：FastAPI + SQLite
- 模型：OpenAI 兼容 Chat Completions（豆包 / DeepSeek / 硅基流动 / 自定义等）
- 评测：Python `unittest` + Agent eval + Playwright e2e

## 目录

```
青柠/
├── web/          React + TypeScript
├── server/       Python FastAPI（含本机 data/，已 gitignore）
└── docs/         评测指标与完整演示视频
```

## 本地运行

### 一键启动（推荐）

```bash
./scripts/local-dev.sh
```

脚本会先检查 Python / Node / npm、前后端依赖、`.env` 和 8000/5173 端口，然后同时启动前后端。按 `Ctrl+C` 会同时停止两个服务。

只做环境检查、不启动：

```bash
./scripts/local-dev.sh --check
```

### 分别启动

**1. 后端**

```bash
cd server
python3 -m pip install -r requirements.txt --user
# 可选：用 .env 作为默认豆包配置（也可稍后在页面「模型设置」里填）
cp .env.example .env   # 编辑 ARK_API_KEY / ARK_MODEL
python3 -m uvicorn main:app --reload --port 8000
```

看到 `Uvicorn running on http://127.0.0.1:8000` 即可。

**2. 前端（另开终端）**

```bash
cd web
npm install
npm run dev
```

浏览器打开 http://127.0.0.1:5173 。Vite 已把 `/api` 代理到 `8000`。

**3. 自检**

- 顶栏徽章：有 Key →「豆包 · …」等；无 Key →「演示模式」
- 点「隐私说明」可看数据落点；点「模型设置」可改提供商（Key 只写本机 `server/data/`）

## 接入模型（两种方式）

### A. 环境变量（默认豆包）

1. [火山方舟控制台](https://console.volcengine.com/ark) 创建 API Key 与推理接入点。
2. `server/.env`：

```bash
ARK_API_KEY=your_key
ARK_MODEL=ep-xxxxxxxx        # 接入点 ID
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
# 可选：ARK_VISION_MODEL=...  # 读图审核专用，默认与 ARK_MODEL 相同
```

3. 重启后端。

### B. 页面「模型设置」（多提供商）

在顶栏打开「模型设置」，选择豆包 / DeepSeek / OpenAI / 硅基流动 / 自定义，填写 Key 与模型名。  
配置写入本机 `server/data/llm_runtime.json`（已在 `.gitignore`），**前端响应里只会看到脱敏后的 Key 提示，不会回传完整密钥**。

> 文书内容仍会发往你所选的模型服务商；请先脱敏/打码。详见页内隐私说明。

## 常见问题

| 现象 | 处理 |
|------|------|
| 页顶「后端未就绪」 | 先启动 `uvicorn`；确认 `8000` 未被占用；前端用 `5173` 且代理未改坏 |
| 一直「演示模式」 | `.env` 未填 Key，或未重启后端；也可在「模型设置」保存 Key |
| 发送失败 / Failed to fetch | 后端挂了或 CORS/代理异常；看终端报错；点「重试连接后端」 |
| 图片审核失败 | 需要已配置可用视觉模型；或改用粘贴文本 |
| 豆包 401/403 | Key 或接入点 ID 错误；`ARK_MODEL` 一般是 `ep-` 开头 |
| 改了 `.env` 仍用旧模型 | 若用过「模型设置」，运行时文件优先；可在设置里「恢复为环境变量」 |

密钥与 `server/data/` **不要提交 Git**。仓库：[dml580/qingning-agent](https://github.com/dml580/qingning-agent)。

## 测试与评测

```bash
# 后端 Skill / 安全边界
cd server && python3 -m unittest test_agent_core.py

# Agent / RAG 离线评测
cd server && python3 eval_agent.py

# 冻结测试集：隐藏工具样例、负例、RAG 难例，并生成 docs/evaluation-metrics.md
cd server && python3 eval_quality.py

# 前端构建
cd web && npm run build

# 登录、账号隔离、提醒主链路
cd web && npm run test:e2e
```

## 工程要点

1. 会话列表、消息区、输入区拆开；流式状态 `connecting → generating → completed | failed | cancelled`。
2. 失败/取消保留半截，**不会**落成 `completed`。
3. Skill 注册表统一管理 JSON Schema、超时、副作用和确认动作。
4. 外部搜索内容标记为不可信数据，不得当作系统指令。
5. 助手消息可复制全文 / 导出 Markdown；长内容保留虚拟列表实现。

## 评测指标

开发回归集与冻结测试集分开维护。冻结集覆盖口语/错别字、矛盾日期、多工具冲突、负例、提示注入、无答案与干扰片段；详见 [评测指标](docs/evaluation-metrics.md)。这些数字是规则化离线回归结果，不等同于线上模型准确率。

## 可观测性与安全

- 每个请求生成 `X-Request-ID`，服务端输出不含正文、Cookie、密码和密钥的结构化日志。
- 账号菜单提供“开发诊断”：按当前账号聚合 Skill 成功率/P95、确认漏斗、模型调用、Token 与错误摘要。
- Cookie 写请求校验 Origin/Sec-Fetch-Site；登录失败 5 次后限流 5 分钟；新密码至少 8 位且包含字母和数字。
- 上传同时校验体积、声明 MIME 与文件头；5 秒内相同提醒写入自动去重；账号备份带 SHA-256 完整性校验。
- 外部搜索端点固定且结果按不可信数据处理，提示注入文本不得升级为系统指令。

## 当前边界

- 项目当前以本机个人使用为主，未开放公网注册。
- PWA 安装后仍依赖本机 FastAPI 后端运行。
- macOS 本地日历同步只作用于运行后端的这台 Mac。
- SQLite 适合当前本地规模；多实例、高并发和公网运营需另行升级。
- 当前未接外部告警平台；公网开放前还需补账号注销/数据删除、持久化分布式限流、密钥轮换和集中错误追踪。

## 许可

本仓库源码以 **[Apache License 2.0](LICENSE)** 发布（见 `LICENSE`、`NOTICE`）。

- 保留作者版权；再分发/修改须保留许可证与署名，并标明改动。
- **不授予**「青柠」名称与吉祥物等标识的商标使用权。
- 分析输出仅供参考，**不构成法律意见**；勿把真实隐私与 API Key 提交进仓库。

## 文档

- [评测指标](docs/evaluation-metrics.md)

## 后续路线

当前优先补充真实脱敏评测集、能力管理交互和本地安装验收；公网部署暂缓。
