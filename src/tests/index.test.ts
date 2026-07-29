import assert from 'node:assert';
import test from 'node:test';

process.env.TEST_MOCK_PLAYWRIGHT = 'true';
// Set a test API key (never empty — prevents auth bypass in tests)
process.env.API_KEY = 'test-key-for-testing';

import { app } from '../index.tsx';
import { accounts, rebuildEmailIndex } from '../services/accountManager.ts';
import { isAccountThrottled } from '../services/auth.ts';

const TEST_API_KEY = 'test-key-for-testing';
const authHeaders = { Authorization: `Bearer ${TEST_API_KEY}` };

test('Health check returns degraded when Playwright not initialized', async () => {
  const req = new Request('http://localhost/health');
  const res = await app.fetch(req);

  assert.strictEqual(res.status, 200);

  const body = await res.json();
  assert.strictEqual(body.status, 'degraded');
  assert.ok(typeof body.uptime === 'number');
});

test('Models endpoint returns the bundled OpenAI-compatible model catalog without upstream access', async () => {
  const originalFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => {
    throw new Error('models endpoint must not call upstream');
  };

  try {
    const req = new Request('http://localhost/v1/models', { headers: authHeaders });
    const res = await app.fetch(req);

    assert.strictEqual(res.status, 200);

    const body = await res.json();
    assert.strictEqual(body.object, 'list');
    assert.ok(Array.isArray(body.data));

    const model = body.data[0];
    assert.strictEqual(model.id, 'qwen3.6-plus');
    assert.strictEqual(model.object, 'model');
    assert.ok(typeof model.created === 'number');
    assert.strictEqual(model.owned_by, 'qwen');
    assert.strictEqual(model.context_window, 1000000);
    assert.strictEqual(model.max_output_tokens, 65536);
    assert.deepStrictEqual(model.modalities, ['text', 'image', 'video']);
    assert.strictEqual(model.description, '');
    assert.deepStrictEqual(model.capabilities, {});
    // should not carry raw Qwen-internal fields
    assert.strictEqual(model.info, undefined);
    assert.strictEqual(model.preset, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Chat Completions endpoint with qwen3.6-plus (thinking enabled)', async () => {
  const originalFetch = globalThis.fetch;
  (globalThis as any).fetch = async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'qwen3.6-plus', owned_by: 'qwen' }] }), { status: 200 });
    }
    if (url.includes('/api/v2/chat/completions')) {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(
            new TextEncoder().encode(
              'data: {"choices": [{"delta": {"phase": "thinking_summary", "extra": {"summary_thought": {"content": ["Thinking..."]}}}}]}\n\n',
            ),
          );
          c.enqueue(new TextEncoder().encode('data: {"choices": [{"delta": {"phase": "answer", "content": "Hello"}}]}\n\n'));
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        },
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input);
  };

  try {
    const payload = {
      model: 'qwen3.6-plus',
      messages: [{ role: 'user', content: 'What is 99 * 182? Please think step by step.' }],
      stream: true,
    };

    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders),
      body: JSON.stringify(payload),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('Content-Type'), 'text/event-stream');

    const reader = res.body?.getReader();
    assert.ok(reader, 'Response should have a readable body');

    const decoder = new TextDecoder();
    let hasReasoning = false;
    let hasContent = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (line.trim() === 'data: [DONE]') {
          break;
        }
        if (line.startsWith('data: ')) {
          try {
            const dataStr = line.slice(6);
            if (dataStr !== '[DONE]') {
              const data = JSON.parse(dataStr);

              if (data.choices && data.choices[0] && data.choices[0].delta) {
                const delta = data.choices[0].delta;
                if (delta.content) {
                  hasContent = true;
                }
                if (delta.reasoning_content) {
                  hasReasoning = true;
                }
              }
            }
          } catch {
            // Partial JSON ignored
          }
        }
      }
    }

    assert.ok(hasReasoning, 'Should have received streamed chunks with reasoning_content (Thinking enabled)');
    assert.ok(hasContent, 'Should have received streamed chunks with content');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Chat Completions returns explicit error for non-SSE upstream JSON errors', async () => {
  const originalFetch = globalThis.fetch;
  (globalThis as any).fetch = async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/v2/chat/completions')) {
      return new Response(
        JSON.stringify({
          success: false,
          data: {
            code: 'RateLimited',
            details: "You've reached the upper limit for today's usage.",
            num: 3,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return originalFetch(input);
  };

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders),
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        messages: [{ role: 'user', content: 'hello' }],
        stream: false,
      }),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 429);

    const body = await res.json();
    assert.match(body.error.message, /Qwen upstream error: RateLimited/);
    assert.match(body.error.message, /upper limit/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Chat Completions returns a JSON chat.completion object for non-streaming requests', async () => {
  const originalFetch = globalThis.fetch;
  (globalThis as any).fetch = async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/v2/chat/completions')) {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"choices": [{"delta": {"phase": "answer", "content": "Hello"}}]}\n\n'));
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        },
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input);
  };

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders),
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        messages: [{ role: 'user', content: 'hello' }],
        stream: false,
      }),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);

    const body = await res.json();
    assert.strictEqual(body.object, 'chat.completion');
    assert.strictEqual(body.choices[0].message.role, 'assistant');
    assert.strictEqual(body.choices[0].message.content, 'Hello');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('API Key protection', async () => {
  const originalApiKey = process.env.API_KEY;
  process.env.API_KEY = 'test-api-key';
  let originalFetch: any;

  try {
    // 1. Test request without API Key
    const req1 = new Request('http://localhost/v1/models');
    const res1 = await app.fetch(req1);
    assert.strictEqual(res1.status, 401, 'Should return 401 Unauthorized without API Key');

    // 2. Test request with wrong API Key
    const req2 = new Request('http://localhost/v1/models', {
      headers: { Authorization: 'Bearer wrong-key' },
    });
    const res2 = await app.fetch(req2);
    assert.strictEqual(res2.status, 401, 'Should return 401 Unauthorized with wrong API Key');

    // 3. Test request with correct API Key
    // Mock fetch for models list
    originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => new Response(JSON.stringify({ data: [] }), { status: 200 });

    try {
      const req3 = new Request('http://localhost/v1/models', {
        headers: { Authorization: 'Bearer test-api-key' },
      });
      const res3 = await app.fetch(req3);
      assert.strictEqual(res3.status, 200, 'Should return 200 OK with correct API Key');
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    globalThis.fetch = originalFetch;
    process.env.API_KEY = originalApiKey;
  }
});

test('Chat completions with image uploads attaches files (t2t chat_type, vision class)', async () => {
  const originalFetch = globalThis.fetch;
  const originalAccounts = [...accounts];

  // Seed a test account so pickAccount returns an account for image upload
  accounts.push({
    email: 'test@qwen-gate.dev',
    password: 'test',
    state: { token: 'mock-token', expiresAt: Date.now() + 3600000, refreshToken: null },
    lastUsed: 0,
    throttledUntil: 0,
    refreshInFlight: null,
    loginAttempt: 0,
    inFlight: 0,
    totalRequests: 0,
    startupStatus: 'ready',
  });

  let stsCalled = false;
  let ossCalled = false;
  let chatPayload: any = null;

  (globalThis as any).fetch = async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'qwen3.6-plus', owned_by: 'qwen' }] }), { status: 200 });
    }
    if (url.includes('/api/v2/files/getstsToken')) {
      stsCalled = true;
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            access_key_id: 'test-key',
            access_key_secret: 'test-secret',
            security_token: 'test-token',
            bucketname: 'test-bucket',
            region: 'oss-cn-hangzhou',
            endpoint: 'oss-cn-hangzhou.aliyuncs.com',
            file_id: 'test-file-id',
            file_path: 'test-user/test-file-id_image.png',
            file_url: 'https://test-bucket.oss-cn-hangzhou.aliyuncs.com/test-file-id_image.png',
          },
        }),
        { status: 200 },
      );
    }
    if (url.includes('/api/v2/files/parse/status')) {
      return new Response(JSON.stringify({ data: [{ status: 'success' }] }), { status: 200 });
    }
    if (url.includes('/api/v2/files/parse')) {
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    if (url.includes('aliyuncs.com') || url.includes('oss-')) {
      ossCalled = true;
      return new Response(null, { status: 200 });
    }
    if (url.includes('/api/v2/chat/completions')) {
      // Capture the payload for later assertions
      // init?.body is set when browserlessFetch calls globalThis.fetch(url, { method, headers, body })
      const bodyStr =
        typeof input === 'string' && init?.body ? init.body : typeof input !== 'string' ? await (input as Request).clone().text() : '';
      try {
        chatPayload = JSON.parse(bodyStr);
      } catch {}
      // Return a simple stream
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"choices": [{"delta": {"content": "Image received"}}]}\n\n'));
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        },
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input, init);
  };

  try {
    const payload = {
      model: 'qwen3.6-plus',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is in this image?' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAA=' } },
          ],
        },
      ],
      stream: false,
    };

    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, { Authorization: 'Bearer test-key-for-testing' }),
      body: JSON.stringify(payload),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);

    // Verify STS token was requested (image upload initiated)
    assert.ok(stsCalled, 'Should have called getstsToken for image upload');

    // Verify OSS upload happened
    assert.ok(ossCalled, 'Should have uploaded image to OSS');

    // Verify the chat payload has the right format
    assert.ok(chatPayload, 'Chat completion should have been called');
    const msg = chatPayload?.messages?.[0];
    assert.ok(msg, 'Should have at least one message');

    // The image_url should be stripped from content text (only text parts remain)
    assert.ok(!msg.content.includes('image_url'), 'Image URL should be stripped from content text');
    assert.ok(msg.content.includes('What is in this image?'), 'Text content should be preserved');

    // Should have files attached
    assert.ok(Array.isArray(msg.files), 'Message should have files array');
    assert.ok(msg.files.length > 0, 'Should have at least one file (image)');

    // Chat type should remain t2t (default) — Qwen web UI uses t2t even with images
    assert.strictEqual(msg.chat_type, 't2t', 'Chat type should remain t2t for images');
    assert.strictEqual(msg.sub_chat_type, 't2t', 'Sub chat type should remain t2t');
    assert.strictEqual(msg.extra?.meta?.subChatType, 't2t', 'Extra subChatType should remain t2t');

    // Verify file attachment format
    const file = msg.files[0];
    assert.strictEqual(file.type, 'image', 'File attachment type should be image');
    assert.strictEqual(file.file_class, 'vision', 'File class should be vision');
  } finally {
    globalThis.fetch = originalFetch;
    accounts.splice(0, accounts.length, ...originalAccounts);
  }
});

