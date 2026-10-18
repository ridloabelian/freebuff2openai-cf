# freebuff2openai-cf

Serverless **OpenAI-compatible API Proxy** (`/v1/chat/completions` & `/v1/models`) powered by **Freebuff / Codebuff** (`https://freebuff.com` & `https://www.codebuff.com`) running 100% on **Cloudflare Workers** + **Cloudflare KV**.

Unlike Docker or VPS-based proxies, `freebuff2openai-cf` runs entirely at the Cloudflare Edge with **zero runtime npm dependencies** and includes an interactive **`/setup` Web Dashboard** featuring:
1. **1-Click Browser OAuth Login Flow:** Uses Freebuff's CLI device/fingerprint auth endpoints (`/api/auth/cli/code` + `/api/auth/cli/status`) with live browser polling right inside `/setup` — no local CLI installation required.
2. **Multi-Account Token Pool:** Paste or connect multiple Freebuff accounts to automatically rotate across accounts and reuse active model sessions without triggering single-account session lock collisions.

---

## Key Features

- **100% Serverless on Cloudflare Edge:** Pure TypeScript using Web Fetch, Web Crypto, and Web Streams (`TransformStream`) APIs.
- **Interactive `/setup` Web Dashboard:**
  - **Option A — 1-Click Browser Login:** Opens `freebuff.com` login in a new tab, polls `/setup/auth/poll` every 2 seconds, verifies your `authToken`, and saves your account into Cloudflare KV (`FREEBUFF_KV`).
  - **Option B — Paste Auth Token(s):** Paste one or more `authToken` strings (comma or newline separated) to populate a multi-account pool.
- **Smart Session & Waiting-Room Management:**
  - Automatically manages `/api/v1/freebuff/session` lifecycle (`GET` / `POST` / `DELETE`), polls queued waiting-room sessions until active, and performs non-blocking ad/streak warm-up (`/api/v1/ads` & `/api/v1/freebuff/streak`).
  - Prefers accounts that already hold an active session for the requested model, or selects idle accounts via round-robin to avoid unnecessary session teardown.
- **Full Agent-Run Chain Lifecycle:**
  - Supports **Direct Root Models** (`base2-free-*` + `context-pruner` child run) and **Gemini Child-Agent Models** (`file-picker`, `file-picker-max`, `thinker-with-files-gemini`).
  - Uses Cloudflare's `ctx.waitUntil(...)` to finalize agent-run steps and `FINISH` actions asynchronously without delaying streaming responses.
- **OpenAI API Compatibility:**
  - `GET /v1/models` — Lists all supported Freebuff and Gemini models.
  - `POST /v1/chat/completions` — Supports both streaming (`stream: true`) and unary (`stream: false`) responses, `reasoning_content`, and `tools` / `tool_calls`.
- **Cloudflare AI Gateway Native Collaboration:**
  - **Custom Provider Ready:** Supports `custom-<slug>/<model>` prefixes (`custom-freebuff/deepseek/deepseek-v4-flash`) and normalized `/compat/chat/completions` & `/v1/chat/completions` routing.
  - **Built-in AI Gateway Auto-Fallback:** Optionally forwards requests to Cloudflare AI Gateway (`AI_GATEWAY_FALLBACK_URL`) when all Freebuff accounts are busy or rate-limited.
  - **Outbound Observability:** Optionally routes upstream Codebuff calls through AI Gateway (`AI_GATEWAY_CODEBUFF_URL`) with automatic `cf-aig-metadata` telemetry headers.

---

## Project Structure

```text
freebuff2openai-cf/
├── package.json
├── tsconfig.json
├── wrangler.toml
├── .dev.vars.example
└── src/
    ├── index.ts                # Worker entry point, CORS, AI Gateway fallback & route dispatcher
    ├── types.ts                # TypeScript interfaces (Env, Pool, Sessions, OpenAI)
    ├── kv.ts                   # Cloudflare KV multi-account pool & session-aware selector
    ├── freebuff/
    │   ├── auth.ts             # CLI device OAuth flow (/api/auth/cli/code & /status)
    │   ├── models.ts           # Model registry, custom-provider prefix parser & validation payload
    │   └── client.ts           # Session lifecycle, waiting room, ads, agent-runs & AI Gateway telemetry
    ├── converters/
    │   └── openai.ts           # Buffy system prompt, SSE TransformStream, & accumulator
    └── ui/
        └── setup.ts            # Interactive /setup Web Dashboard & admin endpoints
```

---

## Supported Models (`/v1/models`)

### 1. Direct Root Models (`parent_agent_id: null`)

