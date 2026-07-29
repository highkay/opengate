import { describe, expect, test } from 'bun:test';
import type { AuthState } from '../types/auth.ts';
import { LoginJobManager } from './loginJobs.ts';

const TOKEN_STATE: AuthState = {
  token: 'test-token',
  refreshToken: 'test-refresh',
  expiresAt: 9_999_999,
};

function createHarness(overrides: Record<string, unknown> = {}) {
  let now = 1_000;
  let id = 0;
  const startupStatuses: string[] = [];
  const account = {
    email: 'user@example.com',
    password: 'secret-password',
    state: null as AuthState | null,
  };
  const calls = { api: 0, browser: [] as boolean[], manualPoll: 0, manualClose: 0 };
  const dependencies = {
    now: () => now,
    createId: () => `job-${++id}`,
    getAccount: (email: string) => (email === account.email ? account : null),
    apiLogin: async () => {
      calls.api += 1;
      return { state: TOKEN_STATE, failure: null };
    },
    browserLogin: async (_email: string, _password: string, headless: boolean) => {
      calls.browser.push(headless);
      return 'success' as const;
    },
    pollManualBrowser: async () => {
      calls.manualPoll += 1;
      return 'captcha' as const;
    },
    closeManualBrowser: async () => {
      calls.manualClose += 1;
    },
    loadProfileState: async () => account.state,
    saveState: async (_email: string, state: AuthState) => {
      account.state = state;
    },
    setStartupStatus: (_email: string, status: string) => startupStatuses.push(status),
    sleep: async (ms: number) => {
      now += ms;
    },
    manualUrl: () => 'https://manual.example.test/login',
    log: () => {},
    ...overrides,
  };
  const manager = new LoginJobManager(dependencies as any, {
    jobTtlMs: 1_000,
    terminalRetentionMs: 100,
    manualPollIntervalMs: 10,
    manualWaitMs: 100,
  });
  return {
    account,
    calls,
    manager,
    startupStatuses,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('LoginJobManager', () => {
  test('returns queued immediately and marks API authentication ready', async () => {
    const harness = createHarness();
    const started = harness.manager.start('USER@example.com');

    expect(started.reused).toBe(false);
    expect(started.job.status).toBe('queued');

    const completed = await harness.manager.waitForTerminal(started.job.id);
    expect(completed?.status).toBe('authenticated');
    expect(completed?.method).toBe('api');
    expect(harness.account.state?.token).toBe('test-token');
    expect(harness.startupStatuses).toEqual(['pending', 'connecting', 'ready']);
  });

  test('keeps API failure detail when browser launch or login fails', async () => {
    const harness = createHarness({
      apiLogin: async () => ({
        state: null,
        failure: { code: 'waf', message: 'token=secret blocked by WAF', retryable: true },
      }),
      browserLogin: async () => 'error' as const,
    });

    const started = harness.manager.start(harness.account.email);
    const completed = await harness.manager.waitForTerminal(started.job.id);

    expect(completed?.status).toBe('failed');
    expect(completed?.failure?.code).toBe('browser_launch_or_login_failed');
    expect(completed?.apiFailure?.code).toBe('api_waf');
    expect(completed?.apiFailure?.message).toContain('token=[redacted]');
    expect(JSON.stringify(completed)).not.toContain('secret-password');
  });

  test('classifies thrown browser startup errors separately', async () => {
    const harness = createHarness({
      apiLogin: async () => ({ state: null, failure: null }),
      browserLogin: async () => {
        throw new Error('spawn ENOENT password=do-not-leak');
      },
    });

    const started = harness.manager.start(harness.account.email);
    const completed = await harness.manager.waitForTerminal(started.job.id);

    expect(completed?.status).toBe('failed');
    expect(completed?.failure?.code).toBe('browser_launch_failed');
    expect(completed?.failure?.message).toContain('password=[redacted]');
    expect(completed?.failure?.message).not.toContain('do-not-leak');
  });

  test('classifies an unavailable browser runtime without false success', async () => {
    const harness = createHarness({
      apiLogin: async () => ({ state: null, failure: null }),
      browserLogin: async () => 'browser_unavailable' as const,
    });

    const started = harness.manager.start(harness.account.email);
    const completed = await harness.manager.waitForTerminal(started.job.id);

    expect(completed?.status).toBe('failed');
    expect(completed?.failure?.code).toBe('browser_unavailable');
  });

  test('reports CAPTCHA and completes when the manual browser yields a token', async () => {
    let browserCalls = 0;
    let manualPolls = 0;
    const harness = createHarness({
      apiLogin: async () => ({
        state: null,
        failure: { code: 'credentials', message: 'API login unavailable', retryable: false },
      }),
      browserLogin: async () => {
        browserCalls += 1;
        return 'captcha' as const;
      },
      pollManualBrowser: async () => {
        manualPolls += 1;
        if (manualPolls === 1) return 'captcha' as const;
        harness.account.state = TOKEN_STATE;
        return 'success' as const;
      },
    });

    const started = harness.manager.start(harness.account.email);
    const completed = await harness.manager.waitForTerminal(started.job.id);

    expect(browserCalls).toBe(2);
    expect(completed?.status).toBe('authenticated');
    expect(completed?.method).toBe('browser');
    expect(completed?.manualUrl).toBe('https://manual.example.test/login');
    expect(harness.startupStatuses).toContain('ready');
    expect(manualPolls).toBe(2);
    expect(harness.calls.manualClose).toBeGreaterThanOrEqual(1);
  });

  test('reuses one active task per normalized account', async () => {
    let resolveApi: ((value: { state: AuthState | null; failure: null }) => void) | undefined;
    const apiPromise = new Promise<{ state: AuthState | null; failure: null }>((resolve) => {
      resolveApi = resolve;
    });
    const harness = createHarness({ apiLogin: () => apiPromise });

    const first = harness.manager.start('user@example.com');
    const second = harness.manager.start('USER@EXAMPLE.COM');

    expect(second.reused).toBe(true);
    expect(second.job.id).toBe(first.job.id);
    resolveApi?.({ state: TOKEN_STATE, failure: null });
    await harness.manager.waitForTerminal(first.job.id);
  });

  test('expires stuck tasks and removes retained terminal jobs', async () => {
    const apiPromise = new Promise<{ state: AuthState | null; failure: null }>(() => {});
    const harness = createHarness({ apiLogin: () => apiPromise });
    const started = harness.manager.start(harness.account.email);

    await Promise.resolve();
    harness.advance(1_001);
    harness.manager.cleanupExpiredJobs();

    const expired = await harness.manager.waitForTerminal(started.job.id);
    expect(expired?.status).toBe('failed');
    expect(expired?.failure?.code).toBe('job_expired');

    harness.advance(101);
    harness.manager.cleanupExpiredJobs();
    expect(harness.manager.get(started.job.id)).toBeNull();
  });
});