test('Chat image upload RateLimited STS retries next account and throttles limited one', async () => {
  const originalFetch = globalThis.fetch;
  const originalAccounts = [...accounts];
  accounts.splice(0, accounts.length);

  accounts.push(
    {
      email: 'limited-upload@qwen-gate.dev',
      password: 'test',
      state: { token: 'limited-token', expiresAt: Date.now() + 3600000, refreshToken: null },
      lastUsed: 0,
      throttledUntil: 0,
      refreshInFlight: null,
      loginAttempt: 0,
      inFlight: 0,
      totalRequests: 0,
      startupStatus: 'ready',
    },
    {
      email: 'ok-upload@qwen-gate.dev',
      password: 'test',
      state: { token: 'ok-token', expiresAt: Date.now() + 3600000, refreshToken: null },
      lastUsed: 0,
      throttledUntil: 0,
      refreshInFlight: null,
      loginAttempt: 0,
      inFlight: 0,
      totalRequests: 0,
      startupStatus: 'ready',
    },
  );
  rebuildEmailIndex();

  const stsByAccount: string[] = [];
  let chatPayload: any = null;

  (globalThis as any).fetch = async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'qwen3.6-plus', owned_by: 'qwen' }] }), { status: 200 });
    }
    if (url.includes('/api/v2/files/getstsToken')) {
      const cookie = (init?.headers?.cookie || init?.headers?.Cookie || '') as string;
      const account = cookie.includes('limited-token') ? 'limited-upload@qwen-gate.dev' : 'ok-upload@qwen-gate.dev';
      stsByAccount.push(account);
      if (account === 'limited-upload@qwen-gate.dev') {
        // Production shape that previously caused objectKey.startsWith crash
        return new Response(
          JSON.stringify({
            success: false,
            request_id: 'rate-limited',
            data: {
              code: 'RateLimited',
              details: "You've reached the upper limit for today's usage.",
              num: 19,
            },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            access_key_id: 'test-key',
            access_key_secret: 'test-secret',
            security_token: 'test-token',
            bucketname: 'test-bucket',
            region: 'oss-cn-hangzhou',
            endpoint: 'oss-cn-hangzhou.aliyuncs.com',
            file_id: 'ok-file-id',
            file_path: 'test-user/ok-file-id_image.png',
            file_url: 'https://test-bucket.oss-cn-hangzhou.aliyuncs.com/ok-file-id_image.png',
          },
        }),
        { status: 200 },
      );
    }
    if (url.includes('aliyuncs.com') || url.includes('oss-')) {
      return new Response(null, { status: 200 });
    }
    if (url.includes('/api/v2/chat/completions')) {
      const bodyStr =
        typeof input === 'string' && init?.body ? init.body : typeof input !== 'string' ? await (input as Request).clone().text() : '';
      try {
        chatPayload = JSON.parse(bodyStr);
      } catch {}
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"choices": [{"delta": {"content": "ok"}}]}\n\n'));
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        },
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input, init);
  };

  try {
    const payload = {
      model: 'qwen3.6-plus',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'describe' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAA=' } },
          ],
        },
      ],
      stream: false,
    };

    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, { Authorization: 'Bearer test-key-for-testing' }),
      body: JSON.stringify(payload),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200, await res.text());

    // First pick hits limited account STS; then retries healthy account
    assert.ok(stsByAccount.includes('limited-upload@qwen-gate.dev'), 'should attempt limited account');
    assert.ok(stsByAccount.includes('ok-upload@qwen-gate.dev'), 'should retry healthy account');
    assert.ok(isAccountThrottled('limited-upload@qwen-gate.dev'), 'limited account must be throttled after RateLimited STS');
    assert.ok(!isAccountThrottled('ok-upload@qwen-gate.dev'), 'healthy account must not be throttled');
    assert.ok(chatPayload?.messages?.[0]?.files?.length > 0, 'should attach uploaded image from healthy account');
  } finally {
    globalThis.fetch = originalFetch;
    accounts.splice(0, accounts.length, ...originalAccounts);
    rebuildEmailIndex();
  }
});

