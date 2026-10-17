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

---

## Project Structure

```text
freebuff2openai-cf/
├── package.json
├── tsconfig.json
├── wrangler.toml
├── .dev.vars.example
└── src/
    ├── index.ts                # Worker entry point, CORS, & route dispatcher
    ├── types.ts                # TypeScript interfaces (Env, Pool, Sessions, OpenAI)
    ├── kv.ts                   # Cloudflare KV multi-account pool & session-aware selector
    ├── freebuff/
    │   ├── auth.ts             # CLI device OAuth flow (/api/auth/cli/code & /status)
    │   ├── models.ts           # Model registry, agent mappings, & validation payload
    │   └── client.ts           # Session lifecycle, waiting room, ads, & agent-runs
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

## Local Development

```bash
cp .dev.vars.example .dev.vars
npm run dev
```

Then visit `http://localhost:8787/setup`.
