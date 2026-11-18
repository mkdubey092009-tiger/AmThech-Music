/* ==========================================================================
   Offline Apple Music Clone — Complete Audio Engine, ID3 Parser & IndexedDB
   ========================================================================== */

const DB_NAME = 'AppleMusicOfflineDB';
const DB_VERSION = 1;

const state = {
  tracks: [],
  playlists: [],
  queue: [],
  currentIndex: -1,
  isPlaying: false,
  isShuffle: false,
  repeatMode: 'off', // 'off' | 'all' | 'one'
  currentView: 'listen-now',
  activePlaylistId: null,
  activeAlbum: null,
  activeArtist: null,
  searchQuery: '',
  sortBy: 'added',
  drawerTab: 'queue',
  playbackRate: 1.0,
  sleepTimerId: null,
  sleepEndTime: null,
  pendingPlaylistTrackId: null,
};

const audio = document.getElementById('audioPlayer');
const contentArea = document.getElementById('contentArea');
const viewTitle = document.getElementById('viewTitle');
const viewSubtitle = document.getElementById('viewSubtitle');

let audioCtx = null;
let analyser = null;
let eqFilters = [];
const EQ_FREQS = [60, 230, 910, 3600, 14000];
const EQ_PRESETS = {
  flat: [0, 0, 0, 0, 0],
  bass: [7, 5, 0, 0, 1],
  vocal: [-2, 1, 4, 3, 1],
  pop: [-1, 3, 4, 2, -1],
  electronic: [5, 3, -1, 3, 5],
};

function cleanDisplayText(str) {
  return String(str || '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

/* ==========================================================================
   1. IndexedDB Offline Storage
   ========================================================================== */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('tracks')) {
        db.createObjectStore('tracks', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('playlists')) {
        db.createObjectStore('playlists', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(storeName, item) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbDelete(storeName, id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbGetAll(storeName) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

/* ==========================================================================
   2. Zero-Dependency ID3v2 Metadata & Embedded Cover Art Extractor
   ========================================================================== */
function decodeTextFrame(bytes) {
  if (!bytes || bytes.length === 0) return '';
  const encoding = bytes[0];
  const payload = bytes.slice(1);
  try {
    if (encoding === 1 || encoding === 2) {
      return new TextDecoder('utf-16').decode(payload).replace(/\0/g, '').trim();
    }
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
    if (view.getUint8(0) !== 0x49 || view.getUint8(1) !== 0x44 || view.getUint8(2) !== 0x33) {
      return meta;
    }
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
      const frameData = new Uint8Array(buffer, offset + 10, frameSize);

      if (frameId === 'TIT2') meta.title = decodeTextFrame(frameData);
      else if (frameId === 'TPE1') meta.artist = decodeTextFrame(frameData);
      else if (frameId === 'TALB') meta.album = decodeTextFrame(frameData);
      else if (frameId === 'APIC' && !meta.coverBlob) {
        const encoding = frameData[0];
        let i = 1;
        let mime = '';
        while (i < frameData.length && frameData[i] !== 0) {
          mime += String.fromCharCode(frameData[i++]);
        }
        i += 2;
        if (encoding === 1 || encoding === 2) {
          while (i + 1 < frameData.length && !(frameData[i] === 0 && frameData[i + 1] === 0)) i += 2;
          i += 2;
        } else {
          while (i < frameData.length && frameData[i] !== 0) i++;
          i += 1;
        }
        if (i < frameData.length) {
          const imgBytes = frameData.slice(i);
          meta.coverBlob = new Blob([imgBytes], { type: mime || 'image/jpeg' });
        }
      }
      offset += 10 + frameSize;
    }
  } catch (err) {
    console.warn('ID3 parse fallback:', err);
  }
  return meta;
}

function getAudioDuration(url) {
  return new Promise((resolve) => {
    const tempAudio = new Audio();
    tempAudio.src = url;
    tempAudio.addEventListener('loadedmetadata', () => resolve(tempAudio.duration || 0));
    tempAudio.addEventListener('error', () => resolve(0));
  });
}

async function importAudioFiles(fileList) {
  const audioFiles = Array.from(fileList).filter((f) => f.type.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|flac)$/i.test(f.name));
  if (!audioFiles.length) return;

  for (const file of audioFiles) {
    const headerSlice = await file.slice(0, 512 * 1024).arrayBuffer();
    const id3 = parseID3v2(headerSlice);
    const cleanName = cleanDisplayText(file.name.replace(/\.[^/.]+$/, ''));
    const parts = cleanName.split(' - ');

    const title = cleanDisplayText(id3.title || (parts.length > 1 ? parts.slice(1).join(' - ') : cleanName));
    const artist = cleanDisplayText(id3.artist || (parts.length > 1 ? parts[0] : 'Unknown Artist'));
    const album = cleanDisplayText(id3.album || 'Offline Singles');

    const audioUrl = URL.createObjectURL(file);
    const duration = await getAudioDuration(audioUrl);
    const coverUrl = id3.coverBlob ? URL.createObjectURL(id3.coverBlob) : '';

    const trackRecord = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      title,
      artist,
      album,
      duration,
      liked: false,
      plays: 0,
      addedAt: Date.now(),
      lyrics: '',
      blob: file,
      coverBlob: id3.coverBlob || null,
    };

    await dbPut('tracks', trackRecord);
    state.tracks.push({ ...trackRecord, audioUrl, coverUrl });
  }

  if (state.queue.length === 0) {
    state.queue = [...state.tracks];
  }
  renderCurrentView();
}

/* ==========================================================================
   3. Dynamic Ambient Color Extraction
   ========================================================================== */
function updateAmbientColor(imgUrl) {
  if (!imgUrl) {
    document.documentElement.style.setProperty('--dynamic-glow', 'rgba(250, 36, 60, 0.32)');
    return;
  }
  const img = new Image();
  img.crossOrigin = 'Anonymous';
  img.src = imgUrl;
  img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = 24;
    canvas.height = 24;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, 24, 24);
    const data = ctx.getImageData(0, 0, 24, 24).data;
    let r = 0, g = 0, b = 0, count = 0;
    for (let i = 0; i < data.length; i += 4) {
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      count++;
    }
    r = Math.round(r / count);
    g = Math.round(g / count);
    b = Math.round(b / count);
    document.documentElement.style.setProperty('--dynamic-glow', `rgba(${r}, ${g}, ${b}, 0.45)`);
  };
}

