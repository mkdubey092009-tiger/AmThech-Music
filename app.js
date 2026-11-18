/* ==========================================================================
   Muse (Arc Music Style) — Unlimited Offline Library & Live Auto-Sync Engine
   ========================================================================== */

const DB_NAME = 'AppleMusicOfflineDB';
const DB_VERSION = 4;

const state = {
  tracks: [],
  playlists: [],
  queue: [],
  currentIndex: -1,
  isPlaying: false,
  isShuffle: false,
  repeatMode: 'off', // 'off' | 'all' | 'one'
  activeTab: 'songs', // 'songs' | 'playlists' | 'folders' | 'albums' | 'artists'
  subFilter: null,
  searchQuery: '',
  sortMode: 'added', // 'added' | 'name' | 'artist' | 'duration'
  menuTrackId: null,
  savedDirHandles: [],
  isScanning: false,
  autoWatchTimerId: null,
  sleepTimerId: null,
  sleepEndTime: null,
  settings: {
    theme: 'arc',
    minDurationSec: 5,
    crossfadeEnabled: false,
    crossfadeSec: 10,
    gapless: true,
    seekStepSec: 10,
    resumeLongAudio: true,
    playbackSpeed: 1.0,
  },
};

const audio = document.getElementById('audioPlayer');
const xfAudio = document.getElementById('crossfadePlayer');
const contentArea = document.getElementById('contentArea');

let activeAudioUrl = null;
let activeXfUrl = null;
let audioCtx = null;
let eqFilters = [];
let crossfadeTriggered = false;

const EQ_FREQS = [60, 230, 910, 3600, 14000];
const EQ_PRESETS = {
  flat: [0, 0, 0, 0, 0],
  bass: [7, 5, 0, 0, 1],
  vocal: [-2, 1, 4, 3, 1],
  pop: [-1, 3, 4, 2, -1],
  electronic: [5, 3, -1, 3, 5],
};

function cleanText(str) {
  return String(str || '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

function formatTime(sec) {
  if (!sec || isNaN(sec)) return '00:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
}

function showToast(msg) {
  const el = document.getElementById('toastPill');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => (el.hidden = true), 2600);
}

/* ==========================================================================
   1. Persistent IndexedDB Storage (Lightweight Metadata + File Handles)
   ========================================================================== */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('tracks')) db.createObjectStore('tracks', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('playlists')) db.createObjectStore('playlists', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(store, item) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbDelete(store, id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbGetAll(store) {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => resolve([]);
  });
}

async function dbGetSetting(key) {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction('settings', 'readonly');
    const req = tx.objectStore('settings').get(key);
    req.onsuccess = () => resolve(req.result ? req.result.value : null);
    req.onerror = () => resolve(null);
  });
}

async function saveAppSettings() {
  await dbPut('settings', { key: 'userPrefs', value: state.settings });
}

async function saveDirectoryHandles() {
  await dbPut('settings', { key: 'musicDirHandles', value: state.savedDirHandles });
}

/* ==========================================================================
   2. Fast Incremental Directory Scanner & Auto-Watcher
   ========================================================================== */
const AUDIO_EXT_REGEX = /\.(mp3|wav|ogg|m4a|flac|aac|opus)$/i;

async function walkDirectoryFast(dirHandle, pathPrefix = '', folderLabel = '', out = []) {
  const currentFolder = folderLabel || dirHandle.name || 'Music';
  for await (const entry of dirHandle.values()) {
    const relPath = pathPrefix ? `${pathPrefix}/${entry.name}` : `${dirHandle.name}/${entry.name}`;
    if (entry.kind === 'file') {
      if (AUDIO_EXT_REGEX.test(entry.name)) {
        out.push({
          fileHandle: entry,
          relativePath: relPath,
          folder: currentFolder,
          fileName: entry.name,
        });
      }
    } else if (entry.kind === 'directory' && !entry.name.startsWith('.')) {
      try {
        await walkDirectoryFast(entry, relPath, entry.name, out);
      } catch {}
    }
  }
  return out;
}

async function syncAllGrantedFolders({ silent = true } = {}) {
  if (state.isScanning || !state.savedDirHandles.length) return;
  state.isScanning = true;
  if (!silent) showToast('Scanning storage for new songs...');

  try {
    const discovered = [];
    for (const dirHandle of state.savedDirHandles) {
      try {
        const perm = await dirHandle.queryPermission({ mode: 'read' });
        if (perm === 'granted') {
          await walkDirectoryFast(dirHandle, '', dirHandle.name, discovered);
        }
      } catch {}
    }

    if (!discovered.length) {
      state.isScanning = false;
      return;
    }

    // Fast path-based deduplication before reading any file bytes
    const existingPaths = new Set(state.tracks.map((t) => t.relativePath || t.fileKey));
    const newEntries = discovered.filter((d) => !existingPaths.has(d.relativePath));

    if (newEntries.length > 0) {
      let addedCount = 0;
      for (const item of newEntries) {
        try {
          const file = await item.fileHandle.getFile();
          const saved = await processAndStoreTrack({
            file,
            fileHandle: item.fileHandle,
            relativePath: item.relativePath,
            folder: item.folder,
          });
          if (saved) addedCount++;
        } catch {}
      }

      if (addedCount > 0) {
        // Refresh queue smoothly without interrupting currently playing song
        const currentTrack = state.queue[state.currentIndex];
        state.queue = getVisibleTracks();
        if (currentTrack) {
          const newIdx = state.queue.findIndex((t) => t.id === currentTrack.id);
          if (newIdx !== -1) state.currentIndex = newIdx;
        }
        renderMainView();
        updateFolderStatusLabel();
        showToast(`Added ${addedCount} new ${addedCount === 1 ? 'song' : 'songs'}`);
      }
    } else if (!silent) {
      showToast('All songs are up to date');
    }
  } catch (err) {
    console.warn('Auto-sync error:', err);
  } finally {
    state.isScanning = false;
  }
}

function updateFolderStatusLabel() {
  const el = document.getElementById('settingsFolderStatus');
  if (!el) return;
  if (!state.savedDirHandles.length) {
    el.textContent = 'Grant storage permission & auto-scan songs';
    return;
  }
  const names = state.savedDirHandles.map((h) => h.name).join(', ');
  el.textContent = `Auto-watching: ${names} (${state.tracks.length} songs)`;
}

async function requestFolderAccess() {
  if ('showDirectoryPicker' in window) {
    try {
      let handle;
      try {
        handle = await window.showDirectoryPicker({ mode: 'read' });
      } catch {
        handle = await window.showDirectoryPicker();
      }

      // Avoid adding duplicate folder handles
      let alreadySaved = false;
      for (const existing of state.savedDirHandles) {
        if (existing.isSameEntry && (await existing.isSameEntry(handle))) {
          alreadySaved = true;
          break;
        }
      }
      if (!alreadySaved) {
        state.savedDirHandles.push(handle);
        await saveDirectoryHandles();
      }

      document.getElementById('permissionStrip').hidden = true;
      updateFolderStatusLabel();
      await syncAllGrantedFolders({ silent: false });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
    }
  }
  document.getElementById('folderInput').click();
}

