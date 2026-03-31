/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent response cycle).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { spawn, execFile } from 'child_process';
import { fileURLToPath } from 'url';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;
const MCP_CONFIG_PATH = '/workspace/group/.mcp.json';
const SOUL_MD_PATH = '/workspace/global/SOUL.md';
const BASH_HOOK_SCRIPT_PATH = '/tmp/hooks/sanitize-bash.js';

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

/**
 * Write .mcp.json to /workspace/group/ so the claude CLI picks it up.
 * Uses env var names that ipc-mcp-stdio.ts reads.
 */
function writeMcpConfig(
  containerInput: ContainerInput,
  mcpServerPath: string,
): void {
  const config = {
    mcpServers: {
      nanoclaw: {
        command: 'node',
        args: [mcpServerPath],
        env: {
          NANOCLAW_CHAT_JID: containerInput.chatJid,
          NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
          NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
        },
      },
    },
  };
  fs.mkdirSync(path.dirname(MCP_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(MCP_CONFIG_PATH, JSON.stringify(config, null, 2));
}

/**
 * Write a Node.js PreToolUse hook that strips credential env vars
 * from every Bash command spawned by claude, via settings.json.
 */
function writeBashSanitizationHook(): void {
  // Write the Node.js hook script
  const hookScript = [
    '#!/usr/bin/env node',
    'const chunks = [];',
    "process.stdin.on('data', (c) => chunks.push(c));",
    "process.stdin.on('end', () => {",
    '  const input = JSON.parse(Buffer.concat(chunks).toString());',
    "  if (input.tool_input && typeof input.tool_input.command === 'string') {",
    '    input.tool_input.command =',
    "      'unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_AUTH_TOKEN 2>/dev/null; ' +",
    '      input.tool_input.command;',
    '  }',
    '  process.stdout.write(JSON.stringify(input));',
    '});',
  ].join('\n') + '\n';

  fs.mkdirSync('/tmp/hooks', { recursive: true });
  fs.writeFileSync(BASH_HOOK_SCRIPT_PATH, hookScript, { mode: 0o755 });

  // Read existing settings.json (or start fresh)
  const settingsPath = path.join(process.env.HOME || '/home/node', '.claude', 'settings.json');
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch {
    /* file may not exist yet */
  }

  // Merge PreToolUse hook for Bash
  const hooks = (settings.hooks as Record<string, unknown>) || {};
  const preToolUse = (hooks.PreToolUse as unknown[]) || [];

  // Remove any existing Bash sanitization entry to avoid duplicates
  const filtered = (preToolUse as Array<Record<string, unknown>>).filter((entry) => {
    return !(entry.matcher === 'Bash' && JSON.stringify(entry.hooks).includes('sanitize-bash'));
  });

  filtered.push({
    matcher: 'Bash',
    hooks: [{ type: 'command', command: `node ${BASH_HOOK_SCRIPT_PATH}` }],
  });

  settings.hooks = { ...hooks, PreToolUse: filtered };

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function getSessionSummary(
  sessionId: string,
  transcriptPath: string,
): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(
      fs.readFileSync(indexPath, 'utf-8'),
    );
    const entry = index.entries.find((e) => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(
      `Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return null;
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text =
          typeof entry.message.content === 'string'
            ? entry.message.content
            : entry.message.content
                .map((c: { text?: string }) => c.text || '')
                .join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {}
  }

  return messages;
}

function formatTranscriptMarkdown(
  messages: ParsedMessage[],
  title?: string | null,
  assistantName?: string,
): string {
  const now = new Date();
  const formatDateTime = (d: Date) =>
    d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : assistantName || 'Assistant';
    const content =
      msg.content.length > 2000
        ? msg.content.slice(0, 2000) + '...'
        : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Archive the full transcript before compaction.
 * Called when we detect a pre_compact event in the stream.
 */
function archiveTranscript(
  transcriptPath: string,
  sessionId: string,
  assistantName?: string,
): void {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    log('No transcript found for archiving');
    return;
  }

  try {
    const content = fs.readFileSync(transcriptPath, 'utf-8');
    const messages = parseTranscript(content);

    if (messages.length === 0) {
      log('No messages to archive');
      return;
    }

    const summary = getSessionSummary(sessionId, transcriptPath);
    const name = summary ? sanitizeFilename(summary) : generateFallbackName();

    const conversationsDir = '/workspace/group/conversations';
    fs.mkdirSync(conversationsDir, { recursive: true });

    const date = new Date().toISOString().split('T')[0];
    const filename = `${date}-${name}.md`;
    const filePath = path.join(conversationsDir, filename);

    const markdown = formatTranscriptMarkdown(messages, summary, assistantName);
    fs.writeFileSync(filePath, markdown);

    log(`Archived conversation to ${filePath}`);
  } catch (err) {
    log(
      `Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try {
      fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    } catch {
      /* ignore */
    }
    return true;
  }
  return false;
}

function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(
          `Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* ignore */
        }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      const messages = drainIpcInput();
      if (shouldClose()) {
        resolve(null);
        return;
      }
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Run a single claude CLI subprocess and stream results via writeOutput.
 * Pipes IPC messages as follow-up user turns via stdin stream-json.
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  containerInput: ContainerInput,
): Promise<{ newSessionId?: string; closedDuringQuery: boolean }> {
  // Build claude CLI args
  const args: string[] = [
    '--dangerously-skip-permissions',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    '-p',
    '--verbose',
  ];

  if (sessionId) {
    args.push('--resume', sessionId);
  }

  // Load SOUL.md as appended system prompt if present
  if (fs.existsSync(SOUL_MD_PATH)) {
    const soulContent = fs.readFileSync(SOUL_MD_PATH, 'utf-8');
    args.push('--append-system-prompt', soulContent);
  }

  // Load global CLAUDE.md as additional system context (for non-main groups)
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    const globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
    args.push('--append-system-prompt', globalClaudeMd);
  }

  // Discover extra directories
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        args.push('--add-dir', fullPath);
      }
    }
  }

  log(`Spawning claude CLI (session: ${sessionId || 'new'})...`);

  const child = spawn('claude', args, {
    cwd: '/workspace/group',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
    },
  });

  let newSessionId: string | undefined;
  let closedDuringQuery = false;
  let ipcPolling = true;
  let messageCount = 0;
  let resultText: string | null = null;

  // Write initial user message as stream-json
  const initialMessage = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: prompt },
  });
  child.stdin.write(initialMessage + '\n');

  // Poll IPC during query, pipe follow-up messages to claude's stdin
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    const messages = drainIpcInput();
    if (shouldClose()) {
      log('Close sentinel detected during query, ending stdin');
      closedDuringQuery = true;
      ipcPolling = false;
      child.stdin.end();
      return;
    }
    for (const text of messages) {
      log(`Piping IPC message into active query (${text.length} chars)`);
      const msg = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: text },
      });
      child.stdin.write(msg + '\n');
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  // Parse stream-json output from claude CLI
  await new Promise<void>((resolve, reject) => {
    let lineBuffer = '';

    child.stdout.on('data', (chunk: Buffer) => {
      lineBuffer += chunk.toString();
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        messageCount++;
        try {
          const msg = JSON.parse(line);
          const msgType =
            msg.type === 'system' ? `system/${msg.subtype}` : msg.type;
          log(`[msg #${messageCount}] type=${msgType}`);

          if (msg.type === 'system' && msg.subtype === 'init') {
            newSessionId = msg.session_id;
            log(`Session initialized: ${newSessionId}`);
          }

          if (
            msg.type === 'system' &&
            msg.subtype === 'pre_compact' &&
            msg.transcript_path
          ) {
            log('Pre-compact hook: archiving transcript');
            archiveTranscript(
              msg.transcript_path,
              msg.session_id || newSessionId || '',
              containerInput.assistantName,
            );
          }

          if (msg.type === 'result') {
            const text = typeof msg.result === 'string' ? msg.result : null;
            log(
              `Result: subtype=${msg.subtype}${text ? ` text=${text.slice(0, 200)}` : ''}`,
            );
            resultText = text;
            writeOutput({
              status: 'success',
              result: text,
              newSessionId,
            });
          }
        } catch (err) {
          log(
            `Failed to parse stream-json line: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const lines = chunk.toString().trim().split('\n');
      for (const line of lines) {
        if (line) log(`[claude stderr] ${line}`);
      }
    });

    child.on('close', (code) => {
      ipcPolling = false;
      log(`Claude CLI exited with code ${code}. Messages: ${messageCount}`);
      if (code !== 0 && !resultText) {
        reject(new Error(`claude CLI exited with code ${code}`));
      } else {
        resolve();
      }
    });

    child.on('error', (err) => {
      ipcPolling = false;
      reject(err);
    });
  });

  log(`Query done. closedDuringQuery: ${closedDuringQuery}`);
  return { newSessionId, closedDuringQuery };
}

interface ScriptResult {
  wakeAgent: boolean;
  data?: unknown;
}

const SCRIPT_TIMEOUT_MS = 30_000;

async function runScript(script: string): Promise<ScriptResult | null> {
  const scriptPath = '/tmp/task-script.sh';
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  return new Promise((resolve) => {
    execFile(
      'bash',
      [scriptPath],
      {
        timeout: SCRIPT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: (() => {
          const SECRET_ENV_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN'];
          const scriptEnv = { ...process.env };
          for (const key of SECRET_ENV_VARS) {
            delete scriptEnv[key];
          }
          return scriptEnv;
        })(),
      },
      (error, stdout, stderr) => {
        if (stderr) {
          log(`Script stderr: ${stderr.slice(0, 500)}`);
        }

        if (error) {
          log(`Script error: ${error.message}`);
          return resolve(null);
        }

        const lines = stdout.trim().split('\n');
        const lastLine = lines[lines.length - 1];
        if (!lastLine) {
          log('Script produced no output');
          return resolve(null);
        }

        try {
          const result = JSON.parse(lastLine);
          if (typeof result.wakeAgent !== 'boolean') {
            log(
              `Script output missing wakeAgent boolean: ${lastLine.slice(0, 200)}`,
            );
            return resolve(null);
          }
          resolve(result as ScriptResult);
        } catch {
          log(`Script output is not valid JSON: ${lastLine.slice(0, 200)}`);
          resolve(null);
        }
      },
    );
  });
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try {
      fs.unlinkSync('/tmp/input.json');
    } catch {
      /* may not exist */
    }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  // Write .mcp.json and bash sanitization hook
  writeMcpConfig(containerInput, mcpServerPath);
  writeBashSanitizationHook();

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    /* ignore */
  }

  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Script phase: run script before waking agent
  if (containerInput.script && containerInput.isScheduledTask) {
    log('Running task script...');
    const scriptResult = await runScript(containerInput.script);

    if (!scriptResult || !scriptResult.wakeAgent) {
      const reason = scriptResult
        ? 'wakeAgent=false'
        : 'script error/no output';
      log(`Script decided not to wake agent: ${reason}`);
      writeOutput({
        status: 'success',
        result: null,
      });
      return;
    }

    log(`Script wakeAgent=true, enriching prompt with data`);
    prompt = `[SCHEDULED TASK]\n\nScript output:\n${JSON.stringify(scriptResult.data, null, 2)}\n\nInstructions:\n${containerInput.prompt}`;
  }

  // Query loop: run query -> wait for IPC message -> run new query -> repeat
  try {
    while (true) {
      log(`Starting query (session: ${sessionId || 'new'})...`);

      const queryResult = await runQuery(prompt, sessionId, containerInput);
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }

      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');

      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage,
    });
    process.exit(1);
  }
}

main();