| Model ID | Freebuff Agent ID | Notes |
| :--- | :--- | :--- |
| `deepseek/deepseek-v4-flash` | `base2-free-deepseek-flash` | **Default** fast coding model |
| `deepseek/deepseek-v4-pro` | `base2-free-deepseek` | Deep reasoning root model |
| `moonshotai/kimi-k2.6` | `base2-free-kimi` | Kimi K2.6 root model |
| `minimax/minimax-m2.7` | `base2-free` | MiniMax M2.7 root model |
| `minimax/minimax-m3` | `base2-free-minimax-m3` | MiniMax M3 root model |
| `openai/gpt-5.6-luna` | `base2-free-luna` | OpenAI GPT-5.6 Luna root model |
| `z-ai/glm-5.2` | `base2-free-glm` | Z.ai GLM 5.2 root model |
| `mimo/mimo-v2.5` | `base2-free-mimo` | Always-available unlimited model |
| `mimo/mimo-v2.5-pro` | `base2-free-mimo-pro` | MiMo V2.5 Pro root model |
| `anthropic/claude-fable-5` | `base2-free-fable` | Anthropic Claude Fable 5 |

### 2. Gemini Child-Agent Free Models

| Model ID | Child Agent ID | Session Model ID | Parent Agent ID |
| :--- | :--- | :--- | :--- |
| `google/gemini-2.5-flash-lite` | `file-picker` | `deepseek/deepseek-v4-flash` | `base2-free-deepseek-flash` |
| `google/gemini-3.1-flash-lite-preview` | `file-picker-max` | `deepseek/deepseek-v4-flash` | `base2-free-deepseek-flash` |
| `google/gemini-3.1-pro-preview` | `thinker-with-files-gemini` | `moonshotai/kimi-k2.6` | `base2-free-kimi` |

*(Additional upstream Freebuff models such as `openai/gpt-6-luna`, `openai/gpt-6.1-sol`, `google/gemini-4-argon`, `google/gemini-3.8-flash`, `z-ai/glm-5.3-flash`, and `anthropic/claude-fable-5.1` are also registered).*

---

## Quick Start Guide

### Step 1: Clone & Install

```bash
git clone https://github.com/ridloabelian/freebuff2openai-cf.git
cd freebuff2openai-cf
npm install
```

### Step 2: Create Cloudflare KV Namespace & Set Secrets

1. Create the `FREEBUFF_KV` namespace:
   ```bash
   npx wrangler kv namespace create FREEBUFF_KV
   ```
   Update the `id` under `[[kv_namespaces]]` in `wrangler.toml`.

2. Set your `API_KEY` (used by OpenAI clients) and `ADMIN_PASSWORD` (protects `/setup`):
   ```bash
   npx wrangler secret put API_KEY
   npx wrangler secret put ADMIN_PASSWORD
   ```

### Step 3: Deploy to Cloudflare Workers

```bash
npm run deploy
```

### Step 4: Connect Your Freebuff Account(s) via `/setup`

1. Open `https://freebuff2openai-cf.<your-subdomain>.workers.dev/setup` in your browser.
2. Enter your `ADMIN_PASSWORD` to unlock the dashboard.
3. **Option A (1-Click Browser Login):** Click **"1. Login with Freebuff (Open Browser)"**, sign in on the opened Freebuff tab, and watch the `/setup` dashboard automatically save your account to KV.
4. **Option B (Paste Token):** Paste one or more `authToken` strings into the textarea and click **"Save Token(s) to Pool"**.

---

## Client Configuration (Cursor / Cline / Roo Code / OpenCode)

- **Base URL:** `https://freebuff2openai-cf.<your-subdomain>.workers.dev/v1`
- **API Key:** Your `API_KEY` secret value
- **Model ID:** `deepseek/deepseek-v4-flash`, `google/gemini-3.1-pro-preview`, `openai/gpt-5.6-luna`, etc.

### Quick Test via `curl`

```bash
curl https://freebuff2openai-cf.<your-subdomain>.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "deepseek/deepseek-v4-flash",
    "messages": [
      {"role": "user", "content": "Hello from Cloudflare Workers!"}
    ],
    "stream": true
  }'
```

---

## Collaborating with Cloudflare AI Gateway

### `freebuff2openai-cf` vs. Cloudflare AI Gateway

Both run on Cloudflare's edge network, but they solve **different layers** of the AI stack and are designed to work together:

| Layer / Feature | `freebuff2openai-cf` (This Worker) | Cloudflare AI Gateway |
| :--- | :--- | :--- |
| **Primary Role** | **Protocol Adapter & Session Orchestrator** | **Observability, Caching & Multi-Provider Router** |
| **What It Does** | Translates proprietary Freebuff/Codebuff internals (CLI OAuth, waiting-room polling, session locks, ad/streak warm-up, and `agent-runs` chains) into standard OpenAI `/v1/chat/completions`. | Sits in front of standard AI APIs to provide prompt/response logging, token analytics, response caching, rate limiting, and provider fallbacks. |
| **Can It Talk to Freebuff Directly?** | **Yes** (purpose-built for Freebuff/Codebuff). | **No** (does not understand Freebuff sessions or `agent-runs`). |
| **State Management** | Multi-account token & session pool in `FREEBUFF_KV`. | Managed analytics, cache storage, and dynamic routing rules. |