async function checkSavedFoldersOnBoot() {
  if (!('showDirectoryPicker' in window)) return;

  // Migrate single handle from older DB version if present
  const legacySingle = await dbGetSetting('musicDirHandle');
  const savedList = (await dbGetSetting('musicDirHandles')) || [];
  if (legacySingle && !savedList.length) savedList.push(legacySingle);

  state.savedDirHandles = savedList;
  updateFolderStatusLabel();
  if (!state.savedDirHandles.length) return;

  let needsPrompt = false;
  let hasGranted = false;

  for (const handle of state.savedDirHandles) {
    try {
      const perm = await handle.queryPermission({ mode: 'read' });
      if (perm === 'granted') hasGranted = true;
      else if (perm === 'prompt') needsPrompt = true;
    } catch {}
  }

  if (hasGranted) {
    await syncAllGrantedFolders({ silent: true });
  }
  if (needsPrompt) {
    const names = state.savedDirHandles.map((h) => h.name).join(', ');
    document.getElementById('permissionStripText').textContent = `Tap Allow to auto-sync new songs in "${names}"`;
    document.getElementById('permissionStrip').hidden = false;
  }
}

/* ==========================================================================
   3. ID3v2 Metadata & Compact Cover Thumbnail Generator
   ========================================================================== */
function decodeTextFrame(bytes) {
  if (!bytes || !bytes.length) return '';
  const enc = bytes[0];
  const payload = bytes.slice(1);
  try {
    if (enc === 1 || enc === 2) return new TextDecoder('utf-16').decode(payload).replace(/\0/g, '').trim();
    return new TextDecoder('utf-8').decode(payload).replace(/\0/g, '').trim();
  } catch {
    return new TextDecoder('iso-8859-1').decode(payload).replace(/\0/g, '').trim();
  }
}

function parseID3v2(buffer) {
  const meta = { title: '', artist: '', album: '', coverBlob: null };
  try {
    const view = new DataView(buffer);
    if (buffer.byteLength < 10) return meta;
    if (view.getUint8(0) !== 0x49 || view.getUint8(1) !== 0x44 || view.getUint8(2) !== 0x33) return meta;
    const version = view.getUint8(3);
    const tagSize =
      ((view.getUint8(6) & 0x7f) << 21) |
      ((view.getUint8(7) & 0x7f) << 14) |
      ((view.getUint8(8) & 0x7f) << 7) |
      (view.getUint8(9) & 0x7f);

    let offset = 10;
    const end = Math.min(buffer.byteLength, 10 + tagSize);

    while (offset + 10 <= end) {
      const frameId = String.fromCharCode(
        view.getUint8(offset),
        view.getUint8(offset + 1),
        view.getUint8(offset + 2),
        view.getUint8(offset + 3)
      );
      if (!/^[A-Z0-9]{4}$/.test(frameId)) break;

      const frameSize =
        version === 4
          ? ((view.getUint8(offset + 4) & 0x7f) << 21) |
            ((view.getUint8(offset + 5) & 0x7f) << 14) |
            ((view.getUint8(offset + 6) & 0x7f) << 7) |
            (view.getUint8(offset + 7) & 0x7f)
          : view.getUint32(offset + 4);

      if (frameSize <= 0 || offset + 10 + frameSize > end) break;
      const data = new Uint8Array(buffer, offset + 10, frameSize);

      if (frameId === 'TIT2') meta.title = decodeTextFrame(data);
      else if (frameId === 'TPE1') meta.artist = decodeTextFrame(data);
      else if (frameId === 'TALB') meta.album = decodeTextFrame(data);
      else if (frameId === 'APIC' && !meta.coverBlob) {
        const enc = data[0];
        let i = 1;
        let mime = '';
        while (i < data.length && data[i] !== 0) mime += String.fromCharCode(data[i++]);
        i += 2;
        if (enc === 1 || enc === 2) {
          while (i + 1 < data.length && !(data[i] === 0 && data[i + 1] === 0)) i += 2;
          i += 2;
        } else {
          while (i < data.length && data[i] !== 0) i++;
          i += 1;
        }
        if (i < data.length) meta.coverBlob = new Blob([data.slice(i)], { type: mime || 'image/jpeg' });
      }
      offset += 10 + frameSize;
    }
  } catch {}
  return meta;
}

// Shrinks embedded cover art to 200x200 JPEG so thousands of songs never exhaust storage
function compressCoverBlob(blob) {
  if (!blob) return Promise.resolve(null);
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const size = 200;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, size, size);
      URL.revokeObjectURL(url);
      canvas.toBlob((smallBlob) => resolve(smallBlob || blob), 'image/jpeg', 0.78);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

function getAudioDurationFast(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const a = new Audio();
    a.preload = 'metadata';
    a.src = url;
    const done = (dur) => {
      URL.revokeObjectURL(url);
      resolve(dur || 0);
    };
    a.addEventListener('loadedmetadata', () => done(a.duration));
    a.addEventListener('error', () => done(0));
  });
}

async function processAndStoreTrack({ file, fileHandle = null, relativePath = '', folder = 'Music' }) {
  if (!file || (!file.type.startsWith('audio/') && !AUDIO_EXT_REGEX.test(file.name))) return false;

  const relKey = relativePath || `${folder}/${file.name}::${file.size}`;
  if (state.tracks.some((t) => (t.relativePath || t.fileKey) === relKey)) return false;

  const slice = await file.slice(0, 384 * 1024).arrayBuffer();
  const id3 = parseID3v2(slice);
  const baseName = cleanText(file.name.replace(/\.[^/.]+$/, ''));
  const parts = baseName.split(' - ');

  const title = cleanText(id3.title || (parts.length > 1 ? parts.slice(1).join(' - ') : baseName));
  const artist = cleanText(id3.artist || (parts.length > 1 ? parts[0] : 'Unknown artist'));
  const album = cleanText(id3.album || folder || 'Music');

  const duration = await getAudioDurationFast(file);
  const compactCover = await compressCoverBlob(id3.coverBlob);
  const coverUrl = compactCover ? URL.createObjectURL(compactCover) : '';

  const record = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    relativePath: relKey,
    fileKey: `${file.name}::${file.size}`,
    fileName: file.name,
    fileSize: file.size,
    folder: folder || 'Music',
    title,
    artist,
    album,
    duration,
    liked: false,
    hidden: false,
    plays: 0,
    lastPosition: 0,
    addedAt: Date.now(),
    lyrics: '',
    // Store lightweight fileHandle when available; only store raw blob for manual single-file picks
    fileHandle: fileHandle || null,
    blob: fileHandle ? null : file,
    coverBlob: compactCover || null,
  };

  await dbPut('tracks', record);
  state.tracks.push({ ...record, coverUrl });
  return true;
}

/* ==========================================================================
   4. On-Demand Direct Audio Playback (Zero Memory Bloat)
   ========================================================================== */
