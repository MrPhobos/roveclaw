/**
 * Argus workspace preparation — called from runAgent in index.ts.
 * Always works on MrPhobos/watchtower. Uses ~/argus-worktrees/ for isolation.
 */
import path from 'path';
import os from 'os';

import { logger } from './logger.js';
import { prepareWorkspace } from './repo-manager.js';
import { RegisteredGroup } from './types.js';

const OWNER = 'MrPhobos';
const REPO = 'watchtower';
const ARGUS_WORKTREES = path.join(os.homedir(), 'argus-worktrees');

export function prepareArgusWorkspace(
  group: RegisteredGroup,
  prompt: string,
): {
  modifiedGroup: RegisteredGroup;
  modifiedPrompt: string;
  repoDir: string;
  jobId: string;
  worktreesBase: string;
} | null {
  if (group.folder !== 'telegram_argus') return null;

  const jobId = `argus-${Date.now()}`;

  let repoDir: string;
  let worktreePath: string;
  try {
    const workspace = prepareWorkspace(OWNER, REPO, jobId, ARGUS_WORKTREES);
    repoDir = workspace.repoDir;
    worktreePath = workspace.worktreePath;
  } catch (err) {
    logger.error(
      { error: err instanceof Error ? err.message : String(err) },
      'Argus: failed to prepare workspace',
    );
    return null;
  }

  const modifiedGroup: RegisteredGroup = {
    ...group,
    containerConfig: {
      ...group.containerConfig,
      timeout: group.containerConfig?.timeout ?? 600_000,
      additionalMounts: [
        ...(group.containerConfig?.additionalMounts ?? []),
        {
          hostPath: worktreePath,
          containerPath: 'repo',
          readonly: false,
        },
        {
          hostPath: repoDir,
          containerPath: 'watchtower-base',
          readonly: true,
        },
      ],
    },
  };

  const repoContext = [
    `You are working on https://github.com/${OWNER}/${REPO}.`,
    'Your working copy is at /workspace/extra/repo (a git worktree).',
    'cd there before starting work.',
    '',
    '',
  ].join('\n');
  const modifiedPrompt = repoContext + prompt;

  return {
    modifiedGroup,
    modifiedPrompt,
    repoDir,
    jobId,
    worktreesBase: ARGUS_WORKTREES,
  };
}
