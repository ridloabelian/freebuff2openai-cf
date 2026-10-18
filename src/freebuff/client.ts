import {
  Env,
  FreebuffAccount,
  FreebuffModelDef,
  FreebuffRunChain,
  FreebuffSessionState,
  OpenAIChatMessage,
} from "../types";
import { isSessionFresh, updateAccountState } from "../kv";
import { getCodebuffBaseUrl } from "./auth";
import {
  buildAgentValidationPayload,
  CONTEXT_PRUNER_AGENT_ID,
} from "./models";

export const CODEBUFF_JSON_USER_AGENT = "Bun/1.3.11";
export const FREEBUFF_CLI_USER_AGENT = "Freebuff-CLI/0.0.105";
export const CHAT_COMPLETIONS_USER_AGENT =
  "ai-sdk/openai-compatible/0.0.0-test/codebuff ai-sdk/provider-utils/3.0.25 runtime/browser";
export const HAR_BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";

const AD_PROVIDERS = ["zeroclick", "codebuff"] as const;

export class CodebuffUpstreamError extends Error {
  status: number;
  code: string;

  constructor(message: string, status = 502, code = "codebuff_upstream_error") {
    super(message);
    this.name = "CodebuffUpstreamError";
    this.status = status;
    this.code = code;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getZeroclickBaseUrl(env: Env): string {
  return (env.ZEROCLICK_API_BASE_URL || "https://zeroclick.dev").replace(
    /\/+$/,
    ""
  );
}

/**
 * Helper for JSON requests to `https://www.codebuff.com`.
 */
async function codebuffJson<T = Record<string, unknown>>(
  env: Env,
  authToken: string | null,
  method: string,
  path: string,
  options: {
    body?: unknown;
    extraHeaders?: Record<string, string>;
    userAgent?: string;
  } = {}
): Promise<T> {
  const baseUrl = getCodebuffBaseUrl(env);
  const url = `${baseUrl}${path}`;

  const headers: Record<string, string> = {
    Accept: "*/*",
    "User-Agent": options.userAgent || CODEBUFF_JSON_USER_AGENT,
    ...(options.extraHeaders || {}),
  };

  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(url, {
    method,
    headers,
    body:
      options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  if (!response.ok) {
    const rawText = await response.text().catch(() => "");
    if (response.status === 409) {
      try {
        const data = JSON.parse(rawText) as {
          error?: string;
          message?: string;
        };
        if (data.error === "session_model_mismatch") {
          throw new CodebuffUpstreamError(
            `Codebuff 409 session_model_mismatch: ${data.message || rawText.slice(0, 300)}`,
            409,
            "session_model_mismatch"
          );
        }
      } catch (e) {
        if (e instanceof CodebuffUpstreamError) throw e;
      }
    }
    throw new CodebuffUpstreamError(
      `Codebuff ${method} ${path} failed (HTTP ${response.status}): ${rawText.slice(0, 400)}`,
      response.status === 401 || response.status === 403
        ? response.status
        : 502,
      `codebuff_${response.status}`
    );
  }

  const text = await response.text();
  if (!text) {
    return {} as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return {} as T;
  }
}

/**
 * Fetch the current Freebuff session state from `/api/v1/freebuff/session`.
 */
export async function getUpstreamSession(
  env: Env,
  authToken: string,
  instanceId?: string
): Promise<Record<string, unknown>> {
  const extraHeaders: Record<string, string> = {};
  if (instanceId) {
    extraHeaders["x-freebuff-instance-id"] = instanceId;
  }
  return codebuffJson<Record<string, unknown>>(
    env,
    authToken,
    "GET",
    "/api/v1/freebuff/session",
    { extraHeaders }
  );
}

/**
 * Delete the currently active Freebuff session on an account.
 */
export async function deleteUpstreamSession(
  env: Env,
  authToken: string
): Promise<void> {
  await codebuffJson(env, authToken, "DELETE", "/api/v1/freebuff/session");
}

/**
 * Query upstream for the account's currently entitled free models (`rateLimitsByModel`).
 */
export async function fetchAccountEntitledModels(
  env: Env,
  authToken: string
): Promise<Set<string>> {
  const data = await getUpstreamSession(env, authToken);
  const rateLimits = data.rateLimitsByModel as
    | Record<string, unknown>
    | undefined;
  if (!rateLimits || typeof rateLimits !== "object") {
    return new Set();
  }
  const set = new Set<string>();
  for (const key of Object.keys(rateLimits)) {
    if (key === "crof/glm-5.2") {
      set.add("z-ai/glm-5.2");
    } else {
      set.add(key);
    }
  }
  return set;
}

/**
 * Convert OpenAI messages to simplified ad context messages.
 */
function formatAdMessages(
  messages?: OpenAIChatMessage[]
): Array<{ role: string; content: string }> {
  if (!Array.isArray(messages)) return [];
  return messages.slice(-6).map((m) => {
    const role = m.role === "developer" ? "system" : String(m.role || "user");
    let content = "";
    if (typeof m.content === "string") {
      content = m.content;
    } else if (Array.isArray(m.content)) {
      content = m.content
        .map((part) => (typeof part?.text === "string" ? part.text : ""))
        .filter(Boolean)
        .join("\n");
    }
    return { role, content: content.slice(0, 1000) };
  });
}

/**
 * Trigger the non-blocking Freebuff ad + streak + impression warm-up chain:
 * `POST /api/v1/ads` -> `GET /api/v1/freebuff/streak` -> `POST https://zeroclick.dev/api/v2/impressions` -> `POST /api/v1/ads/impression`
 * Errors from ad providers are caught and ignored so chat is never blocked.
 */
export async function triggerAdAndStreakWarmup(
  env: Env,
  authToken: string,
  options: {
    messages?: OpenAIChatMessage[];
    surface?: string;
    includeStreak?: boolean;
  } = {}
): Promise<void> {
  const sessionId = crypto.randomUUID();
  const formattedMessages = formatAdMessages(options.messages);

  for (const provider of AD_PROVIDERS) {
    try {
      const body: Record<string, unknown> = {
        provider,
        messages: formattedMessages,
        sessionId,
        device: {
          os: "darwin",
          timezone: "America/Los_Angeles",
          locale: "en-US",
        },
        userAgent: HAR_BROWSER_USER_AGENT,
      };
      if (options.surface) {
        body.surface = options.surface;
      }

      const adsData = await codebuffJson<{
        ads?: Array<{ impressionIds?: string[]; impUrl?: string }>;
      }>(env, authToken, "POST", "/api/v1/ads", {
        body,
        userAgent: FREEBUFF_CLI_USER_AGENT,
      });

      const ad = Array.isArray(adsData.ads) ? adsData.ads[0] : undefined;
      if (!ad) {
        continue;
      }

      if (options.includeStreak) {
        await codebuffJson(
          env,
          authToken,
          "GET",
          "/api/v1/freebuff/streak"
        ).catch(() => {});
      }

      const impressionIds = Array.isArray(ad.impressionIds)
        ? ad.impressionIds
        : [];
      if (impressionIds.length > 0) {
        const zcUrl = `${getZeroclickBaseUrl(env)}/api/v2/impressions`;
        await fetch(zcUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "*/*",
            "User-Agent": CODEBUFF_JSON_USER_AGENT,
          },
          body: JSON.stringify({ ids: impressionIds }),
        }).catch(() => {});
      }

      if (ad.impUrl) {
        await codebuffJson(env, authToken, "POST", "/api/v1/ads/impression", {
          body: { impUrl: ad.impUrl, mode: "LITE" },
          userAgent: FREEBUFF_CLI_USER_AGENT,
        }).catch(() => {});
      }

      return;
    } catch {
      // Ignore ad provider failures and continue
    }
  }
}

/**
 * Parse a `FreebuffSessionState` from upstream `/api/v1/freebuff/session` JSON.
 */
function parseActiveSession(
  data: Record<string, unknown>,
  fallbackModel: string,
  fallbackInstanceId?: string
): FreebuffSessionState {
  const instanceId =
    (typeof data.instanceId === "string" && data.instanceId) ||
    fallbackInstanceId ||
    "";
  if (data.status !== "active" || !instanceId) {
    throw new CodebuffUpstreamError(
      `Freebuff session is not active: ${JSON.stringify(data).slice(0, 300)}`,
      502,
      "session_not_active"
    );
  }
  return {
    instanceId,
    model:
      typeof data.model === "string" && data.model ? data.model : fallbackModel,
    status: "active",
    expiresAt:
      typeof data.expiresAt === "string" ? data.expiresAt : undefined,
    remainingMs:
      typeof data.remainingMs === "number" ? data.remainingMs : undefined,
    updatedAt: Date.now(),
  };
}

/**
 * Create a new Freebuff session (`POST /api/v1/freebuff/session`) and poll
 * if placed into the waiting room (`status === "queued"`).
 */
async function createAndPollSession(
  env: Env,
  authToken: string,
  sessionModelId: string
): Promise<FreebuffSessionState> {
  let data = await codebuffJson<Record<string, unknown>>(
    env,
    authToken,
    "POST",
    "/api/v1/freebuff/session",
    {
      extraHeaders: {
        "x-freebuff-model": sessionModelId,
      },
    }
  );

  if (data.status === "queued") {
    const instanceId =
      typeof data.instanceId === "string" ? data.instanceId : "";
    if (!instanceId) {
      throw new CodebuffUpstreamError(
        `Freebuff queued session missing instanceId: ${JSON.stringify(data)}`,
        502,
        "queued_missing_id"
      );
    }

    const deadline = Date.now() + 25_000;
    let attempts = 0;
    while (data.status === "queued") {
      if (Date.now() >= deadline) {
        throw new CodebuffUpstreamError(
          `Freebuff waiting room queue did not activate within 25s (position=${data.position ?? "?"}, queueDepth=${data.queueDepth ?? "?"}). Please retry shortly.`,
          503,
          "waiting_room_timeout"
        );
      }
      if (attempts > 0) {
        const estMs =
          typeof data.estimatedWaitMs === "number"
            ? data.estimatedWaitMs
            : 2000;
        const delayMs = Math.min(Math.max(estMs / 2, 1200), 2500);
        await sleep(delayMs);
      }
      data = await getUpstreamSession(env, authToken, instanceId);
      attempts++;
    }
    return parseActiveSession(data, sessionModelId, instanceId);
  }

  return parseActiveSession(data, sessionModelId);
}

/**
 * Ensure an active Freebuff session exists for `sessionModelId` on the given account.
 * Reuses cached session if active and matching; deletes mismatched session; handles waiting room.
 */
export async function ensureActiveSession(
  env: Env,
  account: FreebuffAccount,
  sessionModelId: string,
  messages?: OpenAIChatMessage[]
): Promise<FreebuffSessionState> {
  const authToken = account.authToken;

  // 1. Check cached session if still fresh
  if (
    account.session &&
    isSessionFresh(account.session) &&
    account.session.model === sessionModelId
  ) {
    try {
      const liveData = await getUpstreamSession(
        env,
        authToken,
        account.session.instanceId
      );
      if (
        liveData.status === "active" &&
        (!liveData.model || liveData.model === sessionModelId)
      ) {
        const refreshed = parseActiveSession(
          liveData,
          sessionModelId,
          account.session.instanceId
        );
        await updateAccountState(env, account.id, {
          session: refreshed,
          last_error: null,
        });
        return refreshed;
      }
    } catch {
      // Fall through to inspect/recreate
    }
  }

  // 2. Inspect current upstream session state on the account
  try {
    const currentData = await getUpstreamSession(env, authToken);
    if (currentData.status === "active") {
      const currentModel =
        typeof currentData.model === "string" ? currentData.model : null;
      if (
        (!currentModel || currentModel === sessionModelId) &&
        typeof currentData.instanceId === "string" &&
        currentData.instanceId
      ) {
        const reused = parseActiveSession(currentData, sessionModelId);
        await updateAccountState(env, account.id, {
          session: reused,
          last_error: null,
        });
        return reused;
      }
      // Active session is locked to a different model -> delete it first
      await deleteUpstreamSession(env, authToken).catch(() => {});
    }
  } catch {
    // Ignore inspection error and proceed to create
  }

  // 3. Trigger waiting_room ad/streak warm-up (non-blocking if ad provider fails)
  await triggerAdAndStreakWarmup(env, authToken, {
    messages,
    surface: "waiting_room",
    includeStreak: true,
  });

  // 4. Create new session for `sessionModelId` (with retry on model_locked)
  let session: FreebuffSessionState;
  try {
    session = await createAndPollSession(env, authToken, sessionModelId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("model_locked") || msg.includes("409")) {
      await deleteUpstreamSession(env, authToken).catch(() => {});
      session = await createAndPollSession(env, authToken, sessionModelId);
    } else {
      throw err;
    }
  }

  await updateAccountState(env, account.id, {
    session,
    last_error: null,
  });

  return session;
}

/**
 * Validate agent definitions once per account (`POST /api/agents/validate`).
 */
export async function validateAgentsIfNeeded(
  env: Env,
  account: FreebuffAccount
): Promise<void> {
  if (account.agents_validated) return;
  try {
    await codebuffJson(env, null, "POST", "/api/agents/validate", {
      body: buildAgentValidationPayload(),
    });
    await updateAccountState(env, account.id, { agents_validated: true });
  } catch {
    // Non-fatal; continue with server configs
  }
}

/**
 * Start a single agent run (`POST /api/v1/agent-runs` with `action: "START"`).
 */
async function startSingleAgentRun(
  env: Env,
  authToken: string,
  agentId: string,
  ancestorRunIds: string[] = []
): Promise<string> {
  const data = await codebuffJson<{ runId?: string }>(
    env,
    authToken,
    "POST",
    "/api/v1/agent-runs",
    {
      body: {
        action: "START",
        agentId,
        ancestorRunIds,
      },
    }
  );
  if (!data.runId) {
    throw new CodebuffUpstreamError(
      `Codebuff /api/v1/agent-runs START did not return runId for agent "${agentId}"`,
      502,
      "missing_run_id"
    );
  }
  return data.runId;
}

/**
 * Record a step on an agent run (`POST /api/v1/agent-runs/${runId}/steps`).
 */
export async function recordAgentRunStep(
  env: Env,
  authToken: string,
  runId: string,
  params: {
    stepNumber: number;
    messageId: string | null;
    startTime: string;
    childRunIds?: string[];
  }
): Promise<void> {
  await codebuffJson(
    env,
    authToken,
    "POST",
    `/api/v1/agent-runs/${runId}/steps`,
    {
      body: {
        stepNumber: params.stepNumber,
        credits: 0,
        childRunIds: params.childRunIds || [],
        messageId: params.messageId,
        status: "completed",
        startTime: params.startTime,
      },
    }
  );
}

/**
 * Finish an agent run (`POST /api/v1/agent-runs` with `action: "FINISH"`).
 */
export async function finishAgentRun(
  env: Env,
  authToken: string,
  runId: string,
  totalSteps: number
): Promise<void> {
  await codebuffJson(env, authToken, "POST", "/api/v1/agent-runs", {
    body: {
      action: "FINISH",
      runId,
      status: "completed",
      totalSteps,
      directCredits: 0,
      totalCredits: 0,
    },
  });
}

/**
 * Start the full Freebuff agent-run chain required before calling `/api/v1/chat/completions`:
 * - Root models: START root -> START context-pruner child -> step 1 & FINISH child -> step 1 on root -> use `runId`.
 * - Child models (e.g. Gemini): START parent root -> START child agent -> use `chatRunId`.
 */
export async function startFreebuffRunChain(
  env: Env,
  authToken: string,
  model: FreebuffModelDef
): Promise<FreebuffRunChain> {
  // Child model path (e.g. Gemini 2.5 Flash Lite, 3.1 Flash Lite Preview, 3.1 Pro Preview)
  if (model.parent_agent_id) {
    const startedAt = new Date().toISOString();
    const parentRunId = await startSingleAgentRun(
      env,
      authToken,
      model.parent_agent_id,
      []
    );
    const chatStartedAt = new Date().toISOString();
    const chatRunId = await startSingleAgentRun(
      env,
      authToken,
      model.agent_id,
      [parentRunId]
    );
    return {
      runId: parentRunId,
      agentId: model.parent_agent_id,
      startedAt,
      payloadRunId: chatRunId,
      childRunId: chatRunId,
      chatRunId,
      chatStartedAt,
    };
  }

  // Direct Root model path
  const startedAt = new Date().toISOString();
  const runId = await startSingleAgentRun(env, authToken, model.agent_id, []);
  const childStartedAt = new Date().toISOString();
  const childRunId = await startSingleAgentRun(
    env,
    authToken,
    CONTEXT_PRUNER_AGENT_ID,
    [runId]
  );

  await recordAgentRunStep(env, authToken, childRunId, {
    stepNumber: 1,
    messageId: null,
    startTime: childStartedAt,
    childRunIds: [],
  });
  await finishAgentRun(env, authToken, childRunId, 2);
  await recordAgentRunStep(env, authToken, runId, {
    stepNumber: 1,
    messageId: null,
    startTime: startedAt,
    childRunIds: [childRunId],
  });

  return {
    runId,
    agentId: model.agent_id,
    startedAt,
    payloadRunId: runId,
    childRunId,
  };
}

/**
 * Finalize the Freebuff agent-run chain after chat completion finishes.
 * Can be awaited directly (non-streaming) or scheduled via `ctx.waitUntil(...)` (streaming).
 */
export async function finalizeFreebuffRunChain(
  env: Env,
  authToken: string,
  run: FreebuffRunChain,
  messageId: string | null
): Promise<void> {
  try {
    if (run.chatRunId && run.chatRunId !== run.runId) {
      await recordAgentRunStep(env, authToken, run.chatRunId, {
        stepNumber: 1,
        messageId,
        startTime: run.chatStartedAt || run.startedAt,
        childRunIds: [],
      });
      await finishAgentRun(env, authToken, run.chatRunId, 2);

      await recordAgentRunStep(env, authToken, run.runId, {
        stepNumber: 1,
        messageId: null,
        startTime: run.startedAt,
        childRunIds: [run.chatRunId],
      });
      await finishAgentRun(env, authToken, run.runId, 2);
      return;
    }

    await recordAgentRunStep(env, authToken, run.runId, {
      stepNumber: 2,
      messageId,
      startTime: run.startedAt,
      childRunIds: [],
    });
    await finishAgentRun(env, authToken, run.runId, 3);
  } catch {
    // Suppress background finalization errors
  }
}

/**
 * Dispatch the prepared chat completion request to `POST https://www.codebuff.com/api/v1/chat/completions`
 * (or through Cloudflare AI Gateway if `env.AI_GATEWAY_CODEBUFF_URL` is configured).
 */
export async function sendUpstreamChatCompletions(
  env: Env,
  authToken: string,
  payload: Record<string, unknown>,
  meta?: { accountId?: string; agentId?: string; modelId?: string }
): Promise<Response> {
  const gatewayUrl = env.AI_GATEWAY_CODEBUFF_URL?.trim().replace(/\/+$/, "");
  const baseUrl = gatewayUrl || getCodebuffBaseUrl(env);
  const url = `${baseUrl}/api/v1/chat/completions`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${authToken}`,
    "Content-Type": "application/json",
    Accept: "*/*",
    "User-Agent": CHAT_COMPLETIONS_USER_AGENT,
  };

  const isAiGateway =
    Boolean(gatewayUrl) || baseUrl.includes("gateway.ai.cloudflare.com");

  if (isAiGateway) {
    const cfAigToken = env.CF_AIG_TOKEN?.trim();
    if (cfAigToken) {
      headers["cf-aig-authorization"] = cfAigToken.startsWith("Bearer ")
        ? cfAigToken
        : `Bearer ${cfAigToken}`;
    }
    headers["cf-aig-metadata"] = JSON.stringify({
      source: "freebuff2openai-cf",
      account_id: meta?.accountId || "pool",
      agent_id: meta?.agentId || "root",
      model: meta?.modelId || String(payload.model || ""),
    });
  }

  return fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
}