/* ==========================================================================
   4. Web Audio API (5-Band Equalizer + Real-Time Visualizer)
   ========================================================================== */
function initAudioEngine() {
  if (audioCtx) return;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  audioCtx = new AudioContextClass();
  const source = audioCtx.createMediaElementSource(audio);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 128;

  eqFilters = EQ_FREQS.map((freq, idx) => {
    const filter = audioCtx.createBiquadFilter();
    filter.type = idx === 0 ? 'lowshelf' : idx === EQ_FREQS.length - 1 ? 'highshelf' : 'peaking';
    filter.frequency.value = freq;
    filter.Q.value = 1.0;
    filter.gain.value = 0;
    return filter;
  });

  source.connect(eqFilters[0]);
  for (let i = 0; i < eqFilters.length - 1; i++) {
    eqFilters[i].connect(eqFilters[i + 1]);
  }
  eqFilters[eqFilters.length - 1].connect(analyser);
  analyser.connect(audioCtx.destination);

  drawVisualizer();
}

function drawVisualizer() {
  requestAnimationFrame(drawVisualizer);
  const canvas = document.getElementById('visualizerCanvas');
  if (!canvas || !analyser) return;
  const ctx = canvas.getContext('2d');
  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);
  analyser.getByteFrequencyData(dataArray);

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const barWidth = (canvas.width / bufferLength) * 1.4;
  let x = 0;

  for (let i = 0; i < bufferLength; i++) {
    const barHeight = (dataArray[i] / 255) * canvas.height;
    ctx.fillStyle = `rgba(255, 255, 255, ${0.35 + (dataArray[i] / 255) * 0.65})`;
    ctx.beginPath();
    ctx.roundRect(x, canvas.height - barHeight, Math.max(2, barWidth - 2), barHeight, 3);
    ctx.fill();
    x += barWidth;
  }
}

/* ==========================================================================
   5. Playback Controller
   ========================================================================== */
function formatTime(sec) {
  if (!sec || isNaN(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

async function playTrackAtIndex(index, customQueue = null) {
  if (customQueue) state.queue = [...customQueue];
  if (index < 0 || index >= state.queue.length) return;

  initAudioEngine();
  if (audioCtx.state === 'suspended') await audioCtx.resume();

  state.currentIndex = index;
  const track = state.queue[index];
  audio.src = track.audioUrl;
  audio.playbackRate = state.playbackRate;

  try {
    await audio.play();
    state.isPlaying = true;
    track.plays = (track.plays || 0) + 1;
    await persistTrackMetadata(track);
  } catch (err) {
    console.error('Playback error:', err);
  }

  updatePlayerUI();
  renderCurrentView();
  if (document.getElementById('sideDrawer').classList.contains('open')) renderDrawer();
}

function togglePlayPause() {
  if (!state.queue.length && state.tracks.length) {
    playTrackAtIndex(0, state.tracks);
    return;
  }
  if (!audio.src) return;
  initAudioEngine();
  if (audio.paused) {
    audio.play();
    state.isPlaying = true;
  } else {
    audio.pause();
    state.isPlaying = false;
  }
  updatePlayerUI();
}

function playNext() {
  if (!state.queue.length) return;
  if (state.isShuffle) {
    const rand = Math.floor(Math.random() * state.queue.length);
    playTrackAtIndex(rand);
    return;
  }
  const nextIdx = state.currentIndex + 1;
  if (nextIdx < state.queue.length) {
    playTrackAtIndex(nextIdx);
  } else if (state.repeatMode === 'all') {
    playTrackAtIndex(0);
  } else {
    state.isPlaying = false;
    updatePlayerUI();
  }
}

function playPrev() {
  if (audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }
  const prevIdx = state.currentIndex - 1;
  if (prevIdx >= 0) {
    playTrackAtIndex(prevIdx);
  } else if (state.repeatMode === 'all' && state.queue.length) {
    playTrackAtIndex(state.queue.length - 1);
  }
}

async function persistTrackMetadata(track) {
  const { audioUrl, coverUrl, ...dbRecord } = track;
  await dbPut('tracks', dbRecord);
}

function updatePlayerUI() {
  const track = state.queue[state.currentIndex];
  const playIcon = document.getElementById('playIcon');
  const pauseIcon = document.getElementById('pauseIcon');
  const fsPlayPause = document.getElementById('fsPlayPauseBtn');
  const fsArtContainer = document.getElementById('fsArtworkContainer');

  playIcon.hidden = state.isPlaying;
  pauseIcon.hidden = !state.isPlaying;
  fsPlayPause.textContent = state.isPlaying ? '⏸' : '▶';
  fsArtContainer.classList.toggle('playing', state.isPlaying);

  if (!track) return;

  const title = cleanDisplayText(track.title);
  const artist = cleanDisplayText(track.artist);
  const album = cleanDisplayText(track.album);

  document.getElementById('playerTitle').textContent = title;
  document.getElementById('playerArtist').textContent = `${artist} — ${album}`;
  document.getElementById('fsTitle').textContent = title;
  document.getElementById('fsArtist').textContent = `${artist} — ${album}`;

  const pCover = document.getElementById('playerCover');
  const pPlace = document.getElementById('playerCoverPlaceholder');
  const fsCover = document.getElementById('fsCover');
  const fsPlace = document.getElementById('fsCoverPlaceholder');

  if (track.coverUrl) {
    pCover.src = track.coverUrl;
    pCover.hidden = false;
    pPlace.hidden = true;
    fsCover.src = track.coverUrl;
    fsCover.hidden = false;
    fsPlace.hidden = true;
  } else {
    pCover.hidden = true;
    pPlace.hidden = false;
    fsCover.hidden = true;
    fsPlace.hidden = false;
  }

  const likeText = track.liked ? '♥' : '♡';
  const pLike = document.getElementById('playerLikeBtn');
  const fsLike = document.getElementById('fsLikeBtn');
  pLike.textContent = likeText;
  fsLike.textContent = likeText;
  pLike.classList.toggle('liked', track.liked);
  fsLike.classList.toggle('liked', track.liked);

  updateAmbientColor(track.coverUrl);
  renderLyrics(track);

  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title,
      artist,
      album,
      artwork: track.coverUrl ? [{ src: track.coverUrl, sizes: '512x512', type: 'image/jpeg' }] : [],
    });
  }
}

