# Apple Music — Offline Web Player

A zero-dependency, 100% offline local music player featuring an Apple Music-inspired translucent glass UI, persistent IndexedDB audio storage, built-in ID3v2 cover art & metadata extraction, synced `.lrc` lyrics, and a 5-band Web Audio API equalizer.

## Features

- **100% Offline Storage (IndexedDB):** Import audio files (`.mp3`, `.wav`, `.ogg`, `.m4a`, `.flac`), drag-and-drop tracks, or import entire folders. Audio blobs and cover art persist locally across browser restarts.
- **Built-in ID3v2 Tag & Cover Art Reader:** Automatically extracts track title, artist, album, and embedded artwork with zero external libraries.
- **Apple Music UI & Dynamic Ambient Glow:** Frosted glassmorphism player bar, full-screen Now Playing mode, adaptive ambient colors extracted from album artwork, and Light/Dark theme support.
- **5-Band Equalizer & Live Visualizer:** Real-time Web Audio API frequency visualizer and EQ presets (`Flat`, `Bass Boost`, `Vocal`, `Pop`, `Electronic`).
- **Synced Lyrics (`.lrc`) & Queue:** Import `.lrc` files or edit lyrics directly, click any timestamped lyric line to seek, and manage custom playlists or liked songs.
- **Extra Utilities:** Sleep timer, variable playback speed (`0.75x`–`2.0x`), OS Media Session lock-screen controls, and keyboard shortcuts.

## Keyboard Shortcuts

| Key | Action |
| :--- | :--- |
| `Space` | Play / Pause |
| `→` / `←` | Next / Previous Track |
| `S` | Toggle Shuffle |
| `R` | Cycle Repeat Mode (Off / All / One) |
| `M` | Mute / Unmute |
| `L` | Open Full-Screen Now Playing & Lyrics |

## Deploy on GitHub Pages

1. Push all files (`index.html`, `style.css`, `app.js`, `sw.js`, `manifest.json`, `README.md`) to your GitHub repository.
2. Go to **Settings → Pages** in your repository.
3. Under **Source**, select `Deploy from a branch`, choose `main` (root `/`), and click **Save**.
4. Open the generated GitHub Pages URL once—the Service Worker will cache the app for full offline use.
