import { describe, test, expect } from 'bun:test';
import { CircuitBreaker, CircuitOpenError } from './retry.ts';

describe('CircuitBreaker recovery', () => {
  test('allowRequest transitions open → half_open after reset timeout', async () => {
    const cb = new CircuitBreaker('test-recovery', {
      failureThreshold: 2,
      resetTimeoutMs: 200,
      halfOpenMaxAttempts: 1,
    });

    await cb.recordFailure();
    await cb.recordFailure();
    expect(cb.getState()).toBe('open');

    // Immediate allowRequest while still within reset window must reject
    expect(() => cb.allowRequest()).toThrow(CircuitOpenError);
    expect(cb.getState()).toBe('open');

    // After reset timeout, allowRequest must open a half_open probe path
    await Bun.sleep(220);
    expect(() => cb.allowRequest()).not.toThrow();
    expect(cb.getState()).toBe('half_open');

    await cb.recordSuccess();
    expect(cb.getState()).toBe('closed');
  });

  test('getState alone does not recover from open (documents the pitfall)', async () => {
    const cb = new CircuitBreaker('test-getstate', {
      failureThreshold: 1,
      resetTimeoutMs: 30,
      halfOpenMaxAttempts: 1,
    });

    await cb.recordFailure();
    expect(cb.getState()).toBe('open');
    await Bun.sleep(40);

    // Reading state must stay pure — recovery only via allowRequest/tryTransitionToHalfOpen
    expect(cb.getState()).toBe('open');
    cb.tryTransitionToHalfOpen();
    expect(cb.getState()).toBe('half_open');
  });
});