async function resolvePlayableFile(track) {
  if (track.fileHandle) {
    let perm = await track.fileHandle.queryPermission({ mode: 'read' });
    if (perm !== 'granted') {
      perm = await track.fileHandle.requestPermission({ mode: 'read' });
    }
    if (perm === 'granted') {
      return await track.fileHandle.getFile();
    }
  }
  return track.blob || null;
}

function initAudioContext() {
  if (audioCtx) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  audioCtx = new Ctx();
  const src = audioCtx.createMediaElementSource(audio);
  eqFilters = EQ_FREQS.map((freq, i) => {
    const f = audioCtx.createBiquadFilter();
    f.type = i === 0 ? 'lowshelf' : i === EQ_FREQS.length - 1 ? 'highshelf' : 'peaking';
    f.frequency.value = freq;
    f.gain.value = 0;
    return f;
  });
  src.connect(eqFilters[0]);
  for (let i = 0; i < eqFilters.length - 1; i++) eqFilters[i].connect(eqFilters[i + 1]);
  eqFilters[eqFilters.length - 1].connect(audioCtx.destination);
}

async function persistTrack(track) {
  const { coverUrl, ...dbRecord } = track;
  await dbPut('tracks', dbRecord);
}

async function playTrackAtIndex(index, customQueue = null) {
  if (customQueue) state.queue = [...customQueue];
  if (index < 0 || index >= state.queue.length) return;

  initAudioContext();
  if (audioCtx.state === 'suspended') await audioCtx.resume();

  const prevTrack = state.queue[state.currentIndex];
  if (prevTrack && prevTrack.duration > 600) {
    prevTrack.lastPosition = audio.currentTime;
    persistTrack(prevTrack);
  }

  xfAudio.pause();
  if (activeXfUrl) {
    URL.revokeObjectURL(activeXfUrl);
    activeXfUrl = null;
  }
  audio.volume = 1;
  crossfadeTriggered = false;

  state.currentIndex = index;
  const track = state.queue[index];

  try {
    const file = await resolvePlayableFile(track);
    if (!file) {
      showToast('File moved or permission needed — tap Allow');
      return;
    }

    if (activeAudioUrl) URL.revokeObjectURL(activeAudioUrl);
    activeAudioUrl = URL.createObjectURL(file);
    audio.src = activeAudioUrl;
    audio.playbackRate = state.settings.playbackSpeed;

    if (state.settings.resumeLongAudio && track.duration > 600 && track.lastPosition > 5 && track.lastPosition < track.duration - 10) {
      audio.currentTime = track.lastPosition;
    }

    await audio.play();
    state.isPlaying = true;
    track.plays = (track.plays || 0) + 1;
    await persistTrack(track);
  } catch (err) {
    console.warn('Playback error:', err);
  }

  updatePlayerUI();
  renderMainView();
}

function togglePlayPause() {
  if (!state.queue.length) {
    const visible = getVisibleTracks();
    if (visible.length) playTrackAtIndex(0, visible);
    return;
  }
  if (!audio.src) {
    playTrackAtIndex(Math.max(0, state.currentIndex));
    return;
  }
  initAudioContext();
  if (audio.paused) {
    audio.play();
    state.isPlaying = true;
  } else {
    audio.pause();
    state.isPlaying = false;
  }
  updatePlayerUI();
}

function getNextIndex() {
  if (!state.queue.length) return -1;
  if (state.isShuffle) return Math.floor(Math.random() * state.queue.length);
  const next = state.currentIndex + 1;
  if (next < state.queue.length) return next;
  if (state.repeatMode === 'all') return 0;
  return -1;
}

function playNext() {
  const next = getNextIndex();
  if (next !== -1) playTrackAtIndex(next);
  else {
    state.isPlaying = false;
    updatePlayerUI();
  }
}

function playPrev() {
  if (audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }
  const prev = state.currentIndex - 1;
  if (prev >= 0) playTrackAtIndex(prev);
  else if (state.repeatMode === 'all' && state.queue.length) playTrackAtIndex(state.queue.length - 1);
}

function updatePlayerUI() {
  const track = state.queue[state.currentIndex];
  document.getElementById('miniPlayIcon').hidden = state.isPlaying;
  document.getElementById('miniPauseIcon').hidden = !state.isPlaying;
  document.getElementById('npPlayIcon').hidden = state.isPlaying;
  document.getElementById('npPauseIcon').hidden = !state.isPlaying;

  const speedBadge = document.getElementById('npSpeedBadge');
  speedBadge.hidden = state.settings.playbackSpeed === 1.0;
  speedBadge.textContent = `${state.settings.playbackSpeed}x`;

  if (!track) return;
  const title = cleanText(track.title);
  const artist = cleanText(track.artist);

  document.getElementById('miniTitle').textContent = title;
  document.getElementById('miniArtist').textContent = artist;
  document.getElementById('npTitle').textContent = title;
  document.getElementById('npArtist').textContent = artist;

  const mCov = document.getElementById('miniCover');
  const mPlc = document.getElementById('miniCoverPlaceholder');
  const nCov = document.getElementById('npCover');
  const nPlc = document.getElementById('npCoverPlaceholder');
  const disc = document.getElementById('ambientDisc');

  if (track.coverUrl) {
    mCov.src = track.coverUrl; mCov.hidden = false; mPlc.hidden = true;
    nCov.src = track.coverUrl; nCov.hidden = false; nPlc.hidden = true;
    disc.style.backgroundImage = `url('${track.coverUrl}')`;
  } else {
    mCov.hidden = true; mPlc.hidden = false;
    nCov.hidden = true; nPlc.hidden = false;
    disc.style.backgroundImage = 'none';
  }

  document.getElementById('npHeartOutline').hidden = !!track.liked;
  document.getElementById('npHeartFilled').hidden = !track.liked;

  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title,
      artist,
      album: cleanText(track.album),
      artwork: track.coverUrl ? [{ src: track.coverUrl, sizes: '200x200', type: 'image/jpeg' }] : [],
    });
  }
}

/* ==========================================================================
   5. Filtering, Sorting & View Rendering
   ========================================================================== */
function getVisibleTracks() {
  const minDur = state.settings.minDurationSec || 0;
  const q = state.searchQuery.toLowerCase().trim();
  let list = state.tracks.filter((t) => !t.hidden && (t.duration === 0 || t.duration >= minDur));

  if (q) {
    list = list.filter(
      (t) =>
        cleanText(t.title).toLowerCase().includes(q) ||
        cleanText(t.artist).toLowerCase().includes(q) ||
        cleanText(t.album).toLowerCase().includes(q) ||
        cleanText(t.folder).toLowerCase().includes(q)
    );
  }

  list.sort((a, b) => {
    if (state.sortMode === 'added') return (b.addedAt || 0) - (a.addedAt || 0);
    if (state.sortMode === 'artist') return cleanText(a.artist).localeCompare(cleanText(b.artist));
    if (state.sortMode === 'duration') return (b.duration || 0) - (a.duration || 0);
    return cleanText(a.title).localeCompare(cleanText(b.title));
  });
  return list;
}

