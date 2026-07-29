import type { AuthState } from '../types/auth.ts';
import { getAccountByEmail, loadCookiesFromProfile, saveCookies, setStartupStatus } from './auth.ts';
import { getLastLoginFailure, type LoginFailure, loginFresh } from './loginService.ts';
import { logStore } from './logStore.ts';
import { closeManualBrowserProfile, openBrowserProfile, pollManualBrowserProfile } from './playwright.ts';

export type LoginJobStatus = 'queued' | 'api_login' | 'browser_login' | 'captcha' | 'awaiting_manual' | 'authenticated' | 'failed';

export type LoginJobMode = 'auto' | 'manual';

export interface LoginJobFailure {
  stage: 'account' | 'api' | 'browser' | 'job';
  code: string;
  message: string;
  retryable: boolean;
}

export interface LoginJob {
  id: string;
  email: string;
  mode: LoginJobMode;
  status: LoginJobStatus;
  message: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  method?: 'api' | 'browser';
  manualUrl?: string;
  apiFailure?: LoginJobFailure;
  failure?: LoginJobFailure;
}

export interface LoginJobStartResult {
  job: LoginJob;
  reused: boolean;
}

interface LoginAccount {
  email: string;
  password: string;
  state: AuthState | null;
}

type BrowserLoginResult = 'success' | 'captcha' | 'browser_unavailable' | 'closed' | 'error';

interface LoginJobDependencies {
  now: () => number;
  createId: () => string;
  getAccount: (email: string) => LoginAccount | null;
  apiLogin: (email: string, password: string) => Promise<{ state: AuthState | null; failure: LoginFailure | null }>;
  browserLogin: (email: string, password: string, headless: boolean) => Promise<BrowserLoginResult>;
  pollManualBrowser: (email: string) => Promise<'success' | 'captcha' | 'closed'>;
  closeManualBrowser: (email: string) => Promise<void>;
  loadProfileState: (email: string) => Promise<AuthState | null>;
  saveState: (email: string, state: AuthState) => Promise<void>;
  setStartupStatus: (email: string, status: 'pending' | 'connecting' | 'ready') => void;
  sleep: (ms: number) => Promise<void>;
  manualUrl: () => string | undefined;
  log: (level: 'info' | 'warn' | 'error', message: string) => void;
}

interface LoginJobManagerOptions {
  jobTtlMs: number;
  terminalRetentionMs: number;
  manualPollIntervalMs: number;
  manualWaitMs: number;
  cleanupIntervalMs: number;
  startCleanupTimer: boolean;
}

interface InternalLoginJob extends LoginJob {
  terminalPromise: Promise<LoginJob>;
  resolveTerminal: (job: LoginJob) => void;
}

const TERMINAL_STATUSES = new Set<LoginJobStatus>(['authenticated', 'failed']);
const ACTIONABLE_STATUSES = new Set<LoginJobStatus>(['authenticated', 'failed', 'awaiting_manual']);

const DEFAULT_OPTIONS: LoginJobManagerOptions = {
  jobTtlMs: 15 * 60_000,
  terminalRetentionMs: 5 * 60_000,
  manualPollIntervalMs: 2_000,
  manualWaitMs: 10 * 60_000,
  cleanupIntervalMs: 60_000,
  startCleanupTimer: false,
};

function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}