/* ==========================================================================
   6. Synced LRC Lyrics Parser & Renderer
   ========================================================================== */
function parseLyrics(raw) {
  if (!raw || !raw.trim()) return [];
  const lines = raw.split('\n');
  const parsed = [];
  const timeRegex = /\[(\d{2}):(\d{2})(?:\.(\d{2,3}))?\]/;

  for (const line of lines) {
    const match = line.match(timeRegex);
    if (match) {
      const mins = parseInt(match[1], 10);
      const secs = parseInt(match[2], 10);
      const ms = match[3] ? parseInt(match[3].padEnd(3, '0'), 10) / 1000 : 0;
      const text = line.replace(timeRegex, '').trim();
      if (text) parsed.push({ time: mins * 60 + secs + ms, text });
    } else if (line.trim()) {
      parsed.push({ time: null, text: line.trim() });
    }
  }
  return parsed;
}

function renderLyrics(track) {
  const container = document.getElementById('fsLyricsContainer');
  if (!track || !track.lyrics) {
    container.innerHTML = `<p class="empty-lyrics-msg">No lyrics added for this song yet. Tap <strong>Edit Lyrics</strong> or <strong>Import .LRC</strong> above.</p>`;
    return;
  }
  const lines = parseLyrics(track.lyrics);
  container.innerHTML = lines
    .map(
      (l, idx) =>
        `<div class="lyric-line" data-idx="${idx}" ${l.time !== null ? `data-time="${l.time}"` : ''}>${escapeHtml(l.text)}</div>`
    )
    .join('');

  container.querySelectorAll('.lyric-line[data-time]').forEach((el) => {
    el.addEventListener('click', () => {
      audio.currentTime = parseFloat(el.dataset.time);
    });
  });
}