function renderSongRows(tracks) {
  const current = state.queue[state.currentIndex];
  if (!tracks.length) {
    return `<div class="empty-onboarding"><h3>No songs found</h3><p>Tap the folder icon above or open Settings to add a music folder.</p></div>`;
  }
  return tracks
    .map((t, idx) => {
      const playing = current && current.id === t.id;
      return `
      <div class="track-row ${playing ? 'playing' : ''}" data-track-id="${t.id}" data-row-idx="${idx}">
        ${t.coverUrl ? `<img class="row-thumb" src="${t.coverUrl}" alt="" loading="lazy" />` : `<div class="row-thumb">♫</div>`}
        <div class="row-meta">
          <div class="track-title">${escapeHtml(cleanText(t.title))}</div>
          <div class="track-sub">${escapeHtml(cleanText(t.artist))}</div>
        </div>
        <button class="row-more-btn" data-menu-id="${t.id}" aria-label="Track Options">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="12" cy="5" r="1.7" />
            <circle cx="12" cy="12" r="1.7" />
            <circle cx="12" cy="19" r="1.7" />
          </svg>
        </button>
      </div>`;
    })
    .join('');
}

function bindSongRowClicks(tracks) {
  contentArea.querySelectorAll('.track-row').forEach((row) => {
    row.addEventListener('click', (e) => {
      const menuBtn = e.target.closest('[data-menu-id]');
      if (menuBtn) {
        e.stopPropagation();
        openTrackMenu(menuBtn.dataset.menuId);
        return;
      }
      const idx = parseInt(row.dataset.rowIdx, 10);
      playTrackAtIndex(idx, tracks);
    });
  });
}

