import { describe, it, expect } from 'vitest';
import { solvePoW, solvePoWSync } from './pow';

describe('pow', () => {
  it('solvePoW returns a valid nonce for low difficulty', async () => {
    const result = await solvePoW('test-challenge', 1);
    expect(typeof result.nonce).toBe('string');
    expect(result.nonce.length).toBeGreaterThan(0);
    expect(result.iterations).toBeGreaterThanOrEqual(1);
  }, 15000);

  it('solvePoWSync returns a valid nonce for low difficulty', () => {
    const result = solvePoWSync('test-challenge', 1);
    expect(typeof result.nonce).toBe('string');
    expect(result.nonce.length).toBeGreaterThan(0);
    expect(result.iterations).toBeGreaterThanOrEqual(1);
  }, 15000);

  it('solvePoWSync times out on impossibly high difficulty', () => {
    expect(() => solvePoWSync('test-challenge', 256)).toThrow('timed out');
  }, 130000);
});
