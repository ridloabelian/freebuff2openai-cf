import { FreebuffModelDef } from "../types";

export const CONTEXT_PRUNER_AGENT_ID = "context-pruner";
export const DEFAULT_FREEBUFF_MODEL_ID = "deepseek/deepseek-v4-flash";

/**
 * Full registry of Freebuff / Codebuff supported models and their agent mappings.
 * Includes all primary root models, Gemini child-agent models, and latest Freebuff additions.
 */
export const FREEBUFF_MODELS: readonly FreebuffModelDef[] = [
  // 1. Direct Root Models (parent_agent_id: null)
  {
    id: "deepseek/deepseek-v4-flash",
    agent_id: "base2-free-deepseek-flash",
    owned_by: "freebuff",
    upstream_model_id: "deepseek/deepseek-v4-flash",
    session_model_id: "deepseek/deepseek-v4-flash",
    parent_agent_id: null,
    description: "DeepSeek V4 Flash — Fast default Freebuff coding model",
  },
  {
    id: "deepseek/deepseek-v4-pro",
    agent_id: "base2-free-deepseek",
    owned_by: "freebuff",
    upstream_model_id: "deepseek/deepseek-v4-pro",
    session_model_id: "deepseek/deepseek-v4-pro",
    parent_agent_id: null,
    description: "DeepSeek V4 Pro — Deep reasoning root model",
  },
  {
    id: "moonshotai/kimi-k2.6",
    agent_id: "base2-free-kimi",
    owned_by: "freebuff",
    upstream_model_id: "moonshotai/kimi-k2.6",
    session_model_id: "moonshotai/kimi-k2.6",
    parent_agent_id: null,
    description: "Moonshot Kimi K2.6 — Long-context root model",
  },
  {
    id: "minimax/minimax-m2.7",
    agent_id: "base2-free",
    owned_by: "freebuff",
    upstream_model_id: "minimax/minimax-m2.7",
    session_model_id: "minimax/minimax-m2.7",
    parent_agent_id: null,
    description: "MiniMax M2.7 — Balanced coding root model",
  },
  {
    id: "minimax/minimax-m3",
    agent_id: "base2-free-minimax-m3",
    owned_by: "freebuff",
    upstream_model_id: "minimax/minimax-m3",
    session_model_id: "minimax/minimax-m3",
    parent_agent_id: null,
    description: "MiniMax M3 — Next-gen MiniMax root model",
  },
  {
    id: "openai/gpt-5.6-luna",
    agent_id: "base2-free-luna",
    owned_by: "freebuff",
    upstream_model_id: "openai/gpt-5.6-luna",
    session_model_id: "openai/gpt-5.6-luna",
    parent_agent_id: null,
    description: "OpenAI GPT-5.6 Luna — High-reasoning Freebuff root model",
  },
  {
    id: "z-ai/glm-5.2",
    agent_id: "base2-free-glm",
    owned_by: "freebuff",
    upstream_model_id: "z-ai/glm-5.2",
    session_model_id: "z-ai/glm-5.2",
    parent_agent_id: null,
    description: "Z.ai GLM 5.2 — Fast agentic coding model",
  },
  {
    id: "mimo/mimo-v2.5",
    agent_id: "base2-free-mimo",
    owned_by: "freebuff",
    upstream_model_id: "mimo/mimo-v2.5",
    session_model_id: "mimo/mimo-v2.5",
    parent_agent_id: null,
    description: "MiMo V2.5 — Always-available unlimited fallback model",
  },
  {
    id: "mimo/mimo-v2.5-pro",
    agent_id: "base2-free-mimo-pro",
    owned_by: "freebuff",
    upstream_model_id: "mimo/mimo-v2.5-pro",
    session_model_id: "mimo/mimo-v2.5-pro",
    parent_agent_id: null,
    description: "MiMo V2.5 Pro — Enhanced MiMo root model",
  },
  {
    id: "anthropic/claude-fable-5",
    agent_id: "base2-free-fable",
    owned_by: "freebuff",
    upstream_model_id: "anthropic/claude-fable-5",
    session_model_id: "anthropic/claude-fable-5",
    parent_agent_id: null,
    description: "Anthropic Claude Fable 5 — Freebuff root model",
  },

  // 2. Gemini Child-Agent Free Models (require spawning parent run first)
  {
    id: "google/gemini-2.5-flash-lite",
    agent_id: "file-picker",
    owned_by: "google",
    upstream_model_id: "google/gemini-2.5-flash-lite",
    session_model_id: "deepseek/deepseek-v4-flash",
    parent_agent_id: "base2-free-deepseek-flash",
    description: "Google Gemini 2.5 Flash Lite (via file-picker child agent)",
  },
  {
    id: "google/gemini-3.1-flash-lite-preview",
    agent_id: "file-picker-max",
    owned_by: "google",
    upstream_model_id: "google/gemini-3.1-flash-lite-preview",
    session_model_id: "deepseek/deepseek-v4-flash",
    parent_agent_id: "base2-free-deepseek-flash",
    description: "Google Gemini 3.1 Flash Lite Preview (via file-picker-max child agent)",
  },
  {
    id: "google/gemini-3.1-pro-preview",
    agent_id: "thinker-with-files-gemini",
    owned_by: "google",
    upstream_model_id: "google/gemini-3.1-pro-preview",
    session_model_id: "moonshotai/kimi-k2.6",
    parent_agent_id: "base2-free-kimi",
    description: "Google Gemini 3.1 Pro Preview (via thinker-with-files-gemini child agent)",
  },

  // 3. Extended Upstream Freebuff Root Models
  {
    id: "openai/gpt-6-luna",
    agent_id: "base2-free-luna-6",
    owned_by: "freebuff",
    upstream_model_id: "openai/gpt-6-luna",
    session_model_id: "openai/gpt-6-luna",
    parent_agent_id: null,
    description: "OpenAI GPT-6 Luna — Freebuff root model",
  },
  {
    id: "openai/gpt-6.1-sol",
    agent_id: "base2-free-gpt-6-1-sol",
    owned_by: "freebuff",
    upstream_model_id: "openai/gpt-6.1-sol",
    session_model_id: "openai/gpt-6.1-sol",
    parent_agent_id: null,
    description: "OpenAI GPT-6.1 Sol — Freebuff root model",
  },
  {
    id: "google/gemini-4-argon",
    agent_id: "base2-free-gemini-4-argon",
    owned_by: "google",
    upstream_model_id: "google/gemini-4-argon",
    session_model_id: "google/gemini-4-argon",
    parent_agent_id: null,
    description: "Google Gemini 4 Argon — Freebuff root model",
  },
  {
    id: "google/gemini-3.8-flash",
    agent_id: "base2-free-gemini-3-8-flash",
    owned_by: "google",
    upstream_model_id: "google/gemini-3.8-flash",
    session_model_id: "google/gemini-3.8-flash",
    parent_agent_id: null,
    description: "Google Gemini 3.8 Flash — Freebuff root model",
  },
  {
    id: "z-ai/glm-5.3-flash",
    agent_id: "base2-free-glm-5-3-flash",
    owned_by: "freebuff",
    upstream_model_id: "z-ai/glm-5.3-flash",
    session_model_id: "z-ai/glm-5.3-flash",
    parent_agent_id: null,
    description: "Z.ai GLM 5.3 Flash — Freebuff root model",
  },
  {
    id: "anthropic/claude-fable-5.1",
    agent_id: "base2-free-fable",
    owned_by: "freebuff",
    upstream_model_id: "anthropic/claude-fable-5.1",
    session_model_id: "anthropic/claude-fable-5.1",
    parent_agent_id: null,
    description: "Anthropic Claude Fable 5.1 — Freebuff root model",
  },
  {
    id: "mimo/mimo-v2.6-pro",
    agent_id: "base2-free-mimo-2-6-pro",
    owned_by: "freebuff",
    upstream_model_id: "mimo/mimo-v2.6-pro",
    session_model_id: "mimo/mimo-v2.6-pro",
    parent_agent_id: null,
    description: "MiMo V2.6 Pro — Freebuff root model",
  },
];

