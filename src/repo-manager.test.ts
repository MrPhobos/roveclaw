import { describe, it, expect } from 'vitest';
import { parseRepoRef } from './repo-manager.js';

describe('parseRepoRef', () => {
  it('extracts owner/repo from message text', () => {
    expect(parseRepoRef('add search to MrPhobos/inventory-app')).toEqual({
      owner: 'MrPhobos',
      repo: 'inventory-app',
      cleanedMessage: 'add search to',
    });
  });

  it('returns null when no repo reference found', () => {
    expect(parseRepoRef('add search feature')).toEqual(null);
  });

  it('handles repo at start of message', () => {
    expect(parseRepoRef('MrPhobos/inventory-app add search')).toEqual({
      owner: 'MrPhobos',
      repo: 'inventory-app',
      cleanedMessage: 'add search',
    });
  });

  it('handles repo with hyphens and numbers', () => {
    expect(parseRepoRef('fix bug in some-org/my-repo-2')).toEqual({
      owner: 'some-org',
      repo: 'my-repo-2',
      cleanedMessage: 'fix bug in',
    });
  });

  it('does not match file paths with dots', () => {
    expect(parseRepoRef('edit src/components/Button.tsx')).toEqual(null);
  });
});
