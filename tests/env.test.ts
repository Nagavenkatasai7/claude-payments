import { describe, it, expect } from 'vitest';
import { env } from '@/lib/env';

describe('env', () => {
  it('reads a configured variable', () => {
    expect(env.appBaseUrl).toBe('https://sendhome.test');
  });

  it('throws a clear error when a variable is missing', () => {
    const original = process.env.OLLAMA_API_KEY;
    delete process.env.OLLAMA_API_KEY;
    expect(() => env.ollamaApiKey).toThrow(/OLLAMA_API_KEY/);
    process.env.OLLAMA_API_KEY = original;
  });
});
