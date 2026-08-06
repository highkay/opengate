/*
 * File: auth.ts
 * Shared authentication types used across auth.ts, accountManager.ts, and playwright.ts.
 * Extracted to break circular dependency chains.
 */

export interface AuthState {
  token: string;
  expiresAt: number;
  refreshToken: string | null;
}

export interface AccountEntry {
  email: string;
  password: string;
  state: AuthState | null;
  lastUsed: number;
  throttledUntil: number;
  refreshInFlight: Promise<boolean> | null;
  loginAttempt: number;
  inFlight: number;
  totalRequests: number;
  /** Full cookie string from browser profile (cna, ssxmod_itna, tfstk, isg, token, etc.) for WAF bypass */
  profileCookies?: string;
  /** Startup lifecycle — 'pending' (added), 'initializing' (boot in progress), 'ready' (fully initialized) */
  startupStatus?: 'pending' | 'initializing' | 'connecting' | 'ready';
  /** If true, account is excluded from request routing */
  disabled?: boolean;
  /**
   * Per-account sticky proxy URL.
   * Format: http://Default.{account}:password@host:port
   * When set, all traffic for this account routes through this proxy
   * (same exit IP for the session lifetime).
   */
  proxyUrl?: string;
  /**
   * Proxy health flag. When true, the current proxy is degraded/punished and
   * must be rebuilt (new session → new exit IP) before the next request.
   */
  proxyFailed?: boolean;
}
