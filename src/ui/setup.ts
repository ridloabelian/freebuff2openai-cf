import {
  pollCliLoginStatus,
  startCliLogin,
  verifyTokenAndGetProfile,
} from "../freebuff/auth";
import { FREEBUFF_MODELS } from "../freebuff/models";
import {
  clearAllAccounts,
  getPoolState,
  removeAccount,
  updateAccountState,
  upsertAccount,
} from "../kv";
import { Env, FreebuffAccount, FreebuffPoolState } from "../types";

const ADMIN_COOKIE_NAME = "fb_admin_token";

/**
 * Constant-time string comparison to prevent timing side-channel attacks.
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
 * Extract a cookie value by name from the `Cookie` header.
 */
function getCookie(request: Request, name: string): string | null {
  const cookieHeader = request.headers.get("Cookie");
  if (!cookieHeader) return null;
  const cookies = cookieHeader.split(";");
  for (const part of cookies) {
    const [k, ...vParts] = part.trim().split("=");
    if (k === name) {
      return decodeURIComponent(vParts.join("="));
    }
  }
  return null;
}

/**
 * Check if the incoming request is authorized to access `/setup`.
 */
function isAuthorizedAdmin(request: Request, env: Env): boolean {
  const adminPassword = env.ADMIN_PASSWORD?.trim();
  if (!adminPassword) {
    return true;
  }

  const url = new URL(request.url);
  const queryKey =
    url.searchParams.get("password") ?? url.searchParams.get("key");
  if (queryKey && timingSafeEqual(queryKey, adminPassword)) {
    return true;
  }

  const headerPass = request.headers.get("X-Admin-Password");
  if (headerPass && timingSafeEqual(headerPass.trim(), adminPassword)) {
    return true;
  }

  const authHeader = request.headers.get("Authorization");
  if (authHeader) {
    if (authHeader.startsWith("Bearer ")) {
      const token = authHeader.slice(7).trim();
      if (timingSafeEqual(token, adminPassword)) {
        return true;
      }
    } else if (authHeader.startsWith("Basic ")) {
      try {
        const decoded = atob(authHeader.slice(6).trim());
        const colonIdx = decoded.indexOf(":");
        const pass = colonIdx >= 0 ? decoded.slice(colonIdx + 1) : decoded;
        if (timingSafeEqual(pass, adminPassword)) {
          return true;
        }
      } catch {
        // Ignore invalid base64
      }
    }
  }

  const cookieToken = getCookie(request, ADMIN_COOKIE_NAME);
  if (cookieToken && timingSafeEqual(cookieToken, adminPassword)) {
    return true;
  }

  return false;
}

/**
 * Escape HTML special characters to prevent XSS.
 */
function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function maskToken(token: string): string {
  const clean = token.trim();
  if (clean.length <= 12) return "••••••••";
  return `${clean.slice(0, 6)}••••${clean.slice(-4)}`;
}

function formatRemainingTime(account: FreebuffAccount): string {
  const session = account.session;
  if (!session || session.status !== "active") {
    return "Idle (No active session)";
  }
  if (session.expiresAt) {
    const diffMs = Date.parse(session.expiresAt) - Date.now();
    if (!Number.isNaN(diffMs)) {
      if (diffMs <= 0) return "Expired";
      const mins = Math.floor(diffMs / 60000);
      const secs = Math.floor((diffMs % 60000) / 1000);
      return `${session.model} (${mins}m ${secs}s left)`;
    }
  }
  if (typeof session.remainingMs === "number") {
    const elapsed = Date.now() - (session.updatedAt || Date.now());
    const rem = session.remainingMs - elapsed;
    if (rem <= 0) return "Expired";
    const mins = Math.floor(rem / 60000);
    return `${session.model} (~${mins}m left)`;
  }
  return `${session.model} (Active)`;
}

/**
 * Render the Admin Login HTML page when `ADMIN_PASSWORD` is configured and user is not authenticated.
 */
