import {
  buildUpstreamChatPayload,
  collectUnaryCompletionFromSse,
  createOpenAISseTransformStream,
} from "./converters/openai";
import {
  CodebuffUpstreamError,
  ensureActiveSession,
  fetchAccountEntitledModels,
  finalizeFreebuffRunChain,
  sendUpstreamChatCompletions,
  startFreebuffRunChain,
  triggerAdAndStreakWarmup,
  validateAgentsIfNeeded,
} from "./freebuff/client";
import {
  buildOpenAIModelsResponse,
  DEFAULT_FREEBUFF_MODEL_ID,
  resolveFreebuffModel,
} from "./freebuff/models";
import {
  getPoolState,
  selectAccountForModel,
  updateAccountState,
} from "./kv";
import { Env, OpenAIChatCompletionRequest } from "./types";
import { handleSetupRequest } from "./ui/setup";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-API-Key, X-Admin-Password, OpenAI-Beta, cf-aig-authorization, cf-aig-cache-ttl, cf-aig-skip-cache, cf-aig-metadata, cf-aig-custom-cost, cf-aig-event-id, cf-aig-collect-log",
  "Access-Control-Max-Age": "86400",
};

/**
 * Helper to return a JSON response with CORS headers attached.
 */
function jsonResponse(
  data: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

/**
 * Helper to return an OpenAI-formatted error response.
 */
function openAIErrorResponse(
  message: string,
  status = 400,
  type = "invalid_request_error",
  code: string | null = null
): Response {
  return jsonResponse(
    {
      error: {
        message,
        type,
        param: null,
        code,
      },
    },
    status
  );
}

/**
 * Constant-time string comparison for API key validation.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  if (aBytes.length !== bBytes.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) {
    diff |= aBytes[i] ^ bBytes[i];
  }
  return diff === 0;
}

/**
 * Validate client `Authorization: Bearer <API_KEY>` or `x-api-key` header.
 * If `env.API_KEY` is not configured, requests are allowed through.
 */
function verifyClientApiKey(request: Request, env: Env): boolean {
  const expectedKey = env.API_KEY?.trim();
  if (!expectedKey) {
    return true;
  }

  let providedKey = "";
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    providedKey = authHeader.slice(7).trim();
  } else {
    providedKey = request.headers.get("x-api-key")?.trim() || "";
  }

  if (!providedKey) {
    return false;
  }

  return timingSafeEqual(providedKey, expectedKey);
}

/**
 * Forward a chat completion request to Cloudflare AI Gateway fallback endpoint
 * (`env.AI_GATEWAY_FALLBACK_URL`) when all Freebuff accounts are unavailable or fail.
 */
async function forwardToAiGatewayFallback(
  body: OpenAIChatCompletionRequest,
  env: Env,
  reason: string
): Promise<Response | null> {
  const fallbackUrl = env.AI_GATEWAY_FALLBACK_URL?.trim();
  if (!fallbackUrl) {
    return null;
  }

  const targetUrl =
    fallbackUrl.endsWith("/chat/completions") || fallbackUrl.endsWith("/ai/run")
      ? fallbackUrl
      : `${fallbackUrl.replace(/\/+$/, "")}/chat/completions`;

  const fallbackPayload: OpenAIChatCompletionRequest = {
    ...body,
    model: env.AI_GATEWAY_FALLBACK_MODEL?.trim() || body.model,
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: body.stream ? "text/event-stream" : "application/json",
  };

  const providerApiKey = env.AI_GATEWAY_FALLBACK_API_KEY?.trim();
  if (providerApiKey) {
    headers["Authorization"] = providerApiKey.startsWith("Bearer ")
      ? providerApiKey
      : `Bearer ${providerApiKey}`;
  }

  const cfAigToken = env.CF_AIG_TOKEN?.trim();
  if (cfAigToken) {
    headers["cf-aig-authorization"] = cfAigToken.startsWith("Bearer ")
      ? cfAigToken
      : `Bearer ${cfAigToken}`;
  }

  headers["cf-aig-metadata"] = JSON.stringify({
    source: "freebuff2openai-cf-fallback",
    requested_model: body.model || "default",
    fallback_model: fallbackPayload.model || "default",
    fallback_reason: reason.slice(0, 120),
  });

  const res = await fetch(targetUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(fallbackPayload),
  });

  const responseHeaders = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    responseHeaders.set(k, v);
  }
  responseHeaders.set("X-Freebuff-Fallback", "cloudflare-ai-gateway");

  return new Response(res.body, {
    status: res.status,
    headers: responseHeaders,
  });
}

/**
 * Handle `GET /v1/models`
 */
