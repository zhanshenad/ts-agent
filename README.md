# TsAgent

一个用 **TypeScript** 写的本地 AI 智能体，零运行时依赖（只用 Node 内置 `fetch` / `fs` / `child_process`）。
功能对标我自己平时用的那套 agent 形态：**工具调用循环 + 技能按需加载 + 长期记忆 + 会话持久化 + 子智能体 + 破坏性操作审批**。

```
you> 帮我看下 src/config.ts 有没有 bug，顺便跑下测试
⚙ read_file {"path":"src/config.ts"}
  → src/config.ts (120 lines, showing 1-120) ...
⚙ shell {"command":"npm test"}
⚠ run shell command
  npm test
Allow? [y/N] y
  → ... exit code: 0
  配置加载没问题，但 pick() 在 jsonFile 缺失时会返回字符串 "undefined" ...
```

## 功能

| 能力 | 实现位置 | 说明 |
| --- | --- | --- |
| 工具调用循环 | `src/agent.ts` | 一次 `run()` 内多轮 model → tool → model，直到出最终答案或到达迭代上限 |
| 文件工具 | `src/tools/fs.ts` | `read_file` `write_file` `edit_file` `list_dir` `glob` `grep`，全部沙箱在 workspace 内 |
| Shell | `src/tools/shell.ts` | 默认要人批准；`--yes` 或在沙箱里才自动放行 |
| 联网 | `src/tools/web.ts` | `web_fetch`，HTML 转纯文本、限长、30s 超时 |
| 技能 | `src/skills.ts` + `src/tools/skill.ts` | 扫描 `.tsagent/skills/*/SKILL.md`；**只把名字和描述**放进 system prompt，正文按需用 `skill` 工具加载 |
| 长期记忆 | `src/memory.ts` | `MEMORY.md` + `memory/YYYY-MM-DD.md` 每轮注入；`memory_search` 做轻量词法检索；`memory_append` 落盘 |
| 会话持久化 | `src/session.ts` | 每轮落盘 `.tsagent/sessions/<id>.json`，可 `--session <id>` 续聊 |
| 子智能体 | `src/tools/index.ts` | `spawn_subagent` 开全新上下文跑独立任务，只回传最终结论（禁止嵌套递归） |
| 模型接入 | `src/llm.ts` | 任何 OpenAI 兼容的 `/chat/completions`：OpenAI、DeepSeek、通义/DashScope、Ollama、vLLM… |
| 中断 | `src/index.ts` | Ctrl+C 取消当前请求，会话已落盘 |
| Web 界面 | `src/server.ts` + `public/` | 完整的 agent 循环（工具 / 技能 / 记忆 / 会话）+ 工具卡片 + 审批弹窗；同时提供 OpenAI 兼容的 `/v1/chat/completions` |

## 快速开始

```bash
cd ts-agent
npm install
npm run build
npm run serve
```

打开 http://127.0.0.1:8787 ，右上角 **⚙ → 模型 → ＋ 添加模型**：选好提供商，填 Base URL、模型名、API Key，保存后回到顶部下拉框选中它就能聊。

**不需要事先准备 `.env`**。网页里保存的配置写进 `models.local.json`，重启后仍在；环境里已有的 key（比如 `DASHSCOPE_API_KEY`）会被自动识别，列表直接显示「已配置」。

想用命令行版 agent（工具 / 技能 / 记忆 / 会话），再配 `.env`：

```bash
cp .env.example .env        # 填 TSA_API_KEY / TSA_BASE_URL / TSA_MODEL
node dist/index.js "用一句话介绍你自己"
node dist/index.js          # 交互模式
```

> Web 端读 `models.json` + `models.local.json`，CLI 端读 `TSA_*` 环境变量，是两套配置。

Windows 下把 `node dist/index.js` 换成 `node dist\index.js`，或 `npm link` 之后直接用 `tsagent`。

### 配置项

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TSA_API_KEY` | — | 必填，`Bearer` token |
| `TSA_BASE_URL` | `https://api.openai.com/v1` | 兼容端点，末尾不要带 `/chat/completions` |
| `TSA_MODEL` | `gpt-4o-mini` | 模型名 |
| `TSA_TEMPERATURE` | `0.3` | 采样温度 |
| `TSA_MAX_ITERATIONS` | `16` | 单次提问内最多几轮工具调用 |
| `TSA_WORKSPACE` | 当前目录 | 工具可访问的根目录，越界路径直接拒绝 |
| `TSA_AUTO_APPROVE` | `false` | 危险工具免审批（仅限沙箱/CI） |

优先级：命令行参数 > 环境变量 > `./.env` > `.tsagent/config.json` > 默认值。

常用参数：