function renderLoginPage(errorMsg?: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="dark" />
  <title>Admin Login — Freebuff2OpenAI Setup</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #070b14;
      --card: rgba(17, 24, 39, 0.88);
      --border: #1e293b;
      --text: #f8fafc;
      --muted: #94a3b8;
      --primary: #10b981;
      --primary-hover: #059669;
      --danger: #ef4444;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif;
      background: radial-gradient(circle at top, #064e3b 0%, var(--bg) 60%);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1.5rem;
    }
    .login-card {
      background: var(--card);
      backdrop-filter: blur(16px);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 2.25rem;
      width: 100%;
      max-width: 420px;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.55);
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: #6ee7b7;
      background: rgba(16, 185, 129, 0.15);
      border: 1px solid rgba(16, 185, 129, 0.35);
      padding: 0.3rem 0.65rem;
      border-radius: 999px;
      margin-bottom: 1rem;
    }
    h1 {
      font-size: 1.45rem;
      font-weight: 700;
      margin-bottom: 0.5rem;
    }
    p {
      color: var(--muted);
      font-size: 0.9rem;
      line-height: 1.5;
      margin-bottom: 1.5rem;
    }
    label {
      display: block;
      font-size: 0.82rem;
      font-weight: 600;
      color: #d1d5db;
      margin-bottom: 0.45rem;
    }
    input[type="password"] {
      width: 100%;
      padding: 0.75rem 0.9rem;
      background: #0b0f19;
      border: 1px solid #334155;
      border-radius: 10px;
      color: var(--text);
      font-size: 0.95rem;
      outline: none;
      transition: border-color 0.15s;
      margin-bottom: 1.1rem;
    }
    input[type="password"]:focus {
      border-color: var(--primary);
    }
    button {
      width: 100%;
      padding: 0.8rem 1rem;
      background: var(--primary);
      color: #052e16;
      font-weight: 700;
      font-size: 0.95rem;
      border: none;
      border-radius: 10px;
      cursor: pointer;
      transition: background 0.15s;
    }
    button:hover {
      background: var(--primary-hover);
      color: white;
    }
    .error {
      background: rgba(239, 68, 68, 0.12);
      border: 1px solid rgba(239, 68, 68, 0.35);
      color: #fca5a5;
      padding: 0.7rem 0.9rem;
      border-radius: 8px;
      font-size: 0.85rem;
      margin-bottom: 1rem;
    }
  </style>
</head>
<body>
  <div class="login-card">
    <div class="badge">Cloudflare Worker Edge Proxy</div>
    <h1>Freebuff2OpenAI Setup</h1>
    <p>Enter your <code>ADMIN_PASSWORD</code> secret to access the Freebuff multi-account OAuth dashboard.</p>
    ${errorMsg ? `<div class="error">${escapeHtml(errorMsg)}</div>` : ""}
    <form method="POST" action="/setup/login">
      <label for="password">Admin Password</label>
      <input type="password" id="password" name="password" placeholder="Enter ADMIN_PASSWORD..." required autofocus />
      <button type="submit">Unlock Dashboard</button>
    </form>
  </div>