export const DEFAULT_MODEL_DEF: FreebuffModelDef = FREEBUFF_MODELS[0];

/**
 * Resolve a requested model string to its `FreebuffModelDef`.
 * Supports exact match (`provider/model`), short alias (`model`),
 * Cloudflare AI Gateway Custom Provider prefixes (`custom-<slug>/...` or `freebuff/...`),
 * or default fallback.
 */
export function resolveFreebuffModel(
  requested?: string | null,
  defaultModelId = DEFAULT_FREEBUFF_MODEL_ID
): FreebuffModelDef {
  const rawTarget = (
    requested ||
    defaultModelId ||
    DEFAULT_FREEBUFF_MODEL_ID
  ).trim();

  // Strip optional Cloudflare AI Gateway Custom Provider prefix (e.g. "custom-freebuff/..." or "freebuff/...")
  const target = rawTarget.replace(/^(?:custom-[a-z0-9_-]+|freebuff)\//i, "");

  // 1. Exact ID match
  const exact = FREEBUFF_MODELS.find((m) => m.id === target);
  if (exact) {
    return exact;
  }

  // 2. Case-insensitive or short suffix match (e.g., "deepseek-v4-flash" -> "deepseek/deepseek-v4-flash")
  const lower = target.toLowerCase();
  const suffixMatch = FREEBUFF_MODELS.find(
    (m) =>
      m.id.toLowerCase() === lower ||
      m.id.toLowerCase().endsWith(`/${lower}`)
  );
  if (suffixMatch) {
    return suffixMatch;
  }

  throw new Error(
    `Unsupported Freebuff model: "${rawTarget}". Call GET /v1/models for the list of supported models.`
  );
}

/**
 * Build the OpenAI-compatible `/v1/models` response payload.
 */
export function buildOpenAIModelsResponse(
  discoveredUpstreamIds?: Set<string> | null
): {
  object: "list";
  data: Array<{
    id: string;
    object: "model";
    created: number;
    owned_by: string;
    agent_id: string;
    session_model_id: string;
    parent_agent_id: string | null;
  }>;
} {
  // Always return the full catalog (ordered with primary 13 models first)
  // while annotating any live upstream availability if queried.
  const models = FREEBUFF_MODELS.map((m) => ({
    id: m.id,
    object: "model" as const,
    created: 1735689600,
    owned_by: m.owned_by,
    agent_id: m.agent_id,
    session_model_id: m.session_model_id,
    parent_agent_id: m.parent_agent_id,
    ...(discoveredUpstreamIds
      ? {
          upstream_entitled:
            discoveredUpstreamIds.has(m.id) ||
            m.id === "deepseek/deepseek-v4-flash" ||
            m.id === "mimo/mimo-v2.5" ||
            m.parent_agent_id !== null,
        }
      : {}),
  }));

  return {
    object: "list",
    data: models,
  };
}

/**
 * Build the `/api/agents/validate` payload used to register local agent definitions
 * with the Codebuff backend before starting a run chain.
 */
export function buildAgentValidationPayload(): {
  agentDefinitions: Array<Record<string, unknown>>;
} {
  const modelsByAgent = new Map<string, FreebuffModelDef>();
  const spawnableByAgent = new Map<string, Set<string>>();

  for (const model of FREEBUFF_MODELS) {
    if (!modelsByAgent.has(model.agent_id)) {
      modelsByAgent.set(model.agent_id, model);
    }
    if (!spawnableByAgent.has(model.agent_id)) {
      spawnableByAgent.set(model.agent_id, new Set());
    }
    spawnableByAgent.get(model.agent_id)!.add(CONTEXT_PRUNER_AGENT_ID);

    if (model.parent_agent_id) {
      if (!spawnableByAgent.has(model.parent_agent_id)) {
        spawnableByAgent.set(model.parent_agent_id, new Set());
      }
      spawnableByAgent.get(model.parent_agent_id)!.add(model.agent_id);
    }
  }

  const definitions: Array<Record<string, unknown>> = [];

  for (const [agentId, model] of modelsByAgent.entries()) {
    const spawnable = Array.from(spawnableByAgent.get(agentId) || []).sort();
    definitions.push(
      createAgentDefinition({
        agentId,
        modelId: model.upstream_model_id,
        displayName: `Freebuff ${model.upstream_model_id}`,
        spawnableAgents: spawnable,
      })
    );
  }

  definitions.push(
    createAgentDefinition({
      agentId: CONTEXT_PRUNER_AGENT_ID,
      modelId: DEFAULT_FREEBUFF_MODEL_ID,
      displayName: "Context Pruner",
      spawnableAgents: [],
    })
  );

  return { agentDefinitions: definitions };
}

function createAgentDefinition(params: {
  agentId: string;
  modelId: string;
  displayName: string;
  spawnableAgents: string[];
}): Record<string, unknown> {
  return {
    id: params.agentId,
    publisher: "codebuff",
    model: params.modelId,
    displayName: params.displayName,
    spawnerPrompt: "Freebuff OpenAI-compatible orchestrator",
    inputSchema: {
      prompt: {
        type: "string",
        description: "A coding task to complete",
      },
      params: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    outputMode: "last_message",
    includeMessageHistory: true,
    toolNames: params.spawnableAgents.length > 0 ? ["spawn_agents"] : [],
    spawnableAgents: params.spawnableAgents,
    systemPrompt: "Act as a helpful coding assistant.",
  };
}
