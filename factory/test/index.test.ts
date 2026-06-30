import { describe, expect, it } from 'vitest';
import {
  compileInitPlan,
  isFullCommit,
  isSha256,
  parseManifest,
  serializeInitPlan,
  sha256Hex,
  validateManifest,
} from '../src/index.js';

describe('@sdd/factory', () => {
  it('exports the core M2a API surface', () => {
    expect(typeof compileInitPlan).toBe('function');
    expect(typeof serializeInitPlan).toBe('function');
    expect(typeof parseManifest).toBe('function');
    expect(typeof validateManifest).toBe('function');
    expect(typeof sha256Hex).toBe('function');
  });

  it('sha256Hex returns the expected prefix+hex format', () => {
    const digest = sha256Hex(Buffer.from('hello world', 'utf8'));
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('isSha256 / isFullCommit validate formats correctly', () => {
    expect(isSha256(`sha256:${'a'.repeat(64)}`)).toBe(true);
    expect(isSha256(`sha256:${'g'.repeat(64)}`)).toBe(false);
    expect(isSha256('abc')).toBe(false);
    expect(isFullCommit('a'.repeat(40))).toBe(true);
    expect(isFullCommit('a'.repeat(39))).toBe(false);
    expect(isFullCommit('g'.repeat(40))).toBe(false);
  });

  it('parseManifest rejects malformed input', () => {
    expect(() => parseManifest(null)).toThrow();
    expect(() => parseManifest({ template: 'other' })).toThrow();
    expect(() =>
      parseManifest({
        template: 'monorepo-root',
        path: 'templates/monorepo-root',
        tree_sha256: 'invalid',
        files: [],
      }),
    ).toThrow();
  });
});