test('Chat completions with video uploads attaches files (t2t chat_type, video class)', async () => {
  const originalFetch = globalThis.fetch;
  const originalAccounts = [...accounts];

  accounts.push({
    email: 'test-video@qwen-gate.dev',
    password: 'test',
    state: { token: 'mock-token', expiresAt: Date.now() + 3600000, refreshToken: null },
    lastUsed: 0,
    throttledUntil: 0,
    refreshInFlight: null,
    loginAttempt: 0,
    inFlight: 0,
    totalRequests: 0,
    startupStatus: 'ready',
  });

  let stsCalled = false;
  let stsFiletype: string | null = null;
  let ossCalled = false;
  let chatPayload: any = null;

  (globalThis as any).fetch = async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'qwen3.6-plus', owned_by: 'qwen' }] }), { status: 200 });
    }
    if (url.includes('/api/v2/files/getstsToken')) {
      stsCalled = true;
      try {
        const bodyStr = typeof init?.body === 'string' ? init.body : '';
        const body = bodyStr ? JSON.parse(bodyStr) : {};
        stsFiletype = body.filetype ?? null;
      } catch {}
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            access_key_id: 'test-key',
            access_key_secret: 'test-secret',
            security_token: 'test-token',
            bucketname: 'test-bucket',
            region: 'oss-cn-hangzhou',
            endpoint: 'oss-cn-hangzhou.aliyuncs.com',
            file_id: 'test-video-file-id',
            file_path: 'test-user/test-video-file-id_video.mp4',
            file_url: 'https://test-bucket.oss-cn-hangzhou.aliyuncs.com/test-video-file-id_video.mp4',
          },
        }),
        { status: 200 },
      );
    }
    if (url.includes('/api/v2/files/parse/status')) {
      return new Response(JSON.stringify({ data: [{ status: 'success' }] }), { status: 200 });
    }
    if (url.includes('/api/v2/files/parse')) {
      // Videos should NOT trigger parse — fail loudly if they do
      throw new Error('parse should not be called for video uploads');
    }
    if (url.includes('aliyuncs.com') || url.includes('oss-')) {
      ossCalled = true;
      return new Response(null, { status: 200 });
    }
    if (url.includes('/api/v2/chat/completions')) {
      const bodyStr =
        typeof input === 'string' && init?.body ? init.body : typeof input !== 'string' ? await (input as Request).clone().text() : '';
      try {
        chatPayload = JSON.parse(bodyStr);
      } catch {}
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"choices": [{"delta": {"content": "Video received"}}]}\n\n'));
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        },
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input, init);
  };

  try {
    // Minimal valid base64 payload (not a real mp4 — upload path only checks size/mime)
    const payload = {
      model: 'qwen3.6-plus',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What happens in this video?' },
            { type: 'video_url', video_url: { url: 'data:video/mp4;base64,AAAA' } },
          ],
        },
      ],
      stream: false,
    };

    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, { Authorization: 'Bearer test-key-for-testing' }),
      body: JSON.stringify(payload),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);

    assert.ok(stsCalled, 'Should have called getstsToken for video upload');
    assert.strictEqual(stsFiletype, 'video', 'STS filetype should be video');
    assert.ok(ossCalled, 'Should have uploaded video to OSS');

    assert.ok(chatPayload, 'Chat completion should have been called');
    const msg = chatPayload?.messages?.[0];
    assert.ok(msg, 'Should have at least one message');

    assert.ok(!msg.content.includes('video_url'), 'Video URL should be stripped from content text');
    assert.ok(msg.content.includes('What happens in this video?'), 'Text content should be preserved');

    assert.ok(Array.isArray(msg.files), 'Message should have files array');
    assert.ok(msg.files.length > 0, 'Should have at least one file (video)');

    assert.strictEqual(msg.chat_type, 't2t', 'Chat type should remain t2t for videos');
    assert.strictEqual(msg.sub_chat_type, 't2t', 'Sub chat type should remain t2t');

    const file = msg.files[0];
    assert.strictEqual(file.type, 'video', 'File attachment type should be video');
    assert.strictEqual(file.file_class, 'video', 'File class should be video');
    assert.strictEqual(file.showType, 'video', 'showType should be video');
    assert.strictEqual(file.file_type, 'video/mp4', 'file_type should be video/mp4');
  } finally {
    globalThis.fetch = originalFetch;
    accounts.splice(0, accounts.length, ...originalAccounts);
  }
});

