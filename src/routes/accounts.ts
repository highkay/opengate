import { Hono } from 'hono';
import { addAccount, getAccountByEmail, getAccounts, removeAccount, setAccountDisabled } from '../services/auth.ts';
import {
  getActiveLoginJob,
  getLoginJob,
  type LoginJob,
  LoginJobStartError,
  listLoginJobs,
  startLoginJob,
  waitForActionableLoginJob,
} from '../services/loginJobs.ts';

const accountActionRateLimit = new Map<string, number[]>();

function checkRateLimit(key: string, maxPerMinute: number = 10): boolean {
  const now = Date.now();
  const window = 60_000;
  const timestamps = (accountActionRateLimit.get(key) || []).filter((t) => now - t < window);
  if (timestamps.length >= maxPerMinute) return false;
  timestamps.push(now);
  accountActionRateLimit.set(key, timestamps);
  return true;
}

export const accountsRouter = new Hono();

function loginJobPayload(job: LoginJob, reused: boolean = false) {
  return {
    success: true,
    email: job.email,
    jobId: job.id,
    status: job.status,
    authenticated: job.status === 'authenticated',
    reused,
    job,
  };
}

function loginStartErrorResponse(c: any, error: unknown) {
  if (error instanceof LoginJobStartError) {
    const status = error.code === 'account_not_found' ? 404 : 400;
    return c.json({ error: { code: error.code, message: error.message } }, status);
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error('[Accounts] Login job start failed:', message);
  return c.json({ error: { code: 'login_job_start_failed', message: 'Failed to start login task' } }, 500);
}

accountsRouter.get('/', (c) => {
  const accounts = getAccounts();
  const masked = accounts.map((a) => ({
    email: a.email,
    passwordMasked: a.password ? '••••••••' : '',
    authenticated: a.state !== null && a.state.token !== '' && a.state.expiresAt > Date.now(),
    tokenExpiresAt: a.state?.expiresAt || null,
    throttled: a.throttledUntil > Date.now(),
    throttledUntil: a.throttledUntil > Date.now() ? a.throttledUntil : null,
    throttledUnlockAt: a.throttledUntil > Date.now() ? new Date(a.throttledUntil).toISOString() : null,
    inFlight: a.inFlight,
    totalRequests: a.totalRequests,
    startupStatus: a.startupStatus || null,
    loginJob: getActiveLoginJob(a.email),
  }));
  return c.json({ count: masked.length, accounts: masked });
});

accountsRouter.get('/login-jobs', (c) => {
  return c.json({ jobs: listLoginJobs() });
});

accountsRouter.post('/', async (c) => {
  try {
    if (!checkRateLimit('accounts')) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }
    const body = await c.req.json();
    const { email, password } = body;

    if (!email || !password) {
      return c.json({ error: { message: 'email and password are required' } }, 400);
    }

    if (typeof email !== 'string' || typeof password !== 'string') {
      return c.json({ error: { message: 'email and password must be strings' } }, 400);
    }

    const result = await addAccount(email, password);

    return c.json(
      { success: true, email: email.toLowerCase().trim(), loginSucceeded: result.loginSucceeded, loginError: result.loginError },
      201,
    );
  } catch (err: any) {
    if (err.message.includes('already exists')) {
      return c.json({ error: { message: err.message } }, 409);
    }
    console.error('[Accounts] POST failed:', err.message);
    return c.json({ error: { message: 'Failed to add account' } }, 500);
  }
});

/**
 * PATCH /api/accounts/:email
 * Update account properties (e.g. disabled)
 */
accountsRouter.patch('/:email', async (c) => {
  try {
    if (!checkRateLimit('accounts')) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }
    const email = decodeURIComponent(c.req.param('email'));
    const body = await c.req.json();
    if (typeof body.disabled === 'boolean') {
      setAccountDisabled(email, body.disabled);
    }
    return c.json({ success: true, email, disabled: body.disabled });
  } catch (err: any) {
    if (err.message.includes('not found')) {
      return c.json({ error: { message: err.message } }, 404);
    }
    console.error('[Accounts] PATCH failed:', err.message);
    return c.json({ error: { message: 'Failed to update account' } }, 500);
  }
});

