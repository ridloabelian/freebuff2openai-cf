import {
  CliLoginPollResult,
  CliLoginStartResponse,
  Env,
  FreebuffSessionState,
} from "../types";

const CLI_USER_AGENT = "Bun/1.3.11";

/**
 * Generate a cryptographically random hex string of `byteLength` bytes.
 */
export function randomHex(byteLength = 8): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Get the configured Freebuff Auth host (`https://freebuff.com` or `https://www.codebuff.com`).
 */
export function getAuthBaseUrl(env: Env, mode?: string): string {
  if (mode === "codebuff") {
    return (env.CODEBUFF_API_BASE_URL || "https://www.codebuff.com").replace(
      /\/+$/,
      ""
    );
  }
  return (env.FREEBUFF_AUTH_BASE_URL || "https://freebuff.com").replace(
    /\/+$/,
    ""
  );
}

/**
 * Get the configured Codebuff API base URL (`https://www.codebuff.com`).
 */
export function getCodebuffBaseUrl(env: Env): string {
  return (env.CODEBUFF_API_BASE_URL || "https://www.codebuff.com").replace(
    /\/+$/,
    ""
  );
}

/**
 * Step 1 of Freebuff CLI OAuth Flow:
 * Requests a login URL and fingerprintHash from `/api/auth/cli/code`.
 */
export async function startCliLogin(
  env: Env,
  mode: "freebuff" | "codebuff" = "freebuff"
): Promise<CliLoginStartResponse> {
  const authHost = getAuthBaseUrl(env, mode);
  const fingerprintId = `fb-${randomHex(8)}`;
  const url = `${authHost}/api/auth/cli/code`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": CLI_USER_AGENT,
    },
    body: JSON.stringify({ fingerprintId }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(
      `Failed to start Freebuff CLI login (HTTP ${response.status}): ${errText.slice(0, 300)}`
    );
  }

  const data = (await response.json()) as {
    loginUrl?: string;
    fingerprintHash?: string;
    expiresAt?: number;
  };

  if (!data.loginUrl || !data.fingerprintHash || !data.expiresAt) {
    throw new Error(
      `Invalid response from ${url}: missing loginUrl or fingerprintHash.`
    );
  }

  return {
    fingerprintId,
    fingerprintHash: data.fingerprintHash,
    loginUrl: data.loginUrl,
    expiresAt: data.expiresAt,
    authHost,
  };
}

/**
 * Step 2 of Freebuff CLI OAuth Flow:
 * Polls `/api/auth/cli/status` once to check if the user completed browser sign-in.
 */
export async function pollCliLoginStatus(
  env: Env,
  params: {
    fingerprintId: string;
    fingerprintHash: string;
    expiresAt: number | string;
    authHost?: string;
  }
): Promise<CliLoginPollResult> {
  const baseHost = (params.authHost || getAuthBaseUrl(env)).replace(/\/+$/, "");
  const qs = new URLSearchParams({
    fingerprintId: params.fingerprintId,
    fingerprintHash: params.fingerprintHash,
    expiresAt: String(params.expiresAt),
  });
  const url = `${baseHost}/api/auth/cli/status?${qs.toString()}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "User-Agent": CLI_USER_AGENT,
    },
  });

  if (response.status === 401) {
    return { status: "pending" };
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    return {
      status: "error",
      error: `Auth poll returned HTTP ${response.status}: ${errText.slice(0, 200)}`,
    };
  }

  const data = (await response.json()) as {
    user?: {
      id?: string;
      name?: string;
      email?: string;
      authToken?: string;
    };
  };

  if (data.user && data.user.authToken) {
    return {
      status: "completed",
      user: {
        id: data.user.id || `user_${randomHex(6)}`,
        name: data.user.name,
        email: data.user.email,
        authToken: data.user.authToken,
      },
    };
  }

  return { status: "pending" };
}

/**
 * Verify an `authToken` against `https://www.codebuff.com/api/v1/freebuff/session`
 * and inspect any existing session state on the account.
 */
export async function verifyTokenAndGetProfile(
  env: Env,
  authToken: string
): Promise<{
  valid: boolean;
  error?: string;
  session?: FreebuffSessionState | null;
  rawSessionData?: Record<string, unknown>;
}> {
  const token = authToken.trim();
  if (!token) {
    return { valid: false, error: "Empty token" };
  }

  const baseUrl = getCodebuffBaseUrl(env);
  const url = `${baseUrl}/api/v1/freebuff/session`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "*/*",
        "User-Agent": CLI_USER_AGENT,
      },
    });

    if (response.status === 401 || response.status === 403) {
      const text = await response.text().catch(() => "");
      return {
        valid: false,
        error: `Token rejected (HTTP ${response.status}): ${text.slice(0, 200)}`,
      };
    }

    let rawData: Record<string, unknown> = {};
    try {
      rawData = (await response.json()) as Record<string, unknown>;
    } catch {
      // Non-JSON response is still considered valid if not 401/403
    }

    let session: FreebuffSessionState | null = null;
    if (
      rawData &&
      typeof rawData.status === "string" &&
      typeof rawData.instanceId === "string" &&
      rawData.instanceId
    ) {
      session = {
        instanceId: rawData.instanceId,
        model:
          typeof rawData.model === "string"
            ? rawData.model
            : env.DEFAULT_MODEL || "deepseek/deepseek-v4-flash",
        status: rawData.status,
        expiresAt:
          typeof rawData.expiresAt === "string" ? rawData.expiresAt : undefined,
        remainingMs:
          typeof rawData.remainingMs === "number"
            ? rawData.remainingMs
            : undefined,
        updatedAt: Date.now(),
      };
    }

    return {
      valid: true,
      session,
      rawSessionData: rawData,
    };
  } catch (err) {
    return {
      valid: false,
      error:
        err instanceof Error ? err.message : "Network error verifying token",
    };
  }
}