test('Chat Completions endpoint - Non-streaming (stream: false)', async () => {
  const originalFetch = globalThis.fetch;
  (globalThis as any).fetch = async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'qwen3.6-plus', owned_by: 'qwen' }] }), { status: 200 });
    }
    if (url.includes('/api/v2/chat/completions')) {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(
            new TextEncoder().encode(
              'data: {"choices": [{"delta": {"phase": "thinking_summary", "extra": {"summary_thought": {"content": ["Thinking non-stream..."]}}}}]}\n\n',
            ),
          );
          c.enqueue(new TextEncoder().encode('data: {"choices": [{"delta": {"phase": "answer", "content": "Hello non-stream"}}]}\n\n'));
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        },
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input);
  };

  try {
    const payload = {
      model: 'qwen3.6-plus',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: false,
    };

    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders),
      body: JSON.stringify(payload),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers.get('Content-Type')?.includes('application/json'));

    const body = await res.json();
    assert.strictEqual(body.object, 'chat.completion');
    assert.strictEqual(body.model, 'qwen3.6-plus');
    assert.ok(body.choices);
    assert.strictEqual(body.choices.length, 1);

    const choice = body.choices[0];
    assert.strictEqual(choice.message.role, 'assistant');
    assert.strictEqual(choice.message.content, 'Hello non-stream');
    assert.strictEqual(choice.message.reasoning_content, 'Thinking non-stream...');
    assert.strictEqual(choice.finish_reason, 'stop');

    assert.ok(body.usage);
    assert.ok(body.usage.prompt_tokens > 0);
    assert.ok(body.usage.completion_tokens >= 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Anthropic streaming strips XML artifacts from text deltas', async () => {
  const originalFetch = globalThis.fetch;
  const originalAccounts = [...accounts];

  accounts.push({
    email: 'xml-test@qwen-gate.dev',
    password: 'test',
    state: { token: 'mock-token', expiresAt: Date.now() + 3600000, refreshToken: null },
    lastUsed: 0,
    throttledUntil: 0,
    refreshInFlight: null,
    loginAttempt: 0,
    inFlight: 0,
    totalRequests: 0,
    startupStatus: 'ready',
  });

  (globalThis as any).fetch = async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'qwen3.7-max', owned_by: 'qwen' }] }), { status: 200 });
    }
    if (url.includes('/api/v2/chat/completions')) {
      const stream = new ReadableStream({
        start(c) {
          // Text chunk with XML tool call artifact embedded
          c.enqueue(
            new TextEncoder().encode(
              'data: {"choices":[{"delta":{"phase":"answer","content":"I\'ll check the file. <function=Bash><parameter=command>cat /etc/hostname</parameter></function>"}}]}\n\n',
            ),
          );
          c.enqueue(
            new TextEncoder().encode('data: {"choices":[{"delta":{"phase":"answer","content":" The hostname is qwen-gate."}}]}\n\n'),
          );
          c.enqueue(
            new TextEncoder().encode(
              'data: {"choices":[{"delta":{"phase":"local_tool","status":"finished","extra":{"local_mcp":{"★":[{"tool_name":"★-Bash","params":{"command":"cat /etc/hostname"}}]}}}}]}\n\n',
            ),
          );
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        },
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input);
  };

  try {
    const payload = {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      stream: true,
      tools: [
        {
          name: 'Bash',
          description: 'Run a shell command',
          input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
        },
      ],
      messages: [{ role: 'user', content: 'Check hostname' }],
    };

    const req = new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        ...authHeaders,
      },
      body: JSON.stringify(payload),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200, `Expected 200 got ${res.status}`);

    const reader = res.body?.getReader();
    assert.ok(reader, 'Response should have a readable body');

    const decoder = new TextDecoder();
    let allSse = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      allSse += decoder.decode(value, { stream: true });
    }

    const events: any[] = [];
    for (const line of allSse.split('\n')) {
      if (line.startsWith('data: ') && line.slice(6) !== '[DONE]') {
        try {
          events.push(JSON.parse(line.slice(6)));
        } catch {
          /* skip partial */
        }
      }
    }

    // Check that NO text_delta contains XML artifacts
    const textDeltas = events.filter((e) => e.type === 'content_block_delta' && e.delta?.type === 'text_delta');
    for (const td of textDeltas) {
      assert.doesNotMatch(
        td.delta.text,
        /<function=|<\/function>|<parameter=/,
        `text_delta must not contain XML artifacts. Got: ${JSON.stringify(td.delta.text)}`,
      );
    }

    // Verify tool_use block exists (from local_mcp)
    const toolStart = events.find((e) => e.type === 'content_block_start' && e.content_block?.type === 'tool_use');
    assert.ok(toolStart, `Should have tool_use block`);
    assert.strictEqual(toolStart.content_block.name, 'Bash');
    // Per Anthropic spec, content_block_start has input: {}
    assert.deepStrictEqual(toolStart.content_block.input, {}, 'tool_use start must have empty input');

    // Verify input_json_delta carries the actual args
    const inputDeltas = events.filter((e) => e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta');
    assert.ok(inputDeltas.length >= 1, 'Should have at least one input_json_delta event');
    const parsedInput = JSON.parse(inputDeltas[0].delta.partial_json);
    assert.strictEqual(parsedInput.command, 'cat /etc/hostname', 'input_json_delta must contain command');
  } finally {
    accounts.splice(0, accounts.length, ...originalAccounts);
    globalThis.fetch = originalFetch;
  }
});

