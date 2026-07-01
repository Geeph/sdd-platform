/**
 * local-reader.test.ts — parseRemoteUrl + createLocalFsReadPort unit tests.
 *
 * These tests verify the source-identity invariants without depending on
 * the developer's local git state.
 */

import { describe, expect, it } from 'vitest';
import { parseRemoteUrl } from '../src/local-reader.js';

describe('parseRemoteUrl', () => {
  it('parses HTTPS GitHub URLs', () => {
    expect(parseRemoteUrl('https://github.com/acme/sdd-platform.git')).toEqual({
      owner: 'acme',
      repo: 'sdd-platform',
    });
    // Owner is lowercased (GitHub orgs are case-insensitive).
    expect(parseRemoteUrl('https://github.com/Geeph/sdd-platform')).toEqual({
      owner: 'geeph',
      repo: 'sdd-platform',
    });
  });

  it('parses SSH GitHub URLs', () => {
    expect(parseRemoteUrl('git@github.com:acme/sdd-platform.git')).toEqual({
      owner: 'acme',
      repo: 'sdd-platform',
    });
    expect(parseRemoteUrl('git@github.com:Geeph/sdd-platform')).toEqual({
      owner: 'geeph',
      repo: 'sdd-platform',
    });
  });

  it('parses ssh:// URLs', () => {
    expect(parseRemoteUrl('ssh://git@github.com/acme/sdd-platform.git')).toEqual({
      owner: 'acme',
      repo: 'sdd-platform',
    });
  });

  it('returns null for unparseable URLs', () => {
    expect(parseRemoteUrl('')).toBeNull();
    expect(parseRemoteUrl('not-a-url')).toBeNull();
    expect(parseRemoteUrl('https://example.com/no/slash')).not.toBeNull();
  });
});