```text
[Client: Cursor / Cline / App]
       │
       ▼
[Cloudflare AI Gateway]  ──(1. Primary: Custom Provider)──► [Worker: freebuff2openai-cf] ──► [Freebuff / Codebuff]
       │
       └──(2. Auto-Fallback if busy/error)──► [Workers AI / Google AI Studio / OpenRouter / OpenAI]
```

---

### Mode 1: Put Cloudflare AI Gateway in Front of `freebuff2openai-cf` (Custom Provider)

Register your deployed `freebuff2openai-cf` Worker as a **Custom Provider** in Cloudflare AI Gateway to get full prompt logging, caching, rate limiting, and dynamic routing:

1. In the **Cloudflare Dashboard**, go to **AI > AI Gateway > Custom Providers** (or use the REST API) and create a provider:
   - **Name:** `Freebuff Worker Proxy`
   - **Slug:** `freebuff` (referenced as `custom-freebuff` in AI Gateway)
   - **Base URL:** `https://freebuff2openai-cf.<your-subdomain>.workers.dev`
2. Call `freebuff2openai-cf` through **AI Gateway's Unified API (`/compat/chat/completions`)**:
   ```bash
   curl https://gateway.ai.cloudflare.com/v1/<CF_ACCOUNT_ID>/<GATEWAY_ID>/compat/chat/completions \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer YOUR_API_KEY" \
     -d '{
       "model": "custom-freebuff/deepseek/deepseek-v4-flash",
       "messages": [{"role": "user", "content": "Hello via Cloudflare AI Gateway!"}],
       "stream": true
     }'
   ```
   *(Note: `freebuff2openai-cf` automatically strips `custom-<slug>/` prefixes from model IDs and normalizes `/compat` and `/v1` paths).*

3. Or use the **Provider-Specific Endpoint** as your OpenAI SDK `baseURL`:
   ```text
   https://gateway.ai.cloudflare.com/v1/<CF_ACCOUNT_ID>/<GATEWAY_ID>/custom-freebuff/v1
   ```

---

### Mode 2: Built-in Auto-Fallback from `freebuff2openai-cf` to Cloudflare AI Gateway

If you connect your IDE/client directly to `freebuff2openai-cf`, you can configure `freebuff2openai-cf` to automatically fall back to Cloudflare AI Gateway whenever all Freebuff accounts in your KV pool are busy or fail:

1. Configure `AI_GATEWAY_FALLBACK_URL` and `AI_GATEWAY_FALLBACK_MODEL` in [`wrangler.toml`](wrangler.toml):
   ```toml
   [vars]
   AI_GATEWAY_FALLBACK_URL = "https://gateway.ai.cloudflare.com/v1/<CF_ACCOUNT_ID>/<GATEWAY_ID>/compat/chat/completions"
   AI_GATEWAY_FALLBACK_MODEL = "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast"
   ```
2. Set your fallback provider API key (and optional Authenticated AI Gateway token):
   ```bash
   npx wrangler secret put AI_GATEWAY_FALLBACK_API_KEY
   npx wrangler secret put CF_AIG_TOKEN
   ```
   When triggered, responses include the header `X-Freebuff-Fallback: cloudflare-ai-gateway` and attach `cf-aig-metadata` with the fallback reason.

---

### Mode 3: Outbound Observability (`freebuff2openai-cf` $\rightarrow$ AI Gateway $\rightarrow$ Codebuff)

To log and inspect the raw upstream calls that `freebuff2openai-cf` makes to `https://www.codebuff.com/api/v1/chat/completions` inside your Cloudflare AI Gateway dashboard:

1. Create a Custom Provider in Cloudflare AI Gateway with slug `codebuff` and Base URL `https://www.codebuff.com`.
2. Set `AI_GATEWAY_CODEBUFF_URL` in [`wrangler.toml`](wrangler.toml):
   ```toml
   [vars]
   AI_GATEWAY_CODEBUFF_URL = "https://gateway.ai.cloudflare.com/v1/<CF_ACCOUNT_ID>/<GATEWAY_ID>/custom-codebuff"
   ```
   `freebuff2openai-cf` will automatically attach `cf-aig-metadata` (containing `account_id`, `agent_id`, and `model`) to every upstream completion request.

---

## Local Development

```bash
cp .dev.vars.example .dev.vars
npm run dev
```

Then visit `http://localhost:8787/setup`.

