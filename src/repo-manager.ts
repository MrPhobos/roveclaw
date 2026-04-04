/**
 * Repo Manager for Bob
 * Handles: parsing repo references from messages, cloning repos,
 * creating/cleaning up git worktrees for task isolation.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { logger } from './logger.js';

const REPOS_BASE = path.join(os.homedir(), 'bob-repos');
const WORKTREES_BASE = path.join(os.homedir(), 'bob-worktrees');

export interface RepoRef {
  owner: string;
  repo: string;
  cleanedMessage: string;
}

/**
 * Parse an {owner}/{repo} reference from a message.
 * Returns null if no repo reference found.
 * Filters out file paths (containing dots before slash).
 */
export function parseRepoRef(message: string): RepoRef | null {
  const match = message.match(
    /(?:^|\s)([A-Za-z0-9-]+\/[A-Za-z0-9_-]+)(?:\s|$)/,
  );
  if (!match) return null;

  const full = match[1];
  const [owner, repo] = full.split('/');

  const cleanedMessage = message.replace(full, '').replace(/\s+/g, ' ').trim();
  return { owner, repo, cleanedMessage };
}

/**
 * Ensure a repo is cloned locally. Fetch latest if already cloned.
 * Returns the path to the local clone.
 */
export function ensureRepo(owner: string, repo: string): string {
  const repoDir = path.join(REPOS_BASE, owner, repo);

  if (fs.existsSync(path.join(repoDir, '.git'))) {
    logger.info({ owner, repo }, 'Fetching latest for existing repo');
    execFileSync('git', ['fetch', 'origin'], { cwd: repoDir, timeout: 60_000 });
  } else {
    logger.info({ owner, repo }, 'Cloning repo for first time');
    fs.mkdirSync(path.join(REPOS_BASE, owner), { recursive: true });
    const url = `https://github.com/${owner}/${repo}.git`;
    execFileSync('git', ['clone', url, repoDir], { timeout: 120_000 });
  }

  return repoDir;
}

function getDefaultBranch(repoDir: string): string {
  return execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
    cwd: repoDir,
    encoding: 'utf-8',
    timeout: 10_000,
  })
    .trim()
    .replace('refs/remotes/origin/', '');
}

/**
 * Create a git worktree for a task. Returns the worktree path.
 */
export function createWorktree(repoDir: string, jobId: string): string {
  const worktreePath = path.join(WORKTREES_BASE, jobId);
  fs.mkdirSync(WORKTREES_BASE, { recursive: true });

  const branchName = `bob/${jobId}`;
  const defaultBranch = getDefaultBranch(repoDir);

  execFileSync(
    'git',
    [
      'worktree',
      'add',
      '-b',
      branchName,
      worktreePath,
      `origin/${defaultBranch}`,
    ],
    { cwd: repoDir, timeout: 30_000 },
  );

  logger.info({ jobId, worktreePath, branchName }, 'Created worktree');
  return worktreePath;
}

/**
 * Clean up a worktree after task completion.
 */
export function cleanupWorktree(repoDir: string, jobId: string): void {
  const worktreePath = path.join(WORKTREES_BASE, jobId);
  try {
    execFileSync('git', ['worktree', 'remove', worktreePath, '--force'], {
      cwd: repoDir,
      timeout: 15_000,
    });
    logger.info({ jobId }, 'Cleaned up worktree');
  } catch (err) {
    logger.warn(
      { jobId, error: err instanceof Error ? err.message : String(err) },
      'Failed to clean up worktree',
    );
  }
}

/**
 * Clone if needed, create worktree, return paths.
 */
export function prepareWorkspace(
  owner: string,
  repo: string,
  jobId: string,
): { repoDir: string; worktreePath: string } {
  const repoDir = ensureRepo(owner, repo);
  const worktreePath = createWorktree(repoDir, jobId);
  return { repoDir, worktreePath };
}

/**
 * Read default repo from a group CLAUDE.md.
 * Expects format: "## Default Repository\n\n{owner}/{repo}"
 */
export function readDefaultRepo(
  claudeMdPath: string,
): { owner: string; repo: string } | null {
  try {
    const content = fs.readFileSync(claudeMdPath, 'utf-8');
    const match = content.match(
      /## Default Repository\s+([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)/,
    );
    if (!match) return null;
    const [owner, repo] = match[1].split('/');
    return { owner, repo };
  } catch {
    return null;
  }
}
