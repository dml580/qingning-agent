# 青柠

生活文书工作台：把合同与通知里的约定说明白。React 负责状态与渲染，Python 负责会话、SSE 推流、结束落库。  
配好火山方舟密钥后，回答来自**豆包**真流式；未配置则自动走演示文案。

## 技术

- 前端：React、TypeScript、Vite
- 通信：SSE（可中断、可重连、`seq` 去重）
- 后端：FastAPI + SQLite
- 模型：火山方舟豆包（OpenAI 兼容 Chat Completions 流式）
- 产品模块：左侧大板块（生活文书已上线 / 生活提醒预留）；文书下 5 个场景模版（通用、租房、劳动、培训、分期贷款）

## 目录

```
实时工作台/
├── web/          React + TypeScript
├── server/       Python FastAPI
└── docs/         虚拟列表对比说明
```

## 接入豆包（真回答）

1. 打开 [火山方舟控制台](https://console.volcengine.com/ark)，开通服务，创建 **API Key**。
2. 在「模型推理」里创建**推理接入点**（可用带免费额度的豆包 Lite / Pro，以控制台为准）。
3. 复制 `server/.env.example` 为 `server/.env`：

```bash
cd server
cp .env.example .env
# 编辑 .env：填入 ARK_API_KEY 与 ARK_MODEL（接入点 ID，一般是 ep-xxxx）
```

4. 重启后端。右上角徽章应显示「豆包 · …」，而不是「演示模式」。

> 密钥只放本机 `.env`，不要提交仓库。新用户常有免费额度，具体以控制台账单为准。

## 本地运行

```bash
# 后端
cd server
python3 -m pip install -r requirements.txt --user
python3 -m uvicorn main:app --reload --port 8000

# 前端（另开终端）
cd web
npm install
npm run dev
```

浏览器打开 http://127.0.0.1:5173 。`/api` 已代理到 8000。

## 工程要点

1. 会话列表、消息区、输入区拆开（`SessionList` / `MessageArea` / `InputArea`）。
2. 流式：中断、失败重试；状态 `connecting → generating → completed | failed | cancelled`。
3. 长内容行级虚拟列表 + 右侧节点数 / FPS 对比（见 `docs/virtual-list-compare.md`）。
4. 失败/取消保留半截内容，**不会**落成 `completed`。
5. 部署后留公网地址，再写进简历。

没有线上地址、没有虚拟列表对比、状态串在一起，先不要写进简历。

## 待办提醒

后续要完善的、有空再做的、以及「页面自选大模型 API」等想法，记在 [docs/待办与路线图.md](docs/待办与路线图.md)。有空打开勾选即可。
