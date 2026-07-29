import { afterEach, describe, test } from 'bun:test';
import assert from 'node:assert';
import { accounts, rebuildEmailIndex } from './accountManager.ts';
import { isAccountThrottled } from './auth.ts';
import { parseStsTokenResponse, StsTokenError } from './qwenFileUpload.ts';

const VALID_STS = {
  access_key_id: 'STS.TEST',
  access_key_secret: 'secret',
  security_token: 'token',
  bucketname: 'qwen-webui-prod',
  region: 'ap-southeast-1',
  endpoint: 'oss-accelerate.aliyuncs.com',
  file_id: 'file-id-1',
  file_path: 'user-id/file-id-1_image.jpeg',
  file_url: 'https://qwen-webui-prod.oss-accelerate.aliyuncs.com/user-id/file-id-1_image.jpeg',
};

describe('parseStsTokenResponse', () => {
  const originalAccounts = [...accounts];

  afterEach(() => {
    accounts.splice(0, accounts.length, ...originalAccounts);
    rebuildEmailIndex();
  });

  test('accepts valid STS payload without success field (legacy shape)', () => {
    const sts = parseStsTokenResponse({ data: VALID_STS }, 'test@qwen');
    assert.strictEqual(sts.file_id, 'file-id-1');
    assert.strictEqual(sts.file_path, VALID_STS.file_path);
  });

  test('accepts valid STS payload with success:true', () => {
    const sts = parseStsTokenResponse({ success: true, data: VALID_STS }, 'test@qwen');
    assert.strictEqual(sts.bucketname, 'qwen-webui-prod');
  });

  test('rejects RateLimited and throttles account for reported hours', () => {
    accounts.push({
      email: 'limited@qwen',
      password: 'x',
      state: { token: 't', expiresAt: Date.now() + 3600000, refreshToken: null },
      lastUsed: 0,
      throttledUntil: 0,
      refreshInFlight: null,
      loginAttempt: 0,
      inFlight: 0,
      totalRequests: 0,
      startupStatus: 'ready',
    });
    rebuildEmailIndex();

    let err: unknown;
    try {
      parseStsTokenResponse(
        {
          success: false,
          request_id: 'req-1',
          data: {
            code: 'RateLimited',
            details: "You've reached the upper limit for today's usage.",
            template: 'You have reached the daily usage limit. Please wait {{num}} hours before trying again.',
            num: 19,
          },
        },
        'limited@qwen',
      );
    } catch (e) {
      err = e;
    }

    assert.ok(err instanceof StsTokenError, 'should throw StsTokenError');
    const stsErr = err as StsTokenError;
    assert.strictEqual(stsErr.code, 'RateLimited');
    assert.strictEqual(stsErr.upstreamStatus, 429);
    assert.strictEqual(stsErr.retryHours, 19);
    assert.match(stsErr.message, /RateLimited/);
    assert.match(stsErr.message, /19 hour/);
    assert.ok(isAccountThrottled('limited@qwen'), 'account must be throttled');

    const acct = accounts.find((a) => a.email === 'limited@qwen')!;
    // ~19 hours remaining (allow small clock skew)
    const remaining = acct.throttledUntil - Date.now();
    assert.ok(remaining > 18.5 * 3600_000 && remaining <= 19 * 3600_000, `throttle duration was ${remaining}ms`);
  });

  test('rejects success:false without STS credentials (no objectKey crash path)', () => {
    assert.throws(
      () =>
        parseStsTokenResponse(
          {
            success: false,
            data: { code: 'RateLimited', details: 'limit', num: 1 },
          },
          'nobody@qwen',
        ),
      (e: any) => e instanceof StsTokenError && e.code === 'RateLimited' && e.upstreamStatus === 429,
    );
  });

  test('rejects incomplete STS fields even when success is not false', () => {
    assert.throws(
      () =>
        parseStsTokenResponse(
          {
            success: true,
            data: { file_id: 'only-id' },
          },
          'test@qwen',
        ),
      (e: any) => e instanceof StsTokenError && e.upstreamStatus === 502,
    );
  });

  test('rejects empty data object (the production crash shape)', () => {
    // HTTP 200 + data present but all STS fields missing → previously crashed in uploadToOss
    assert.throws(
      () => parseStsTokenResponse({ success: false, data: { code: 'RateLimited', details: 'limit', num: 20 } }, 'x@qwen'),
      (error: unknown) => error instanceof StsTokenError && !('file_path' in error),
    );
  });
});
