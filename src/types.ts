/** Shared types for the agent runtime. */

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    /** Raw JSON string produced by the model. */
    arguments: string;
  };
}

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/** A message body: plain text, or an OpenAI-style multipart body for images. */
export type MessageContent = string | ContentPart[] | null;

export interface ChatMessage {
  role: Role;
  content: MessageContent;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  description?: string;
  enum?: string[];
  items?: JsonSchema;
  [key: string]: unknown;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
}

export interface ToolContext {
  /** Root folder tools are allowed to touch. */
  workspace: string;
  /** Directory holding sessions / memory / skills (.tsagent). */
  homeDir: string;
  sessionId: string;
  /** How much autonomy the shell tool has. */
  mode: import("./permissions.js").PermissionMode;
  /** Ask the human for permission. Returns false in non-interactive mode. */
  approve(action: string, detail?: string): Promise<boolean>;
  /** Progress line for the UI. */
  log(message: string): Promise<void> | void;
}

export interface Tool {
  spec: ToolSpec;
  /** Whether this tool needs human approval before it runs. */
  destructive?: boolean;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export type ToolRegistry = Map<string, Tool>;

/** Events emitted while the agent loop runs. */
export interface AgentHooks {
  onAssistantText(text: string): void;
  onToolStart(name: string, args: Record<string, unknown>): void;
  onToolEnd(name: string, result: ToolResult): void;
  onIteration?(index: number): void;
}
