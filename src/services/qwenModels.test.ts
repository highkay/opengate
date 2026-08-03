import { expect, test } from 'bun:test';
import { fetchQwenModels } from './qwenModels.ts';

test('fetchQwenModels returns the local catalog without upstream authentication', async () => {
  const models = await fetchQwenModels();
  const ids = new Set(models.map((model) => model.id));

  expect(models.length).toBeGreaterThan(20);
  expect(ids.has('qwen3.8-max')).toBe(true);
  expect(ids.has('qwen3.5-plus')).toBe(true);
  expect(ids.has('qwen3.6-plus')).toBe(true);
  expect(ids.has('qwen-plus')).toBe(true);
});
