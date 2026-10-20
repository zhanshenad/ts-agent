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
| 命令权限 | `src/permissions.ts` | 四档模式：关闭 / 严格 / 智能 / 自动，服务端可设上限 |
| 文件上传 | `src/uploads.ts` | 图片、文档、代码拖入即传；文本内联、图片走多模态、其余交给工具按路径读 |

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
- **命令权限**：顶栏可切「严格 / 智能 / 自动 / 关闭」，服务端可设上限
- **文件上传**：点 📎 或直接把文件拖进窗口，图片、文档、代码都行
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

### 命令权限

`shell` 工具的执行权由模式决定：

| 模式 | 行为 |
| --- | --- |
| `off`（关闭） | 完全禁用，工具直接返回「已禁用」 |
| `strict`（严格） | 每条命令都必须人工确认 |
| `smart`（智能，默认） | 只读命令（`ls`/`cat`/`git status`/`npm test`…）直接跑，其余一律确认 |
| `auto`（自动） | 全部直接跑 |

判定逻辑在 `src/permissions.ts`：

1. 按 `&&`、`||`、`;`、`|` 把命令拆成多段（引号内不拆，`2>&1` 不拆）
2. 先剔除无害重定向：`>nul`、`> /dev/null`、`2>&1` 只是丢弃输出，不算写文件
3. 任何一段命中危险模式（`rm`、`del`、`>` 写文件、`git push`、`npm install`、`| sh`、`find -delete`、`sort -o`…）→ 整条危险
4. **每一段**都命中只读白名单 → 整条安全
5. 其余一律按危险处理（保守）

所以这种链式只读命令在智能模式下直接放行，不会再弹确认：

```
cd /d "D:\proj\src" && chcp 65001 >nul && type service\impl\X.java | more +0 && echo ====
```

权限上限由服务端掌握，浏览器只能往下调：

```bash
npm run serve                            # 默认 --max-mode smart
npm run serve:auto                       # 放开到 auto（自担风险）
node dist/server.js --max-mode strict    # 只允许「严格」和「关闭」
```

- 请求里的 `mode` 会被 `clampMode()` 夹到上限，`start` 事件返回实际生效的 `mode`
- 页面上超出上限的选项会显示成「自动（需 --max-mode auto）」，点它会在状态栏直接告诉你原因，而不是默默灰掉
- **非本机访问一律强制 `strict`**，避免局域网里有人直接把 shell 开到 auto
- CLI 默认 `strict`；`--mode smart|auto|off` 可改，`--yes` 等价于 `auto`

### 文件上传

点输入框左边的 📎，或把文件直接拖进页面。单文件上限 10 MB，一次最多 10 个。

文件存到 `.tsagent/uploads/<8位id>-<安全文件名>`，然后按类型处理：

| 类型 | 处理方式 |
| --- | --- |
| 文本 / 代码 / 文档（`.txt .md .json .csv .ts .py .sql` …） | 内容内联进这一轮消息（截断 50 KB），模型直接看到 |
| 图片（`.png .jpg .webp` …）且模型标记了 `vision: true` | 转成 `image_url` 多模态块发给模型 |
| 图片但模型不支持视觉 | 明确告诉模型「你看不到画面」，让它转告用户换模型或改用文字描述；**不会**再给它路径去 `read_file` |
| 其他二进制（zip、pdf…） | 只给路径和大小，交给工具处理 |

`models.json` 里给模型加 `"vision": true` 即可启用看图，例如内置的 `qwen-vl-max`。
页面的模型下拉会给这类模型标「可看图」，设置面板也会显示当前模型是「支持图片」还是「仅文本」。

> ⚠️ `deepseek-chat`、`gpt-4o-mini` 这类是**纯文本模型**，没有视觉输入能力——传图片给它们，
> 它们真的看不见，这不是框架的问题。要读图请选 `qwen-vl-max` 这类视觉模型。

`read_file` 遇到二进制会直接拒绝并说明原因（图片会额外提示换视觉模型），不会再把 JPEG 当文本吐一堆乱码。

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
| POST | `/api/upload` | multipart 上传，返回 `{files:[{id,name,size,mime,kind,url}]}` |
| GET | `/uploads/:id` | 回显已上传的文件 |
| POST | `/v1/chat/completions` | OpenAI 兼容（**纯 chat**，不走工具循环） |
| GET | `/api/health` | 健康检查 |

`/api/chat` 的请求与 SSE 事件：

```json
// 请求
{
  "sessionId": "可选",
  "modelId": "qwen-plus",
  "message": "帮我看看这个文件",
  "system": "",
  "temperature": 0.7,
  "mode": "smart",
  "attachments": [{ "id": "1a2b3c4d-notes.md" }]
}
```

| 事件 | 含义 |
| --- | --- |
| `start` | `{sessionId, model, mode, maxMode}`，新会话时前端要记住 `sessionId` |
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

五层，全部用本地假模型，不联网、不花钱。

| 命令 | 层 | 覆盖 |
| --- | --- | --- |
| `npm run test:unit` | 单元 | `mdToHtml`（XSS / `javascript:` / 代码块）、命令风险判定、权限夹取、上传文件名清洗、multipart 解析、`read_file` 二进制防护、`globToRegExp`、路径沙箱、模型配置、记忆检索、wire 格式 |
| `npm run test:api` | 集成 | 四种权限模式、权限上限降级、审批拒绝/超时、409 并发、上游 401/500、畸形 JSON、超大消息、断连释放锁、上传与附件注入、SSRF |
| `npm run test:web` | 集成 | Web 网关主链路：模型列表不泄 key、SSE 帧、工具调用、会话落盘 |
| `npm run test:cli` | 集成 | 工具循环、会话落盘、shell 审批、路径穿越、edit/grep 往返 |
| `npm run test:retry` | 回归 | 连接被重置后重试（`fetch failed` 的回归用例） |
| `npm run test:contract` | 契约 | 用官方 `openai` SDK 打 `/v1`：非流式、流式、404 |
| `npm run test:e2e` | E2E | Chromium 驱动真实页面：发消息、工具卡片、点击审批、刷新恢复、模型管理 |
| `npm run test:perf` | 非功能 | 10 路并发、40 轮长会话劣化、abort 风暴泄漏、4000 字输出 |

`npm test` 依次跑全部（约 1 分钟，其中 E2E 会启动浏览器）。

E2E 复用机器上已下载的 Playwright Chromium；找不到时设置 `PW_CHROMIUM_PATH`，否则自动跳过（退出码 0）。

**回归纪律**：每修一个 bug，先写一条会失败的用例，再修。`tests/retry.test.mjs` 就是 `fetch failed` 留下的那道疤。

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
