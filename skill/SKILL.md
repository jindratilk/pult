---
name: pult
description: Pult is a local review desk for images and videos (draw right on the frames, comment on a frame, approve or reject, team review). Use it whenever you create or edit images or videos for the user to review, when the user says "send it to Pult", "put it on Pult", "show me on Pult" (Czech: „pošli to na Pult“, „dej to na pult“), when they say "check Pult", "check the reviews", "what did I draw" (Czech: „koukni na Pult“, „koukni na revize“), or ask about their notes. Also for updating Pult ("update Pult", Czech: „aktualizuj Pult“), questions about Pult settings, team sharing or problems with Pult.
---

# Pult

Pult runs on this computer as a service: **{{URL}}**. It is controlled with the command:

```
{{PULT}}
```

(in a new terminal plain `pult` works). Library with batches and reviews: `{{LIBRARY}}`.

Talk to the user in their language. Pult's own output (revize.md, labels) is partly in Czech: "revize" = review, "dávka" = batch, "položka" = item.

## Send to Pult

```
pult add -t "Short clear title" file1.png video.mp4 folder/
```

- Images (jpg, png, webp, gif, avif, heic, tif…) and videos (mp4, mov, webm, mkv…). A folder = all supported files in it.
- File order = item numbers #01, #02… Put them in the order the user should see them (variants v1, v2, v3…).
- Originals stay where they are (`--copy` copies them into the library). Pult makes a light preview for smooth playback.
- `--to BATCH_ID` adds files to an existing batch. `--wait` waits until previews are ready.
- Output is JSON (batch id, address). Tell the user the batch title and item count so they know what to look for.
- Only outputs to review or approve belong on Pult (drafts, versions, renders). No study material, references or helper frames.
- One batch = one thing to review (variants of one banner, versions of one video). Do not mix unrelated things.

## Your note in Pult (`-m`, `--item-note`, `pult note`)

Write what matters for the review straight into Pult: the user sees it at the top of the Notes panel for the batch and the open item, without switching to the chat.

```
pult add -t "Intro v10" -m "Hook shortened to 2.5 s, captions moved up." --item-note "2: Different music here, compare with #01." a.mp4 b.mp4
pult note BATCH_ID "new text"          # note for the whole batch (empty text deletes it)
pult note BATCH_ID -i 2 "new text"     # for item #02
```

- Only the essentials: what changed since the last version, what to focus on, a known issue or doubt. One to three short sentences, not your whole chat answer.
- For variants, write the differences per item (`--item-note`), shared things for the batch (`-m`).
- In the review (`revize.md`) you get your notes back, so you know what the reviewer reacted to.

## Reviews straight into this chat (`pult wait`)

Right after `pult add`, run this **in the background** if your agent can (Claude Code: Bash with `run_in_background: true`; Codex and others: a background or long-running terminal task):

```
pult wait BATCH_ID
```

It runs until the user clicks **Send review** in Pult, then prints the whole review and exits, so the review lands in the chat that sent the batch: read it, look at the images and act on it (see below). Meanwhile Pult shows "waiting for your review". Once the review arrives, Pult shows "working" (in the top bar, at the batch and in the video). Post short updates there: `pult progress BATCH_ID "Rendering v6 with music B"` (one sentence per bigger step). Do not run `pult wait` in the foreground and do not loop `pult status`. If the batch gets deleted it exits with code 2.

If your agent cannot run background tasks, skip `pult wait` and tell the user to say "check Pult" when they are done. Reviews never disappear: `pult status` finds them. `revize.md` also says which chat sent the batch (`local_…`).

## Read reviews ("check Pult")

```
pult status          # server, new reviews (paths to revize.md), batches in progress
pult reviews --json  # new reviews only
```

1. When there is a new review, read its `revize.md` and **look at every image** in that folder. Each image is exactly the frame the reviewer saw, with their drawing; the caption at the bottom is `#item · mm:ss:ff · frame N · author`.
2. How to read it:
   - A drawing (line, arrow, circle, rectangle) marks the spot the note is about. The comment below says what to do with it.
   - Time `mm:ss:ff` = minutes:seconds:frame within the second; in brackets the seconds and frame index from 0 (for ffmpeg: `-ss` in seconds).
   - ✅ approved / ❌ rejected is the verdict for the whole item (for variants: picked and dropped). An item without notes or verdict is fine.
   - "beze změny od minulé revize" = unchanged since the last review: the note is older, not new.
   - Several authors = a team; names are on every note.
   - "(nadiktováno, přepis může mít chyby)" = dictated: the user spoke and speech-to-text transcribed it. Take the meaning, not the exact wording; guess misheard names and terms from context.
3. Then make the changes. Send the new version to Pult again as a new batch (for example "Banner v3").
4. Mark the review as done: `pult archive <review-folder> -m "what is done"` (or `all`). The user sees "done" with that message in Pult. If you picked the review up through `pult status` (without `pult wait`), first run `pult progress <review-folder>` so it shows you are working on it.
5. If there is no new review, say so plainly and give the time of the last one. If `status` reports unsent drawings, mention them: the user has them in Pult but has not pressed **Send review** yet.

