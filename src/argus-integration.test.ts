import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prepareArgusWorkspace } from './argus-integration.js';
import type { RegisteredGroup } from './types.js';
import * as repoManager from './repo-manager.js';

vi.mock('./repo-manager.js', () => ({
  prepareWorkspace: vi.fn().mockReturnValue({
    repoDir: '/Users/robert/bob-repos/MrPhobos/watchtower',
    worktreePath: '/Users/robert/argus-worktrees/argus-1234',
  }),
}));

const baseGroup: RegisteredGroup = {
  name: 'Argus',
  folder: 'telegram_argus',
  trigger: '',
  added_at: new Date().toISOString(),
};

describe('prepareArgusWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null for non-argus groups', () => {
    const group = { ...baseGroup, folder: 'telegram_rove' };
    expect(prepareArgusWorkspace(group, 'hello')).toBeNull();
  });

  it('prepares workspace for argus group', () => {
    const result = prepareArgusWorkspace(
      baseGroup,
      'implement the action panel',
    );
    expect(result).not.toBeNull();
    expect(result!.modifiedGroup.containerConfig!.additionalMounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ containerPath: 'repo', readonly: false }),
      ]),
    );
  });

  it('prepends repo context to prompt', () => {
    const result = prepareArgusWorkspace(baseGroup, 'fix the bug');
    expect(result!.modifiedPrompt).toContain('MrPhobos/watchtower');
    expect(result!.modifiedPrompt).toContain('/workspace/extra/repo');
    expect(result!.modifiedPrompt).toContain('fix the bug');
  });

  it('calls prepareWorkspace with argus worktrees base', () => {
    const prepareWorkspace = vi.mocked(repoManager.prepareWorkspace);
    prepareArgusWorkspace(baseGroup, 'test');
    expect(prepareWorkspace).toHaveBeenCalledWith(
      'MrPhobos',
      'watchtower',
      expect.stringMatching(/^argus-/),
      expect.stringContaining('argus-worktrees'),
    );
  });
});
