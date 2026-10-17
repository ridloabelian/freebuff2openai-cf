export interface Env {
  FREEBUFF_KV: KVNamespace;
  API_KEY?: string;
  ADMIN_PASSWORD?: string;
  FREEBUFF_AUTH_BASE_URL?: string;
  CODEBUFF_API_BASE_URL?: string;
  ZEROCLICK_API_BASE_URL?: string;
  DEFAULT_MODEL?: string;
}

export interface FreebuffSessionState {
  instanceId: string;
  model: string;
  status: string;
  expiresAt?: string;
  remainingMs?: number;
  updatedAt: number;
}

export interface FreebuffAccount {
  id: string;
  name?: string;
  email?: string;
  authToken: string;
  added_at: string;
  last_used_at?: string;
  last_error?: string | null;
  session?: FreebuffSessionState | null;
  agents_validated?: boolean;
}

export interface FreebuffPoolState {
  accounts: FreebuffAccount[];
  rr_index: number;
  updated_at: string;
}

export interface CliLoginStartResponse {
  fingerprintId: string;
  fingerprintHash: string;
  loginUrl: string;
  expiresAt: number;
  authHost: string;
}

export interface CliLoginPollResult {
  status: "pending" | "completed" | "error";
  user?: {
    id: string;
    name?: string;
    email?: string;
    authToken: string;
  };
  account?: FreebuffAccount;
  error?: string;
}

export interface FreebuffModelDef {
  id: string;
  agent_id: string;
  owned_by: string;
  upstream_model_id: string;
  session_model_id: string;
  parent_agent_id: string | null;
  description?: string;
}

export interface FreebuffRunChain {
  runId: string;
  agentId: string;
  startedAt: string;
  payloadRunId: string;
  childRunId?: string;
  chatRunId?: string;
  chatStartedAt?: string;
}

export interface OpenAIToolCall {
  index?: number;
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface OpenAIChatMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content?: string | Array<Record<string, unknown>> | null;
  name?: string;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  cache_control?: { type: string };
  [key: string]: unknown;
}

export interface OpenAIChatCompletionRequest {
  model?: string;
  messages: OpenAIChatMessage[];
  stream?: boolean;
  stop?: string | string[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  tools?: unknown[];
  tool_choice?: unknown;
  reasoning_effort?: string;
  presence_penalty?: number;
  frequency_penalty?: number;
  response_format?: unknown;
  seed?: number;
  user?: string;
  [key: string]: unknown;
}
