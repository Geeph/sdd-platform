import { describe, expect, it } from 'vitest';
import { M1_PLACEHOLDER } from '../src/index.js';

describe('@sdd/factory', () => {
  it('has a placeholder export', () => {
    expect(M1_PLACEHOLDER).toBe('@sdd/factory');
  });
});