function renderMainView() {
  const visible = getVisibleTracks();

  if (state.tracks.length === 0) {
    contentArea.innerHTML = `
      <div class="empty-onboarding">
        <div style="font-size:44px;">📂</div>
        <h3>Allow Music Folder Access</h3>
        <p>Grant permission once to automatically sync unlimited songs and subfolders whenever new music is added to your phone.</p>
        <button class="primary-btn" id="emptyGrantBtn">Allow & Auto-Scan Songs</button>
      </div>
    `;
    document.getElementById('emptyGrantBtn')?.addEventListener('click', requestFolderAccess);
    return;
  }

  if (state.subFilter) {
    let subTracks = [];
    if (state.subFilter.type === 'playlist') {
      const pl = state.playlists.find((p) => p.id === state.subFilter.value);
      subTracks = pl ? pl.trackIds.map((id) => visible.find((t) => t.id === id)).filter(Boolean) : [];
    } else if (state.subFilter.type === 'folder') {
      subTracks = visible.filter((t) => (t.folder || 'Music') === state.subFilter.value);
    } else if (state.subFilter.type === 'album') {
      subTracks = visible.filter((t) => cleanText(t.album) === state.subFilter.value);
    } else if (state.subFilter.type === 'artist') {
      subTracks = visible.filter((t) => cleanText(t.artist) === state.subFilter.value);
    }

    contentArea.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
        <button class="secondary-btn" id="backSubFilterBtn">← ${escapeHtml(state.subFilter.label)}</button>
        <span style="font-size:12.5px;color:var(--text-secondary)">${subTracks.length} songs</span>
      </div>
      ${renderSongRows(subTracks)}
    `;
    document.getElementById('backSubFilterBtn').addEventListener('click', () => {
      state.subFilter = null;
      renderMainView();
    });
    bindSongRowClicks(subTracks);
    return;
  }

  if (state.activeTab === 'songs') {
    contentArea.innerHTML = renderSongRows(visible);
    bindSongRowClicks(visible);
  } else if (state.activeTab === 'playlists') {
    const likedCount = visible.filter((t) => t.liked).length;
    contentArea.innerHTML = `
      <div class="track-row" id="openNewPlaylistBtn">
        <div class="row-thumb">+</div>
        <div class="row-meta">
          <div class="track-title">Create new playlist</div>
          <div class="track-sub">Organize your favorite songs</div>
        </div>
      </div>
      <div class="track-row" id="openLikedPlaylistBtn">
        <div class="row-thumb">♥</div>
        <div class="row-meta">
          <div class="track-title">Favorites</div>
          <div class="track-sub">${likedCount} songs</div>
        </div>
      </div>
      ${state.playlists
        .map(
          (pl) => `
        <div class="track-row" data-open-pl="${pl.id}">
          <div class="row-thumb">🎵</div>
          <div class="row-meta">
            <div class="track-title">${escapeHtml(pl.name)}</div>
            <div class="track-sub">${pl.trackIds.length} songs</div>
          </div>
          <button class="row-more-btn" data-del-pl="${pl.id}">🗑</button>
        </div>`
        )
        .join('')}
    `;

    document.getElementById('openNewPlaylistBtn').addEventListener('click', () => {
      state.menuTrackId = null;
      openPlaylistSheet();
    });
    document.getElementById('openLikedPlaylistBtn').addEventListener('click', () => {
      const liked = visible.filter((t) => t.liked);
      if (liked.length) playTrackAtIndex(0, liked);
      else showToast('No favorite songs yet');
    });
    contentArea.querySelectorAll('[data-open-pl]').forEach((row) => {
      row.addEventListener('click', (e) => {
        const delBtn = e.target.closest('[data-del-pl]');
        if (delBtn) {
          e.stopPropagation();
          state.playlists = state.playlists.filter((p) => p.id !== delBtn.dataset.delPl);
          dbDelete('playlists', delBtn.dataset.delPl);
          renderMainView();
          return;
        }
        const pl = state.playlists.find((p) => p.id === row.dataset.openPl);
        if (pl) {
          state.subFilter = { type: 'playlist', value: pl.id, label: pl.name };
          renderMainView();
        }
      });
    });
  } else if (state.activeTab === 'folders') {
    const map = new Map();
    visible.forEach((t) => {
      const f = t.folder || 'Music';
      map.set(f, (map.get(f) || 0) + 1);
    });
    contentArea.innerHTML = Array.from(map.entries())
      .map(
        ([folder, count]) => `
      <div class="track-row" data-folder="${escapeHtml(folder)}">
        <div class="row-thumb">📁</div>
        <div class="row-meta">
          <div class="track-title">${escapeHtml(folder)}</div>
          <div class="track-sub">${count} songs</div>
        </div>
      </div>`
      )
      .join('');
    contentArea.querySelectorAll('[data-folder]').forEach((row) => {
      row.addEventListener('click', () => {
        state.subFilter = { type: 'folder', value: row.dataset.folder, label: row.dataset.folder };
        renderMainView();
      });
    });
  } else if (state.activeTab === 'albums') {
    const map = new Map();
    visible.forEach((t) => {
      const alb = cleanText(t.album);
      if (!map.has(alb)) map.set(alb, { name: alb, artist: cleanText(t.artist), cover: t.coverUrl, count: 0 });
      map.get(alb).count++;
      if (!map.get(alb).cover && t.coverUrl) map.get(alb).cover = t.coverUrl;
    });
    contentArea.innerHTML = Array.from(map.values())
      .map(
        (a) => `
      <div class="track-row" data-album="${escapeHtml(a.name)}">
        ${a.cover ? `<img class="row-thumb" src="${a.cover}" loading="lazy" />` : `<div class="row-thumb">💿</div>`}
        <div class="row-meta">
          <div class="track-title">${escapeHtml(a.name)}</div>
          <div class="track-sub">${escapeHtml(a.artist)} · ${a.count} songs</div>
        </div>
      </div>`
      )
      .join('');
    contentArea.querySelectorAll('[data-album]').forEach((row) => {
      row.addEventListener('click', () => {
        state.subFilter = { type: 'album', value: row.dataset.album, label: row.dataset.album };
        renderMainView();
      });
    });
  } else if (state.activeTab === 'artists') {
    const map = new Map();
    visible.forEach((t) => {
      const art = cleanText(t.artist);
      if (!map.has(art)) map.set(art, { name: art, cover: t.coverUrl, count: 0 });
      map.get(art).count++;
      if (!map.get(art).cover && t.coverUrl) map.get(art).cover = t.coverUrl;
    });
    contentArea.innerHTML = Array.from(map.values())
      .map(
        (a) => `
      <div class="track-row" data-artist="${escapeHtml(a.name)}">
        ${a.cover ? `<img class="row-thumb round" src="${a.cover}" loading="lazy" />` : `<div class="row-thumb round">🎤</div>`}
        <div class="row-meta">
          <div class="track-title">${escapeHtml(a.name)}</div>
          <div class="track-sub">${a.count} songs</div>
        </div>
      </div>`
      )
      .join('');
    contentArea.querySelectorAll('[data-artist]').forEach((row) => {
      row.addEventListener('click', () => {
        state.subFilter = { type: 'artist', value: row.dataset.artist, label: row.dataset.artist };
        renderMainView();
      });
    });
  }
}

/* ==========================================================================
   6. Track Options Bottom Sheet
   ========================================================================== */
function openTrackMenu(trackId) {
  const track = state.tracks.find((t) => t.id === trackId);
  if (!track) return;
  state.menuTrackId = trackId;

  document.getElementById('menuTrackTitle').textContent = cleanText(track.title);
  document.getElementById('menuTrackSub').textContent = `${cleanText(track.artist)} · ${track.folder || 'Music'}`;
  document.getElementById('menuSpeedVal').textContent = `${state.settings.playbackSpeed}x`;

  const cov = document.getElementById('menuTrackCover');
  const plc = document.getElementById('menuTrackPlaceholder');
  if (track.coverUrl) {
    cov.src = track.coverUrl; cov.hidden = false; plc.hidden = true;
  } else {
    cov.hidden = true; plc.hidden = false;
  }

  document.getElementById('trackMenuSheet').hidden = false;
}

function openPlaylistSheet() {
  const list = document.getElementById('playlistOptionsList');
  list.innerHTML = state.playlists
    .map(
      (pl) => `
    <button class="menu-action-row" data-pick-pl="${pl.id}">
      <span>🎵</span>
      <span style="flex:1">${escapeHtml(pl.name)}</span>
      <small class="menu-right-val">${pl.trackIds.length}</small>
    </button>`
    )
    .join('');

  list.querySelectorAll('[data-pick-pl]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const pl = state.playlists.find((p) => p.id === btn.dataset.pickPl);
      if (pl && state.menuTrackId && !pl.trackIds.includes(state.menuTrackId)) {
        pl.trackIds.push(state.menuTrackId);
        await dbPut('playlists', pl);
        showToast(`Added to ${pl.name}`);
      }
      document.getElementById('playlistSheet').hidden = true;
    });
  });

  document.getElementById('playlistSheet').hidden = false;
}

async function handleTrackMenuAction(action) {
  const track = state.tracks.find((t) => t.id === state.menuTrackId);
  document.getElementById('trackMenuSheet').hidden = true;
  if (!track) return;

  if (action === 'playlist') {
    openPlaylistSheet();
  } else if (action === 'album') {
    document.getElementById('nowPlayingScreen').classList.remove('open');
    setActiveTab('albums');
    state.subFilter = { type: 'album', value: cleanText(track.album), label: cleanText(track.album) };
    renderMainView();
  } else if (action === 'artist') {
    document.getElementById('nowPlayingScreen').classList.remove('open');
    setActiveTab('artists');
    state.subFilter = { type: 'artist', value: cleanText(track.artist), label: cleanText(track.artist) };
    renderMainView();
  } else if (action === 'tags') {
    document.getElementById('tagTitleInput').value = cleanText(track.title);
    document.getElementById('tagArtistInput').value = cleanText(track.artist);
    document.getElementById('tagAlbumInput').value = cleanText(track.album);
    document.getElementById('editTagsSheet').hidden = false;
  } else if (action === 'hide') {
    track.hidden = true;
    await persistTrack(track);
    updateSettingsLabels();
    renderMainView();
    showToast('Song hidden (restore in Settings → Hidden files)');
  } else if (action === 'share') {
    const file = await resolvePlayableFile(track);
    if (navigator.share && file) {
      navigator.share({ title: track.title, text: `${track.title} - ${track.artist}`, files: [file] }).catch(() => {});
    } else {
      showToast('Share supported on mobile browsers');
    }
  } else if (action === 'speed') {
    const speeds = [1.0, 1.25, 1.5, 2.0, 0.75];
    state.settings.playbackSpeed = speeds[(speeds.indexOf(state.settings.playbackSpeed) + 1) % speeds.length];
    audio.playbackRate = state.settings.playbackSpeed;
    saveAppSettings();
    updatePlayerUI();
    showToast(`Playback speed: ${state.settings.playbackSpeed}x`);
  } else if (action === 'ringtone') {
    const file = await resolvePlayableFile(track);
    if (!file) return;
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = track.fileName || `${cleanText(track.title)}.mp3`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    showToast('Saved to Downloads — select it in Android Sound settings');
  } else if (action === 'properties') {
    const mb = track.fileSize ? `${(track.fileSize / (1024 * 1024)).toFixed(2)} MB` : 'Unknown';
    document.getElementById('propertiesContent').innerHTML = `
      <div class="prop-row"><span>Title</span><span>${escapeHtml(cleanText(track.title))}</span></div>
      <div class="prop-row"><span>Artist</span><span>${escapeHtml(cleanText(track.artist))}</span></div>
      <div class="prop-row"><span>Album</span><span>${escapeHtml(cleanText(track.album))}</span></div>
      <div class="prop-row"><span>Folder</span><span>${escapeHtml(track.folder || 'Music')}</span></div>
      <div class="prop-row"><span>File name</span><span>${escapeHtml(track.fileName || 'Local Audio')}</span></div>
      <div class="prop-row"><span>Size</span><span>${mb}</span></div>
      <div class="prop-row"><span>Duration</span><span>${formatTime(track.duration)}</span></div>
      <div class="prop-row"><span>Plays</span><span>${track.plays || 0}</span></div>
    `;
    document.getElementById('propertiesSheet').hidden = false;
  }
}

/* ==========================================================================
   7. Lyrics & Settings Helpers
   ========================================================================== */
function renderLyricsSheet() {
  const track = state.queue[state.currentIndex];
  const viewBox = document.getElementById('lyricsViewBox');
  document.getElementById('lyricsEditBox').hidden = true;
  viewBox.hidden = false;

  if (!track || !track.lyrics) {
    viewBox.innerHTML = `<p style="color:var(--text-secondary);padding:20px 0;">No lyrics yet. Tap <strong>+ .LRC</strong> or <strong>Edit</strong> above.</p>`;
    return;
  }
  const timeRegex = /\[(\d{2}):(\d{2})(?:\.(\d{2,3}))?\]/;
  viewBox.innerHTML = track.lyrics
    .split('\n')
    .filter((l) => l.trim())
    .map((line) => {
      const m = line.match(timeRegex);
      if (m) {
        const sec = parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + (m[3] ? parseInt(m[3].padEnd(3, '0'), 10) / 1000 : 0);
        const txt = line.replace(timeRegex, '').trim();
        return txt ? `<div class="lyric-line" data-ltime="${sec}">${escapeHtml(txt)}</div>` : '';
      }
      return `<div class="lyric-line">${escapeHtml(line)}</div>`;
    })
    .join('');

  viewBox.querySelectorAll('[data-ltime]').forEach((el) => {
    el.addEventListener('click', () => (audio.currentTime = parseFloat(el.dataset.ltime)));
  });
}

function updateSettingsLabels() {
  const themeNames = { arc: 'Arc Dark', oled: 'OLED Black', light: 'Light Mode' };
  document.documentElement.setAttribute('data-theme', state.settings.theme);
  document.getElementById('settingsThemeLabel').textContent = themeNames[state.settings.theme] || 'Arc Dark';
  document.getElementById('settingsFilterLabel').textContent = state.settings.minDurationSec === 0 ? 'Off' : `< ${state.settings.minDurationSec}s`;
  const hiddenCount = state.tracks.filter((t) => t.hidden).length;
  document.getElementById('settingsHiddenCount').textContent = `Manage hidden files and folders (${hiddenCount})`;
  document.getElementById('crossfadeToggle').checked = state.settings.crossfadeEnabled;
  document.getElementById('crossfadeRange').value = state.settings.crossfadeSec;
  document.getElementById('crossfadeSecLabel').textContent = `${state.settings.crossfadeSec}s`;
  document.getElementById('gaplessToggle').checked = state.settings.gapless;
  document.getElementById('seekStepLabel').textContent = `${state.settings.seekStepSec}s`;
  document.getElementById('resumeLongToggle').checked = state.settings.resumeLongAudio;
  updateFolderStatusLabel();
}

function setActiveTab(tab) {
  state.activeTab = tab;
  state.subFilter = null;
  document.querySelectorAll('.pill-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  renderMainView();
}

/* ==========================================================================
   8. Event Listeners & Live Auto-Sync Loop
   ========================================================================== */
function bindEvents() {
  document.querySelectorAll('.pill-tab').forEach((btn) => {
    btn.addEventListener('click', () => setActiveTab(btn.dataset.tab));
  });

  document.getElementById('openSearchBtn').addEventListener('click', () => {
    const wrap = document.getElementById('searchBarWrap');
    wrap.hidden = !wrap.hidden;
    if (!wrap.hidden) document.getElementById('searchInput').focus();
  });
  document.getElementById('closeSearchBtn').addEventListener('click', () => {
    state.searchQuery = '';
    document.getElementById('searchInput').value = '';
    document.getElementById('searchBarWrap').hidden = true;
    renderMainView();
  });
  document.getElementById('searchInput').addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    renderMainView();
  });

  const sortLabels = { added: 'Recently added', name: 'Name', artist: 'Artist', duration: 'Duration' };
  const sortKeys = Object.keys(sortLabels);
  document.getElementById('sortLabel').textContent = sortLabels[state.sortMode];
  document.getElementById('sortCycleBtn').addEventListener('click', () => {
    state.sortMode = sortKeys[(sortKeys.indexOf(state.sortMode) + 1) % sortKeys.length];
    document.getElementById('sortLabel').textContent = sortLabels[state.sortMode];
    renderMainView();
  });

  document.getElementById('scanFolderQuickBtn').addEventListener('click', requestFolderAccess);
  document.getElementById('permissionStripBtn').addEventListener('click', async () => {
    if (!state.savedDirHandles.length) return requestFolderAccess();
    for (const handle of state.savedDirHandles) {
      try {
        await handle.requestPermission({ mode: 'read' });
      } catch {}
    }
    document.getElementById('permissionStrip').hidden = true;
    await syncAllGrantedFolders({ silent: false });
  });

  document.getElementById('shuffleAllBtn').addEventListener('click', () => {
    const list = getVisibleTracks().sort(() => Math.random() - 0.5);
    if (list.length) {
      state.isShuffle = true;
      document.getElementById('npShuffleBtn').classList.add('active');
      playTrackAtIndex(0, list);
    }
  });

  document.getElementById('playAllBtn').addEventListener('click', () => {
    const list = getVisibleTracks();
    if (list.length) playTrackAtIndex(0, list);
  });

  document.getElementById('fileInput').addEventListener('change', async (e) => {
    let added = 0;
    for (const f of Array.from(e.target.files)) {
      if (await processAndStoreTrack({ file: f, folder: 'Music' })) added++;
    }
    state.queue = getVisibleTracks();
    showToast(`Imported ${added} songs`);
    renderMainView();
  });

  document.getElementById('folderInput').addEventListener('change', async (e) => {
    let added = 0;
    for (const f of Array.from(e.target.files)) {
      const parts = (f.webkitRelativePath || '').split('/');
      const folder = parts.length > 1 ? parts[parts.length - 2] : 'Music';
      if (await processAndStoreTrack({ file: f, relativePath: f.webkitRelativePath, folder })) added++;
    }
    state.queue = getVisibleTracks();
    showToast(`Scanned ${added} songs`);
    renderMainView();
  });

  document.getElementById('openNowPlayingBtn').addEventListener('click', () => document.getElementById('nowPlayingScreen').classList.add('open'));
  document.getElementById('closeNowPlayingBtn').addEventListener('click', () => document.getElementById('nowPlayingScreen').classList.remove('open'));
  document.getElementById('npMoreBtn').addEventListener('click', () => {
    const t = state.queue[state.currentIndex];
    if (t) openTrackMenu(t.id);
  });

  document.getElementById('miniPlayPauseBtn').addEventListener('click', togglePlayPause);
  document.getElementById('npPlayPauseBtn').addEventListener('click', togglePlayPause);
  document.getElementById('npNextBtn').addEventListener('click', playNext);
  document.getElementById('npPrevBtn').addEventListener('click', playPrev);

  document.getElementById('npLikeBtn').addEventListener('click', () => {
    const t = state.queue[state.currentIndex];
    if (!t) return;
    t.liked = !t.liked;
    persistTrack(t);
    updatePlayerUI();
  });

  document.getElementById('npShuffleBtn').addEventListener('click', (e) => {
    state.isShuffle = !state.isShuffle;
    e.currentTarget.classList.toggle('active', state.isShuffle);
  });

  document.getElementById('npRepeatBtn').addEventListener('click', (e) => {
    const modes = ['off', 'all', 'one'];
    state.repeatMode = modes[(modes.indexOf(state.repeatMode) + 1) % modes.length];
    e.currentTarget.classList.toggle('active', state.repeatMode !== 'off');
    document.getElementById('npRepeatOneBadge').hidden = state.repeatMode !== 'one';
  });

  let lastTapTime = 0;
  document.getElementById('npArtworkBox').addEventListener('click', (e) => {
    const now = Date.now();
    if (now - lastTapTime < 300 && audio.duration) {
      const rect = e.currentTarget.getBoundingClientRect();
      const isRight = e.clientX - rect.left > rect.width / 2;
      const step = state.settings.seekStepSec || 10;
      audio.currentTime = Math.max(0, Math.min(audio.duration, audio.currentTime + (isRight ? step : -step)));
      const toast = document.getElementById('seekToast');
      toast.textContent = isRight ? `+${step}s` : `-${step}s`;
      toast.hidden = false;
      clearTimeout(toast._t);
      toast._t = setTimeout(() => (toast.hidden = true), 700);
    }
    lastTapTime = now;
  });

  const npSlider = document.getElementById('npSeekSlider');
  audio.addEventListener('timeupdate', async () => {
    const pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
    document.getElementById('miniProgressFill').style.width = `${pct}%`;
    npSlider.value = pct;
    document.getElementById('npCurrentTime').textContent = formatTime(audio.currentTime);
    document.getElementById('npDuration').textContent = formatTime(audio.duration);

    document.querySelectorAll('[data-ltime]').forEach((el) => {
      el.classList.toggle('active', audio.currentTime >= parseFloat(el.dataset.ltime));
    });

    if (state.settings.crossfadeEnabled && audio.duration > 15 && !crossfadeTriggered) {
      const rem = audio.duration - audio.currentTime;
      if (rem <= state.settings.crossfadeSec && rem > 0.5) {
        const nextIdx = getNextIndex();
        if (nextIdx !== -1 && state.queue[nextIdx]) {
          crossfadeTriggered = true;
          const nextFile = await resolvePlayableFile(state.queue[nextIdx]);
          if (nextFile) {
            if (activeXfUrl) URL.revokeObjectURL(activeXfUrl);
            activeXfUrl = URL.createObjectURL(nextFile);
            xfAudio.src = activeXfUrl;
            xfAudio.volume = 0;
            xfAudio.play().catch(() => {});
          }
        }
      }
    }
    if (crossfadeTriggered && !xfAudio.paused) {
      const rem = Math.max(0, audio.duration - audio.currentTime);
      const ratio = Math.min(1, Math.max(0, rem / state.settings.crossfadeSec));
      audio.volume = ratio;
      xfAudio.volume = 1 - ratio;
    }
  });

  npSlider.addEventListener('input', (e) => {
    if (audio.duration) audio.currentTime = (e.target.value / 100) * audio.duration;
  });

  audio.addEventListener('ended', () => {
    if (state.repeatMode === 'one') {
      audio.currentTime = 0;
      audio.play();
    } else {
      playNext();
    }
  });

  document.querySelectorAll('[data-track-action]').forEach((btn) => {
    btn.addEventListener('click', () => handleTrackMenuAction(btn.dataset.trackAction));
  });

  document.getElementById('createPlaylistBtn').addEventListener('click', async () => {
    const name = document.getElementById('newPlaylistInput').value.trim();
    if (!name) return;
    const pl = { id: `pl-${Date.now()}`, name, trackIds: state.menuTrackId ? [state.menuTrackId] : [] };
    state.playlists.push(pl);
    await dbPut('playlists', pl);
    document.getElementById('newPlaylistInput').value = '';
    document.getElementById('playlistSheet').hidden = true;
    renderMainView();
    showToast(`Playlist "${name}" created`);
  });

  let pendingCoverBlob = null;
  document.getElementById('pickTagCoverBtn').addEventListener('click', () => document.getElementById('coverArtInput').click());
  document.getElementById('coverArtInput').addEventListener('change', async (e) => {
    if (e.target.files[0]) {
      pendingCoverBlob = await compressCoverBlob(e.target.files[0]);
      showToast('New cover image selected');
    }
  });
  document.getElementById('saveTagsBtn').addEventListener('click', async () => {
    const track = state.tracks.find((t) => t.id === state.menuTrackId);
    if (!track) return;
    track.title = document.getElementById('tagTitleInput').value.trim() || track.title;
    track.artist = document.getElementById('tagArtistInput').value.trim() || track.artist;
    track.album = document.getElementById('tagAlbumInput').value.trim() || track.album;
    if (pendingCoverBlob) {
      if (track.coverUrl) URL.revokeObjectURL(track.coverUrl);
      track.coverBlob = pendingCoverBlob;
      track.coverUrl = URL.createObjectURL(pendingCoverBlob);
      pendingCoverBlob = null;
    }
    await persistTrack(track);
    document.getElementById('editTagsSheet').hidden = true;
    updatePlayerUI();
    renderMainView();
    showToast('Tags updated');
  });

  document.getElementById('npLyricsBtn').addEventListener('click', () => {
    renderLyricsSheet();
    document.getElementById('lyricsSheet').hidden = false;
  });
  document.getElementById('toggleEditLyricsBtn').addEventListener('click', () => {
    const t = state.queue[state.currentIndex];
    document.getElementById('lyricsTextarea').value = t ? t.lyrics || '' : '';
    document.getElementById('lyricsViewBox').hidden = true;
    document.getElementById('lyricsEditBox').hidden = false;
  });
  document.getElementById('saveLyricsBtn').addEventListener('click', async () => {
    const t = state.queue[state.currentIndex];
    if (!t) return;
    t.lyrics = document.getElementById('lyricsTextarea').value;
    await persistTrack(t);
    renderLyricsSheet();
  });
  document.getElementById('importLrcBtn').addEventListener('click', () => document.getElementById('lrcInput').click());
  document.getElementById('lrcInput').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    const t = state.queue[state.currentIndex];
    if (!f || !t) return;
    t.lyrics = await f.text();
    await persistTrack(t);
    renderLyricsSheet();
  });

  document.getElementById('npEqBtn').addEventListener('click', () => {
    initAudioContext();
    document.getElementById('eqSheet').hidden = false;
  });
  document.querySelectorAll('.eq-range').forEach((s) => {
    s.addEventListener('input', (e) => {
      const b = parseInt(e.target.dataset.band, 10);
      if (eqFilters[b]) eqFilters[b].gain.value = parseFloat(e.target.value);
    });
  });
  document.querySelectorAll('.preset-pill').forEach((p) => {
    p.addEventListener('click', () => {
      document.querySelectorAll('.preset-pill').forEach((x) => x.classList.remove('active'));
      p.classList.add('active');
      const vals = EQ_PRESETS[p.dataset.preset];
      document.querySelectorAll('.eq-range').forEach((s, i) => {
        s.value = vals[i];
        if (eqFilters[i]) eqFilters[i].gain.value = vals[i];
      });
    });
  });

  document.getElementById('npSleepBtn').addEventListener('click', () => (document.getElementById('sleepSheet').hidden = false));
  document.querySelectorAll('[data-sleep]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mins = parseInt(btn.dataset.sleep, 10);
      clearInterval(state.sleepTimerId);
      if (mins === 0) {
        document.getElementById('sleepSheetTitle').textContent = 'Sleep timer';
        showToast('Sleep timer off');
      } else {
        state.sleepEndTime = Date.now() + mins * 60000;
        state.sleepTimerId = setInterval(() => {
          const rem = Math.max(0, Math.ceil((state.sleepEndTime - Date.now()) / 60000));
          document.getElementById('sleepSheetTitle').textContent = `Sleep timer (${rem}m left)`;
          if (Date.now() >= state.sleepEndTime) {
            clearInterval(state.sleepTimerId);
            audio.pause();
            state.isPlaying = false;
            updatePlayerUI();
            document.getElementById('sleepSheetTitle').textContent = 'Sleep timer';
          }
        }, 1000);
        showToast(`Sleep timer set for ${mins} minutes`);
      }
      document.getElementById('sleepSheet').hidden = true;
    });
  });

  const openQueue = () => {
    document.getElementById('queueCountLabel').textContent = state.queue.length;
    const box = document.getElementById('queueListBox');
    box.innerHTML = state.queue
      .map(
        (t, idx) => `
      <div class="track-row ${idx === state.currentIndex ? 'playing' : ''}" data-q-idx="${idx}">
        <div class="row-thumb">${idx + 1}</div>
        <div class="row-meta">
          <div class="track-title">${escapeHtml(cleanText(t.title))}</div>
          <div class="track-sub">${escapeHtml(cleanText(t.artist))}</div>
        </div>
      </div>`
      )
      .join('');
    box.querySelectorAll('[data-q-idx]').forEach((el) => {
      el.addEventListener('click', () => {
        playTrackAtIndex(parseInt(el.dataset.qIdx, 10));
        document.getElementById('queueSheet').hidden = true;
      });
    });
    document.getElementById('queueSheet').hidden = false;
  };
  document.getElementById('miniQueueBtn').addEventListener('click', openQueue);
  document.getElementById('npQueueBtn').addEventListener('click', openQueue);

  document.getElementById('openSettingsBtn').addEventListener('click', () => {
    updateSettingsLabels();
    document.getElementById('settingsScreen').classList.add('open');
  });
  document.getElementById('closeSettingsBtn').addEventListener('click', () => document.getElementById('settingsScreen').classList.remove('open'));
  document.getElementById('settingsGrantFolderBtn').addEventListener('click', requestFolderAccess);
  document.getElementById('settingsPickFilesBtn').addEventListener('click', () => document.getElementById('fileInput').click());

  document.getElementById('settingsThemeBtn').addEventListener('click', () => {
    const order = ['arc', 'oled', 'light'];
    state.settings.theme = order[(order.indexOf(state.settings.theme) + 1) % order.length];
    saveAppSettings();
    updateSettingsLabels();
  });

  document.getElementById('settingsFilterAudioBtn').addEventListener('click', () => {
    const steps = [0, 5, 15, 30, 60];
    state.settings.minDurationSec = steps[(steps.indexOf(state.settings.minDurationSec) + 1) % steps.length];
    saveAppSettings();
    updateSettingsLabels();
    renderMainView();
  });

  document.getElementById('settingsHiddenFilesBtn').addEventListener('click', () => {
    const hidden = state.tracks.filter((t) => t.hidden);
    const box = document.getElementById('hiddenFilesListBox');
    if (!hidden.length) {
      box.innerHTML = `<p style="color:var(--text-secondary);padding:16px 0;">No hidden songs.</p>`;
    } else {
      box.innerHTML = hidden
        .map(
          (t) => `
        <div class="track-row">
          <div class="row-meta">
            <div class="track-title">${escapeHtml(cleanText(t.title))}</div>
            <div class="track-sub">${escapeHtml(cleanText(t.artist))}</div>
          </div>
          <button class="secondary-btn" data-unhide-id="${t.id}">Unhide</button>
        </div>`
        )
        .join('');
      box.querySelectorAll('[data-unhide-id]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const tr = state.tracks.find((x) => x.id === btn.dataset.unhideId);
          if (tr) {
            tr.hidden = false;
            await persistTrack(tr);
            updateSettingsLabels();
            renderMainView();
            document.getElementById('hiddenFilesSheet').hidden = true;
            showToast('Song restored');
          }
        });
      });
    }
    document.getElementById('hiddenFilesSheet').hidden = false;
  });

  document.getElementById('crossfadeToggle').addEventListener('change', (e) => {
    state.settings.crossfadeEnabled = e.target.checked;
    saveAppSettings();
  });
  document.getElementById('crossfadeRange').addEventListener('input', (e) => {
    state.settings.crossfadeSec = parseInt(e.target.value, 10);
    document.getElementById('crossfadeSecLabel').textContent = `${state.settings.crossfadeSec}s`;
    saveAppSettings();
  });
  document.getElementById('gaplessToggle').addEventListener('change', (e) => {
    state.settings.gapless = e.target.checked;
    saveAppSettings();
  });
  document.getElementById('settingsSeekStepBtn').addEventListener('click', () => {
    const steps = [5, 10, 15, 30];
    state.settings.seekStepSec = steps[(steps.indexOf(state.settings.seekStepSec) + 1) % steps.length];
    saveAppSettings();
    updateSettingsLabels();
  });
  document.getElementById('resumeLongToggle').addEventListener('change', (e) => {
    state.settings.resumeLongAudio = e.target.checked;
    saveAppSettings();
  });

  document.querySelectorAll('[data-close-sheet]').forEach((btn) => {
    btn.addEventListener('click', () => (document.getElementById(btn.dataset.closeSheet).hidden = true));
  });
  document.querySelectorAll('.sheet-backdrop').forEach((bg) => {
    bg.addEventListener('click', (e) => {
      if (e.target === bg) bg.hidden = true;
    });
  });

  // Automatically detect and add newly downloaded songs when returning to the app
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      syncAllGrantedFolders({ silent: true });
    }
  });
  window.addEventListener('focus', () => {
    syncAllGrantedFolders({ silent: true });
  });
}

async function bootstrap() {
  // Request persistent storage so Android never limits or evicts the library
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }

  bindEvents();
  const savedPrefs = await dbGetSetting('userPrefs');
  if (savedPrefs) Object.assign(state.settings, savedPrefs);
  updateSettingsLabels();

  const savedTracks = await dbGetAll('tracks');
  state.tracks = savedTracks.map((t) => ({
    ...t,
    coverUrl: t.coverBlob ? URL.createObjectURL(t.coverBlob) : '',
  }));
  state.playlists = await dbGetAll('playlists');
  state.queue = getVisibleTracks();
  renderMainView();

  await checkSavedFoldersOnBoot();

  // Live background watcher: checks granted folders every 6 seconds for new songs
  state.autoWatchTimerId = setInterval(() => {
    if (document.visibilityState === 'visible') {
      syncAllGrantedFolders({ silent: true });
    }
  }, 6000);

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

bootstrap();