/**
 * DELETE /api/accounts/:email
 * Remove an account by email
 */
accountsRouter.delete('/:email', async (c) => {
  try {
    if (!checkRateLimit('accounts')) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }
    const email = decodeURIComponent(c.req.param('email'));
    await removeAccount(email);
    return c.json({ success: true, email });
  } catch (err: any) {
    if (err.message.includes('not found')) {
      return c.json({ error: { message: err.message } }, 404);
    }
    console.error('[Accounts] DELETE failed:', err.message);
    return c.json({ error: { message: 'Failed to remove account' } }, 500);
  }
});

/**
 * GET /api/accounts/:email/login
 * Compatibility endpoint: run the new login task and wait for an actionable state.
 */
accountsRouter.get('/:email/login', async (c) => {
  try {
    const email = decodeURIComponent(c.req.param('email'));
    const started = startLoginJob(email, 'auto');
    const job = await waitForActionableLoginJob(started.job.id);
    if (!job) return c.json({ error: { code: 'login_job_not_found', message: 'Login task was not found' } }, 404);

    if (job.status === 'authenticated') {
      return c.json({ ...loginJobPayload(job, started.reused), method: job.method });
    }
    if (job.status === 'awaiting_manual') {
      return c.json(
        {
          error: {
            code: 'awaiting_manual',
            message: job.message,
            manualUrl: job.manualUrl,
            apiFailure: job.apiFailure,
          },
          email: job.email,
          jobId: job.id,
          status: job.status,
          job,
        },
        400,
      );
    }

    if (job.status === 'failed') {
      return c.json(
        {
          error: job.failure,
          email: job.email,
          jobId: job.id,
          status: job.status,
          apiFailure: job.apiFailure,
          job,
        },
        job.failure?.stage === 'account' ? 400 : 500,
      );
    }

    return c.json(loginJobPayload(job, started.reused), 202);
  } catch (error) {
    return loginStartErrorResponse(c, error);
  }
});

/** POST /api/accounts/:email/login — start or reuse an asynchronous login task. */
accountsRouter.post('/:email/login', async (c) => {
  try {
    const email = decodeURIComponent(c.req.param('email'));
    let mode: 'auto' | 'manual' = 'auto';
    const contentType = c.req.header('content-type') || '';
    if (contentType.includes('application/json')) {
      const body = await c.req.json();
      if (body?.mode !== undefined && body.mode !== 'auto' && body.mode !== 'manual') {
        return c.json({ error: { code: 'invalid_login_mode', message: 'mode must be auto or manual' } }, 400);
      }
      if (body?.mode === 'manual') mode = 'manual';
    }
    const started = startLoginJob(email, mode);
    return c.json(loginJobPayload(started.job, started.reused), 202);
  } catch (error) {
    return loginStartErrorResponse(c, error);
  }
});

/** GET /api/accounts/:email/login-jobs/:jobId — query a login task without exposing credentials. */
accountsRouter.get('/:email/login-jobs/:jobId', (c) => {
  const email = decodeURIComponent(c.req.param('email')).toLowerCase().trim();
  const job = getLoginJob(c.req.param('jobId'));
  if (!job || job.email !== email) {
    return c.json({ error: { code: 'login_job_not_found', message: 'Login task was not found' } }, 404);
  }
  return c.json(loginJobPayload(job));
});

accountsRouter.get('/:email/autofill', async (c) => {
  try {
    const email = decodeURIComponent(c.req.param('email'));
    const started = startLoginJob(email, 'manual');
    return c.json({
      ...loginJobPayload(started.job, started.reused),
      message: started.reused ? 'Existing login task is still running.' : 'Manual browser login task queued.',
    });
  } catch (error) {
    return loginStartErrorResponse(c, error);
  }
});