</body>
</html>`;
}

/**
 * Render the main interactive `/setup` Web Dashboard HTML.
 */
function renderSetupDashboard(
  request: Request,
  env: Env,
  poolState: FreebuffPoolState,
  flashMessage?: { type: "success" | "error"; text: string }
): string {
  const url = new URL(request.url);
  const workerOrigin = `${url.protocol}//${url.host}`;
  const baseUrlV1 = `${workerOrigin}/v1`;
  const accounts = poolState.accounts;
  const isConnected = accounts.length > 0;
  const adminPasswordConfigured = Boolean(env.ADMIN_PASSWORD?.trim());

  const accountsRowsHtml =
    accounts.length === 0
      ? `<tr>
          <td colspan="6" style="text-align:center; padding: 2rem; color: var(--muted);">
            No Freebuff accounts connected yet. Use <strong>Option A (1-Click Browser Login)</strong> or <strong>Option B (Paste Token)</strong> above to add your first account.
          </td>
        </tr>`
      : accounts
          .map((acct, idx) => {
            const isActiveSession =
              acct.session && acct.session.status === "active";
            return `<tr>
              <td><span class="mono-badge">#${idx + 1}</span></td>
              <td>
                <div style="font-weight:600; color:#f8fafc;">${escapeHtml(acct.name || "Freebuff User")}</div>
                <div style="font-size:0.78rem; color:var(--muted);">${escapeHtml(acct.email || acct.id)}</div>
              </td>
              <td><code class="token-pill">${escapeHtml(maskToken(acct.authToken))}</code></td>
              <td>
                <span class="session-badge ${isActiveSession ? "session-active" : "session-idle"}">
                  ${escapeHtml(formatRemainingTime(acct))}
                </span>
                ${
                  acct.last_error
                    ? `<div style="font-size:0.75rem; color:#fca5a5; margin-top:0.25rem;">${escapeHtml(acct.last_error.slice(0, 80))}</div>`
                    : ""
                }
              </td>
              <td style="font-size:0.8rem; color:var(--muted);">
                ${escapeHtml(acct.last_used_at ? new Date(acct.last_used_at).toLocaleString() : "Never")}
              </td>
              <td style="text-align:right;">
                <form method="POST" action="/setup/accounts/delete" style="display:inline;" onsubmit="return confirm('Remove this account from the pool?');">
                  <input type="hidden" name="accountId" value="${escapeHtml(acct.id)}" />
                  <button type="submit" class="btn btn-danger btn-sm">Remove</button>
                </form>
              </td>
            </tr>`;
          })
          .join("\n");

  const modelsPillsHtml = FREEBUFF_MODELS.slice(0, 13)
    .map(
      (m) =>
        `<span class="model-chip" title="${escapeHtml(m.description || m.agent_id)}">${escapeHtml(m.id)}</span>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="dark" />
  <title>freebuff2openai-cf — Serverless Freebuff / Codebuff OpenAI Proxy</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #060a12;
      --card: rgba(15, 23, 42, 0.86);
      --card-alt: #0b1120;
      --border: #1e293b;
      --text: #f8fafc;
      --muted: #94a3b8;
      --primary: #10b981;
      --primary-hover: #059669;
      --accent: #6366f1;
      --warning: #f59e0b;
      --danger: #ef4444;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif;
      background: radial-gradient(circle at 50% 0%, #064e3b 0%, var(--bg) 55%);
      color: var(--text);
      min-height: 100vh;
      padding: 2rem 1.25rem 4rem;
      line-height: 1.5;
    }
    .container {
      max-width: 1000px;
      margin: 0 auto;
    }
    header {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      margin-bottom: 2rem;
      padding-bottom: 1.25rem;
      border-bottom: 1px solid var(--border);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 0.9rem;
    }
    .brand-icon {
      width: 44px;
      height: 44px;
      border-radius: 12px;
      background: linear-gradient(135deg, #10b981, #059669);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 800;
      font-size: 1.15rem;
      color: #022c22;
      box-shadow: 0 8px 22px rgba(16, 185, 129, 0.35);
    }
    .brand-text h1 {
      font-size: 1.35rem;
      font-weight: 700;
      letter-spacing: -0.02em;
    }
    .brand-text span {
      font-size: 0.83rem;
      color: var(--muted);
    }
    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.45rem 0.95rem;
      border-radius: 999px;
      font-size: 0.82rem;
      font-weight: 600;
    }
    .status-connected {
      background: rgba(16, 185, 129, 0.15);
      border: 1px solid rgba(16, 185, 129, 0.4);
      color: #34d399;
    }
    .status-disconnected {
      background: rgba(239, 68, 68, 0.15);
      border: 1px solid rgba(239, 68, 68, 0.4);
      color: #f87171;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: currentColor;
      box-shadow: 0 0 8px currentColor;
    }
    .alert {
      padding: 0.9rem 1.1rem;
      border-radius: 12px;
      margin-bottom: 1.5rem;
      font-size: 0.88rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
    }
    .alert-success {
      background: rgba(16, 185, 129, 0.15);
      border: 1px solid rgba(16, 185, 129, 0.4);
      color: #6ee7b7;
    }
    .alert-error {
      background: rgba(239, 68, 68, 0.15);
      border: 1px solid rgba(239, 68, 68, 0.4);
      color: #fca5a5;
    }
    .alert-warning {
      background: rgba(245, 158, 11, 0.12);
      border: 1px solid rgba(245, 158, 11, 0.35);
      color: #fcd34d;
    }
    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1.5rem;
      margin-bottom: 1.5rem;
    }
    @media (max-width: 800px) {
      .grid { grid-template-columns: 1fr; }
    }
    .card {
      background: var(--card);
      backdrop-filter: blur(16px);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 1.6rem;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.4);
      margin-bottom: 1.5rem;
    }
    .grid .card {
      margin-bottom: 0;
    }
    .card h2 {
      font-size: 1.05rem;
      font-weight: 700;
      margin-bottom: 0.35rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
    }
    .card p.subtitle {
      color: var(--muted);
      font-size: 0.84rem;
      margin-bottom: 1.25rem;
    }
    .step-box {
      background: var(--card-alt);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 1.15rem;
      margin-bottom: 1rem;
    }
    .step-header {
      font-size: 0.78rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #34d399;
      margin-bottom: 0.4rem;
    }
    .step-desc {
      font-size: 0.84rem;
      color: var(--muted);
      margin-bottom: 0.9rem;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      padding: 0.72rem 1.1rem;
      border-radius: 10px;
      font-weight: 600;
      font-size: 0.9rem;
      text-decoration: none;
      cursor: pointer;
      border: none;
      transition: all 0.15s ease;
    }
    .btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .btn-primary {
      background: var(--primary);
      color: #022c22;
      font-weight: 700;
      width: 100%;
    }
    .btn-primary:hover:not(:disabled) {
      background: var(--primary-hover);
      color: white;
    }
    .btn-oauth {
      background: #ffffff;
      color: #0f172a;
      font-weight: 700;
      width: 100%;
    }
    .btn-oauth:hover:not(:disabled) {
      background: #e2e8f0;
    }
    .btn-outline {
      background: transparent;
      border: 1px solid #334155;
      color: #cbd5e1;
      font-size: 0.82rem;
      padding: 0.5rem 0.85rem;
    }
    .btn-outline:hover {
      background: #1e293b;
      color: white;
    }
    .btn-danger {
      background: rgba(239, 68, 68, 0.14);
      border: 1px solid rgba(239, 68, 68, 0.35);
      color: #fca5a5;
      font-size: 0.82rem;
      padding: 0.5rem 0.85rem;
    }
    .btn-danger:hover {
      background: rgba(239, 68, 68, 0.25);
    }
    .btn-sm {
      padding: 0.35rem 0.65rem;
      font-size: 0.76rem;
      border-radius: 8px;
    }
    label {
      display: block;
      font-size: 0.8rem;
      font-weight: 600;
      color: #cbd5e1;
      margin-bottom: 0.35rem;
    }
    textarea, input[type="text"], select {
      width: 100%;
      background: #060a12;
      border: 1px solid #334155;
      border-radius: 10px;
      padding: 0.7rem 0.85rem;
      color: var(--text);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 0.83rem;
      outline: none;
      transition: border-color 0.15s;
      margin-bottom: 0.85rem;
    }
    textarea {
      resize: vertical;
      min-height: 92px;
    }
    textarea:focus, input[type="text"]:focus, select:focus {
      border-color: var(--primary);
    }
    .copy-box {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      background: #060a12;
      border: 1px solid #334155;
      border-radius: 10px;
      padding: 0.55rem 0.75rem;
      margin-top: 0.35rem;
      margin-bottom: 1rem;
    }
    .copy-box code {
      flex: 1;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.83rem;
      color: #6ee7b7;
      overflow-x: auto;
      white-space: nowrap;
    }
    .table-wrap {
      overflow-x: auto;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: var(--card-alt);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.85rem;
    }
    th, td {
      padding: 0.8rem 0.95rem;
      text-align: left;
      border-bottom: 1px solid var(--border);
    }
    th {
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--muted);
      background: rgba(15, 23, 42, 0.6);
    }
    tr:last-child td {
      border-bottom: none;
    }
    .token-pill {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.78rem;
      background: rgba(99, 102, 241, 0.12);
      border: 1px solid rgba(99, 102, 241, 0.3);
      color: #a5b4fc;
      padding: 0.2rem 0.5rem;
      border-radius: 6px;
    }
    .mono-badge {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.76rem;
      color: var(--muted);
    }
    .session-badge {
      display: inline-block;
      padding: 0.22rem 0.55rem;
      border-radius: 999px;
      font-size: 0.76rem;
      font-weight: 600;
    }
    .session-active {
      background: rgba(16, 185, 129, 0.15);
      border: 1px solid rgba(16, 185, 129, 0.35);
      color: #34d399;
    }
    .session-idle {
      background: rgba(148, 163, 184, 0.12);
      border: 1px solid rgba(148, 163, 184, 0.25);
      color: #94a3b8;
    }
    .poll-box {
      display: none;
      margin-top: 0.9rem;
      padding: 0.9rem;
      border-radius: 10px;
      background: rgba(16, 185, 129, 0.1);
      border: 1px solid rgba(16, 185, 129, 0.35);
      font-size: 0.84rem;
      color: #a7f3d0;
    }
    .spinner {
      display: inline-block;
      width: 14px;
      height: 14px;
      border: 2px solid rgba(167, 243, 208, 0.3);
      border-top-color: #34d399;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      vertical-align: middle;
      margin-right: 0.45rem;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    .models-wrap {
      display: flex;
      flex-wrap: wrap;
      gap: 0.45rem;
      margin-top: 0.5rem;
    }
    .model-chip {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.75rem;
      padding: 0.28rem 0.6rem;
      border-radius: 8px;
      background: var(--card-alt);
      border: 1px solid var(--border);
      color: #cbd5e1;
    }
    pre.code-snippet {
      background: #060a12;
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 0.95rem;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.78rem;
      color: #cbd5e1;
      overflow-x: auto;
      line-height: 1.55;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="brand">
        <div class="brand-icon">FB</div>
        <div class="brand-text">
          <h1>freebuff2openai-cf</h1>
          <span>Serverless Freebuff / Codebuff OpenAI-Compatible Proxy on Cloudflare Workers + KV</span>
        </div>
      </div>
      <div class="status-pill ${isConnected ? "status-connected" : "status-disconnected"}">
        <span class="dot"></span>
        <span>${isConnected ? `${accounts.length} Account(s) in Pool` : "No Accounts Connected"}</span>
      </div>
    </header>

    ${
      !adminPasswordConfigured
        ? `<div class="alert alert-warning">
            <span><strong>Security Notice:</strong> <code>ADMIN_PASSWORD</code> secret is not configured. Run <code>npx wrangler secret put ADMIN_PASSWORD</code> to protect this dashboard.</span>
          </div>`
        : ""
    }

    ${
      flashMessage
        ? `<div class="alert ${flashMessage.type === "success" ? "alert-success" : "alert-error"}">
            <span>${escapeHtml(flashMessage.text)}</span>
          </div>`
        : ""
    }

    <div class="grid">
      <!-- Option A: 1-Click Browser OAuth Login -->
      <div class="card">
        <h2>Option A — 1-Click Browser OAuth Login</h2>
        <p class="subtitle">Authenticate directly in your browser using Freebuff's CLI device flow. No local CLI required!</p>

        <div class="step-box" style="margin-bottom:0;">
          <div class="step-header">Browser OAuth + Live Polling</div>
          <div class="step-desc">
            Click the button below to generate a unique login link and open Freebuff in a new tab. Once you sign in, this page will automatically capture and save your <code>authToken</code> into <code>FREEBUFF_KV</code>.
          </div>

          <label for="auth-mode">Auth Provider Host</label>
          <select id="auth-mode">
            <option value="freebuff" selected>freebuff.com (Recommended Default)</option>
            <option value="codebuff">www.codebuff.com</option>
          </select>

          <button type="button" class="btn btn-oauth" id="start-oauth-btn" onclick="startBrowserLogin()">
            1. Login with Freebuff (Open Browser) ↗
          </button>

          <div id="poll-box" class="poll-box">
            <div>
              <span class="spinner" id="poll-spinner"></span>
              <span id="poll-status-text">Waiting for you to complete login in the new tab...</span>
            </div>
            <div id="poll-link-wrap" style="margin-top:0.55rem; font-size:0.78rem; word-break:break-all;"></div>
          </div>
        </div>
      </div>

      <!-- Option B: Manual Token Input & Multi-Account Pool -->
      <div class="card">
        <h2>Option B — Paste Auth Token(s)</h2>
        <p class="subtitle">Paste one or more Freebuff / Codebuff <code>authToken</code> strings to populate your multi-account rotation pool.</p>

        <form id="paste-token-form" method="POST" action="/setup/tokens">
          <label for="tokens-input">Freebuff Auth Token(s) (comma or newline separated)</label>
          <textarea
            id="tokens-input"
            name="tokens"
            placeholder="Paste one or multiple authToken strings here (one per line or comma-separated)..."
            required
          ></textarea>
          <button type="submit" class="btn btn-primary" id="save-tokens-btn">
            Save Token(s) to Pool
          </button>
        </form>
        <div id="token-toast" style="display:none; margin-top:0.85rem;"></div>

        <div style="margin-top: 1.2rem;">
          <label>OpenAI Base URL (Copy to Cursor / Cline / Roo Code / OpenCode)</label>
          <div class="copy-box" style="margin-bottom:0;">
            <code id="base-url-code">${escapeHtml(baseUrlV1)}</code>
            <button type="button" class="btn btn-outline btn-sm" onclick="copyBaseUrl()">Copy URL</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Connected Accounts Pool Table -->
    <div class="card">
      <h2>
        <span>Connected Accounts Pool (${accounts.length})</span>
        <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
          <form method="POST" action="/setup/accounts/refresh" style="display:inline;">
            <button type="submit" class="btn btn-outline btn-sm">↻ Refresh Sessions</button>
          </form>
          <a href="/v1/models" target="_blank" class="btn btn-outline btn-sm">View /v1/models ↗</a>
          ${
            accounts.length > 0
              ? `<form method="POST" action="/setup/accounts/clear" style="display:inline;" onsubmit="return confirm('Clear ALL connected Freebuff accounts from Cloudflare KV?');">
                  <button type="submit" class="btn btn-danger btn-sm">Clear All</button>
                </form>`
              : ""
          }
        </div>
      </h2>
      <p class="subtitle">
        Requests automatically prefer an account with an already-active session for the requested model, or rotate across idle accounts to prevent session collisions.
      </p>

      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Account</th>
              <th>Token</th>
              <th>Active Session / Model</th>
              <th>Last Used</th>
              <th style="text-align:right;">Action</th>
            </tr>
          </thead>
          <tbody>
            ${accountsRowsHtml}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Supported Models & Quick Test -->
    <div class="card">
      <h2>Supported Models &amp; Quick API Test</h2>
      <p class="subtitle">Includes Direct Root Models and Gemini Child-Agent Free Models:</p>
      <div class="models-wrap" style="margin-bottom: 1.25rem;">
        ${modelsPillsHtml}
      </div>

      <label>cURL Test Command</label>
      <pre class="code-snippet">curl ${escapeHtml(baseUrlV1)}/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -d '{
    "model": "deepseek/deepseek-v4-flash",
    "messages": [{"role": "user", "content": "Write a TypeScript debounce function."}],
    "stream": true
  }'</pre>
    </div>

    <!-- Cloudflare AI Gateway Collaboration -->
    <div class="card" style="margin-bottom:0;">
      <h2>
        <span>Cloudflare AI Gateway Integration</span>
        <div style="display:flex; gap:0.45rem; flex-wrap:wrap;">
          <span class="session-badge session-active">Custom Provider Ready</span>
          <span class="session-badge ${env.AI_GATEWAY_CODEBUFF_URL?.trim() ? "session-active" : "session-idle"}">
            Outbound Logging: ${env.AI_GATEWAY_CODEBUFF_URL?.trim() ? "Active" : "Off"}
          </span>
          <span class="session-badge ${env.AI_GATEWAY_FALLBACK_URL?.trim() ? "session-active" : "session-idle"}">
            Auto-Fallback: ${env.AI_GATEWAY_FALLBACK_URL?.trim() ? "Active" : "Off"}
          </span>
        </div>
      </h2>
      <p class="subtitle">
        Combine <code>freebuff2openai-cf</code> (Protocol Adapter &amp; Multi-Account Pool) with <strong>Cloudflare AI Gateway</strong> for centralized prompt logging, caching, rate limiting, and multi-provider fallbacks.
      </p>

      <label>1. Register as Custom Provider in Cloudflare AI Gateway (Slug: <code>freebuff</code>, Base URL below)</label>
      <div class="copy-box">
        <code id="aig-base-url-code">${escapeHtml(workerOrigin)}</code>
        <button type="button" class="btn btn-outline btn-sm" onclick="copyAigBaseUrl()">Copy Origin URL</button>
      </div>

      <label>2. Call via Cloudflare AI Gateway Unified API (<code>/compat/chat/completions</code>)</label>
      <pre class="code-snippet">curl https://gateway.ai.cloudflare.com/v1/&lt;CF_ACCOUNT_ID&gt;/&lt;GATEWAY_ID&gt;/compat/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -d '{
    "model": "custom-freebuff/deepseek/deepseek-v4-flash",
    "messages": [{"role": "user", "content": "Hello via Cloudflare AI Gateway!"}],
    "stream": true
  }'</pre>
    </div>
  </div>

  <script>
    let pollTimer = null;

    function copyBaseUrl() {
      const text = document.getElementById("base-url-code").innerText;
      navigator.clipboard.writeText(text).then(() => {
        alert("Copied OpenAI Base URL: " + text);
      });
    }

    function copyAigBaseUrl() {
      const text = document.getElementById("aig-base-url-code").innerText;
      navigator.clipboard.writeText(text).then(() => {
        alert("Copied Custom Provider Base URL: " + text);
      });
    }

    async function startBrowserLogin() {
      const btn = document.getElementById("start-oauth-btn");
      const mode = document.getElementById("auth-mode").value;
      const pollBox = document.getElementById("poll-box");
      const statusText = document.getElementById("poll-status-text");
      const linkWrap = document.getElementById("poll-link-wrap");
      const spinner = document.getElementById("poll-spinner");

      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }

      btn.disabled = true;
      btn.textContent = "Generating Login Link...";
      pollBox.style.display = "block";
      spinner.style.display = "inline-block";
      statusText.textContent = "Requesting CLI login code from Freebuff...";
      linkWrap.innerHTML = "";

      try {
        const res = await fetch("/setup/auth/start", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Accept": "application/json" },
          body: JSON.stringify({ mode })
        });
        const data = await res.json();
        if (!res.ok || !data.loginUrl) {
          throw new Error(data.error || "Failed to start Freebuff CLI login");
        }

        // Open loginUrl in a new tab
        window.open(data.loginUrl, "_blank", "noopener,noreferrer");

        btn.textContent = "Waiting for Browser Login...";
        statusText.textContent = "Complete sign-in in the opened tab. Polling status every 2s...";
        linkWrap.innerHTML = 'If the tab did not open automatically, <a href="' + data.loginUrl + '" target="_blank" rel="noopener noreferrer" style="color:#6ee7b7;text-decoration:underline;">click here to open Freebuff Login ↗</a>';

        const pollParams = new URLSearchParams({
          fingerprintId: data.fingerprintId,
          fingerprintHash: data.fingerprintHash,
          expiresAt: String(data.expiresAt),
          authHost: data.authHost || ""
        });

        pollTimer = setInterval(async () => {
          try {
            const pollRes = await fetch("/setup/auth/poll?" + pollParams.toString(), {
              headers: { "Accept": "application/json" }
            });
            const pollData = await pollRes.json();

            if (pollData.status === "completed") {
              clearInterval(pollTimer);
              pollTimer = null;
              spinner.style.display = "none";
              statusText.textContent = "✓ Login successful! Connected account: " + (pollData.account?.email || pollData.account?.name || pollData.account?.id) + ". Reloading...";
              setTimeout(() => window.location.reload(), 900);
            } else if (pollData.status === "error") {
              clearInterval(pollTimer);
              pollTimer = null;
              spinner.style.display = "none";
              statusText.textContent = "✗ Error: " + (pollData.error || "Login polling failed");
              btn.disabled = false;
              btn.textContent = "1. Login with Freebuff (Open Browser) ↗";
            }
          } catch (err) {
            // Transient poll error; keep polling
          }
        }, 2000);
      } catch (err) {
        spinner.style.display = "none";
        statusText.textContent = "✗ " + (err.message || "Failed to start login");
        btn.disabled = false;
        btn.textContent = "1. Login with Freebuff (Open Browser) ↗";
      }
    }

    // Progressive AJAX handler for pasting tokens
    const tokenForm = document.getElementById("paste-token-form");
    const saveTokensBtn = document.getElementById("save-tokens-btn");
    const tokenToast = document.getElementById("token-toast");

    tokenForm?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const rawTokens = document.getElementById("tokens-input").value.trim();
      if (!rawTokens) return;

      saveTokensBtn.disabled = true;
      saveTokensBtn.textContent = "Verifying & Saving Token(s)...";
      tokenToast.style.display = "none";

      try {
        const res = await fetch("/setup/tokens", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Accept": "application/json" },
          body: JSON.stringify({ tokens: rawTokens })
        });
        const data = await res.json();
        tokenToast.style.display = "block";
        if (res.ok && data.success) {
          tokenToast.className = "alert alert-success";
          tokenToast.textContent = data.message || ("Saved " + data.addedCount + " account(s)! Reloading...");
          setTimeout(() => window.location.reload(), 900);
        } else {
          tokenToast.className = "alert alert-error";
          tokenToast.textContent = data.error || "Failed to verify and save token(s).";
          saveTokensBtn.disabled = false;
          saveTokensBtn.textContent = "Save Token(s) to Pool";
        }
      } catch (err) {
        tokenToast.style.display = "block";
        tokenToast.className = "alert alert-error";
        tokenToast.textContent = "Network error: " + err.message;
        saveTokensBtn.disabled = false;
        saveTokensBtn.textContent = "Save Token(s) to Pool";
      }
    });
  </script>
</body>
</html>`;
}