```bash
node dist/index.js -p "把 README 翻成英文"      # 单次执行
node dist/index.js -s 20261020-...              # 续接会话
node dist/index.js --list-sessions
node dist/index.js -m deepseek-chat --base-url https://api.deepseek.com/v1
node dist/index.js -w C:\work\my-project        # 限定可操作目录
```

## Web 界面

```bash
npm run serve          # 启动，默认 http://127.0.0.1:8787
```

页面能力：

- **选模型**：下拉框按 provider 分组，未配置 key 的模型会标注出来但仍可选（选中后请求会明确报错）
- **完整 agent 能力**：不是单轮聊天——模型可以连续调用工具（读写文件、grep、抓网页、查记忆、加载技能），每一步都实时显示
- **工具卡片**：显示工具名、参数、状态（运行中 / 完成 / 失败）和输出摘要
- **审批弹窗**：`shell` 这类危险工具会停下来问你，点「允许」才执行；120 秒不回答自动拒绝
- **会话持久化**：每轮写入 `.tsagent/sessions/`，刷新页面自动恢复上次对话
- **模型管理**：右上角 ⚙ → 「模型」标签页里可以增删改模型、填 API key、点「测试」发一个极小的请求验证连通性
- **流式输出**：逐字返回，带停止按钮；支持 Markdown 代码块、列表、行内代码
- **参数面板**：System prompt、temperature，存 localStorage
- **消息元信息**：模型名、耗时、字数、一键复制

模型清单来自 `models.json`（不存在时用内置列表）：

```json
{
  "id": "qwen-plus",
  "label": "Qwen Plus",
  "provider": "DashScope",
  "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
  "model": "qwen-plus",
  "apiKeyEnv": "DASHSCOPE_API_KEY"
}
```

`apiKeyEnv` 指向环境变量名，key 只在服务端读取，**不会下发到浏览器**（`/api/models` 只返回 `available` / `hasKey` 布尔值）。
本地 Ollama 用 `"requiresKey": false` 就能免 key 使用。也可以用 `TSA_MODELS_FILE=/path/to/models.json` 换一份目录。

### 在网页里加模型和填 key

不用改文件：⚙ → 「模型」→ 「＋ 添加模型」，填 Base URL / 模型名 / API Key 即可，保存后立刻出现在下拉框。

- 写入 `models.local.json`（**明文 key**，已加入 `.gitignore`），与 `models.json` 分离，不会被覆盖
- **key 是只写不读的**：接口不会回传明文，页面只能看到「已配置 / 未配置」
- 编辑时 API Key 留空 = 保留原值；内置模型保存后会以「本地覆盖」的形式生效，可以「删除」来隐藏它
- 「测试」按钮会发一次 `max_tokens=8` 的最小请求，只在你点击时才发出
- 存储路径可用 `TSA_MODELS_LOCAL_FILE` 覆盖

### 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/` | 聊天页面 |
| GET | `/api/models` | 模型列表（含可用性，不含 key） |
| POST | `/api/models` | 新增/修改模型，body 里的 `apiKey` 只写不读 |
| DELETE | `/api/models/:id` | 删除；内置模型会被隐藏 |
| POST | `/api/models/:id/test` | 发一个最小请求验证 key / baseUrl |
| POST | `/api/sessions` | 新建会话，返回 id |
| GET | `/api/sessions/:id` | 取会话历史（含 tool 消息） |
| POST | `/api/chat` | 完整 agent 一轮，SSE 流式，见下表 |
| POST | `/api/chat/approve` | 回答审批：`{approvalId, approved}` |
| POST | `/v1/chat/completions` | OpenAI 兼容（**纯 chat**，不走工具循环） |
| GET | `/api/health` | 健康检查 |

`/api/chat` 的请求与 SSE 事件：

```json
// 请求
{ "sessionId": "可选", "modelId": "qwen-plus", "message": "帮我看看 src 里的代码", "system": "", "temperature": 0.7 }
```

| 事件 | 含义 |
| --- | --- |
| `start` | `{sessionId, model}`，新会话时前端要记住 `sessionId` |
| `iteration` | 第几轮工具循环 |
| `delta` | `{text}` 模型输出的增量文本 |
| `tool_start` | `{name, args}` 开始调用工具 |
| `tool_end` | `{name, ok, preview}` 工具返回 |
| `approval` | `{approvalId, action, detail}` 需要用户确认 |
| `approval_timeout` | 超时自动拒绝 |
| `done` | `{chars, ms, sessionId}` |
| `error` | `{message, aborted}` |

OpenAI 兼容端点可以这么用（把任意 OpenAI SDK 的 baseURL 指过来即可）：

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{"model":"qwen-plus","messages":[{"role":"user","content":"hi"}]}'

