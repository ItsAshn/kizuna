import { describe, it, expect } from 'vitest';
import { solvePoW } from './pow';

describe('pow', () => {
  it('solvePoW returns a valid nonce for low difficulty', async () => {
    const result = await solvePoW('test-challenge', 1);
    expect(typeof result.nonce).toBe('string');
    expect(result.nonce.length).toBeGreaterThan(0);
    expect(result.iterations).toBeGreaterThanOrEqual(1);
  }, 15000);
});
