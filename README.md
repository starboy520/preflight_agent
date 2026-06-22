# Agent Run Preflight Workbench

这是 AgentOS Agent Run Preflight Workbench 上机题的独立全栈实现。

## 交付内容

- 需求分析与技术设计：`docs/agent-run-preflight-workbench.md`
- 实施计划：`docs/superpowers/plans/2026-06-22-agent-run-preflight-workbench.md`
- 后端接口：`POST /api/v1/platform/runtime/agent-runs/preflight`
- 前端页面：`/admin/runtime/agent-run-preflight`
- 后端和前端测试用例

## 后端启动

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

健康检查：

```txt
GET http://localhost:8000/health
```

Preflight 接口：

```txt
POST http://localhost:8000/api/v1/platform/runtime/agent-runs/preflight
```

运行后端测试：

```bash
cd backend
.venv/bin/python -m pytest
```

## 前端启动

```bash
cd frontend
npm install
VITE_API_BASE_URL=http://localhost:8000 npm run dev
```

浏览器打开：

```txt
http://localhost:5173/admin/runtime/agent-run-preflight
```

运行前端检查：

```bash
cd frontend
npm test
npm run typecheck
npm run build
```

## 说明

后端会把请求体中的 `skills` 和 `tools` 视为本次 Preflight 的 registry snapshot，用于判断任务引用的 Skill / Tool 是否存在。本实现不连接真实 Skill Registry、Tool Registry、审批流、Sandbox 调度器或数据库。
