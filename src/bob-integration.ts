/**
 * Bob workspace preparation — called from runAgent in index.ts
 * For Bob's group: prepare a repo workspace and return modified group + prompt.
 */
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';
import {
  parseRepoRef,
  prepareWorkspace,
  readDefaultRepo,
} from './repo-manager.js';
import { RegisteredGroup } from './types.js';

export function prepareBobWorkspace(
  group: RegisteredGroup,
  prompt: string,
  groupsDir: string,
): {
  modifiedGroup: RegisteredGroup;
  modifiedPrompt: string;
  repoDir: string;
  jobId: string;
  worktreesBase?: string;
} | null {
  if (group.folder !== 'telegram_bob') return null;

  // Extract raw message content from XML-formatted prompt
  const messageMatches = prompt.match(/<message[^>]*>([\s\S]*?)<\/message>/g);
  const rawText = messageMatches
    ? messageMatches
        .map((m) => {
          const content = m
            .replace(/<message[^>]*>/, '')
            .replace(/<\/message>/, '');
          return content
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"');
        })
        .join(' ')
    : prompt;

  // Parse repo reference from message
  const repoRef = parseRepoRef(rawText);
  let owner: string;
  let repo: string;

  if (repoRef) {
    owner = repoRef.owner;
    repo = repoRef.repo;
  } else {
    const claudeMdPath = path.join(groupsDir, 'telegram_bob', 'CLAUDE.md');
    const defaultRepo = readDefaultRepo(claudeMdPath);
    if (!defaultRepo) {
      logger.warn('Bob: no repo specified and no default configured');
      return null;
    }
    owner = defaultRepo.owner;
    repo = defaultRepo.repo;
  }

  const jobId = `bob-${Date.now()}`;

  let repoDir: string;
  let worktreePath: string;
  try {
    const workspace = prepareWorkspace(owner, repo, jobId);
    repoDir = workspace.repoDir;
    worktreePath = workspace.worktreePath;
  } catch (err) {
    logger.error(
      {
        owner,
        repo,
        error: err instanceof Error ? err.message : String(err),
      },
      'Bob: failed to prepare workspace',
    );
    return null;
  }

  // Create modified group with worktree as additional mount
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
          containerPath: repoDir.split('/').pop() + '-base',
          readonly: false,
        },
      ],
    },
  };

  const repoContext = [
    `You are working on https://github.com/${owner}/${repo}.`,
    'Your working copy is at /workspace/extra/repo (a git worktree).',
    'cd there before starting work.',
    '',
    '',
  ].join('\n');
  const modifiedPrompt = repoContext + prompt;

  return { modifiedGroup, modifiedPrompt, repoDir, jobId };
}