function sanitizeMessage(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return message
    .replace(/\b(?:bearer\s+)?eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gi, '[redacted token]')
    .replace(/\b(password|token|refresh_token|authorization|cookie)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .slice(0, 500);
}

function apiFailureToJobFailure(failure: LoginFailure): LoginJobFailure {
  return {
    stage: 'api',
    code: `api_${failure.code}`,
    message: sanitizeMessage(failure.message),
    retryable: failure.retryable,
  };
}

function publicJob(job: InternalLoginJob): LoginJob {
  const { terminalPromise: _, resolveTerminal: __, ...safeJob } = job;
  return { ...safeJob };
}

export class LoginJobStartError extends Error {
  constructor(
    message: string,
    readonly code: 'account_not_found' | 'missing_password',
  ) {
    super(message);
  }
}

export class LoginJobManager {
  private readonly jobs = new Map<string, InternalLoginJob>();
  private readonly activeByEmail = new Map<string, string>();
  private readonly options: LoginJobManagerOptions;
  private apiQueue: Promise<void> = Promise.resolve();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly dependencies: LoginJobDependencies,
    options: Partial<LoginJobManagerOptions> = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    if (this.options.startCleanupTimer) {
      this.cleanupTimer = setInterval(() => this.cleanupExpiredJobs(), this.options.cleanupIntervalMs);
      this.cleanupTimer.unref?.();
    }
  }

  start(email: string, mode: LoginJobMode = 'auto'): LoginJobStartResult {
    this.cleanupExpiredJobs();
    const normalizedEmail = normalizeEmail(email);
    const account = this.dependencies.getAccount(normalizedEmail);
    if (!account) {
      throw new LoginJobStartError(`Account ${normalizedEmail} not found`, 'account_not_found');
    }
    if (!account.password) {
      throw new LoginJobStartError('No password stored for this account', 'missing_password');
    }

    const activeId = this.activeByEmail.get(normalizedEmail);
    const activeJob = activeId ? this.jobs.get(activeId) : undefined;
    if (activeJob && !TERMINAL_STATUSES.has(activeJob.status) && activeJob.expiresAt > this.dependencies.now()) {
      return { job: publicJob(activeJob), reused: true };
    }

    const now = this.dependencies.now();
    let resolveTerminal = (_job: LoginJob): void => {};
    const terminalPromise = new Promise<LoginJob>((resolve) => {
      resolveTerminal = resolve;
    });
    const job: InternalLoginJob = {
      id: this.dependencies.createId(),
      email: normalizedEmail,
      mode,
      status: 'queued',
      message: mode === 'manual' ? 'Manual browser login queued.' : 'Login queued.',
      createdAt: now,
      updatedAt: now,
      expiresAt: now + this.options.jobTtlMs,
      terminalPromise,
      resolveTerminal,
    };

    this.jobs.set(job.id, job);
    this.activeByEmail.set(normalizedEmail, job.id);
    this.safeSetStartupStatus(normalizedEmail, 'pending');
    queueMicrotask(() => {
      void this.run(job.id).catch((error) => {
        this.fail(job.id, {
          stage: 'job',
          code: 'internal_error',
          message: `Login task failed unexpectedly: ${sanitizeMessage(error)}`,
          retryable: true,
        });
      });
    });

    return { job: publicJob(job), reused: false };
  }

  get(jobId: string): LoginJob | null {
    this.cleanupExpiredJobs();
    const job = this.jobs.get(jobId);
    return job ? publicJob(job) : null;
  }

  getActiveForEmail(email: string): LoginJob | null {
    this.cleanupExpiredJobs();
    const jobId = this.activeByEmail.get(normalizeEmail(email));
    return jobId ? this.get(jobId) : null;
  }

  list(): LoginJob[] {
    this.cleanupExpiredJobs();
    return [...this.jobs.values()].map(publicJob).sort((left, right) => right.createdAt - left.createdAt);
  }

  async waitForTerminal(jobId: string): Promise<LoginJob | null> {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    if (TERMINAL_STATUSES.has(job.status)) return publicJob(job);
    return await job.terminalPromise;
  }

  cleanupExpiredJobs(): void {
    const now = this.dependencies.now();
    for (const [jobId, job] of this.jobs) {
      if (TERMINAL_STATUSES.has(job.status)) {
        if (now - job.updatedAt >= this.options.terminalRetentionMs) {
          this.jobs.delete(jobId);
          if (this.activeByEmail.get(job.email) === jobId) this.activeByEmail.delete(job.email);
        }
        continue;
      }
      if (now >= job.expiresAt) {
        this.fail(jobId, {
          stage: 'job',
          code: 'job_expired',
          message: 'Login task expired before authentication completed.',
          retryable: true,
        });
      }
    }
  }

  dispose(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
  }

  private async run(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;
    const account = this.dependencies.getAccount(job.email);
    if (!account?.password) {
      this.fail(jobId, {
        stage: 'account',
        code: account ? 'missing_password' : 'account_not_found',
        message: account ? 'No password stored for this account.' : `Account ${job.email} was removed before login started.`,
        retryable: false,
      });
      return;
    }

    this.safeSetStartupStatus(job.email, 'connecting');

    if (job.mode === 'auto') {
      this.update(jobId, { status: 'api_login', message: 'Trying Qwen API login.' });
      const apiResult = await this.runSerializedApiLogin(job.email, account.password);
      if (apiResult.state?.token) {
        await this.dependencies.saveState(job.email, apiResult.state);
        this.authenticate(jobId, 'api', 'Authenticated through the Qwen API.');
        return;
      }
      if (apiResult.failure) {
        this.update(jobId, { apiFailure: apiFailureToJobFailure(apiResult.failure) });
      }
    }

    await this.runBrowserLogin(jobId, account.password, job.mode === 'auto');
  }

  private async runSerializedApiLogin(email: string, password: string): Promise<{ state: AuthState | null; failure: LoginFailure | null }> {
    let release = (): void => {};
    const previous = this.apiQueue;
    this.apiQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.dependencies.apiLogin(email, password);
    } finally {
      release();
    }
  }

  private async runBrowserLogin(jobId: string, password: string, startHeadless: boolean): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job || TERMINAL_STATUSES.has(job.status)) return;
    const headlessLabel = startHeadless ? 'background' : 'interactive';
    this.update(jobId, { status: 'browser_login', message: `Starting ${headlessLabel} browser login.` });

    let result: BrowserLoginResult;
    try {
      result = await this.dependencies.browserLogin(job.email, password, startHeadless);
    } catch (error) {
      this.fail(jobId, {
        stage: 'browser',
        code: 'browser_launch_failed',
        message: `Browser failed to start: ${sanitizeMessage(error)}`,
        retryable: true,
      });
      return;
    }

    if (result === 'success') {
      await this.confirmBrowserAuthentication(jobId);
      return;
    }

    if (result === 'captcha') {
      this.update(jobId, {
        status: 'captcha',
        message: 'Qwen requires CAPTCHA verification.',
        manualUrl: this.dependencies.manualUrl(),
      });
      if (startHeadless) {
        this.update(jobId, {
          message: 'Opening an interactive browser for CAPTCHA completion.',
          manualUrl: this.dependencies.manualUrl(),
        });
        try {
          result = await this.dependencies.browserLogin(job.email, password, false);
        } catch (error) {
          this.fail(jobId, {
            stage: 'browser',
            code: 'browser_launch_failed',
            message: `Interactive browser failed to start: ${sanitizeMessage(error)}`,
            retryable: true,
          });
          return;
        }
        if (result === 'success') {
          await this.confirmBrowserAuthentication(jobId);
          return;
        }
      }

      if (result === 'captcha') {
        await this.waitForManualAuthentication(jobId);
        return;
      }
    }

    const failure =
      result === 'browser_unavailable'
        ? {
            stage: 'browser' as const,
            code: 'browser_unavailable',
            message: 'Browser runtime is unavailable, so browser login could not start.',
            retryable: true,
          }
        : result === 'closed'
          ? {
              stage: 'browser' as const,
              code: 'browser_closed',
              message: 'Browser login ended before an authenticated session was saved.',
              retryable: true,
            }
          : {
              stage: 'browser' as const,
              code: 'browser_launch_or_login_failed',
              message: 'Browser launch or automated login failed before a token was saved.',
              retryable: true,
            };
    this.fail(jobId, failure);
  }

  private async confirmBrowserAuthentication(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job || TERMINAL_STATUSES.has(job.status)) return;
    let state = this.dependencies.getAccount(job.email)?.state || null;
    if (!state?.token) state = await this.dependencies.loadProfileState(job.email);
    if (!state?.token) {
      this.fail(jobId, {
        stage: 'browser',
        code: 'browser_no_token',
        message: 'Browser reported success, but no authentication token was saved.',
        retryable: true,
      });
      return;
    }
    await this.dependencies.saveState(job.email, state);
    this.authenticate(jobId, 'browser', 'Authenticated through the browser profile.');
  }

  private async waitForManualAuthentication(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job || TERMINAL_STATUSES.has(job.status)) return;
    this.safeSetStartupStatus(job.email, 'pending');
    this.update(jobId, {
      status: 'awaiting_manual',
      message: this.dependencies.manualUrl()
        ? 'Complete login or CAPTCHA using the configured manual browser URL.'
        : 'Complete login or CAPTCHA in the interactive browser window on the service host.',
      manualUrl: this.dependencies.manualUrl(),
    });

    const deadline = Math.min(job.expiresAt, this.dependencies.now() + this.options.manualWaitMs);
    while (this.dependencies.now() < deadline) {
      const current = this.jobs.get(jobId);
      if (!current || TERMINAL_STATUSES.has(current.status)) return;
      const browserResult = await this.dependencies.pollManualBrowser(job.email);
      if (browserResult === 'success') {
        await this.confirmBrowserAuthentication(jobId);
        return;
      }
      if (browserResult === 'closed') {
        this.fail(jobId, {
          stage: 'browser',
          code: 'browser_closed',
          message: 'Interactive browser closed before authentication completed.',
          retryable: true,
        });
        return;
      }
      const state = this.dependencies.getAccount(job.email)?.state;
      if (state?.token) {
        this.authenticate(jobId, 'browser', 'Manual browser login completed.');
        return;
      }
      await this.dependencies.sleep(this.options.manualPollIntervalMs);
    }

    await this.closeManualBrowser(job.email);
    this.fail(jobId, {
      stage: 'browser',
      code: 'manual_timeout',
      message: 'Manual login was not completed before the task timed out.',
      retryable: true,
    });
  }

  private authenticate(jobId: string, method: 'api' | 'browser', message: string): void {
    const job = this.jobs.get(jobId);
    if (!job || TERMINAL_STATUSES.has(job.status)) return;
    this.safeSetStartupStatus(job.email, 'ready');
    void this.closeManualBrowser(job.email);
    this.update(jobId, { status: 'authenticated', method, message, failure: undefined });
    this.dependencies.log('info', `Login job ${job.id} authenticated ${job.email} via ${method}.`);
  }

  private fail(jobId: string, failure: LoginJobFailure): void {
    const job = this.jobs.get(jobId);
    if (!job || TERMINAL_STATUSES.has(job.status)) return;
    this.safeSetStartupStatus(job.email, 'pending');
    void this.closeManualBrowser(job.email);
    this.update(jobId, { status: 'failed', message: failure.message, failure });
    this.dependencies.log('warn', `Login job ${job.id} failed for ${job.email} [${failure.code}]: ${failure.message}`);
  }

  private update(jobId: string, patch: Partial<LoginJob>): void {
    const job = this.jobs.get(jobId);
    if (!job || TERMINAL_STATUSES.has(job.status)) return;
    Object.assign(job, patch, { updatedAt: this.dependencies.now() });
    if (TERMINAL_STATUSES.has(job.status)) {
      if (this.activeByEmail.get(job.email) === jobId) this.activeByEmail.delete(job.email);
      job.resolveTerminal(publicJob(job));
    }
  }

  private safeSetStartupStatus(email: string, status: 'pending' | 'connecting' | 'ready'): void {
    try {
      this.dependencies.setStartupStatus(email, status);
    } catch (error) {
      this.dependencies.log('warn', `Failed to set startup status for ${email}: ${sanitizeMessage(error)}`);
    }
  }

  private async closeManualBrowser(email: string): Promise<void> {
    try {
      await this.dependencies.closeManualBrowser(email);
    } catch (error) {
      this.dependencies.log('warn', `Failed to close manual browser for ${email}: ${sanitizeMessage(error)}`);
    }
  }
}

