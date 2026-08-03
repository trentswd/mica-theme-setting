# Mica Theme Setting

Mica Theme Setting is the desktop companion for [Obsidian Mica](https://github.com/trentswd/obsidian-mica). It applies native Windows backdrop materials to the main Obsidian window and to settings or pop-out windows created later.

## Features

- Mica, Mica Alt, Acrylic, and solid fallback modes.
- Native material applied consistently to current and future Obsidian windows.
- Acrylic tint opacity and additional CSS blur controls.
- True overlay scrollbars for the main window and later pop-out windows, with draggable Windows-style thumbs.
- Automatic cleanup when the plugin is disabled.
- Windows-only behavior; unsupported platforms keep their normal opaque surface.

## Requirements

- Obsidian 1.13 or later.
- Windows 11 for native Mica materials.
- [Obsidian Mica](https://github.com/trentswd/obsidian-mica) for the matching transparent and opaque surface layout.

## Install with BRAT

1. Install and enable [BRAT](https://github.com/TfTHacker/obsidian42-brat).
2. Run **BRAT: Add a beta plugin for testing**.
3. Enter `trentswd/mica-theme-setting` or the full repository URL.
4. Enable **Mica Theme Setting** under Community plugins.

BRAT installs and updates the plugin from GitHub Releases. Each release includes `manifest.json`, `main.js`, and `styles.css` as assets.

## Manual installation

1. Download `manifest.json`, `main.js`, and `styles.css` from the latest GitHub release.
2. Put them in `.obsidian/plugins/mica-theme-setting/` inside your vault.
3. Reload Obsidian and enable **Mica Theme Setting**.

## Development

This repository contains the ready-to-run plugin files at its root. Check the bundled JavaScript with:

```sh
npm run check
```

The plugin uses Obsidian's Electron runtime to configure the native `BrowserWindow` backdrop. The original Pseudo Mica plugin is not required.
