import {
  Env,
  FreebuffAccount,
  FreebuffPoolState,
  FreebuffSessionState,
} from "./types";

const KV_POOL_KEY = "freebuff_pool_state_v1";

/**
 * Generate a short deterministic account ID when user profile ID is unavailable.
 */
export function buildFallbackAccountId(authToken: string): string {
  const clean = authToken.trim();
  const prefix = clean.slice(0, 6).replace(/[^a-zA-Z0-9]/g, "x");
  const suffix = clean.slice(-6).replace(/[^a-zA-Z0-9]/g, "x");
  let hash = 2166136261;
  for (let i = 0; i < clean.length; i++) {
    hash ^= clean.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const hex = (hash >>> 0).toString(16).padStart(8, "0");
  return `acct_${prefix}_${hex}_${suffix}`;
}

/**
 * Check if a cached session is still fresh (not expired).
 */
export function isSessionFresh(
  session: FreebuffSessionState | null | undefined
): boolean {
  if (!session || session.status !== "active" || !session.instanceId) {
    return false;
  }
  if (session.expiresAt) {
    const expMs = Date.parse(session.expiresAt);
    if (!Number.isNaN(expMs) && expMs - Date.now() <= 10_000) {
      return false;
    }
  }
  if (typeof session.remainingMs === "number" && session.remainingMs <= 10_000) {
    const elapsed = Date.now() - (session.updatedAt || 0);
    if (session.remainingMs - elapsed <= 10_000) {
      return false;
    }
  }
  return true;
}

/**
 * Retrieve the current account pool state from Cloudflare KV.
 */
export async function getPoolState(env: Env): Promise<FreebuffPoolState> {
  try {
    const raw = await env.FREEBUFF_KV.get(KV_POOL_KEY, "text");
    if (!raw) {
      return {
        accounts: [],
        rr_index: 0,
        updated_at: new Date().toISOString(),
      };
    }
    const parsed = JSON.parse(raw) as Partial<FreebuffPoolState>;
    const accounts = Array.isArray(parsed.accounts) ? parsed.accounts : [];
    return {
      accounts,
      rr_index: typeof parsed.rr_index === "number" ? parsed.rr_index : 0,
      updated_at: parsed.updated_at || new Date().toISOString(),
    };
  } catch {
    return {
      accounts: [],
      rr_index: 0,
      updated_at: new Date().toISOString(),
    };
  }
}

/**
 * Persist the account pool state to Cloudflare KV.
 */
export async function savePoolState(
  env: Env,
  state: FreebuffPoolState
): Promise<FreebuffPoolState> {
  const updated: FreebuffPoolState = {
    ...state,
    updated_at: new Date().toISOString(),
  };
  await env.FREEBUFF_KV.put(KV_POOL_KEY, JSON.stringify(updated));
  return updated;
}

/**
 * Add or update a Freebuff account in the KV pool.
 * Deduplicates by `authToken` or `id`.
 */
export async function upsertAccount(
  env: Env,
  input: {
    id?: string;
    name?: string;
    email?: string;
    authToken: string;
    session?: FreebuffSessionState | null;
  }
): Promise<{ state: FreebuffPoolState; account: FreebuffAccount }> {
  const token = input.authToken.trim();
  if (!token) {
    throw new Error("authToken cannot be empty.");
  }

  const state = await getPoolState(env);
  const resolvedId = input.id?.trim() || buildFallbackAccountId(token);
  const nowIso = new Date().toISOString();

  const existingIdx = state.accounts.findIndex(
    (a) => a.authToken === token || (input.id && a.id === input.id)
  );

  let account: FreebuffAccount;
  if (existingIdx >= 0) {
    const prev = state.accounts[existingIdx];
    account = {
      ...prev,
      id: input.id?.trim() || prev.id || resolvedId,
      name: input.name?.trim() || prev.name,
      email: input.email?.trim() || prev.email,
      authToken: token,
      last_error: null,
      session: input.session !== undefined ? input.session : prev.session,
    };
    state.accounts[existingIdx] = account;
  } else {
    account = {
      id: resolvedId,
      name: input.name?.trim() || "Freebuff User",
      email: input.email?.trim() || undefined,
      authToken: token,
      added_at: nowIso,
      last_error: null,
      session: input.session ?? null,
    };
    state.accounts.push(account);
  }

  const saved = await savePoolState(env, state);
  return { state: saved, account };
}

/**
 * Remove a specific account by ID from the KV pool.
 */
export async function removeAccount(
  env: Env,
  accountId: string
): Promise<FreebuffPoolState> {
  const state = await getPoolState(env);
  state.accounts = state.accounts.filter((a) => a.id !== accountId);
  if (state.rr_index >= state.accounts.length) {
    state.rr_index = 0;
  }
  return savePoolState(env, state);
}

/**
 * Clear all accounts from the KV pool.
 */
export async function clearAllAccounts(env: Env): Promise<void> {
  await env.FREEBUFF_KV.delete(KV_POOL_KEY);
}

/**
 * Update session state and/or error status for a specific account in KV.
 */
export async function updateAccountState(
  env: Env,
  accountId: string,
  patch: {
    session?: FreebuffSessionState | null;
    last_error?: string | null;
    last_used_at?: string;
    agents_validated?: boolean;
  }
): Promise<void> {
  const state = await getPoolState(env);
  const idx = state.accounts.findIndex((a) => a.id === accountId);
  if (idx < 0) return;

  const current = state.accounts[idx];
  state.accounts[idx] = {
    ...current,
    ...(patch.session !== undefined ? { session: patch.session } : {}),
    ...(patch.last_error !== undefined ? { last_error: patch.last_error } : {}),
    ...(patch.last_used_at !== undefined
      ? { last_used_at: patch.last_used_at }
      : {}),
    ...(patch.agents_validated !== undefined
      ? { agents_validated: patch.agents_validated }
      : {}),
  };

  await savePoolState(env, state);
}

/**
 * Smart multi-account pool selector for a target `sessionModelId`:
 * 1. Prefer an account that already holds an active, fresh session for `sessionModelId`
 *    (avoids session teardown & waiting room delays).
 * 2. Next, prefer an idle account (no active session) via round-robin so we don't
 *    clobber another account's active session on a different model.
 * 3. Fallback to standard round-robin across all accounts.
 */
export async function selectAccountForModel(
  env: Env,
  sessionModelId: string,
  excludeAccountIds: Set<string> = new Set()
): Promise<FreebuffAccount> {
  const state = await getPoolState(env);
  const candidates = state.accounts.filter(
    (a) => a.authToken && !excludeAccountIds.has(a.id)
  );

  if (candidates.length === 0) {
    if (state.accounts.length === 0) {
      throw new Error(
        "No Freebuff accounts configured in FREEBUFF_KV. Visit /setup to connect your Freebuff account or paste an authToken."
      );
    }
    throw new Error(
      "All configured Freebuff accounts failed or are unavailable for this request."
    );
  }

  const total = state.accounts.length;
  const startIdx = total > 0 ? state.rr_index % total : 0;

  // Build round-robin ordered list of available candidates
  const ordered: FreebuffAccount[] = [];
  for (let offset = 0; offset < total; offset++) {
    const acct = state.accounts[(startIdx + offset) % total];
    if (acct && acct.authToken && !excludeAccountIds.has(acct.id)) {
      ordered.push(acct);
    }
  }

  // Tier 1: Account already has an active fresh session for the exact sessionModelId
  const matchingSessionAcct = ordered.find(
    (a) => isSessionFresh(a.session) && a.session?.model === sessionModelId
  );

  // Tier 2: Account has no active fresh session (idle)
  const idleAcct = ordered.find((a) => !isSessionFresh(a.session));

  // Tier 3: First available in round-robin
  const chosen = matchingSessionAcct || idleAcct || ordered[0];

  // Advance round-robin pointer and record last_used_at asynchronously
  const chosenOriginalIdx = state.accounts.findIndex((a) => a.id === chosen.id);
  state.rr_index = chosenOriginalIdx >= 0 ? (chosenOriginalIdx + 1) % total : 0;
  if (chosenOriginalIdx >= 0) {
    state.accounts[chosenOriginalIdx].last_used_at = new Date().toISOString();
  }
  await savePoolState(env, state).catch(() => {});

  return chosen;
}