## Clean up batches that are settled (`pult dismiss`, `--replaces`)

The user should not have to delete leftovers by hand. Do it yourself, but only for batches you know are settled:

- The user settled a batch in the chat (approved it, answered there, said it is no longer needed): `pult dismiss BATCH_ID -m "settled in chat"`.
- You send a new version of a batch nobody reviewed: `pult add -t "Banner v3" --replaces OLD_BATCH_ID files…`. The old one goes away and anyone looking at it lands on the new one.
- Pult refuses a batch that has someone's drawings, comments, verdicts or a sent review. Leave those to the user, there is no way to force it.
- Do not clean up in bulk and do not remove a batch just because it is old: the user may simply not have got to it yet.
- Nothing is deleted: the batch moves to Deleted in the sidebar, the user gets an Undo, and `pult dismiss --undo BATCH_ID` puts it back. The running `pult wait` for that batch exits with code 2, that is expected.

## Other commands

| Command | What for |
|---|---|
| `pult open` | open Pult in the browser |
| `pult url` | addresses and access code for colleagues (when sharing is on) |
| `pult settings` / `pult settings KEY VALUE` | settings (library, inbox_enabled, inbox, share, proxy, copy_originals, cleanup_days, port, lang) |
| `pult doctor` | check the install (Python, ffmpeg, server, start at login) |
| `pult start` / `pult restart` / `pult stop` | server |
| `pult reload` | reload Pult on all connected devices |
| `pult update` | update Pult to the newest version from the repository it was installed from; the library and settings stay. Tell the user the new version and what changed. If it reports local changes or own commits, leave them and tell the user. `--from FOLDER` if the clone cannot be found If it reports rewritten repository history, stop and ask the user before using `--accept-rewritten-history`. |
| `pult wait ID` | wait for the batch review (run in the background, see above) |
| `pult progress ID "text"` | show "working" in Pult with a short message about what you are doing |
| `pult dictation` | microphone dictation status; `pult dictation install` installs local speech-to-text (Whisper large-v3-turbo: mlx-whisper on Apple Silicon, faster-whisper elsewhere; on Mac also NVIDIA Parakeet TDT 0.6B v3; needs internet and a few GB); `pult dictation model whisper-turbo` / `parakeet-v3` switches the model (also Settings › Dictation); `pult dictation use /path/python` uses an existing environment |

## When something does not work

- `pult doctor` says what is missing. Without ffmpeg videos are not prepared: macOS `brew install ffmpeg`, Windows `winget install Gyan.FFmpeg`, then `pult restart`.
- An item that could not be prepared: the error is in the `pult add` output and in the batch's batch.json (`items[].error`), usually a broken or unsupported file.
- Server log: the Pult settings folder, file `server.log` (`pult doctor` or Settings › About Pult shows the path).
- Dictation not available: `pult dictation install` (once, takes a while), or the user pastes an ElevenLabs API key in Settings › Dictation.
- Microphone on iPad or for colleagues on the network: browsers allow it only over https. With sharing on, Pult has a secure address on the port one higher (7859) with its own certificate. On iPad: open `http://<computer>.local:7858/pult-ca.crt` in Safari, Settings › Profile Downloaded › Install, Settings › General › About › Certificate Trust Settings › turn on Pult, then open `https://<computer>.local:7859/?k=CODE` (Settings › Dictation shows the links). Audio from the iPad is transcribed by the computer running Pult. Needs `openssl` (macOS has it; Windows with Git).
- Cloud transcription (ElevenLabs Scribe v2, the most accurate): the user pastes their own API key in Settings › Dictation (or `pult dictation key`, the key is entered hidden). Never put the key on a command line, in files or in the chat. Model: `pult dictation model elevenlabs` / `whisper-large`.
- Never delete the user's originals.

## Fixing Pult

Pult is open code: a Python server (standard library only), plain JavaScript for the web UI and, on macOS, a small Swift app window that the installer compiles. You can read, debug and fix it.

1. Diagnose: `pult doctor`, `pult status --json`, the server log `server.log` in the settings folder (macOS `~/Library/Application Support/Pult/`, Windows `%APPDATA%\Pult\` or `%LOCALAPPDATA%\Pult\`). Browser errors go to `debug.log` next to it (the page with `?debug=1` logs more).
2. Code: the installed copy is in the `app` folder next to the settings (macOS `~/Library/Application Support/Pult/app`, Windows `%LOCALAPPDATA%\Pult\app`): `server.py` (HTTP and API), `library.py` (batches, previews, reviews), `dictation.py` + `asr.py` (dictation), `tls.py` (https), `static/js/*.js` (UI). On macOS the app window is `macapp/Pult.swift`.
3. Fix it preferably in the folder Pult was installed from (the git clone) and run `install.py` again: the copy in `app` is overwritten by every install. A quick fix directly in `app` works too, but the next update removes it.
4. After a Python change `pult restart`; after a web change reloading the page is enough (`pult reload` reloads all devices).
5. Describe the fix briefly so the user can pass it to Pult's author (Jan Pils, https://github.com/jan-visual/pult) and it gets into the next version.

Pult itself never deletes anything permanently (old batches go to the `kos` trash folder in the library).
