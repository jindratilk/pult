# Installing Pult (instructions for your AI agent)

The user wants Pult installed. They gave you this folder, a zip, or the link https://github.com/jan-visual/pult. Follow these steps and only interrupt the user when you really have to. Talk to the user in their own language.

## 0. Get the code

If you only have the link: `git clone https://github.com/jan-visual/pult ~/pult-source` (Windows PowerShell: `git clone https://github.com/jan-visual/pult "$HOME\pult-source"`) and work in that folder. Do not clone it to `~/pult`: on macOS that is the same folder as the default library `~/Pult`. Without git, download the ZIP from GitHub (Code › Download ZIP) and unpack it.

## 1. Check the system and Python

- **macOS:** `python3 --version` (3.9 or newer; macOS ships it with the Command Line Tools). If it is missing, offer `xcode-select --install` or `brew install python`. The Command Line Tools also build the native Pult app, so check `xcode-select -p` too and offer `xcode-select --install` if it fails.
- **Windows (PowerShell):** `py --version`. If it is missing: `winget install -e --id Python.Python.3.12`, then open a new terminal.

## 2. ffmpeg (needed for video)

- **macOS:** `which ffmpeg ffprobe`. If missing and Homebrew is available: `brew install ffmpeg`.
- **Windows:** `where.exe ffmpeg`. If missing: `winget install -e --id Gyan.FFmpeg`.
- Without ffmpeg, Pult works for images only. Tell the user when you install ffmpeg; it is a public open-source package.

## 3. Install

Run from the folder that contains this file:

- **macOS:** `python3 install.py`
- **Windows:** `py install.py`

Options: `--library PATH` (where review batches are stored, default `~/Pult`), `--port 7858`, `--no-open` (do not open the browser), `--install-ffmpeg` (try to install ffmpeg automatically), `--dictation` (also install local dictation, see below), `--lang en|cs` (interface language; by default it follows the browser), `--no-claude` (leave AI agent files alone), `--agent-instructions` (see below).

**Microphone dictation:** on first launch Pult shows a short setup guide. The recommended option is ElevenLabs Scribe: the user pastes their own API key into the guide and nothing gets installed. Install local Whisper (free and private, a few GB of libraries and models) only if the user asks for it: `--dictation` during install, or `pult dictation install` at any time. On Windows it needs Python 3.9 to 3.13.

The installer:
- copies the app (macOS `~/Library/Application Support/Pult/app`, Windows `%LOCALAPPDATA%\Pult\app`),
- makes it start at login (macOS LaunchAgent `cz.pult.server`, Windows `Pult.vbs` in the Startup folder) and starts the server right away,
- creates the `pult` command (macOS `~/.local/bin/pult`, Windows `%LOCALAPPDATA%\Pult\bin\pult.cmd`, added to PATH),
- on macOS builds the native **Pult app** (`~/Applications/Pult.app`: its own window, Dock icon and microphone for dictation; compiled locally with `swiftc` from the Command Line Tools in a few seconds) and adds it to the Dock (skip with `--no-dock`). If it prints `! Native app not built`, run `xcode-select --install`, wait until it finishes and run the installer again; on Windows it creates Start menu › Pult,
- teaches the AI agents on this computer to use Pult by installing the `pult` skill for Claude Code (`~/.claude/skills/pult/`) and, when Codex is installed, for Codex (`~/.codex/skills/pult/`). It does **not** change the global `~/.claude/CLAUDE.md` or `~/.codex/AGENTS.md`, because those load in every chat of every project. Add `--agent-instructions` only if the user asks for that. `--no-agent-instructions` removes the block again. Both choices are remembered for updates,
- prints a JSON status at the end and opens Pult (on macOS the app, elsewhere the browser).

## 4. Verify

```
pult doctor
pult status
```

(On Windows use a new terminal, or the full path printed by the installer.) Everything must show ✓. Then send a test image to Pult so the user can see it works:

```
pult add -t "Pult test" <any image or video>
```

## 5. Tell the user (briefly)

- **macOS:** Pult is an app in the Dock and in `~/Applications`. The first time they dictate, macOS asks for microphone access: allow it.
- **Windows:** open Pult from the Start menu; for its own window use Edge or Chrome › Pult's Settings › App › **Install Pult**.
- The Pult server runs in the background at **http://localhost:7858** and starts by itself after every login (iPad and colleagues use it through Settings › Team).
- Add files by dragging them into the window, with the **Add** button, or by asking you to "send it to Pult".
- Draw right on the frame, type or dictate comments (microphone, key D), approve (S) or reject (X), then **Send review** (⌘/Ctrl+Enter).
- Whenever you send something to Pult, run `pult wait <id>` in the background: the review then arrives straight in the chat. Otherwise read it when the user says "check Pult".
- Team: Settings › Team › **Share on the network** gives a link and an access code for colleagues on the same network (on Windows, allow private networks in the firewall prompt).
- Shortcuts: press **?** in Pult.

## Updating and uninstalling

- New version: run `pult update`. It downloads the update into the folder Pult was installed from and installs it. The library and settings are kept. Tell the user the new version and what changed.
- If it reports local changes or own commits in that folder, stop and tell the user. Do not discard them.
- If it reports that the repository history was rewritten, stop and tell the user. Run `pult update --accept-rewritten-history` only after they confirm they trust the new history.
- Older Pult without `pult update` (unknown command): find the folder it was installed from (it has `install.py` and `pult/server.py`, usually `~/pult-source`), run `git pull --ff-only` there, then `python3 install.py --no-open`. If there is no such folder, or git refuses because the histories differ and the folder has no changes of its own, clone the link the user gave you into a new folder `~/pult-source-new` and run `python3 install.py --no-open` from it. Do not delete the old folder.
- Installed from a zip: download the new zip, then run `install.py` again.
- Uninstall: `python3 install.py --uninstall` (Windows `py install.py --uninstall`). The library with batches stays; `--purge` also deletes the settings.
