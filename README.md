# LatteX

<p align="center">
  <img src="resources/logo.svg" width="128" height="128" alt="LatteX logo">
</p>

<p align="center">
  LaTeX editor with real-time Overleaf sync, themed in Cosmic Latte.
</p>

## Features

- **Real-time Overleaf sync** — WebSocket-based OT collaboration, live co-editing
- **Bidirectional file sync** — edit `.tex` files on disk (e.g. with Claude Code in the integrated terminal) and changes sync to Overleaf automatically
- **Local LaTeX compilation** — compile PDFs locally with `latexmk`, no Overleaf compile limits
- **PDF viewer** — built-in viewer with SyncTeX forward/inverse search, pinch-to-zoom
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