const defaultDependencies: LoginJobDependencies = {
  now: () => Date.now(),
  createId: () => crypto.randomUUID(),
  getAccount: (email) => getAccountByEmail(email),
  apiLogin: async (email, password) => {
    const state = await loginFresh(email, password);
    const getFailure = getLastLoginFailure as (failureEmail?: string) => LoginFailure | null;
    return { state, failure: state ? null : getFailure(email) };
  },
  browserLogin: (email, password, headless) => openBrowserProfile(email, password, { headless }),
  pollManualBrowser: (email) => pollManualBrowserProfile(email),
  closeManualBrowser: (email) => closeManualBrowserProfile(email),
  loadProfileState: (email) => loadCookiesFromProfile(email),
  saveState: (email, state) => saveCookies(email, state.token, state.refreshToken, state.expiresAt),
  setStartupStatus,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  manualUrl: () => {
    const value = process.env.BROWSER_MANUAL_URL?.trim();
    return value && /^https?:\/\//i.test(value) ? value : undefined;
  },
  log: (level, message) => logStore.log(level, 'auth', message),
};

export const loginJobManager = new LoginJobManager(defaultDependencies, { startCleanupTimer: true });

export function startLoginJob(email: string, mode: LoginJobMode = 'auto'): LoginJobStartResult {
  return loginJobManager.start(email, mode);
}

export function getLoginJob(jobId: string): LoginJob | null {
  return loginJobManager.get(jobId);
}

export function getActiveLoginJob(email: string): LoginJob | null {
  return loginJobManager.getActiveForEmail(email);
}

export function listLoginJobs(): LoginJob[] {
  return loginJobManager.list();
}

export async function waitForActionableLoginJob(jobId: string, timeoutMs: number = 120_000): Promise<LoginJob | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = loginJobManager.get(jobId);
    if (!job || ACTIONABLE_STATUSES.has(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return loginJobManager.get(jobId);
}