async function handleModelsRequest(
  request: Request,
  env: Env
): Promise<Response> {
  if (!verifyClientApiKey(request, env)) {
    return openAIErrorResponse(
      "Invalid or missing API key. Provide Authorization: Bearer <API_KEY>.",
      401,
      "authentication_error",
      "invalid_api_key"
    );
  }

  const url = new URL(request.url);
  const fetchLive = url.searchParams.get("live") === "true";

  let entitledIds: Set<string> | null = null;
  if (fetchLive) {
    const pool = await getPoolState(env);
    if (pool.accounts.length > 0) {
      entitledIds = await fetchAccountEntitledModels(
        env,
        pool.accounts[0].authToken
      ).catch(() => null);
    }
  }

  return jsonResponse(buildOpenAIModelsResponse(entitledIds), 200);
}

/**
 * Handle `POST /v1/chat/completions`
 */
async function handleChatCompletionsRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  if (!verifyClientApiKey(request, env)) {
    return openAIErrorResponse(
      "Invalid or missing API key. Provide Authorization: Bearer <API_KEY>.",
      401,
      "authentication_error",
      "invalid_api_key"
    );
  }

  let body: OpenAIChatCompletionRequest;
  try {
    body = (await request.json()) as OpenAIChatCompletionRequest;
  } catch {
    return openAIErrorResponse("Invalid JSON request body.", 400);
  }

  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return openAIErrorResponse(
      "Field `messages` is required and must be a non-empty array.",
      400
    );
  }

  let modelDef;
  try {
    modelDef = resolveFreebuffModel(
      body.model,
      env.DEFAULT_MODEL || DEFAULT_FREEBUFF_MODEL_ID
    );
  } catch (err) {
    return openAIErrorResponse(
      err instanceof Error ? err.message : "Invalid model",
      400,
      "invalid_request_error",
      "model_not_found"
    );
  }

  const isStream = Boolean(body.stream);
  const pool = await getPoolState(env);
  if (pool.accounts.length === 0) {
    const fallbackRes = await forwardToAiGatewayFallback(
      body,
      env,
      "no_freebuff_accounts_connected"
    ).catch(() => null);
    if (fallbackRes) {
      return fallbackRes;
    }

    return openAIErrorResponse(
      "No Freebuff accounts configured in FREEBUFF_KV. Open /setup in your browser to connect your Freebuff account or paste an authToken.",
      401,
      "authentication_error",
      "freebuff_account_not_connected"
    );
  }

  const maxAttempts = Math.min(pool.accounts.length, 3);
  const excludedAccountIds = new Set<string>();
  let lastError: unknown = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let account;
    try {
      account = await selectAccountForModel(
        env,
        modelDef.session_model_id,
        excludedAccountIds
      );
    } catch (err) {
      lastError = err;
      break;
    }

    excludedAccountIds.add(account.id);

    try {
      // 1. Ensure an active Freebuff session for `modelDef.session_model_id`
      const session = await ensureActiveSession(
        env,
        account,
        modelDef.session_model_id,
        body.messages
      );

      // 2. Non-blocking ad warm-up + one-time agent validation
      ctx.waitUntil(
        triggerAdAndStreakWarmup(env, account.authToken, {
          messages: body.messages,
        })
      );
      await validateAgentsIfNeeded(env, account);

      // 3. Start the Freebuff agent-run chain (root + context-pruner OR parent + child)
      const run = await startFreebuffRunChain(env, account.authToken, modelDef);

      // 4. Build upstream `/api/v1/chat/completions` payload
      const upstreamPayload = buildUpstreamChatPayload({
        body,
        modelDef,
        session,
        payloadRunId: run.payloadRunId,
      });

      // 5. Call upstream `/api/v1/chat/completions` (directly or via AI_GATEWAY_CODEBUFF_URL)
      const upstreamRes = await sendUpstreamChatCompletions(
        env,
        account.authToken,
        upstreamPayload,
        {
          accountId: account.id,
          agentId: modelDef.agent_id,
          modelId: modelDef.id,
        }
      );

      if (!upstreamRes.ok) {
        const errText = await upstreamRes.text().catch(() => "");
        ctx.waitUntil(
          finalizeFreebuffRunChain(env, account.authToken, run, null)
        );

        // If 409 session_model_mismatch, clear cached session on this account
        if (upstreamRes.status === 409) {
          await updateAccountState(env, account.id, {
            session: null,
            last_error: `HTTP 409: ${errText.slice(0, 200)}`,
          });
        } else {
          await updateAccountState(env, account.id, {
            last_error: `HTTP ${upstreamRes.status}: ${errText.slice(0, 200)}`,
          });
        }

        throw new CodebuffUpstreamError(
          `Codebuff chat completion failed (HTTP ${upstreamRes.status}): ${errText.slice(0, 400)}`,
          upstreamRes.status,
          `codebuff_${upstreamRes.status}`
        );
      }

      if (!upstreamRes.body) {
        ctx.waitUntil(
          finalizeFreebuffRunChain(env, account.authToken, run, null)
        );
        throw new CodebuffUpstreamError(
          "Codebuff upstream returned an empty response body.",
          502,
          "empty_upstream_body"
        );
      }

      // 6a. Streaming response -> Transform SSE chunks & finalize run in background via ctx.waitUntil
      if (isStream) {
        const authToken = account.authToken;
        const sseStream = createOpenAISseTransformStream(
          upstreamRes.body,
          modelDef.id,
          (messageId) => {
            ctx.waitUntil(
              finalizeFreebuffRunChain(env, authToken, run, messageId)
            );
          }
        );

        return new Response(sseStream, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
            ...CORS_HEADERS,
          },
        });
      }

      // 6b. Non-streaming response -> Accumulate SSE into OpenAI chat.completion JSON
      const { response: completionJson, messageId } =
        await collectUnaryCompletionFromSse(upstreamRes.body, modelDef.id);

      ctx.waitUntil(
        finalizeFreebuffRunChain(env, account.authToken, run, messageId)
      );

      return jsonResponse(completionJson, 200);
    } catch (err) {
      lastError = err;
      const errMsg = err instanceof Error ? err.message : String(err);
      await updateAccountState(env, account.id, {
        last_error: errMsg.slice(0, 250),
      }).catch(() => {});
      // Try next account in pool if available
    }
  }

  const finalMessage =
    lastError instanceof Error
      ? lastError.message
      : "Unexpected error during Freebuff chat completion.";

  // Optional automatic fallback to Cloudflare AI Gateway when all Freebuff accounts fail
  const fallbackRes = await forwardToAiGatewayFallback(
    body,
    env,
    finalMessage
  ).catch(() => null);
  if (fallbackRes) {
    return fallbackRes;
  }

  const finalStatus =
    lastError instanceof CodebuffUpstreamError ? lastError.status : 502;
  const finalCode =
    lastError instanceof CodebuffUpstreamError
      ? lastError.code
      : "upstream_error";

  return openAIErrorResponse(
    finalMessage,
    finalStatus,
    "upstream_api_error",
    finalCode
  );
}