function syncLyricsHighlight(currentTime) {
  const lines = document.querySelectorAll('#fsLyricsContainer .lyric-line[data-time]');
  if (!lines.length) return;
  let activeEl = null;
  lines.forEach((el) => {
    const t = parseFloat(el.dataset.time);
    if (currentTime >= t) activeEl = el;
    el.classList.remove('active');
  });
  if (activeEl) {
    activeEl.classList.add('active');
    activeEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

/* ==========================================================================
   7. Views Rendering (Listen Now, Songs, Albums, Artists, Liked, Playlists)
   ========================================================================== */
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

function getFilteredSortedTracks(baseList = state.tracks) {
  const q = state.searchQuery.toLowerCase().trim();
  let list = q
    ? baseList.filter(
        (t) =>
          cleanDisplayText(t.title).toLowerCase().includes(q) ||
          cleanDisplayText(t.artist).toLowerCase().includes(q) ||
          cleanDisplayText(t.album).toLowerCase().includes(q)
      )
    : [...baseList];

  list.sort((a, b) => {
    if (state.sortBy === 'title') return cleanDisplayText(a.title).localeCompare(cleanDisplayText(b.title));
    if (state.sortBy === 'artist') return cleanDisplayText(a.artist).localeCompare(cleanDisplayText(b.artist));
    if (state.sortBy === 'album') return cleanDisplayText(a.album).localeCompare(cleanDisplayText(b.album));
    if (state.sortBy === 'plays') return (b.plays || 0) - (a.plays || 0);
    return (b.addedAt || 0) - (a.addedAt || 0);
  });
  return list;
}

function renderTrackRows(tracks, playlistId = null) {
  const currentTrack = state.queue[state.currentIndex];
  if (!tracks.length) {
    return `<p style="color:var(--text-secondary);padding:24px 0;">No tracks found in this view.</p>`;
  }

  return `
    <div class="track-table">
      ${tracks
        .map((t, idx) => {
          const isPlaying = currentTrack && currentTrack.id === t.id;
          return `
          <div class="track-row ${isPlaying ? 'playing' : ''}" data-track-id="${t.id}" data-row-idx="${idx}">
            <div class="track-num">${isPlaying && state.isPlaying ? '🔊' : idx + 1}</div>
            ${
              t.coverUrl
                ? `<img class="track-thumb" src="${t.coverUrl}" alt="" />`
                : `<div class="track-thumb">♪</div>`
            }
            <div class="track-main">
              <div class="track-name">${escapeHtml(cleanDisplayText(t.title))}</div>
              <div class="track-artist">${escapeHtml(cleanDisplayText(t.artist))}</div>
            </div>
            <div class="track-album">${escapeHtml(cleanDisplayText(t.album))}</div>
            <div class="track-duration">${formatTime(t.duration)}</div>
            <div class="track-actions">
              <button class="row-action-btn ${t.liked ? 'liked' : ''}" data-action="like" title="Love">${t.liked ? '♥' : '♡'}</button>
              <button class="row-action-btn" data-action="playlist" title="Add to Playlist">+</button>
              <button class="row-action-btn" data-action="delete" title="${playlistId ? 'Remove from Playlist' : 'Delete Offline File'}">🗑</button>
            </div>
          </div>`;
        })
        .join('')}
    </div>
  `;
}

function attachTrackRowEvents(container, tracks, playlistId = null) {
  container.querySelectorAll('.track-row').forEach((row) => {
    const id = row.dataset.trackId;
    const idx = parseInt(row.dataset.rowIdx, 10);
    const track = tracks.find((t) => t.id === id);

    row.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (btn) {
        e.stopPropagation();
        const action = btn.dataset.action;
        if (action === 'like') toggleLikeTrack(track);
        if (action === 'playlist') openAddToPlaylistModal(track.id);
        if (action === 'delete') handleDeleteTrack(track.id, playlistId);
        return;
      }
      playTrackAtIndex(idx, tracks);
    });
  });
}

async function toggleLikeTrack(track) {
  if (!track) return;
  track.liked = !track.liked;
  await persistTrackMetadata(track);
  updatePlayerUI();
  renderCurrentView();
}

async function handleDeleteTrack(trackId, playlistId) {
  if (playlistId) {
    const pl = state.playlists.find((p) => p.id === playlistId);
    if (pl) {
      pl.trackIds = pl.trackIds.filter((id) => id !== trackId);
      await dbPut('playlists', pl);
    }
  } else {
    const idx = state.tracks.findIndex((t) => t.id === trackId);
    if (idx !== -1) {
      URL.revokeObjectURL(state.tracks[idx].audioUrl);
      if (state.tracks[idx].coverUrl) URL.revokeObjectURL(state.tracks[idx].coverUrl);
      state.tracks.splice(idx, 1);
      state.queue = state.queue.filter((t) => t.id !== trackId);
      await dbDelete('tracks', trackId);
    }
  }
  renderCurrentView();
}

