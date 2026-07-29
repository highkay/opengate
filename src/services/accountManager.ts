/*
 * File: accountManager.ts
 * Account management extracted from auth.ts.
 * Handles account CRUD, discovery, persistence, and the account file watcher.
 */
import crypto from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, watch, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import type { AccountEntry, AuthState } from '../types/auth.ts';
import { projectPath } from '../utils/paths.ts';
import { config } from './configService.ts';
import { getLastLoginFailure, loginFresh } from './loginService.ts';
import { logStore } from './logStore.ts';
import { configureAccount } from './qwenModels.ts';

/** In-memory account registry. Mutations must stay synchronous. */
export const accounts: AccountEntry[] = [];

const OLD_ACCOUNTS_FILE = projectPath('qwen_profile', 'accounts.json');

function getQwenDir(): string {
  return process.env.QWEN_DATA_DIR ? path.resolve(process.env.QWEN_DATA_DIR) : projectPath('.qwen');
}

function getAccountsFile(): string {
  return path.join(getQwenDir(), 'accounts.json');
}

function getFallbackAccountsFile(): string {
  return path.join(getQwenDir(), 'accounts.jsonc');
}

function getProfileDirForEmail(email: string): string {
  const safe = email
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]/g, '_');
  return projectPath('.qwen', 'browser-profiles', safe);
}

export function migrateFromOldPaths(): void {
  try {
    const accountsFile = getAccountsFile();
    const fallbackAccountsFile = getFallbackAccountsFile();
    if (!existsSync(OLD_ACCOUNTS_FILE)) return;
    if (existsSync(accountsFile) || existsSync(fallbackAccountsFile)) return;

    logStore.log('info', 'auth', 'Migrating data from qwen_profile/ to .qwen/ ...');

    const newDir = path.dirname(accountsFile);
    if (!existsSync(newDir)) {
      mkdirSync(newDir, { recursive: true });
    }

    const accountsData = readFileSync(OLD_ACCOUNTS_FILE, 'utf-8');
    writeFileSync(accountsFile, accountsData, 'utf-8');
    logStore.log('info', 'auth', 'Migrated accounts.json from qwen_profile/ to .qwen/');
    logStore.log('info', 'auth', 'Note: old token files are ignored — tokens are now read from browser profiles.');
    logStore.log('info', 'auth', 'Migration complete. Old files preserved.');
  } catch (err: any) {
    logStore.log('error', 'auth', `Migration error: ${err.message}`);
  }
}

export interface CookieData {
  email: string;
  token: string;
  refreshToken: string | null;
  savedAt: number;
  expiresAt: number;
}
/** Strip // and /* * / JSONC comments before JSON.parse */
function stripJsoncComments(text: string): string {
  return text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

interface PersistedAccountData {
  email: string;
  password?: string;
  token?: string;
  refreshToken?: string | null;
  refresh_token?: string | null;
  expiresAt?: number;
  expires_at?: number;
  cookies?: string;
  profileCookies?: string;
  throttledUntil?: number;
  disabled?: boolean;
}
export interface LoadedAccountData {
  email: string;
  password: string;
  throttledUntil?: number;
  disabled?: boolean;
  token?: string;
  refreshToken?: string | null;
  expiresAt?: number;
  profileCookies?: string;
}
export function parseAccountsFromEnv(): Array<{ email: string; password: string }> {
  const result: Array<{ email: string; password: string }> = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^ACCOUNT\d+$/i.test(key) || !value) continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx <= 0) continue;
    const email = trimmed.substring(0, colonIdx).trim();
    const password = trimmed.substring(colonIdx + 1).trim();
    if (email && password) {
      result.push({ email, password });
    }
  }
  return result;
}
export function discoverSavedAccounts(): Array<{ email: string; password: string }> {
  return parseAccountsFromEnv();
}

/**
 * Decode a JWT token and return its payload, or null if invalid.
 */