/**
 * Main router handler for `/setup` and `/setup/*` endpoints.
 */
export async function handleSetupRequest(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/setup";

  // 1. Handle `POST /setup/login`
  if (path === "/setup/login" && request.method === "POST") {
    const formData = await request.formData().catch(() => null);
    const password = (formData?.get("password") as string | null)?.trim() ?? "";
    const expected = env.ADMIN_PASSWORD?.trim() ?? "";

    if (!expected || timingSafeEqual(password, expected)) {
      return new Response(null, {
        status: 303,
        headers: {
          Location: "/setup",
          "Set-Cookie": `${ADMIN_COOKIE_NAME}=${encodeURIComponent(
            password
          )}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`,
        },
      });
    }

    return new Response(renderLoginPage("Invalid ADMIN_PASSWORD."), {
      status: 401,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // 2. Check Admin Authorization for all other `/setup*` routes
  if (!isAuthorizedAdmin(request, env)) {
    const acceptsJson = request.headers
      .get("Accept")
      ?.includes("application/json");
    if (acceptsJson && path !== "/setup") {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Unauthorized: Invalid or missing ADMIN_PASSWORD.",
        }),
        {
          status: 401,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        }
      );
    }
    return new Response(renderLoginPage(), {
      status: 401,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // 3. `GET /setup/status` -> Pool JSON telemetry
  if (path === "/setup/status" && request.method === "GET") {
    const pool = await getPoolState(env);
    return new Response(
      JSON.stringify({
        connected: pool.accounts.length > 0,
        account_count: pool.accounts.length,
        updated_at: pool.updated_at,
        accounts: pool.accounts.map((a) => ({
          id: a.id,
          name: a.name,
          email: a.email,
          token_masked: maskToken(a.authToken),
          added_at: a.added_at,
          last_used_at: a.last_used_at,
          last_error: a.last_error,
          session: a.session,
        })),
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      }
    );
  }

  // 4. `POST /setup/auth/start` -> Step 1 of CLI OAuth flow
  if (path === "/setup/auth/start" && request.method === "POST") {
    try {
      let mode: "freebuff" | "codebuff" = "freebuff";
      try {
        const body = (await request.json()) as { mode?: string };
        if (body?.mode === "codebuff") {
          mode = "codebuff";
        }
      } catch {
        // Default to freebuff
      }
      const startData = await startCliLogin(env, mode);
      return new Response(JSON.stringify(startData), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Failed to start CLI login";
      return new Response(JSON.stringify({ error: msg }), {
        status: 500,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }
  }

  // 5. `GET /setup/auth/poll` -> Step 2 of CLI OAuth flow
  if (path === "/setup/auth/poll" && request.method === "GET") {
    const fingerprintId = url.searchParams.get("fingerprintId") || "";
    const fingerprintHash = url.searchParams.get("fingerprintHash") || "";
    const expiresAt = url.searchParams.get("expiresAt") || "";
    const authHost = url.searchParams.get("authHost") || undefined;

    if (!fingerprintId || !fingerprintHash || !expiresAt) {
      return new Response(
        JSON.stringify({
          status: "error",
          error: "Missing fingerprintId, fingerprintHash, or expiresAt",
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        }
      );
    }

    try {
      const pollResult = await pollCliLoginStatus(env, {
        fingerprintId,
        fingerprintHash,
        expiresAt,
        authHost,
      });

      if (pollResult.status === "completed" && pollResult.user) {
        const verification = await verifyTokenAndGetProfile(
          env,
          pollResult.user.authToken
        );
        const { account } = await upsertAccount(env, {
          id: pollResult.user.id,
          name: pollResult.user.name,
          email: pollResult.user.email,
          authToken: pollResult.user.authToken,
          session: verification.session ?? null,
        });

        return new Response(
          JSON.stringify({
            status: "completed",
            account: {
              id: account.id,
              name: account.name,
              email: account.email,
              added_at: account.added_at,
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json; charset=utf-8" },
          }
        );
      }

      return new Response(JSON.stringify(pollResult), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    } catch (err) {
      return new Response(
        JSON.stringify({
          status: "error",
          error: err instanceof Error ? err.message : "Poll failed",
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        }
      );
    }
  }

  // 6. `POST /setup/tokens` -> Paste one or multiple authTokens
  if (path === "/setup/tokens" && request.method === "POST") {
    const contentType = request.headers.get("Content-Type") || "";
    const acceptsJson = request.headers
      .get("Accept")
      ?.includes("application/json");
    let rawTokens = "";

    if (contentType.includes("application/json")) {
      const body = (await request.json().catch(() => ({}))) as {
        tokens?: string;
      };
      rawTokens = body.tokens ?? "";
    } else {
      const formData = await request.formData().catch(() => null);
      rawTokens = (formData?.get("tokens") as string | null) ?? "";
    }

    const tokenList = rawTokens
      .split(/[\r\n,]+/)
      .map((t) => t.trim())
      .filter(Boolean);

    if (tokenList.length === 0) {
      const errMsg = "Please provide at least one non-empty authToken.";
      if (acceptsJson) {
        return new Response(JSON.stringify({ success: false, error: errMsg }), {
          status: 400,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        });
      }
      const pool = await getPoolState(env);
      return new Response(
        renderSetupDashboard(request, env, pool, {
          type: "error",
          text: errMsg,
        }),
        { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } }
      );
    }

    let addedCount = 0;
    const errors: string[] = [];

    for (const token of tokenList) {
      const verify = await verifyTokenAndGetProfile(env, token);
      if (!verify.valid) {
        errors.push(`${maskToken(token)}: ${verify.error || "Invalid token"}`);
        continue;
      }
      await upsertAccount(env, {
        authToken: token,
        session: verify.session ?? null,
      });
      addedCount++;
    }

    if (addedCount === 0) {
      const errMsg = `Failed to verify token(s): ${errors.join("; ")}`;
      if (acceptsJson) {
        return new Response(JSON.stringify({ success: false, error: errMsg }), {
          status: 400,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        });
      }
      const pool = await getPoolState(env);
      return new Response(
        renderSetupDashboard(request, env, pool, {
          type: "error",
          text: errMsg,
        }),
        { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } }
      );
    }

    const msg =
      errors.length > 0
        ? `Verified and saved ${addedCount} account(s). (${errors.length} failed: ${errors.join("; ")})`
        : `Successfully verified and saved ${addedCount} Freebuff account(s) to KV pool!`;

    if (acceptsJson) {
      return new Response(
        JSON.stringify({
          success: true,
          addedCount,
          message: msg,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        }
      );
    }

    const pool = await getPoolState(env);
    return new Response(
      renderSetupDashboard(request, env, pool, {
        type: "success",
        text: msg,
      }),
      { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }

  // 7. `POST /setup/accounts/refresh` -> Refresh live session status for all accounts
  if (path === "/setup/accounts/refresh" && request.method === "POST") {
    const pool = await getPoolState(env);
    for (const acct of pool.accounts) {
      const check = await verifyTokenAndGetProfile(env, acct.authToken);
      if (check.valid) {
        await updateAccountState(env, acct.id, {
          session: check.session ?? null,
          last_error: null,
        });
      } else {
        await updateAccountState(env, acct.id, {
          last_error: check.error || "Token verification failed",
        });
      }
    }
    const updatedPool = await getPoolState(env);
    return new Response(
      renderSetupDashboard(request, env, updatedPool, {
        type: "success",
        text: `Refreshed live session status for ${updatedPool.accounts.length} account(s).`,
      }),
      { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }

  // 8. `POST /setup/accounts/delete` -> Remove single account
  if (path === "/setup/accounts/delete" && request.method === "POST") {
    const formData = await request.formData().catch(() => null);
    const accountId = (formData?.get("accountId") as string | null) ?? "";
    const updatedPool = await removeAccount(env, accountId);
    return new Response(
      renderSetupDashboard(request, env, updatedPool, {
        type: "success",
        text: `Removed account ${accountId} from pool.`,
      }),
      { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }

  // 9. `POST /setup/accounts/clear` -> Clear all accounts
  if (path === "/setup/accounts/clear" && request.method === "POST") {
    await clearAllAccounts(env);
    const emptyPool = await getPoolState(env);
    return new Response(
      renderSetupDashboard(request, env, emptyPool, {
        type: "success",
        text: "Cleared all Freebuff accounts from Cloudflare KV.",
      }),
      { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }

  // 10. Default `GET /setup` -> Render Setup Dashboard
  const poolState = await getPoolState(env);
  return new Response(renderSetupDashboard(request, env, poolState), {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