function renderCurrentView() {
  renderSidebarPlaylists();

  if (state.tracks.length === 0) {
    viewTitle.textContent = 'Muse Offline';
    viewSubtitle.textContent = 'Your local music library is empty';
    contentArea.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">♪</div>
        <h2>Your Offline Music Library</h2>
        <p>Import MP3, FLAC, WAV, OGG, or M4A files or an entire music folder. All tracks, album artwork, and playlists are saved directly on your device for 100% offline playback.</p>
        <div class="empty-actions">
          <button class="primary-pill-btn" onclick="document.getElementById('fileInput').click()">+ Select Audio Files</button>
          <button class="secondary-pill-btn" onclick="document.getElementById('folderInput').click()">📁 Import Music Folder</button>
        </div>
      </div>
    `;
    return;
  }

  const allSorted = getFilteredSortedTracks();

  if (state.currentView === 'listen-now') {
    viewTitle.textContent = 'Listen Now';
    viewSubtitle.textContent = `${state.tracks.length} songs saved offline`;
    const featured = state.queue[state.currentIndex] || allSorted[0];
    const recent = allSorted.slice(0, 6);

    contentArea.innerHTML = `
      <div class="hero-banner">
        ${featured.coverUrl ? `<img class="hero-art" src="${featured.coverUrl}" />` : `<div class="hero-art">♪</div>`}
        <div class="hero-info">
          <div class="hero-tag">FEATURED TRACK</div>
          <h2>${escapeHtml(cleanDisplayText(featured.title))}</h2>
          <p>${escapeHtml(cleanDisplayText(featured.artist))} • ${escapeHtml(cleanDisplayText(featured.album))}</p>
          <button class="primary-pill-btn" id="heroPlayBtn">▶ Play Now</button>
        </div>
      </div>
      <h3 class="section-heading">Recently Added</h3>
      <div class="cards-grid">
        ${recent
          .map(
            (t, i) => `
          <div class="media-card" data-recent-idx="${i}">
            <div class="card-art-wrap">
              ${t.coverUrl ? `<img src="${t.coverUrl}" />` : `<span>♪</span>`}
            </div>
            <div class="card-title">${escapeHtml(cleanDisplayText(t.title))}</div>
            <div class="card-sub">${escapeHtml(cleanDisplayText(t.artist))}</div>
          </div>`
          )
          .join('')}
      </div>
      <h3 class="section-heading">All Tracks</h3>
      ${renderTrackRows(allSorted)}
    `;

    document.getElementById('heroPlayBtn')?.addEventListener('click', () => playTrackAtIndex(0, [featured, ...allSorted.filter((x) => x.id !== featured.id)]));
    contentArea.querySelectorAll('[data-recent-idx]').forEach((card) => {
      card.addEventListener('click', () => playTrackAtIndex(parseInt(card.dataset.recentIdx, 10), recent));
    });
    attachTrackRowEvents(contentArea, allSorted);
  } else if (state.currentView === 'songs') {
    viewTitle.textContent = 'Songs';
    viewSubtitle.textContent = `${allSorted.length} songs`;
    contentArea.innerHTML = renderTrackRows(allSorted);
    attachTrackRowEvents(contentArea, allSorted);
  } else if (state.currentView === 'liked') {
    const likedTracks = allSorted.filter((t) => t.liked);
    viewTitle.textContent = 'Liked Songs';
    viewSubtitle.textContent = `${likedTracks.length} loved songs`;
    contentArea.innerHTML = renderTrackRows(likedTracks);
    attachTrackRowEvents(contentArea, likedTracks);
  } else if (state.currentView === 'albums') {
    if (state.activeAlbum) {
      const albumTracks = allSorted.filter((t) => cleanDisplayText(t.album) === state.activeAlbum);
      viewTitle.textContent = state.activeAlbum;
      viewSubtitle.textContent = `${albumTracks.length} songs • ${cleanDisplayText(albumTracks[0]?.artist || '')}`;
      contentArea.innerHTML = `<button class="secondary-pill-btn" style="margin-bottom:16px;" id="backAlbumsBtn">← All Albums</button>${renderTrackRows(albumTracks)}`;
      document.getElementById('backAlbumsBtn').addEventListener('click', () => {
        state.activeAlbum = null;
        renderCurrentView();
      });
      attachTrackRowEvents(contentArea, albumTracks);
      return;
    }

    const albumMap = new Map();
    allSorted.forEach((t) => {
      const albName = cleanDisplayText(t.album);
      if (!albumMap.has(albName)) albumMap.set(albName, { name: albName, artist: cleanDisplayText(t.artist), cover: t.coverUrl, count: 0 });
      const entry = albumMap.get(albName);
      entry.count++;
      if (!entry.cover && t.coverUrl) entry.cover = t.coverUrl;
    });

    viewTitle.textContent = 'Albums';
    viewSubtitle.textContent = `${albumMap.size} albums`;
    contentArea.innerHTML = `
      <div class="cards-grid">
        ${Array.from(albumMap.values())
          .map(
            (alb) => `
          <div class="media-card" data-album="${escapeHtml(alb.name)}">
            <div class="card-art-wrap">${alb.cover ? `<img src="${alb.cover}" />` : `<span>💿</span>`}</div>
            <div class="card-title">${escapeHtml(alb.name)}</div>
            <div class="card-sub">${escapeHtml(alb.artist)} • ${alb.count} tracks</div>
          </div>`
          )
          .join('')}
      </div>
    `;
    contentArea.querySelectorAll('[data-album]').forEach((card) => {
      card.addEventListener('click', () => {
        state.activeAlbum = card.dataset.album;
        renderCurrentView();
      });
    });
  } else if (state.currentView === 'artists') {
    if (state.activeArtist) {
      const artistTracks = allSorted.filter((t) => cleanDisplayText(t.artist) === state.activeArtist);
      viewTitle.textContent = state.activeArtist;
      viewSubtitle.textContent = `${artistTracks.length} songs`;
      contentArea.innerHTML = `<button class="secondary-pill-btn" style="margin-bottom:16px;" id="backArtistsBtn">← All Artists</button>${renderTrackRows(artistTracks)}`;
      document.getElementById('backArtistsBtn').addEventListener('click', () => {
        state.activeArtist = null;
        renderCurrentView();
      });
      attachTrackRowEvents(contentArea, artistTracks);
      return;
    }

    const artistMap = new Map();
    allSorted.forEach((t) => {
      const artName = cleanDisplayText(t.artist);
      if (!artistMap.has(artName)) artistMap.set(artName, { name: artName, cover: t.coverUrl, count: 0 });
      const entry = artistMap.get(artName);
      entry.count++;
      if (!entry.cover && t.coverUrl) entry.cover = t.coverUrl;
    });

    viewTitle.textContent = 'Artists';
    viewSubtitle.textContent = `${artistMap.size} artists`;
    contentArea.innerHTML = `
      <div class="cards-grid">
        ${Array.from(artistMap.values())
          .map(
            (art) => `
          <div class="media-card" data-artist="${escapeHtml(art.name)}">
            <div class="card-art-wrap round">${art.cover ? `<img src="${art.cover}" />` : `<span>🎤</span>`}</div>
            <div class="card-title" style="text-align:center">${escapeHtml(art.name)}</div>
            <div class="card-sub" style="text-align:center">${art.count} songs</div>
          </div>`
          )
          .join('')}
      </div>
    `;
    contentArea.querySelectorAll('[data-artist]').forEach((card) => {
      card.addEventListener('click', () => {
        state.activeArtist = card.dataset.artist;
        renderCurrentView();
      });
    });
  } else if (state.currentView === 'playlist') {
    const pl = state.playlists.find((p) => p.id === state.activePlaylistId);
    if (!pl) return;
    const plTracks = pl.trackIds.map((id) => state.tracks.find((t) => t.id === id)).filter(Boolean);
    viewTitle.textContent = pl.name;
    viewSubtitle.textContent = `${plTracks.length} songs in playlist`;
    contentArea.innerHTML = `
      <div style="margin-bottom:16px;display:flex;gap:10px;">
        <button class="secondary-pill-btn" id="renamePlaylistBtn">Rename Playlist</button>
        <button class="secondary-pill-btn" id="deletePlaylistBtn" style="color:var(--accent)">Delete Playlist</button>
      </div>
      ${renderTrackRows(plTracks, pl.id)}
    `;
    document.getElementById('renamePlaylistBtn').addEventListener('click', async () => {
      const name = prompt('New playlist name:', pl.name);
      if (name && name.trim()) {
        pl.name = name.trim();
        await dbPut('playlists', pl);
        renderCurrentView();
      }
    });
    document.getElementById('deletePlaylistBtn').addEventListener('click', async () => {
      state.playlists = state.playlists.filter((p) => p.id !== pl.id);
      await dbDelete('playlists', pl.id);
      state.currentView = 'songs';
      renderCurrentView();
    });
    attachTrackRowEvents(contentArea, plTracks, pl.id);
  }
}

function renderSidebarPlaylists() {
  const container = document.getElementById('playlistList');
  container.innerHTML = state.playlists
    .map(
      (pl) => `
    <button class="nav-item ${state.currentView === 'playlist' && state.activePlaylistId === pl.id ? 'active' : ''}" data-pl-id="${pl.id}">
      <span>🎵</span>
      <span>${escapeHtml(pl.name)}</span>
    </button>`
    )
    .join('');

  container.querySelectorAll('[data-pl-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.currentView = 'playlist';
      state.activePlaylistId = btn.dataset.plId;
      document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('sidebar').classList.remove('open');
      renderCurrentView();
    });
  });
}

function openAddToPlaylistModal(trackId) {
  state.pendingPlaylistTrackId = trackId;
  const modal = document.getElementById('playlistModal');
  const list = document.getElementById('modalPlaylistOptions');
  if (!state.playlists.length) {
    list.innerHTML = `<p style="color:var(--text-secondary);font-size:13px;">No playlists yet. Open the top-left menu (☰) and tap <strong>+</strong> next to Playlists first.</p>`;
  } else {
    list.innerHTML = state.playlists
      .map(
        (pl) => `
      <button class="nav-item" style="width:100%" data-target-pl="${pl.id}">
        <span>🎵</span><span>${escapeHtml(pl.name)}</span>
      </button>`
      )
      .join('');
    list.querySelectorAll('[data-target-pl]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const pl = state.playlists.find((p) => p.id === btn.dataset.targetPl);
        if (pl && !pl.trackIds.includes(state.pendingPlaylistTrackId)) {
          pl.trackIds.push(state.pendingPlaylistTrackId);
          await dbPut('playlists', pl);
        }
        modal.hidden = true;
      });
    });
  }
  modal.hidden = false;
}

function renderDrawer() {
  const body = document.getElementById('drawerBody');
  if (state.drawerTab === 'queue') {
    body.innerHTML = state.queue
      .map(
        (t, idx) => `
      <div class="queue-item ${idx === state.currentIndex ? 'current' : ''}" data-q-idx="${idx}">
        <span style="font-size:12px;width:20px;">${idx + 1}</span>
        <div style="min-width:0;flex:1;">
          <div class="card-title">${escapeHtml(cleanDisplayText(t.title))}</div>
          <div class="card-sub">${escapeHtml(cleanDisplayText(t.artist))}</div>
        </div>
      </div>`
      )
      .join('');
    body.querySelectorAll('[data-q-idx]').forEach((el) => {
      el.addEventListener('click', () => playTrackAtIndex(parseInt(el.dataset.qIdx, 10)));
    });
  } else {
    const track = state.queue[state.currentIndex];
    body.innerHTML = `
      <div style="white-space:pre-wrap;line-height:1.7;font-size:14px;color:var(--text-secondary);">
        ${track && track.lyrics ? escapeHtml(track.lyrics) : 'No lyrics available for the active song.'}
      </div>
    `;
  }
}

/* ==========================================================================
   8. Event Listeners & Initialization
   ========================================================================== */
function bindEvents() {
  document.getElementById('addFilesBtn').addEventListener('click', () => document.getElementById('fileInput').click());
  document.getElementById('addFolderBtn').addEventListener('click', () => document.getElementById('folderInput').click());
  document.getElementById('fileInput').addEventListener('change', (e) => importAudioFiles(e.target.files));
  document.getElementById('folderInput').addEventListener('change', (e) => importAudioFiles(e.target.files));

  const dropOverlay = document.getElementById('dropOverlay');
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropOverlay.classList.add('active');
  });
  dropOverlay.addEventListener('dragleave', () => dropOverlay.classList.remove('active'));
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dropOverlay.classList.remove('active');
    if (e.dataTransfer?.files?.length) importAudioFiles(e.dataTransfer.files);
  });

  document.querySelectorAll('.nav-item[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.currentView = btn.dataset.view;
      state.activeAlbum = null;
      state.activeArtist = null;
      document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('sidebar').classList.remove('open');
      renderCurrentView();
    });
  });

  document.getElementById('openSidebarBtn').addEventListener('click', () => document.getElementById('sidebar').classList.add('open'));
  document.getElementById('closeSidebarBtn').addEventListener('click', () => document.getElementById('sidebar').classList.remove('open'));

  const searchInput = document.getElementById('searchInput');
  const clearSearchBtn = document.getElementById('clearSearchBtn');
  searchInput.addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    clearSearchBtn.hidden = !state.searchQuery;
    renderCurrentView();
  });
  clearSearchBtn.addEventListener('click', () => {
    state.searchQuery = '';
    searchInput.value = '';
    clearSearchBtn.hidden = true;
    renderCurrentView();
  });
  document.getElementById('sortSelect').addEventListener('change', (e) => {
    state.sortBy = e.target.value;
    renderCurrentView();
  });

  document.getElementById('playAllBtn').addEventListener('click', () => {
    const list = getFilteredSortedTracks();
    if (list.length) playTrackAtIndex(0, list);
  });
  document.getElementById('shuffleAllBtn').addEventListener('click', () => {
    const list = getFilteredSortedTracks().sort(() => Math.random() - 0.5);
    if (list.length) playTrackAtIndex(0, list);
  });

  document.getElementById('createPlaylistBtn').addEventListener('click', async () => {
    const name = prompt('Playlist Name:');
    if (!name || !name.trim()) return;
    const pl = { id: `pl-${Date.now()}`, name: name.trim(), trackIds: [] };
    state.playlists.push(pl);
    await dbPut('playlists', pl);
    renderSidebarPlaylists();
  });

  document.getElementById('playPauseBtn').addEventListener('click', togglePlayPause);
  document.getElementById('fsPlayPauseBtn').addEventListener('click', togglePlayPause);
  document.getElementById('nextBtn').addEventListener('click', playNext);
  document.getElementById('fsNextBtn').addEventListener('click', playNext);
  document.getElementById('prevBtn').addEventListener('click', playPrev);
  document.getElementById('fsPrevBtn').addEventListener('click', playPrev);

  const toggleShuffle = () => {
    state.isShuffle = !state.isShuffle;
    document.getElementById('shuffleBtn').classList.toggle('active', state.isShuffle);
    document.getElementById('fsShuffleBtn').classList.toggle('active', state.isShuffle);
  };
  document.getElementById('shuffleBtn').addEventListener('click', toggleShuffle);
  document.getElementById('fsShuffleBtn').addEventListener('click', toggleShuffle);

  const cycleRepeat = () => {
    const modes = ['off', 'all', 'one'];
    state.repeatMode = modes[(modes.indexOf(state.repeatMode) + 1) % modes.length];
    document.getElementById('repeatBtn').classList.toggle('active', state.repeatMode !== 'off');
    document.getElementById('fsRepeatBtn').classList.toggle('active', state.repeatMode !== 'off');
    document.getElementById('repeatOneBadge').hidden = state.repeatMode !== 'one';
  };
  document.getElementById('repeatBtn').addEventListener('click', cycleRepeat);
  document.getElementById('fsRepeatBtn').addEventListener('click', cycleRepeat);

  const seekSlider = document.getElementById('seekSlider');
  const fsSeekSlider = document.getElementById('fsSeekSlider');
  audio.addEventListener('timeupdate', () => {
    const pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
    seekSlider.value = pct;
    fsSeekSlider.value = pct;
    document.getElementById('currentTimeLabel').textContent = formatTime(audio.currentTime);
    document.getElementById('durationLabel').textContent = formatTime(audio.duration);
    document.getElementById('fsCurrentTime').textContent = formatTime(audio.currentTime);
    document.getElementById('fsDuration').textContent = formatTime(audio.duration);
    syncLyricsHighlight(audio.currentTime);
  });

  seekSlider.addEventListener('input', (e) => {
    if (audio.duration) audio.currentTime = (e.target.value / 100) * audio.duration;
  });
  fsSeekSlider.addEventListener('input', (e) => {
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

  document.getElementById('playerLikeBtn').addEventListener('click', () => toggleLikeTrack(state.queue[state.currentIndex]));
  document.getElementById('fsLikeBtn').addEventListener('click', () => toggleLikeTrack(state.queue[state.currentIndex]));

  const volumeSlider = document.getElementById('volumeSlider');
  audio.volume = 0.85;
  volumeSlider.addEventListener('input', (e) => {
    audio.volume = parseFloat(e.target.value);
    audio.muted = audio.volume === 0;
    document.getElementById('muteBtn').textContent = audio.muted ? '🔇' : '🔊';
  });
  document.getElementById('muteBtn').addEventListener('click', () => {
    audio.muted = !audio.muted;
    document.getElementById('muteBtn').textContent = audio.muted ? '🔇' : '🔊';
  });

  const rates = [1.0, 1.25, 1.5, 2.0, 0.75];
  document.getElementById('speedBtn').addEventListener('click', (e) => {
    state.playbackRate = rates[(rates.indexOf(state.playbackRate) + 1) % rates.length];
    audio.playbackRate = state.playbackRate;
    e.target.textContent = `${state.playbackRate}x`;
  });

  // Tapping cover or title area opens Full-Screen Now Playing & Lyrics
  document.getElementById('openFullscreenBtn').addEventListener('click', () => document.getElementById('fullscreenPlayer').classList.add('open'));
  document.querySelector('.player-meta').addEventListener('click', () => document.getElementById('fullscreenPlayer').classList.add('open'));
  document.getElementById('closeFullscreenBtn').addEventListener('click', () => document.getElementById('fullscreenPlayer').classList.remove('open'));

  const sideDrawer = document.getElementById('sideDrawer');
  document.getElementById('queueDrawerBtn').addEventListener('click', () => {
    state.drawerTab = 'queue';
    sideDrawer.classList.toggle('open');
    renderDrawer();
  });
  document.getElementById('lyricsDrawerBtn').addEventListener('click', () => {
    state.drawerTab = 'lyrics';
    sideDrawer.classList.toggle('open');
    renderDrawer();
  });
  document.getElementById('closeDrawerBtn').addEventListener('click', () => sideDrawer.classList.remove('open'));
  document.querySelectorAll('.seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.drawerTab = btn.dataset.drawerTab;
      renderDrawer();
    });
  });

  document.getElementById('fsEditLyricsBtn').addEventListener('click', () => {
    const track = state.queue[state.currentIndex];
    if (!track) return;
    document.getElementById('lyricsTextarea').value = track.lyrics || '';
    document.getElementById('lyricsModal').hidden = false;
  });
  document.getElementById('saveLyricsBtn').addEventListener('click', async () => {
    const track = state.queue[state.currentIndex];
    if (!track) return;
    track.lyrics = document.getElementById('lyricsTextarea').value;
    await persistTrackMetadata(track);
    renderLyrics(track);
    document.getElementById('lyricsModal').hidden = true;
  });
  document.getElementById('fsImportLrcBtn').addEventListener('click', () => document.getElementById('lrcInput').click());
  document.getElementById('lrcInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    const track = state.queue[state.currentIndex];
    if (!file || !track) return;
    track.lyrics = await file.text();
    await persistTrackMetadata(track);
    renderLyrics(track);
  });

  // Add mobile EQ button in Sidebar Footer and Full-Screen header
  const sidebarFooter = document.querySelector('.sidebar-footer');
  if (sidebarFooter && !document.getElementById('mobileEqBtn')) {
    const eqUtil = document.createElement('button');
    eqUtil.id = 'mobileEqBtn';
    eqUtil.className = 'util-btn';
    eqUtil.innerHTML = '<span>🎛️</span><span>5-Band Equalizer</span>';
    eqUtil.addEventListener('click', () => {
      document.getElementById('sidebar').classList.remove('open');
      initAudioEngine();
      document.getElementById('eqModal').hidden = false;
    });
    sidebarFooter.prepend(eqUtil);
  }

  document.getElementById('eqBtn').addEventListener('click', () => {
    initAudioEngine();
    document.getElementById('eqModal').hidden = false;
  });
  document.querySelectorAll('.eq-range').forEach((slider) => {
    slider.addEventListener('input', (e) => {
      const band = parseInt(e.target.dataset.band, 10);
      if (eqFilters[band]) eqFilters[band].gain.value = parseFloat(e.target.value);
    });
  });
  document.querySelectorAll('.preset-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.preset-chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      const vals = EQ_PRESETS[chip.dataset.preset];
      document.querySelectorAll('.eq-range').forEach((slider, idx) => {
        slider.value = vals[idx];
        if (eqFilters[idx]) eqFilters[idx].gain.value = vals[idx];
      });
    });
  });

  document.getElementById('sleepTimerBtn').addEventListener('click', () => {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sleepModal').hidden = false;
  });
  document.querySelectorAll('[data-sleep]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mins = parseInt(btn.dataset.sleep, 10);
      clearInterval(state.sleepTimerId);
      if (mins === 0) {
        document.getElementById('sleepTimerLabel').textContent = 'Sleep Timer';
      } else {
        state.sleepEndTime = Date.now() + mins * 60000;
        state.sleepTimerId = setInterval(() => {
          const rem = Math.max(0, Math.ceil((state.sleepEndTime - Date.now()) / 60000));
          document.getElementById('sleepTimerLabel').textContent = `Sleep: ${rem}m`;
          if (Date.now() >= state.sleepEndTime) {
            clearInterval(state.sleepTimerId);
            audio.pause();
            state.isPlaying = false;
            updatePlayerUI();
            document.getElementById('sleepTimerLabel').textContent = 'Sleep Timer';
          }
        }, 1000);
      }
      document.getElementById('sleepModal').hidden = true;
    });
  });

  document.getElementById('themeToggleBtn').addEventListener('click', () => {
    const html = document.documentElement;
    const isDark = html.getAttribute('data-theme') === 'dark';
    html.setAttribute('data-theme', isDark ? 'light' : 'dark');
    document.getElementById('themeIcon').textContent = isDark ? '🌙' : '☀️';
    document.getElementById('themeText').textContent = isDark ? 'Dark Mode' : 'Light Mode';
  });

  document.querySelectorAll('[data-close-modal]').forEach((btn) => {
    btn.addEventListener('click', () => (document.getElementById(btn.dataset.closeModal).hidden = true));
  });

  window.addEventListener('keydown', (e) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
    if (e.code === 'Space') {
      e.preventDefault();
      togglePlayPause();
    } else if (e.code === 'ArrowRight') playNext();
    else if (e.code === 'ArrowLeft') playPrev();
    else if (e.code === 'KeyM') document.getElementById('muteBtn').click();
    else if (e.code === 'KeyS') toggleShuffle();
    else if (e.code === 'KeyR') cycleRepeat();
    else if (e.code === 'KeyL') document.getElementById('openFullscreenBtn').click();
  });
}

async function bootstrap() {
  bindEvents();
  const savedTracks = await dbGetAll('tracks');
  state.tracks = savedTracks.map((t) => ({
    ...t,
    audioUrl: URL.createObjectURL(t.blob),
    coverUrl: t.coverBlob ? URL.createObjectURL(t.coverBlob) : '',
  }));
  state.playlists = await dbGetAll('playlists');
  state.queue = [...state.tracks];
  renderCurrentView();

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

bootstrap();