test('Anthropic /v1/messages streaming with local_mcp tool call emits correct tool_use block', async () => {
  const originalFetch = globalThis.fetch;
  const originalAccounts = [...accounts];

  // Seed a test account
  accounts.push({
    email: 'test@qwen-gate.dev',
    password: 'test',
    state: { token: 'mock-token', expiresAt: Date.now() + 3600000, refreshToken: null },
    lastUsed: 0,
    throttledUntil: 0,
    refreshInFlight: null,
    loginAttempt: 0,
    inFlight: 0,
    totalRequests: 0,
    startupStatus: 'ready',
  });

  (globalThis as any).fetch = async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'qwen3.7-max', owned_by: 'qwen' }] }), { status: 200 });
    }
    if (url.includes('/api/v2/chat/completions')) {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"phase":"answer","content":"I\'ll run that for you."}}]}\n\n'));
          c.enqueue(
            new TextEncoder().encode(
              'data: {"choices":[{"delta":{"phase":"local_tool","status":"finished","extra":{"local_mcp":{"★":[{"tool_name":"★-Bash","params":{"command":"ls -la /tmp"}}]}}}}]}\n\n',
            ),
          );
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        },
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input);
  };

  try {
    const payload = {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      stream: true,
      tools: [
        {
          name: 'Bash',
          description: 'Run a shell command',
          input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
        },
      ],
      messages: [{ role: 'user', content: 'Run ls in /tmp' }],
    };

    const req = new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        ...authHeaders,
      },
      body: JSON.stringify(payload),
    });

    const res = await app.fetch(req);
    assert.strictEqual(
      res.status,
      200,
      `Expected 200 got ${res.status} — body: ${await res
        .clone()
        .text()
        .catch(() => '?')}`,
    );

    const reader = res.body?.getReader();
    assert.ok(reader, 'Response should have a readable body');

    const decoder = new TextDecoder();
    let allSse = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      allSse += decoder.decode(value, { stream: true });
    }

    // Parse all SSE events
    const events: any[] = [];
    for (const line of allSse.split('\n')) {
      if (line.startsWith('data: ') && line.slice(6) !== '[DONE]') {
        try {
          events.push(JSON.parse(line.slice(6)));
        } catch {
          /* skip partial */
        }
      }
    }

    // Verify message_start
    const msgStart = events.find((e) => e.type === 'message_start');
    assert.ok(msgStart, 'Should have message_start');
    assert.strictEqual(msgStart.message.role, 'assistant');

    // Find tool_use content block — per spec, input is {} in start event
    const toolStart = events.find((e) => e.type === 'content_block_start' && e.content_block?.type === 'tool_use');
    assert.ok(toolStart, `Should have tool_use content_block_start — types: ${[...new Set(events.map((e) => e.type))].join(', ')}`);
    assert.strictEqual(toolStart.content_block.name, 'Bash', `Tool name should be Bash. Got: ${toolStart.content_block.name}`);
    assert.deepStrictEqual(toolStart.content_block.input, {}, 'tool_use start must have empty input per spec');

    // Verify input_json_delta carries the actual args
    const inputDeltas = events.filter((e) => e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta');
    assert.ok(inputDeltas.length >= 1, 'Should have at least one input_json_delta');
    const parsedInput = JSON.parse(inputDeltas[0].delta.partial_json);
    assert.strictEqual(parsedInput.command, 'ls -la /tmp', `input_json_delta must have command. Got: ${JSON.stringify(parsedInput)}`);

    // Verify message_delta stop_reason
    const msgDelta = events.find((e) => e.type === 'message_delta');
    assert.ok(msgDelta, 'Should have message_delta');
    assert.strictEqual(msgDelta.delta.stop_reason, 'tool_use');
  } finally {
    accounts.splice(0, accounts.length, ...originalAccounts);
    globalThis.fetch = originalFetch;
  }
});
