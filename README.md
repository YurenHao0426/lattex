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

> **Note:** This is an unsigned build. On first launch, right-click → Open, or allow it in System Settings → Privacy & Security.

### Requirements

- macOS (Apple Silicon)
- [TeX Live](https://www.tug.org/texlive/) or [MacTeX](https://www.tug.org/mactex/) for local compilation

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
| `get_compile_errors` | Get parsed errors from last compile |
| `get_compile_warnings` | Get parsed warnings from last compile |
| `get_compile_log` | Get raw compile log output |

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

## Development

```bash
npm install
npm run dev
```

### Build

```bash
npm run build
npx electron-builder --mac dmg
```

## License

[AGPL-3.0](LICENSE)
