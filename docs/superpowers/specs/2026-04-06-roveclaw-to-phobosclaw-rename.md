# Rename: RoveClaw -> PhobosClaw

## Motivation

"Rove" is Robert's headhunter persona. The project outgrew that origin. Rename the infrastructure to PhobosClaw while keeping `ASSISTANT_NAME=Rove` (the chat-facing identity).

## Scope

Every occurrence of `roveclaw`, `RoveClaw`, or `Roveclaw` becomes `phobosclaw`, `PhobosClaw`, or `Phobosclaw` respectively - except `ASSISTANT_NAME=Rove` which stays.

## Changes

### In-repo code

| File | What changes |
|------|-------------|
| `src/index.ts` | `parent_agent_id`, `agentId`, `agentName`, log summaries |
| `src/reporter.ts` | `parentAgentId` |
| `CLAUDE.md` | Watchtower section prose (GitNexus block regenerates) |
| `launchd/dev.roveclaw.plist` -> `launchd/dev.phobosclaw.plist` | Label, paths, log paths. Keep `ASSISTANT_NAME=Rove` |

### GitHub

- Rename repo `MrPhobos/roveclaw` -> `MrPhobos/phobosclaw` via `gh repo rename`

### iMac (live system)

1. `launchctl unload ~/Library/LaunchAgents/dev.roveclaw.plist`
2. `mv ~/roveclaw ~/phobosclaw`
3. `cd ~/phobosclaw && git remote set-url origin https://github.com/MrPhobos/phobosclaw.git`
4. Deploy new `dev.phobosclaw.plist` to `~/Library/LaunchAgents/`
5. Remove old `~/Library/LaunchAgents/dev.roveclaw.plist`
6. `launchctl load ~/Library/LaunchAgents/dev.phobosclaw.plist`

### Local machine

1. Update git remote URL
2. Rename `~/Documents/dev/roveclaw` -> `~/Documents/dev/phobosclaw`
3. Update `~/.claude/CLAUDE.md`: `dev.roveclaw` -> `dev.phobosclaw`

### Auto-generated (no manual edit)

- `AGENTS.md` and GitNexus block in `CLAUDE.md` - regenerate via `npx gitnexus analyze`

## Order of operations

1. Code changes, commit, push (while current paths still work)
2. GitHub repo rename
3. Update git remotes (both machines)
4. iMac: unload, rename dir, deploy new plist, load
5. Local: rename dir, update global CLAUDE.md
6. Re-index GitNexus

## Preserved

- `ASSISTANT_NAME=Rove`
- `package.json` name
- WhatsApp/Telegram auth, groups, data (path-relative)
- Watchtower auth tokens
