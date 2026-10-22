# 青柠

生活文书工作台：把合同与通知里的约定说明白。React 负责状态与渲染，Python 负责会话、SSE 推流、结束落库。

配好大模型密钥后走真流式；未配置则自动「演示模式」。可在页面「模型设置」里切换提供商（Key **只存本机后端**，不会进前端仓库）。

## 技术

- 前端：React、TypeScript、Vite
- 通信：SSE（可中断、可重连、`seq` 去重）
- 后端：FastAPI + SQLite
- 模型：OpenAI 兼容 Chat Completions（豆包 / DeepSeek / 硅基流动 / 自定义等）
- 产品模块：生活文书已上线；生活提醒预留；文书下 5 个场景模版

## 目录

```
实时工作台/
├── web/          React + TypeScript
├── server/       Python FastAPI（含本机 data/，已 gitignore）
└── docs/         路线图、虚拟列表对比说明
```

## 本地运行

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

密钥与 `server/data/` **不要提交 Git**。仓库：[dml580/qingning-workbench](https://github.com/dml580/qingning-workbench)。

## 工程要点

1. 会话列表、消息区、输入区拆开；流式状态 `connecting → generating → completed | failed | cancelled`。
2. 失败/取消保留半截，**不会**落成 `completed`。
3. 长内容虚拟列表 + 对比面板（见 `docs/virtual-list-compare.md`）。
4. 助手消息可复制全文 / 导出 Markdown。

## 许可

本仓库源码以 **[Apache License 2.0](LICENSE)** 发布（见 `LICENSE`、`NOTICE`）。

- 保留作者版权；再分发/修改须保留许可证与署名，并标明改动。
- **不授予**「青柠」名称与吉祥物等标识的商标使用权。
- 分析输出仅供参考，**不构成法律意见**；勿把真实隐私与 API Key 提交进仓库。

## 文档

- [待办与路线图](docs/待办与路线图.md)
- [面试话术](docs/面试话术.md)
- [AI 前端演示检查清单](docs/AI前端-演示检查清单.md)
- [虚拟列表对比截图](docs/virtual-list-compare.md)
- [浏览器兼容](docs/浏览器兼容.md)

## 待办

下一优先：公网部署；有真实合同时做评测回归。