# 流式
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{"model":"qwen-plus","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

默认只监听 `127.0.0.1`。用 `--host 0.0.0.0` 暴露到局域网时会有警告——那等于把你的 API 额度开放给同网段所有人。

## 目录结构

```
ts-agent/
├─ src/
│  ├─ index.ts        CLI：参数解析、REPL、审批、子智能体装配
│  ├─ server.ts       Web 网关：SSE 聊天 + OpenAI 兼容接口
│  ├─ models.ts       模型目录（models.json）与 key 解析
│  ├─ agent.ts        核心循环：system 刷新 → 模型 → 工具执行 → 落盘
│  ├─ llm.ts          OpenAI 兼容客户端（含重试）
│  ├─ prompt.ts       system prompt 组装（环境 / 行为准则 / 记忆 / 技能清单）
│  ├─ memory.ts       记忆注入 + 词法检索 + 日记追加
│  ├─ skills.ts       SKILL.md 扫描与 frontmatter 解析
│  ├─ session.ts      会话 JSON 存储
│  ├─ types.ts        消息 / 工具 / 钩子类型
│  ├─ ui.ts           ANSI 输出
│  └─ tools/          fs · shell · web · memory · skill · registry
├─ examples/skills/   示例技能（复制到 .tsagent/skills/ 即生效）
├─ public/            Web 前端（index.html / app.js / style.css，无构建）
├─ models.json        可选模型清单
└─ tests/             假模型服务器 + 端到端测试
```

运行期产生的状态全部在 `<workspace>/.tsagent/`：

```
.tsagent/
├─ config.json       可选配置
├─ MEMORY.md         长期事实
├─ memory/           每日笔记
├─ sessions/         会话记录
└─ skills/           技能包
```

## 加一个技能

```bash
mkdir .tsagent/skills/my-skill
```

`.tsagent/skills/my-skill/SKILL.md`：

```markdown
---
name: my-skill
description: 一句话说明这个技能干什么、什么时候用。
---

# My skill

1. 第一步……
2. 第二步……
```

重启后 `skill` 工具就能按名字加载它；system prompt 里只占一行描述，不会撑爆上下文。

## 加一个工具

在 `src/tools/` 新建文件，导出一个 `Tool`：

```ts
import type { Tool } from "../types.js";

export const hello: Tool = {
  spec: {
    name: "hello",
    description: "Say hello to someone.",
    parameters: {
      type: "object",
      properties: { who: { type: "string" } },
      required: ["who"],
    },
  },
  async run(args) {
    return { content: `Hello, ${String(args.who)}!` };
  },
};
```

然后在 `src/tools/index.ts` 的 `createToolRegistry` 里 `add([hello])`。
`destructive: true` 的工具会先走 `ctx.approve()` 人工确认。

## 测试

```bash
npm test
```

冒烟测试会起一个本地假模型服务器（不联网、不花钱），依次验证：

1. 完整工具循环（写文件 → 加载技能 → 写记忆 → 给出结论）
2. 会话落盘且 `tool` 消息带了 `tool_call_id`
3. 未加 `--yes` 时 shell 被拒绝、命令确实没执行
4. 路径越界被拦截
5. `write_file` / `edit_file` / `grep` 往返正确

Web 网关另有一套（`node tests/server.test.mjs`，也可 `npm run test:web`）：起一个假的 SSE 上游，
验证 `/api/models` 不下发 key、`/api/chat` 的 start/delta/done 帧、`/v1/chat/completions`
的流式与非流式、以及错误模型名 / 非法 role 的 400/404。

## 设计取舍

- **不流式**：非流式实现让工具调用解析和落盘逻辑简单得多；要流式只需在 `llm.ts` 里改 SSE 解析。
- **无向量库**：记忆用词法检索（分词 + 命中计分），零依赖、可解释；数据量大了再换 embedding。
- **顺序执行工具**：工具可能有副作用，并行会引入竞态；真实需要时再按 `spec` 标记只读工具并行。
- **单文件沙箱**：所有路径 `resolve` 后必须落在 workspace 内（Windows 大小写不敏感也已处理）。
- **无上下文压缩**：会话长了会顶到模型窗口上限；下一步可加「摘要 + 滑窗」。

## 已知限制

- 依赖模型的 tool calling 能力，纯文本模型无法使用。
- Web 端的工具集里禁用了 `spawn_subagent`：子代理内部的工具审批无法在页面上呈现，接进来等于隐式授权。
- `/v1/chat/completions` 保持纯 chat（不走工具循环），否则会破坏 OpenAI 客户端的语义预期。
- 同一个会话同时只能跑一轮，并发请求返回 409。
- 会话不会自动压缩，聊得很长会顶到模型上下文上限。
- 子智能体的记忆写入是共享的（同一个 `.tsagent/MEMORY.md`），并发跑多个子代理会互相追加。
- 没有内置 MCP 客户端，但 `Tool` 接口很容易包一层。
