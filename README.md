# LatteX

<p align="center">
  <img src="resources/logo.svg" width="128" height="128" alt="LatteX logo">
</p>

<p align="center">
  LaTeX editor with real-time Overleaf sync, themed in <a href="https://en.wikipedia.org/wiki/Cosmic_latte">Cosmic Latte</a>.
</p>

## Features

- **Real-time Overleaf sync** — WebSocket-based OT collaboration, live co-editing
- **Bidirectional file sync** — edit `.tex` files on disk (e.g. with Claude Code in the integrated terminal) and changes sync to Overleaf automatically
- **Claude Code ready** — built-in MCP server for seamless [Claude Code](https://docs.anthropic.com/en/docs/claude-code) integration (see below)
- **Local LaTeX compilation** — compile PDFs locally with `latexmk`, no Overleaf compile limits
- **PDF viewer** — built-in viewer with SyncTeX forward/inverse search, pinch-to-zoom, text search
- **Search** — in-file find/replace (Cmd+F), multi-file search (Cmd+Shift+F), PDF text search
- **LaTeX autocomplete** — commands, environments, `\ref`, `\cite`, file paths
- **Comments & review** — inline comment highlights with review panel
- **Collaborator cursors** — see other editors' positions in real-time
- **Project chat** — real-time chat panel
- **Integrated terminal** — built-in terminal for CLI tools

## Install

Download the latest `.dmg` from [Releases](https://github.com/YurenHao0426/lattex/releases).

> **Note:** The app is not signed with an Apple Developer certificate. On first launch, macOS will block it. Go to **System Settings → Privacy & Security**, scroll down and click **Open Anyway**.

### Requirements

- macOS (Apple Silicon) — primary platform
- Windows 10+ (x64) — experimental installer built by CI (`lattex-*-win-x64.exe`); expects [TeX Live](https://www.tug.org/texlive/) or [MiKTeX](https://miktex.org/) for local compilation
- [TeX Live](https://www.tug.org/texlive/) or [MacTeX](https://www.tug.org/mactex/) for local compilation on macOS

## Recommended: Claude Code

We recommend using [Claude Code](https://docs.anthropic.com/en/docs/claude-code) for AI-assisted LaTeX writing. Install it separately, then use it directly in LatteX's integrated terminal — LatteX provides seamless integration out of the box.

When you open a project, LatteX automatically configures everything Claude Code needs:

- `.mcp.json` — registers the LatteX MCP server so Claude Code can interact with Overleaf
- `.claude/CLAUDE.md` — project context and tool documentation
- `.claude/settings.json` — pre-approved MCP tool permissions (no manual approval needed)

### Usage

1. [Install Claude Code](https://docs.anthropic.com/en/docs/claude-code) if you haven't already
2. Open a project in LatteX
3. Open the integrated terminal (Cmd+\`)
4. Run `claude` — it auto-discovers the MCP server, no configuration needed

Claude Code can edit `.tex` files directly — changes sync to Overleaf in real-time. In addition, the MCP server gives Claude Code extra capabilities beyond file editing:

- **Comments** — read, reply to, resolve, reopen, or delete reviewer comments
- **Compilation** — trigger server-side compilation, inspect errors and warnings
- **Project chat** — read and send messages to collaborators
- **File listing** — list all project files with sizes

### Available MCP Tools

| Tool | Description |
|------|-------------|
| `get_comments` | Read comments, optionally filtered by file |
| `resolve_comment` | Resolve a comment thread |
| `reopen_comment` | Reopen a resolved comment |
| `reply_to_comment` | Reply to a comment thread |
| `delete_comment` | Permanently delete a comment thread |
| `get_chat_messages` | Read project chat history |
| `send_chat_message` | Send a message to project chat |
| `list_project_files` | List all project files with sizes |
| `compile_latex` | Trigger server-side LaTeX compilation |
| `set_main_file` | Set the project's main document (persists on Overleaf) |
| `get_compile_errors` | Get parsed errors from last compile |
| `get_compile_warnings` | Get parsed warnings from last compile |
| `get_compile_log` | Get raw compile log output |
| `search_citation` | Search papers on Semantic Scholar, returns BibTeX |
| `search_openalex` | Search works on OpenAlex; BibTeX cross-checked against Semantic Scholar (unverified entries are flagged) |

### Example Workflow

```
> claude

You: Review the comments on this paper and address the feedback

Claude: [calls get_comments] I see 3 comments...
        [edits sections/intro.tex to address feedback]
        [calls reply_to_comment] "Revised the introduction as suggested."
        [calls resolve_comment]
        [calls compile_latex] Compilation successful, no errors.
```

No configuration needed — LatteX sets everything up automatically when you open a project.

## Headless / Agent Mode (CLI)

`lattex-cli` is a headless CLI for working with Overleaf projects from a server with no display. It is designed for AI agents — short output, `--json` mode on every command, meaningful exit codes, errors on stderr.

### Install

```bash
# From the repo root:
npm run build:cli
# The CLI is at out/cli/lattex-cli.mjs — run with Node 18+:
node out/cli/lattex-cli.mjs --help
# Or create an alias:
alias lattex-cli='node /path/to/lattex/out/cli/lattex-cli.mjs'
```

### Authentication

The CLI needs an Overleaf session cookie. Three ways to provide it:

```bash
# 1. Direct cookie string (from browser dev tools → Application → Cookies)
lattex-cli auth --cookie "overleaf_session2=s%3A..."

# 2. From environment variable
export LATTEX_COOKIE="overleaf_session2=s%3A..."
lattex-cli projects

# 3. From a running Chromium with remote debugging (e.g. --remote-debugging-port=18801)
lattex-cli auth --from-cdp http://127.0.0.1:18801
```

The cookie is stored at `~/.config/lattex/auth.json` with mode 600. Cookie values are never printed.

### Commands

```bash
# List projects
lattex-cli projects [--json]

# Clone a project to a local directory
lattex-cli clone <project-id-or-name> <dir>

# Pull latest changes from Overleaf
lattex-cli pull <dir>

# Show local changes
lattex-cli status <dir>

# Push local changes to Overleaf
lattex-cli push <dir> [--dry-run] [--delete] [--force]
#   --dry-run   Show what would be pushed without pushing
#   --delete    Allow deleting remote files that were deleted locally
#   --force     Push even if remote has changed since last pull

# Compile on Overleaf server and download PDF
lattex-cli compile <dir> [--out output.pdf]
```

All commands accept `--json` for machine-readable output.

### Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error |
| 2 | Authentication error |
| 3 | Conflict (remote changed) |
| 64 | Usage error |

### Example: Template Migration (AAAI → ICLR)

```bash
lattex-cli auth --cookie "$OVERLEAF_COOKIE"
lattex-cli clone "My AAAI Paper" /tmp/paper
cd /tmp/paper
# ... edit files to change template ...
lattex-cli push . --dry-run          # preview changes
lattex-cli push .                    # upload
lattex-cli compile . --out paper.pdf # compile and download PDF
```

### Testing with a Live Session

The CLI requires a valid Overleaf session for all commands except `--help` and `status`. To test live:

```bash
# 1. Get your Overleaf cookie (browser → dev tools → Application → Cookies → overleaf_session2)
# 2. Auth
lattex-cli auth --cookie "overleaf_session2=..."
# 3. List projects to verify
lattex-cli projects --json
# 4. Clone, edit, push, compile
lattex-cli clone <project-id> /tmp/test-project
echo "% test" >> /tmp/test-project/main.tex
lattex-cli status /tmp/test-project
lattex-cli push /tmp/test-project --dry-run
```

## Development

```bash
npm install
npm run dev
```

### Build

```bash
npm run build                    # Electron app + MCP server
npm run build:cli                # Headless CLI (out/cli/lattex-cli.mjs)
npx electron-builder --mac dmg   # macOS installer
```

## License

[AGPL-3.0](LICENSE)
