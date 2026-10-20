import type { Config } from "./config.js";
import { chatCompletion, chatCompletionStream } from "./llm.js";
import type { PermissionMode } from "./permissions.js";
import type { Session, SessionStore } from "./session.js";
import type {
  AgentHooks,
  ChatMessage,
  ContentPart,
  ToolCall,
  ToolContext,
  ToolRegistry,
  ToolResult,
} from "./types.js";

export interface ApprovalRequest {
  action: string;
  detail?: string;
}

export interface AgentOptions {
  config: Config;
  tools: ToolRegistry;
  session: Session;
  store: SessionStore;
  /** Rebuilt on every turn so memory/skill edits take effect immediately. */
  buildSystemPrompt?: () => string;
  hooks?: AgentHooks;
  /** Human approval callback for destructive tools. Defaults to deny. */
  approve?: (req: ApprovalRequest) => Promise<boolean>;
  maxIterations?: number;
  /** How much autonomy the shell tool gets. Defaults to strict. */
  mode?: PermissionMode;
  /** Static signal, or a getter so the caller can swap it per turn. */
  signal?: AbortSignal | (() => AbortSignal | undefined);
  /** Runner for spawn_subagent; omitted inside subagents to prevent recursion. */
  subagentRunner?: (task: string) => Promise<string>;
}

const noopHooks: AgentHooks = {
  onAssistantText: () => {},
  onToolStart: () => {},
  onToolEnd: () => {},
};

export class Agent {
  private current: Session;
  private readonly hooks: AgentHooks;

  constructor(private readonly opts: AgentOptions) {
    this.hooks = opts.hooks ?? noopHooks;
    this.current = opts.session;
  }

  get session(): Session {
    return this.current;
  }

  get messages(): ChatMessage[] {
    return this.current.messages;
  }

  /** Swap in a different (e.g. freshly created) session in place. */
  setSession(session: Session): void {
    this.current = session;
  }

  private signal(): AbortSignal | undefined {
    return typeof this.opts.signal === "function" ? this.opts.signal() : this.opts.signal;
  }

  /** Re-run the system prompt builder and keep it at index 0. */
  private refreshSystem(): void {
    if (!this.opts.buildSystemPrompt) {
      if (this.messages[0]?.role !== "system") {
        this.messages.unshift({ role: "system", content: "You are a helpful agent." });
      }
      return;
    }
    const prompt = this.opts.buildSystemPrompt();
    if (this.messages[0]?.role === "system") this.messages[0].content = prompt;
    else this.messages.unshift({ role: "system", content: prompt });
  }

  private toolContext(): ToolContext {
    return {
      workspace: this.opts.config.workspace,
      homeDir: this.opts.config.homeDir,
      sessionId: this.current.id,
      mode: this.opts.mode ?? "strict",
      approve: async (action, detail) => {
        if (this.opts.config.autoApprove) return true;
        if (!this.opts.approve) return false;
        return await this.opts.approve({ action, detail });
      },
      log: (message) => this.hooks.onAssistantText(message),
    };
  }

  /**
   * Run one user turn to completion.
   * Pass `onDelta` to stream assistant text as it arrives; the tool loop is
   * identical either way, so a streaming caller keeps full agent behaviour.
   */
  async run(input: string | ContentPart[], onDelta?: (text: string) => void): Promise<string> {
    this.refreshSystem();
    this.messages.push({ role: "user", content: input });
    this.opts.store.save(this.current);

    const tools = [...this.opts.tools.values()].map((t) => t.spec);
    const maxIterations = this.opts.maxIterations ?? this.opts.config.maxIterations;
    const streaming = typeof onDelta === "function";
    let lastText = "";

    for (let i = 0; i < maxIterations; i++) {
      this.hooks.onIteration?.(i);

      let content = "";
      let toolCalls: ToolCall[] = [];

      if (streaming) {
        for await (const event of chatCompletionStream(this.opts.config, this.messages, {
          signal: this.signal(),
          tools,
        })) {
          if (event.type === "text") {
            content += event.text;
            onDelta!(event.text);
          } else {
            toolCalls = event.toolCalls;
          }
        }
      } else {
        const result = await chatCompletion(this.opts.config, this.messages, tools, {
          signal: this.signal(),
        });
        content = result.content ?? "";
        toolCalls = result.toolCalls;
      }

      const assistant: ChatMessage = {
        role: "assistant",
        content: content || null,
      };
      if (toolCalls.length) assistant.tool_calls = toolCalls;
      this.messages.push(assistant);

      if (content.trim()) {
        lastText = content;
        if (!streaming) this.hooks.onAssistantText(content);
      }

      if (!toolCalls.length) {
        this.opts.store.save(this.current);
        return (content || lastText).trim();
      }

      for (const call of toolCalls) {
        const name = call.function.name;
        const tool = this.opts.tools.get(name);

        let args: Record<string, unknown> = {};
        let parseError: string | undefined;
        try {
          const raw = call.function.arguments?.trim() || "{}";
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            args = parsed as Record<string, unknown>;
          } else {
            parseError = "Tool arguments must be a JSON object.";
          }
        } catch (err) {
          parseError = `Invalid JSON in tool arguments: ${(err as Error).message}`;
        }

        this.hooks.onToolStart(name, args);

        let toolResult: ToolResult;
        if (!tool) {
          toolResult = {
            content: `Unknown tool "${name}". Available: ${[...this.opts.tools.keys()].join(", ")}`,
            isError: true,
          };
        } else if (parseError) {
          toolResult = { content: parseError, isError: true };
        } else {
          try {
            toolResult = await tool.run(args, this.toolContext());
          } catch (err) {
            toolResult = { content: `Tool "${name}" failed: ${(err as Error).message}`, isError: true };
          }
        }

        this.hooks.onToolEnd(name, toolResult);
        this.messages.push({
          role: "tool",
          tool_call_id: call.id,
          name,
          content: toolResult.content.slice(0, 100_000),
        });
      }

      this.opts.store.save(this.current);
    }

    const notice = `Stopped after ${maxIterations} tool iterations without a final answer. Ask me to continue, or narrow the task.`;
    this.messages.push({ role: "assistant", content: notice });
    this.opts.store.save(this.current);
    return notice;
  }
}