/**
 * Normalize API paths so both direct OpenAI clients and Cloudflare AI Gateway
 * Custom Providers (with or without `/v1` or `/compat` prefixes) resolve cleanly.
 */
function normalizeApiPath(rawPath: string): string {
  const trimmed = rawPath.replace(/\/+$/, "") || "/";
  return trimmed.replace(/^(?:\/(?:v1|compat))+(\/|$)/, "/v1$1");
}

/**
 * Cloudflare Worker Default Export
 */
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    // 1. Handle CORS Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
      });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const normalizedPath = normalizeApiPath(path);

    // 2. Route `/` or `/healthz` -> Health Check JSON
    if ((path === "/" || path === "/healthz") && request.method === "GET") {
      const pool = await getPoolState(env).catch(() => null);
      const count = pool?.accounts.length ?? 0;

      return jsonResponse({
        service: "freebuff2openai-cf",
        status: "ok",
        version: "1.1.0",
        accounts_connected: count,
        default_model: env.DEFAULT_MODEL || DEFAULT_FREEBUFF_MODEL_ID,
        ai_gateway: {
          custom_provider_compatible: true,
          outbound_codebuff_gateway_enabled: Boolean(
            env.AI_GATEWAY_CODEBUFF_URL?.trim()
          ),
          fallback_gateway_enabled: Boolean(
            env.AI_GATEWAY_FALLBACK_URL?.trim()
          ),
        },
        endpoints: {
          setup_ui: `${url.origin}/setup`,
          models: `${url.origin}/v1/models`,
          chat_completions: `${url.origin}/v1/chat/completions`,
          ai_gateway_custom_provider_base_url: url.origin,
        },
      });
    }

    // 3. Route `/setup` and `/setup/*` -> Interactive OAuth & Multi-Account Setup Web UI
    if (path === "/setup" || path.startsWith("/setup/")) {
      return handleSetupRequest(request, env);
    }

    // 4. Route `/v1/models` (or `/models`, `/compat/models`, `/v1/v1/models`) -> Model List
    if (
      (normalizedPath === "/v1/models" || path === "/models") &&
      request.method === "GET"
    ) {
      return handleModelsRequest(request, env);
    }

    // 5. Route `/v1/chat/completions` (or `/chat/completions`, `/compat/chat/completions`, `/v1/v1/chat/completions`) -> Chat Handler
    if (
      (normalizedPath === "/v1/chat/completions" ||
        path === "/chat/completions") &&
      request.method === "POST"
    ) {
      return handleChatCompletionsRequest(request, env, ctx);
    }

    // 6. Fallback 404
    return openAIErrorResponse(
      `Route not found: ${request.method} ${url.pathname}`,
      404,
      "invalid_request_error",
      "route_not_found"
    );
  },
};