export function decodeJwt(token: string): Record<string, any> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(base64, 'base64').toString('utf-8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}
/* ── AES-256-GCM password encryption ── */
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;

function getMasterKeyFile(): string {
  return path.join(getQwenDir(), 'master.key');
}

function getEncryptionKey(): string {
  const masterKeyFile = getMasterKeyFile();
  // 1. If a master key file exists, use it (survives API_KEY changes)
  try {
    if (existsSync(masterKeyFile)) {
      return readFileSync(masterKeyFile, 'utf-8').trim();
    }
  } catch {
    // Fall through to other strategies
  }

  // 2. Persist the current API_KEY as the stable master key for backward compatibility.
  // Existing encrypted passwords were derived from API_KEY, so the first master.key
  // must use the same material before API_KEY can be rotated safely.
  const apiKey = config.get('API_KEY');
  const keyMaterial = apiKey || crypto.randomBytes(32).toString('hex');
  try {
    const dir = path.dirname(masterKeyFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(masterKeyFile, keyMaterial, { encoding: 'utf-8', mode: 0o600 });
    return keyMaterial;
  } catch {
    // 3. Preserve compatibility when the key directory is temporarily unwritable.
    if (apiKey) return apiKey;

    // 4. Last resort for installations without API_KEY and writable persistence.
    const machineId = `${os.hostname()}-${projectPath('.')}`;
    return crypto.createHash('sha256').update(machineId).digest('hex');
  }
}

function deriveKey(keyMaterial: string): Buffer {
  return crypto.scryptSync(keyMaterial, 'qwen-gate-salt', 32);
}

export function encrypt(plaintext: string): string {
  const key = deriveKey(getEncryptionKey());
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
}

export function decrypt(encryptedText: string): string {
  const parts = encryptedText.split(':');
  if (parts.length !== 3) return encryptedText;
  const [ivHex, authTagHex, encrypted] = parts;
  try {
    const key = deriveKey(getEncryptionKey());
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    logStore.log('error', 'auth', 'Decryption failed — wrong API_KEY or corrupted data');
    return '';
  }
}

// Backward-compatible aliases for existing callers
function encryptPassword(password: string): string {
  return encrypt(password);
}

function decryptPassword(encryptedText: string): string {
  if (!isEncryptedPassword(encryptedText)) return encryptedText;
  return decrypt(encryptedText);
}

function isEncryptedPassword(value: string): boolean {
  const parts = value.split(':');
  return parts.length === 3 && /^[0-9a-f]{32}$/i.test(parts[0]) && /^[0-9a-f]{32}$/i.test(parts[1]) && /^[0-9a-f]*$/i.test(parts[2]);
}

function writeAccountsAtomically(filePath: string, data: PersistedAccountData[]): void {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tempFile = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    writeFileSync(tempFile, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
    renameSync(tempFile, filePath);
  } catch (err) {
    try {
      rmSync(tempFile, { force: true });
    } catch {
      // non-blocking cleanup
    }
    throw err;
  }
}

// O(1) email→account lookup index (synced with accounts array mutations)
const emailIndex = new Map<string, AccountEntry>();

export function rebuildEmailIndex(): void {
  emailIndex.clear();
  for (const acct of accounts) {
    emailIndex.set(acct.email.toLowerCase().trim(), acct);
  }
}

export function saveAccountsToFile(accounts: readonly AccountEntry[]): void {
  // Tests mutate the in-memory registry; never persist mock accounts to disk.
  if (process.env.TEST_MOCK_PLAYWRIGHT && !process.env.QWEN_DATA_DIR) return;

  const data: PersistedAccountData[] = accounts
    .filter((a) => a.password || a.state?.token)
    .map((a) => ({
      email: a.email,
      ...(a.password ? { password: encryptPassword(a.password) } : {}),
      ...(a.state?.token
        ? {
            token: a.state.token,
            refreshToken: a.state.refreshToken,
            expiresAt: a.state.expiresAt,
          }
        : {}),
      ...(a.profileCookies ? { profileCookies: a.profileCookies } : {}),
      ...(a.throttledUntil > Date.now() ? { throttledUntil: a.throttledUntil } : {}),
      ...(a.disabled !== undefined ? { disabled: a.disabled } : {}),
    }));
  writeAccountsAtomically(getAccountsFile(), data);
}
function tokenExpiresAt(account: PersistedAccountData): number | undefined {
  if (typeof account.expiresAt === 'number') return account.expiresAt;
  if (typeof account.expires_at === 'number') return account.expires_at;
  if (!account.token) return undefined;
  const payload = decodeJwt(account.token);
  if (typeof payload?.exp === 'number') return payload.exp * 1000;
  return Date.now() + config.getInt('AUTH_TOKEN_MAX_AGE_MS', 28800000);
}
export function loadAccountsFromFile(): LoadedAccountData[] {
  const tryLoad = (filePath: string): LoadedAccountData[] | null => {
    try {
      if (!existsSync(filePath)) return null;
      const raw = readFileSync(filePath, 'utf-8');
      const data: PersistedAccountData[] = JSON.parse(stripJsoncComments(raw));
      const needsPasswordMigration = data.some((account) => account.password && !isEncryptedPassword(account.password));
      const loaded = data
        .filter((d) => d.email && (d.password || d.token))
        .map((d) => ({
          email: d.email,
          password: d.password ? decryptPassword(d.password) : '',
          throttledUntil: d.throttledUntil,
          disabled: d.disabled ?? false,
          token: d.token,
          refreshToken: d.refreshToken ?? d.refresh_token ?? null,
          expiresAt: tokenExpiresAt(d),
          profileCookies: d.profileCookies || d.cookies,
        }));
      if (needsPasswordMigration) {
        const migrated = data.map((account) => ({
          ...account,
          ...(account.password && !isEncryptedPassword(account.password) ? { password: encryptPassword(account.password) } : {}),
        }));
        writeAccountsAtomically(filePath, migrated);
        logStore.log('info', 'auth', `Migrated plaintext passwords in ${path.basename(filePath)} to AES-256-GCM`);
      }
      return loaded;
    } catch (err: any) {
      logStore.log('error', 'auth', `Failed to load ${filePath}: ${err.message}`);
      return null;
    }
  };

  return tryLoad(getAccountsFile()) ?? tryLoad(getFallbackAccountsFile()) ?? [];
}
export async function addAccount(email: string, password: string): Promise<{ loginSucceeded: boolean; loginError?: string }> {
  const normalizedEmail = email.toLowerCase().trim();
  const existing = accounts.find((a) => a.email.toLowerCase().trim() === normalizedEmail);
  if (existing) {
    throw new Error(`Account with email ${normalizedEmail} already exists`);
  }
  const entry: AccountEntry = {
    email: normalizedEmail,
    password,
    state: null,
    lastUsed: 0,
    throttledUntil: 0,
    refreshInFlight: null,
    loginAttempt: 0,
    inFlight: 0,
    totalRequests: 0,
    disabled: false,
    startupStatus: 'pending',
  };
  accounts.push(entry);
  rebuildEmailIndex();
  saveAccountsToFile(accounts);

  // Step 1: API login first (browserlessFetch / wreq — same stack as chat).
  // Browser profile is CAPTCHA/manual fallback only; cloakbrowser often fails on Alpine.
  entry.startupStatus = 'connecting';
  let newState: AuthState | null;
  try {
    newState = await loginFresh(normalizedEmail, password);
  } catch (err) {
    entry.startupStatus = 'pending';
    throw err;
  }
  if (newState) {
    const { saveCookies } = await import('./auth.ts');
    await saveCookies(normalizedEmail, newState.token, newState.refreshToken, newState.expiresAt);
    await configureAccount(normalizedEmail).catch((err) =>
      logStore.log('error', 'account', `Failed to configure ${normalizedEmail}: ${err.message}`),
    );
    return { loginSucceeded: true };
  }

  const apiFailure = getLastLoginFailure(normalizedEmail);
  logStore.log(
    'warn',
    'account',
    `API login failed for ${normalizedEmail}${apiFailure ? ` [${apiFailure.code}]` : ''} — trying browser profile...`,
  );

  // Step 2: Browser profile fallback (headless, then headed on CAPTCHA)
  const { openBrowserProfile } = await import('./browserProfiles.ts');
  let profileResult = await openBrowserProfile(normalizedEmail, password, { headless: true });
  if (profileResult === 'captcha') {
    logStore.log('info', 'account', `Captcha for ${normalizedEmail} — opening headed browser...`);
    profileResult = await openBrowserProfile(normalizedEmail, password, { headless: false });
  }

  if (profileResult === 'success') {
    const { loadCookiesFromProfile } = await import('./auth.ts');
    const profileState = await loadCookiesFromProfile(normalizedEmail);
    if (profileState) {
      entry.state = profileState;
      await configureAccount(normalizedEmail).catch((err) =>
        logStore.log('error', 'account', `Failed to configure ${normalizedEmail}: ${err.message}`),
      );
      return { loginSucceeded: true };
    }
  }

  entry.startupStatus = 'pending';

  const parts: string[] = [`Login failed for ${normalizedEmail}`];
  if (apiFailure) {
    parts.push(`API: [${apiFailure.code}] ${apiFailure.message}`);
  } else {
    parts.push('API: no token');
  }
  if (profileResult === 'captcha') {
    parts.push('Browser: CAPTCHA required — use dashboard Autofill to complete manually');
  } else if (profileResult === 'error' || profileResult === 'closed') {
    parts.push('Browser: launch/login failed (often Alpine + cloakbrowser glibc Chromium mismatch — check system logs for ENOENT)');
  } else {
    parts.push(`Browser: ${profileResult}`);
  }
  const msg = parts.join('. ');
  logStore.log('warn', 'auth', msg);
  return { loginSucceeded: false, loginError: msg };
}
export async function removeAccount(email: string): Promise<void> {
  const normalizedEmail = email.toLowerCase().trim();
  const index = accounts.findIndex((a) => a.email.toLowerCase().trim() === normalizedEmail);
  if (index === -1) {
    throw new Error(`Account with email ${normalizedEmail} not found`);
  }
  accounts.splice(index, 1);
  rebuildEmailIndex();
  saveAccountsToFile(accounts);
  const { removeAccountContext } = await import('./playwright.ts');
  removeAccountContext(normalizedEmail);
  const profileDir = getProfileDirForEmail(normalizedEmail);
  if (existsSync(profileDir)) {
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch (err: any) {
      logStore.log('error', 'auth', `Failed to delete Chromium profile for ${normalizedEmail}: ${err.message}`);
    }
  }
}
/**
 * Re-scan accounts and merge changes into the live accounts array.
 */
export async function reloadAccounts(): Promise<void> {
  if (accountWatcher && !watcherReady) {
    return;
  }
  const persisted = loadAccountsFromFile();
  const discovered = discoverSavedAccounts();
  const persistedEmails = new Set(persisted.map((account) => account.email.toLowerCase().trim()));
  const desiredByEmail = new Map<string, LoadedAccountData>();
  for (const account of discovered) {
    const email = account.email.toLowerCase().trim();
    desiredByEmail.set(email, { email, password: account.password });
  }
  for (const account of persisted) {
    const email = account.email.toLowerCase().trim();
    const existing = desiredByEmail.get(email);
    desiredByEmail.set(email, {
      ...account,
      email,
      password: existing?.password || account.password,
    });
  }
  const desiredEmails = new Set(desiredByEmail.keys());
  const existingEmails = new Set(accounts.map((a) => a.email.toLowerCase().trim()));
  let added = 0;
  let removed = 0;
  for (const [email, desired] of desiredByEmail) {
    if (!existingEmails.has(email)) {
      const entry: AccountEntry = {
        email,
        password: desired.password,
        state: desired.token
          ? {
              token: desired.token,
              expiresAt: desired.expiresAt || Date.now() + config.getInt('AUTH_TOKEN_MAX_AGE_MS', 28800000),
              refreshToken: desired.refreshToken ?? null,
            }
          : null,
        lastUsed: 0,
        throttledUntil: desired.throttledUntil && desired.throttledUntil > Date.now() ? desired.throttledUntil : 0,
        refreshInFlight: null,
        loginAttempt: 0,
        inFlight: 0,
        totalRequests: 0,
        profileCookies: desired.profileCookies,
        disabled: desired.disabled ?? false,
        startupStatus: desired.token && (desired.expiresAt || 0) > Date.now() ? 'ready' : 'pending',
      };
      accounts.push(entry);
      added++;
      continue;
    }

    const existing = accounts.find((account) => account.email.toLowerCase().trim() === email);
    if (!existing) continue;
    existing.password = desired.password;
    existing.disabled = desired.disabled ?? false;
    existing.profileCookies = desired.profileCookies;
    existing.throttledUntil = desired.throttledUntil && desired.throttledUntil > Date.now() ? desired.throttledUntil : 0;
    if (desired.token) {
      existing.state = {
        token: desired.token,
        expiresAt: desired.expiresAt || Date.now() + config.getInt('AUTH_TOKEN_MAX_AGE_MS', 28800000),
        refreshToken: desired.refreshToken ?? null,
      };
      existing.startupStatus = existing.state.expiresAt > Date.now() ? 'ready' : 'pending';
    } else if (persistedEmails.has(email)) {
      existing.state = null;
      existing.startupStatus = 'pending';
    }
  }
  for (let i = accounts.length - 1; i >= 0; i--) {
    const acct = accounts[i];
    if (!desiredEmails.has(acct.email.toLowerCase().trim())) {
      const profileDir = getProfileDirForEmail(acct.email);
      if (existsSync(profileDir)) {
        continue;
      }
      if (acct.inFlight > 0) {
        continue;
      }
      accounts.splice(i, 1);
      removed++;
    }
  }
  if (added > 0 || removed > 0) rebuildEmailIndex();
}
let accountWatcher: any = null;
let reloadDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let watcherReady = false;
let watcherRetryTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * Set up fs.watch on .qwen/ directory with 500ms debounce to detect accounts.json changes.
 */
export function setupAccountWatcher(): void {
  if (accountWatcher) return;
  const qwenDir = getQwenDir();
  if (!existsSync(qwenDir)) {
    mkdirSync(qwenDir, { recursive: true });
  }
  try {
    accountWatcher = watch(qwenDir, (_eventType: string, filename: string | null) => {
      if (!filename || filename !== 'accounts.json') return;
      if (reloadDebounceTimer) clearTimeout(reloadDebounceTimer);
      reloadDebounceTimer = setTimeout(() => {
        reloadDebounceTimer = null;
        reloadAccounts().catch((err) => {
          logStore.log('error', 'auth', `Hot-reload failed: ${err.message}`);
        });
      }, 500);
    });
    accountWatcher.on('error', (err: any) => {
      logStore.log('error', 'auth', `Account watcher error: ${err.message}`);
      try {
        accountWatcher?.close();
      } catch {
        // non-blocking: watcher may already be closed
      }
      accountWatcher = null;
      watcherReady = false;
      if (watcherRetryTimer) clearTimeout(watcherRetryTimer);
      watcherRetryTimer = setTimeout(() => {
        watcherRetryTimer = null;
        setupAccountWatcher();
      }, 10000);
      watcherRetryTimer.unref();
    });
    setTimeout(() => {
      watcherReady = true;
    }, 2000);
  } catch (err: any) {
    logStore.log('error', 'auth', `Failed to set up account watcher: ${err.message}`);
  }
}
/**
 * Enable hot-reload by starting the account file watcher.
 */
export function enableHotReload(): void {
  setupAccountWatcher();
}
export function resetWatcherState(): void {
  watcherReady = false;
  if (watcherRetryTimer) {
    clearTimeout(watcherRetryTimer);
    watcherRetryTimer = null;
  }
}
export function isAvailable(acct: AccountEntry): boolean {
  if (acct.disabled) return false;
  if (!acct.state) return false;
  if (acct.state.expiresAt <= Date.now()) return false;
  if (acct.throttledUntil > Date.now()) return false;
  return true;
}
export async function pickAccount(excludeEmail?: string): Promise<AccountEntry | null> {
  // No lock needed — all operations are synchronous and fast.
  // Worst case for concurrent access: slightly imbalanced inFlight count,
  // which is acceptable for load-balancing purposes.
  try {
    let available = accounts.filter((account) => !account.disabled && account.state && account.throttledUntil <= Date.now());
    if (excludeEmail) {
      available = available.filter((a) => a.email !== excludeEmail);
    }
    if (available.length === 0) {
      // All accounts are throttled or unauthenticated — return null instead
      // of falling back to a throttled account (which would guaranteed fail).
      // The caller should return a proper "all accounts exhausted" error.
      if (accounts.length === 0) {
        return null;
      }
      const throttled = accounts.filter((a) => a.throttledUntil > Date.now()).length;
      const noState = accounts.filter((a) => !a.state).length;
      logStore.log('warn', 'auth', `All ${accounts.length} accounts exhausted — ${throttled} throttled, ${noState} unauthenticated`);
      return null;
    }
    const pool = available.filter((a) => a.inFlight === 0);
    const candidates = [...(pool.length > 0 ? pool : available)].sort(
      (a, b) => a.inFlight - b.inFlight || a.totalRequests - b.totalRequests || (a.lastUsed || 0) - (b.lastUsed || 0),
    );
    const { ensureAccountFresh } = await import('./tokenRefresh.ts');
    let picked: AccountEntry | null = null;
    for (const candidate of candidates) {
      if ((await ensureAccountFresh(candidate)) && isAvailable(candidate)) {
        picked = candidate;
        break;
      }
    }
    if (!picked) return null;
    logStore.log(
      'debug',
      'auth',
      `[Account] Picked ${picked.email} — inFlight=${picked.inFlight} totalReqs=${picked.totalRequests} lastUsed=${picked.lastUsed ? Date.now() - picked.lastUsed + 'ms ago' : 'never'}${excludeEmail ? ` (excluded: ${excludeEmail})` : ''}`,
    );
    picked.lastUsed = Date.now();
    picked.inFlight++;
    // Safety valve: reset if counter drifts unreasonably high
    if (picked.inFlight > 20) picked.inFlight = 0;
    return picked;
  } catch (err: any) {
    logStore.log('error', 'auth', 'pickAccount error:', err);
    return null;
  }
}
export function incrementInFlight(email: string): void {
  const acct = getAccountByEmail(email);
  if (acct) acct.inFlight++;
}
export function decrementInFlight(email: string): void {
  const acct = getAccountByEmail(email);
  if (acct && acct.inFlight > 0) acct.inFlight--;
}
export function incrementTotalRequests(email: string): void {
  const acct = getAccountByEmail(email);
  if (acct) acct.totalRequests++;
}
export function hasInFlight(email: string): boolean {
  const acct = getAccountByEmail(email);
  return acct ? acct.inFlight > 0 : false;
}
export function getAccountByEmail(email: string): AccountEntry | null {
  return emailIndex.get(email.toLowerCase().trim()) || null;
}
export function setAccountDisabled(email: string, disabled: boolean): void {
  const acct = getAccountByEmail(email);
  if (!acct) throw new Error(`Account not found: ${email}`);
  acct.disabled = disabled;
  saveAccountsToFile(accounts);
}
export function throttleAccount(email: string, durationMs?: number): void {
  const acct = getAccountByEmail(email);
  if (!acct) return;
  const cooldown = durationMs || config.getInt('RATE_LIMIT_COOLDOWN_MS', 120000);
  acct.throttledUntil = Date.now() + cooldown;
  const unlockTime = new Date(acct.throttledUntil).toISOString();
  const hours = Math.ceil(cooldown / 3600000);
  logStore.log('warn', 'auth', `Throttled ${email} — unlocks at ${unlockTime} (${hours}h)`);
  // Persist so restart respects the cooldown
  saveAccountsToFile(accounts);
}
export function isAccountThrottled(email: string): boolean {
  const acct = getAccountByEmail(email);
  if (!acct) return true;
  return acct.throttledUntil > Date.now();
}
export function getAccountStats(): Array<{
  email: string;
  authenticated: boolean;
  throttled: boolean;
  disabled: boolean;
  throttledRemainingMs: number;
  throttledUnlockAt: string | null;
  tokenExpiresInMs: number;
  lastUsedAgoMs: number;
  inFlight: number;
  totalRequests: number;
}> {
  const now = Date.now();
  return accounts.map((a) => ({
    email: a.email,
    authenticated: Boolean(a.state && a.state.expiresAt > now),
    throttled: a.throttledUntil > now,
    disabled: a.disabled ?? false,
    throttledRemainingMs: Math.max(0, a.throttledUntil - now),
    throttledUnlockAt: a.throttledUntil > now ? new Date(a.throttledUntil).toISOString() : null,
    tokenExpiresInMs: a.state ? Math.max(0, a.state.expiresAt - now) : 0,
    lastUsedAgoMs: a.lastUsed ? now - a.lastUsed : -1,
    inFlight: a.inFlight,
    totalRequests: a.totalRequests,
  }));
}
export function getAccountCount(): number {
  return accounts.length;
}
export function getAvailableCount(): number {
  return accounts.filter(isAvailable).length;
}
export function getAllAccountEmails(): string[] {
  return accounts.map((a) => a.email);
}
export function getAccounts(): readonly AccountEntry[] {
  return [...accounts];
}
export async function getToken(): Promise<string | null> {
  const acct = await pickAccount();
  if (acct) {
    decrementInFlight(acct.email);
    return acct.state?.token || null;
  }
  return null;
}
export async function getTokenWithAccount(email?: string): Promise<{ token: string; email: string } | null> {
  let acct: AccountEntry | null;
  let picked = false;
  if (email) {
    acct = getAccountByEmail(email);
    if (acct && !isAvailable(acct) && acct.state) {
      // Account exists but throttled — still return it
    }
  } else {
    acct = await pickAccount();
    picked = true;
  }
  if (acct && !picked) {
    const { ensureAccountFresh } = await import('./tokenRefresh.ts');
    if (!(await ensureAccountFresh(acct))) {
      if (picked) decrementInFlight(acct.email);
      return null;
    }
  }
  if (!acct?.state?.token || acct.state.expiresAt <= Date.now()) {
    if (picked && acct) decrementInFlight(acct.email);
    return null;
  }
  acct.lastUsed = Date.now();
  if (picked) decrementInFlight(acct.email);
  return { token: acct.state.token, email: acct.email };
}
