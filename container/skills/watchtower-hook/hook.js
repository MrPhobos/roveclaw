#!/usr/bin/env node
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { condense } = await import(path.join(__dirname, 'condense.js'));

const WATCHTOWER_URL = process.env.WATCHTOWER_URL || 'http://host.docker.internal:8400';
const WATCHTOWER_AUTH = process.env.WATCHTOWER_AUTH || 'admin:changeme';
const HOOK_EVENT = process.env.CLAUDE_HOOK_EVENT || '';
const SESSION_ID = process.env.CLAUDE_SESSION_ID || 'unknown';
const PARENT_AGENT = process.env.NANOCLAW_GROUP || 'unknown';
const DEVICE = 'imac';

function post(urlPath, body) {
  return new Promise((resolve) => {
    const urlObj = new URL(WATCHTOWER_URL);
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlPath,
      method: 'POST',
      timeout: 5000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'Authorization': 'Basic ' + Buffer.from(WATCHTOWER_AUTH).toString('base64'),
      },
    }, (res) => { res.resume(); resolve(); });
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.on('error', () => resolve());
    req.write(data);
    req.end();
  });
}

async function main() {
  let input = {};
  try {
    const raw = fs.readFileSync('/dev/stdin', 'utf-8');
    input = JSON.parse(raw);
  } catch {}

  const subAgentId = `${PARENT_AGENT}/sub-${input.agent_id || 'unknown'}`;

  switch (HOOK_EVENT) {
    case 'SubagentStart': {
      await post('/api/events', {
        agent_id: subAgentId,
        agent_name: `Subagent: ${input.agent_type || 'unknown'}`,
        parent_agent_id: PARENT_AGENT,
        device: DEVICE,
        event_type: 'session_start',
        timestamp: new Date().toISOString(),
        summary: `Subagent started: ${input.agent_type || 'unknown'}`,
      });
      break;
    }

    case 'SubagentStop': {
      await post('/api/events', {
        agent_id: subAgentId,
        agent_name: `Subagent: ${input.agent_type || 'unknown'}`,
        parent_agent_id: PARENT_AGENT,
        device: DEVICE,
        event_type: 'session_end',
        timestamp: new Date().toISOString(),
        summary: `Subagent finished: ${String(input.last_assistant_message || '').slice(0, 120)}`,
      });

      const transcriptPath = input.agent_transcript_path;
      if (transcriptPath && fs.existsSync(transcriptPath)) {
        try {
          const condensed = condense(transcriptPath);
          await post('/api/transcripts', {
            agent_id: subAgentId,
            parent_agent_id: PARENT_AGENT,
            started_at: new Date().toISOString(),
            ended_at: new Date().toISOString(),
            summary: String(input.last_assistant_message || '').slice(0, 200),
            content: condensed,
          });
        } catch {}
      }
      break;
    }

    case 'PostToolUse': {
      const toolName = input.tool_name || 'unknown';
      const toolInput = input.tool_input || {};
      let summary = toolName;
      if (toolName === 'Bash' && toolInput.command) {
        summary = `Bash: ${toolInput.command.slice(0, 120)}`;
      } else if (toolName === 'Edit' && toolInput.file_path) {
        summary = `Edit: ${toolInput.file_path}`;
      } else if (toolName === 'Read' && toolInput.file_path) {
        summary = `Read: ${toolInput.file_path}`;
      } else if (toolName === 'Write' && toolInput.file_path) {
        summary = `Write: ${toolInput.file_path}`;
      }
      await post('/api/events', {
        agent_id: PARENT_AGENT,
        agent_name: PARENT_AGENT,
        device: DEVICE,
        event_type: 'tool_use',
        timestamp: new Date().toISOString(),
        summary,
      });
      break;
    }

    case 'Stop': {
      const stopEvent = {
        agent_id: PARENT_AGENT,
        agent_name: PARENT_AGENT,
        device: DEVICE,
        event_type: 'session_end',
        timestamp: new Date().toISOString(),
        summary: `Session ended`,
      };
      const stopUsage = input.usage;
      const stopModel = input.model;
      if (stopUsage && stopModel) {
        stopEvent.tokens = {
          input: stopUsage.input_tokens || 0,
          output: stopUsage.output_tokens || 0,
          cache_read: stopUsage.cache_read_input_tokens || 0,
          cache_create: stopUsage.cache_creation_input_tokens || 0,
          model: stopModel,
        };
      }
      await post('/api/events', stopEvent);

      const transcriptPath = input.transcript_path;
      if (transcriptPath && fs.existsSync(transcriptPath)) {
        try {
          const condensed = condense(transcriptPath);
          await post('/api/transcripts', {
            agent_id: PARENT_AGENT,
            started_at: new Date().toISOString(),
            ended_at: new Date().toISOString(),
            summary: String(input.last_assistant_message || '').slice(0, 200),
            content: condensed,
          });
        } catch {}
      }
      break;
    }

    case 'Notification': {
      const message = input.message || input.notification || '';
      await post('/api/events', {
        agent_id: PARENT_AGENT,
        agent_name: PARENT_AGENT,
        device: DEVICE,
        event_type: 'notification',
        timestamp: new Date().toISOString(),
        summary: message.length > 200 ? message.slice(0, 200) + '...' : message,
      });
      break;
    }
  }
}

main().catch(() => process.exit(0));
