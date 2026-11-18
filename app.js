/* ==========================================================================
   Muse — Native-Style Offline Android Music App Engine
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
  repeatMode: 'off',
  currentView: 'listen-now',
  librarySubTab: 'all', // 'all' | 'albums' | 'artists' | 'liked'
  activePlaylistId: null,
  activeAlbum: null,
  activeArtist: null,
  searchQuery: '',
  sortBy: 'added',
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

function cleanText(str) {
  return String(str || '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

/* ==========================================================================
   1. IndexedDB Offline Storage
   ========================================================================== */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('tracks')) db.createObjectStore('tracks', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('playlists')) db.createObjectStore('playlists', { keyPath: 'id' });
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
   2. ID3v2 Tag & Cover Art Extractor
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
      const frameData = new Uint8Array(buffer, offset + 10, frameSize);

      if (frameId === 'TIT2') meta.title = decodeTextFrame(frameData);
      else if (frameId === 'TPE1') meta.artist = decodeTextFrame(frameData);
      else if (frameId === 'TALB') meta.album = decodeTextFrame(frameData);
      else if (frameId === 'APIC' && !meta.coverBlob) {
        const encoding = frameData[0];
        let i = 1;
        let mime = '';
        while (i < frameData.length && frameData[i] !== 0) mime += String.fromCharCode(frameData[i++]);
        i += 2;
        if (encoding === 1 || encoding === 2) {
          while (i + 1 < frameData.length && !(frameData[i] === 0 && frameData[i + 1] === 0)) i += 2;
          i += 2;
        } else {
          while (i < frameData.length && frameData[i] !== 0) i++;
          i += 1;
        }
        if (i < frameData.length) {
          meta.coverBlob = new Blob([frameData.slice(i)], { type: mime || 'image/jpeg' });
        }
      }
      offset += 10 + frameSize;
    }
  } catch {}
  return meta;
}

function getAudioDuration(url) {
  return new Promise((resolve) => {
    const temp = new Audio();
    temp.src = url;
    temp.addEventListener('loadedmetadata', () => resolve(temp.duration || 0));
    temp.addEventListener('error', () => resolve(0));
  });
}

async function importAudioFiles(fileList) {
  const files = Array.from(fileList).filter((f) => f.type.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|flac)$/i.test(f.name));
  if (!files.length) return;

  for (const file of files) {
    const header = await file.slice(0, 512 * 1024).arrayBuffer();
    const id3 = parseID3v2(header);
    const rawName = cleanText(file.name.replace(/\.[^/.]+$/, ''));
    const parts = rawName.split(' - ');

    const title = cleanText(id3.title || (parts.length > 1 ? parts.slice(1).join(' - ') : rawName));
    const artist = cleanText(id3.artist || (parts.length > 1 ? parts[0] : 'Unknown Artist'));
    const album = cleanText(id3.album || 'Offline Singles');

    const audioUrl = URL.createObjectURL(file);
    const duration = await getAudioDuration(audioUrl);
    const coverUrl = id3.coverBlob ? URL.createObjectURL(id3.coverBlob) : '';

    const record = {
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

    await dbPut('tracks', record);
    state.tracks.push({ ...record, audioUrl, coverUrl });
  }

  if (!state.queue.length) state.queue = [...state.tracks];
  renderCurrentView();
}

/* ==========================================================================
   3. Dynamic Ambient Color & Web Audio EQ / Visualizer
   ========================================================================== */
function updateAmbientColor(imgUrl) {
  if (!imgUrl) {
    document.documentElement.style.setProperty('--dynamic-glow', 'rgba(250, 36, 60, 0.28)');
    return;
  }
  const img = new Image();
  img.crossOrigin = 'Anonymous';
  img.src = imgUrl;
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = 20;
    c.height = 20;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, 20, 20);
    const d = ctx.getImageData(0, 0, 20, 20).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
    }
    document.documentElement.style.setProperty('--dynamic-glow', `rgba(${Math.round(r / n)}, ${Math.round(g / n)}, ${Math.round(b / n)}, 0.42)`);
  };
}

function initAudioEngine() {
  if (audioCtx) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  audioCtx = new Ctx();
  const src = audioCtx.createMediaElementSource(audio);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 128;

  eqFilters = EQ_FREQS.map((freq, idx) => {
    const f = audioCtx.createBiquadFilter();
    f.type = idx === 0 ? 'lowshelf' : idx === EQ_FREQS.length - 1 ? 'highshelf' : 'peaking';
    f.frequency.value = freq;
    f.gain.value = 0;
    return f;
  });

  src.connect(eqFilters[0]);
  for (let i = 0; i < eqFilters.length - 1; i++) eqFilters[i].connect(eqFilters[i + 1]);
  eqFilters[eqFilters.length - 1].connect(analyser);
  analyser.connect(audioCtx.destination);
  drawVisualizer();
}

function drawVisualizer() {
  requestAnimationFrame(drawVisualizer);
  const canvas = document.getElementById('visualizerCanvas');
  if (!canvas || !analyser) return;
  const ctx = canvas.getContext('2d');
  const len = analyser.frequencyBinCount;
  const data = new Uint8Array(len);
  analyser.getByteFrequencyData(data);

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const barW = (canvas.width / len) * 1.5;
  let x = 0;
  for (let i = 0; i < len; i++) {
    const h = (data[i] / 255) * canvas.height;
    ctx.fillStyle = `rgba(255, 255, 255, ${0.35 + (data[i] / 255) * 0.65})`;
    ctx.beginPath();
    ctx.roundRect(x, canvas.height - h, Math.max(2, barW - 2), h, 3);
    ctx.fill();
    x += barW;
  }
}

/* ==========================================================================
   4. Playback Controls
   ========================================================================== */
function formatTime(sec) {
  if (!sec || isNaN(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

async function persistTrack(track) {
  const { audioUrl, coverUrl, ...dbRecord } = track;
  await dbPut('tracks', dbRecord);
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
    await persistTrack(track);
  } catch {}

  updatePlayerUI();
  renderCurrentView();
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
    playTrackAtIndex(Math.floor(Math.random() * state.queue.length));
    return;
  }
  const next = state.currentIndex + 1;
  if (next < state.queue.length) playTrackAtIndex(next);
  else if (state.repeatMode === 'all') playTrackAtIndex(0);
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
  document.getElementById('fsPlayPauseBtn').textContent = state.isPlaying ? '⏸' : '▶';
  document.getElementById('fsArtworkContainer').classList.toggle('playing', state.isPlaying);

  if (!track) return;
  const title = cleanText(track.title);
  const artist = cleanText(track.artist);
  const album = cleanText(track.album);

  document.getElementById('miniTitle').textContent = title;
  document.getElementById('miniArtist').textContent = `${artist} • ${album}`;
  document.getElementById('fsTitle').textContent = title;
  document.getElementById('fsArtist').textContent = `${artist} — ${album}`;

  const mCover = document.getElementById('miniCover');
  const mPlace = document.getElementById('miniCoverPlaceholder');
  const fCover = document.getElementById('fsCover');
  const fPlace = document.getElementById('fsCoverPlaceholder');

  if (track.coverUrl) {
    mCover.src = track.coverUrl; mCover.hidden = false; mPlace.hidden = true;
    fCover.src = track.coverUrl; fCover.hidden = false; fPlace.hidden = true;
  } else {
    mCover.hidden = true; mPlace.hidden = false;
    fCover.hidden = true; fPlace.hidden = false;
  }

  const heart = track.liked ? '♥' : '♡';
  const mLike = document.getElementById('miniLikeBtn');
  const fLike = document.getElementById('fsLikeBtn');
  mLike.textContent = heart;
  fLike.textContent = heart;
  mLike.classList.toggle('liked', track.liked);
  fLike.classList.toggle('liked', track.liked);

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
   5. Lyrics Parser
   ========================================================================== */
function parseLyrics(raw) {
  if (!raw || !raw.trim()) return [];
  const timeRegex = /\[(\d{2}):(\d{2})(?:\.(\d{2,3}))?\]/;
  return raw.split('\n').reduce((acc, line) => {
    const m = line.match(timeRegex);
    if (m) {
      const t = parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + (m[3] ? parseInt(m[3].padEnd(3, '0'), 10) / 1000 : 0);
      const text = line.replace(timeRegex, '').trim();
      if (text) acc.push({ time: t, text });
    } else if (line.trim()) {
      acc.push({ time: null, text: line.trim() });
    }
    return acc;
  }, []);
}

function renderLyrics(track) {
  const box = document.getElementById('fsLyricsContainer');
  if (!track || !track.lyrics) {
    box.innerHTML = `<p class="empty-lyrics-msg">No lyrics added yet. Tap <strong>+ .LRC</strong> or <strong>✎ Lyrics</strong> above.</p>`;
    return;
  }
  const lines = parseLyrics(track.lyrics);
  box.innerHTML = lines
    .map((l) => `<div class="lyric-line" ${l.time !== null ? `data-time="${l.time}"` : ''}>${escapeHtml(l.text)}</div>`)
    .join('');
  box.querySelectorAll('.lyric-line[data-time]').forEach((el) => {
    el.addEventListener('click', () => (audio.currentTime = parseFloat(el.dataset.time)));
  });
}

function syncLyrics(time) {
  const lines = document.querySelectorAll('#fsLyricsContainer .lyric-line[data-time]');
  if (!lines.length) return;
  let active = null;
  lines.forEach((el) => {
    if (time >= parseFloat(el.dataset.time)) active = el;
    el.classList.remove('active');
  });
  if (active) active.classList.add('active');
}

/* ==========================================================================
   6. Views Rendering
   ========================================================================== */
function getSortedTracks(list = state.tracks) {
  const arr = [...list];
  arr.sort((a, b) => {
    if (state.sortBy === 'title') return cleanText(a.title).localeCompare(cleanText(b.title));
    if (state.sortBy === 'artist') return cleanText(a.artist).localeCompare(cleanText(b.artist));
    if (state.sortBy === 'album') return cleanText(a.album).localeCompare(cleanText(b.album));
    if (state.sortBy === 'plays') return (b.plays || 0) - (a.plays || 0);
    return (b.addedAt || 0) - (a.addedAt || 0);
  });
  return arr;
}

function buildSongListHTML(tracks, playlistId = null) {
  const current = state.queue[state.currentIndex];
  if (!tracks.length) return `<p style="color:var(--text-secondary);padding:16px 0;">No songs found.</p>`;

  return tracks
    .map((t, idx) => {
      const playing = current && current.id === t.id;
      return `
      <div class="song-row ${playing ? 'playing' : ''}" data-id="${t.id}" data-idx="${idx}">
        ${t.coverUrl ? `<img class="song-thumb" src="${t.coverUrl}" alt="" />` : `<div class="song-thumb">♪</div>`}
        <div class="song-info">
          <div class="song-title">${escapeHtml(cleanText(t.title))}</div>
          <div class="song-sub">${escapeHtml(cleanText(t.artist))} • ${formatTime(t.duration)}</div>
        </div>
        <div class="song-actions">
          <button class="row-btn ${t.liked ? 'liked' : ''}" data-act="like">${t.liked ? '♥' : '♡'}</button>
          <button class="row-btn" data-act="pl">+</button>
          <button class="row-btn" data-act="del">🗑</button>
        </div>
      </div>`;
    })
    .join('');
}

function wireSongList(tracks, playlistId = null) {
  contentArea.querySelectorAll('.song-row').forEach((row) => {
    const id = row.dataset.id;
    const idx = parseInt(row.dataset.idx, 10);
    const track = tracks.find((t) => t.id === id);

    row.addEventListener('click', (e) => {
      const actBtn = e.target.closest('[data-act]');
      if (actBtn) {
        e.stopPropagation();
        const act = actBtn.dataset.act;
        if (act === 'like') {
          track.liked = !track.liked;
          persistTrack(track);
          updatePlayerUI();
          renderCurrentView();
        } else if (act === 'pl') {
          openAddToPlaylist(track.id);
        } else if (act === 'del') {
          deleteTrack(track.id, playlistId);
        }
        return;
      }
      playTrackAtIndex(idx, tracks);
    });
  });
}

async function deleteTrack(trackId, playlistId) {
  if (playlistId) {
    const pl = state.playlists.find((p) => p.id === playlistId);
    if (pl) {
      pl.trackIds = pl.trackIds.filter((id) => id !== trackId);
      await dbPut('playlists', pl);
    }
  } else {
    const i = state.tracks.findIndex((t) => t.id === trackId);
    if (i !== -1) {
      URL.revokeObjectURL(state.tracks[i].audioUrl);
      if (state.tracks[i].coverUrl) URL.revokeObjectURL(state.tracks[i].coverUrl);
      state.tracks.splice(i, 1);
      state.queue = state.queue.filter((t) => t.id !== trackId);
      await dbDelete('tracks', trackId);
    }
  }
  renderCurrentView();
}

function openAddToPlaylist(trackId) {
  state.pendingPlaylistTrackId = trackId;
  const list = document.getElementById('modalPlaylistOptions');
  if (!state.playlists.length) {
    list.innerHTML = `<p style="color:var(--text-secondary);font-size:13px;">No playlists yet. Go to the <strong>Playlists</strong> tab at the bottom to create one first.</p>`;
  } else {
    list.innerHTML = state.playlists
      .map((pl) => `<button class="sheet-option-btn" data-pl="${pl.id}"><span class="opt-icon">🎵</span><strong>${escapeHtml(pl.name)}</strong></button>`)
      .join('');
    list.querySelectorAll('[data-pl]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const pl = state.playlists.find((p) => p.id === btn.dataset.pl);
        if (pl && !pl.trackIds.includes(state.pendingPlaylistTrackId)) {
          pl.trackIds.push(state.pendingPlaylistTrackId);
          await dbPut('playlists', pl);
        }
        document.getElementById('playlistModal').hidden = true;
      });
    });
  }
  document.getElementById('playlistModal').hidden = false;
}

function renderCurrentView() {
  document.getElementById('subToolbar').hidden = state.currentView === 'search' || state.currentView === 'playlists';

  if (state.tracks.length === 0 && state.currentView !== 'playlists') {
    viewTitle.textContent = 'Muse';
    viewSubtitle.textContent = '0 songs offline';
    contentArea.innerHTML = `
      <div class="empty-box">
        <div style="font-size:40px;">♪</div>
        <h2>Your Offline Music Library</h2>
        <p>Tap <strong>+ Import</strong> at the top right to add MP3, FLAC, WAV, or M4A songs from your phone storage.</p>
        <button class="accent-pill-btn" onclick="document.getElementById('importSheet').hidden = false">+ Import Music</button>
      </div>
    `;
    return;
  }

  const sorted = getSortedTracks();

  if (state.currentView === 'listen-now') {
    viewTitle.textContent = 'Listen Now';
    viewSubtitle.textContent = `${state.tracks.length} songs saved offline`;
    const featured = state.queue[state.currentIndex] || sorted[0];
    const recent = sorted.slice(0, 4);

    contentArea.innerHTML = `
      <div class="hero-card">
        ${featured.coverUrl ? `<img class="hero-art" src="${featured.coverUrl}" />` : `<div class="hero-art">♪</div>`}
        <div class="hero-meta">
          <div class="hero-kicker">FEATURED TRACK</div>
          <h2>${escapeHtml(cleanText(featured.title))}</h2>
          <p>${escapeHtml(cleanText(featured.artist))} • ${escapeHtml(cleanText(featured.album))}</p>
          <button class="accent-pill-btn" id="heroPlayBtn">▶ Play Now</button>
        </div>
      </div>

      <h3 class="section-title">Recently Added</h3>
      <div class="media-grid">
        ${recent
          .map(
            (t, i) => `
          <div class="media-tile" data-ridx="${i}">
            <div class="tile-art">${t.coverUrl ? `<img src="${t.coverUrl}" />` : `<span>♪</span>`}</div>
            <div class="tile-title">${escapeHtml(cleanText(t.title))}</div>
            <div class="tile-sub">${escapeHtml(cleanText(t.artist))}</div>
          </div>`
          )
          .join('')}
      </div>

      <h3 class="section-title">All Songs</h3>
      ${buildSongListHTML(sorted)}
    `;

    document.getElementById('heroPlayBtn')?.addEventListener('click', () => {
      playTrackAtIndex(0, [featured, ...sorted.filter((x) => x.id !== featured.id)]);
    });
    contentArea.querySelectorAll('[data-ridx]').forEach((tile) => {
      tile.addEventListener('click', () => playTrackAtIndex(parseInt(tile.dataset.ridx, 10), recent));
    });
    wireSongList(sorted);
  } else if (state.currentView === 'songs') {
    viewTitle.textContent = 'Library';
    viewSubtitle.textContent = `${sorted.length} songs`;

    const segHTML = `
      <div class="segment-row">
        <button class="seg-pill ${state.librarySubTab === 'all' ? 'active' : ''}" data-sub="all">Songs</button>
        <button class="seg-pill ${state.librarySubTab === 'albums' ? 'active' : ''}" data-sub="albums">Albums</button>
        <button class="seg-pill ${state.librarySubTab === 'artists' ? 'active' : ''}" data-sub="artists">Artists</button>
        <button class="seg-pill ${state.librarySubTab === 'liked' ? 'active' : ''}" data-sub="liked">Liked</button>
      </div>
    `;

    if (state.librarySubTab === 'all') {
      contentArea.innerHTML = segHTML + buildSongListHTML(sorted);
      wireSongList(sorted);
    } else if (state.librarySubTab === 'liked') {
      const liked = sorted.filter((t) => t.liked);
      contentArea.innerHTML = segHTML + buildSongListHTML(liked);
      wireSongList(liked);
    } else if (state.librarySubTab === 'albums') {
      if (state.activeAlbum) {
        const albTracks = sorted.filter((t) => cleanText(t.album) === state.activeAlbum);
        contentArea.innerHTML = `${segHTML}<button class="secondary-chip-btn" style="margin-bottom:12px;" id="backAlb">← All Albums</button>${buildSongListHTML(albTracks)}`;
        document.getElementById('backAlb').addEventListener('click', () => { state.activeAlbum = null; renderCurrentView(); });
        wireSongList(albTracks);
      } else {
        const map = new Map();
        sorted.forEach((t) => {
          const k = cleanText(t.album);
          if (!map.has(k)) map.set(k, { name: k, artist: cleanText(t.artist), cover: t.coverUrl, count: 0 });
          map.get(k).count++;
          if (!map.get(k).cover && t.coverUrl) map.get(k).cover = t.coverUrl;
        });
        contentArea.innerHTML = `${segHTML}<div class="media-grid">${Array.from(map.values())
          .map((a) => `<div class="media-tile" data-alb="${escapeHtml(a.name)}"><div class="tile-art">${a.cover ? `<img src="${a.cover}" />` : `<span>💿</span>`}</div><div class="tile-title">${escapeHtml(a.name)}</div><div class="tile-sub">${a.count} songs</div></div>`)
          .join('')}</div>`;
        contentArea.querySelectorAll('[data-alb]').forEach((el) => el.addEventListener('click', () => { state.activeAlbum = el.dataset.alb; renderCurrentView(); }));
      }
    } else if (state.librarySubTab === 'artists') {
      if (state.activeArtist) {
        const artTracks = sorted.filter((t) => cleanText(t.artist) === state.activeArtist);
        contentArea.innerHTML = `${segHTML}<button class="secondary-chip-btn" style="margin-bottom:12px;" id="backArt">← All Artists</button>${buildSongListHTML(artTracks)}`;
        document.getElementById('backArt').addEventListener('click', () => { state.activeArtist = null; renderCurrentView(); });
        wireSongList(artTracks);
      } else {
        const map = new Map();
        sorted.forEach((t) => {
          const k = cleanText(t.artist);
          if (!map.has(k)) map.set(k, { name: k, cover: t.coverUrl, count: 0 });
          map.get(k).count++;
          if (!map.get(k).cover && t.coverUrl) map.get(k).cover = t.coverUrl;
        });
        contentArea.innerHTML = `${segHTML}<div class="media-grid">${Array.from(map.values())
          .map((a) => `<div class="media-tile" data-art="${escapeHtml(a.name)}"><div class="tile-art round">${a.cover ? `<img src="${a.cover}" />` : `<span>🎤</span>`}</div><div class="tile-title" style="text-align:center">${escapeHtml(a.name)}</div><div class="tile-sub" style="text-align:center">${a.count} songs</div></div>`)
          .join('')}</div>`;
        contentArea.querySelectorAll('[data-art]').forEach((el) => el.addEventListener('click', () => { state.activeArtist = el.dataset.art; renderCurrentView(); }));
      }
    }

    contentArea.querySelectorAll('[data-sub]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.librarySubTab = btn.dataset.sub;
        state.activeAlbum = null;
        state.activeArtist = null;
        renderCurrentView();
      });
    });
  } else if (state.currentView === 'search') {
    viewTitle.textContent = 'Search';
    const q = state.searchQuery.toLowerCase().trim();
    const matches = q
      ? sorted.filter((t) => cleanText(t.title).toLowerCase().includes(q) || cleanText(t.artist).toLowerCase().includes(q) || cleanText(t.album).toLowerCase().includes(q))
      : sorted;
    viewSubtitle.textContent = `${matches.length} matching songs`;

    contentArea.innerHTML = `
      <div class="native-search-bar">
        <span>🔍</span>
        <input type="text" id="mobileSearchInput" placeholder="Songs, artists, or albums..." value="${escapeHtml(state.searchQuery)}" />
        ${state.searchQuery ? `<button class="row-btn" id="clearMobileSearch">✕</button>` : ''}
      </div>
      ${buildSongListHTML(matches)}
    `;

    const inp = document.getElementById('mobileSearchInput');
    inp.focus();
    inp.setSelectionRange(inp.value.length, inp.value.length);
    inp.addEventListener('input', (e) => {
      state.searchQuery = e.target.value;
      renderCurrentView();
    });
    document.getElementById('clearMobileSearch')?.addEventListener('click', () => {
      state.searchQuery = '';
      renderCurrentView();
    });
    wireSongList(matches);
  } else if (state.currentView === 'playlists') {
    if (state.activePlaylistId) {
      const pl = state.playlists.find((p) => p.id === state.activePlaylistId);
      if (!pl) { state.activePlaylistId = null; renderCurrentView(); return; }
      const plTracks = pl.trackIds.map((id) => state.tracks.find((t) => t.id === id)).filter(Boolean);
      viewTitle.textContent = pl.name;
      viewSubtitle.textContent = `${plTracks.length} songs`;
      contentArea.innerHTML = `
        <div style="display:flex;gap:8px;margin-bottom:14px;">
          <button class="secondary-chip-btn" id="backPlBtn">← Playlists</button>
          <button class="accent-pill-btn" id="playPlBtn">▶ Play All</button>
          <button class="secondary-chip-btn" id="delPlBtn" style="color:var(--accent)">Delete</button>
        </div>
        ${buildSongListHTML(plTracks, pl.id)}
      `;
      document.getElementById('backPlBtn').addEventListener('click', () => { state.activePlaylistId = null; renderCurrentView(); });
      document.getElementById('playPlBtn').addEventListener('click', () => { if (plTracks.length) playTrackAtIndex(0, plTracks); });
      document.getElementById('delPlBtn').addEventListener('click', async () => {
        state.playlists = state.playlists.filter((p) => p.id !== pl.id);
        await dbDelete('playlists', pl.id);
        state.activePlaylistId = null;
        renderCurrentView();
      });
      wireSongList(plTracks, pl.id);
      return;
    }

    viewTitle.textContent = 'Playlists';
    viewSubtitle.textContent = `${state.playlists.length} playlists`;
    contentArea.innerHTML = `
      <button class="accent-pill-btn" style="margin-bottom:16px;width:100%;padding:12px;" id="openNewPlSheet">+ Create New Playlist</button>
      <div class="sheet-actions-list">
        ${state.playlists
          .map((pl) => `<button class="sheet-option-btn" data-open-pl="${pl.id}"><span class="opt-icon">🎵</span><div><strong>${escapeHtml(pl.name)}</strong><small>${pl.trackIds.length} songs</small></div></button>`)
          .join('')}
      </div>
    `;
    document.getElementById('openNewPlSheet').addEventListener('click', () => {
      document.getElementById('newPlaylistNameInput').value = '';
      document.getElementById('createPlaylistModal').hidden = false;
    });
    contentArea.querySelectorAll('[data-open-pl]').forEach((btn) => {
      btn.addEventListener('click', () => { state.activePlaylistId = btn.dataset.openPl; renderCurrentView(); });
    });
  }
}

/* ==========================================================================
   7. Events & Bootstrap
   ========================================================================== */
function bindEvents() {
  document.getElementById('importMenuBtn').addEventListener('click', () => (document.getElementById('importSheet').hidden = false));
  document.getElementById('pickFilesBtn').addEventListener('click', () => {
    document.getElementById('importSheet').hidden = true;
    document.getElementById('fileInput').click();
  });
  document.getElementById('pickFolderBtn').addEventListener('click', () => {
    document.getElementById('importSheet').hidden = true;
    document.getElementById('folderInput').click();
  });
  document.getElementById('fileInput').addEventListener('change', (e) => importAudioFiles(e.target.files));
  document.getElementById('folderInput').addEventListener('change', (e) => importAudioFiles(e.target.files));

  // Bottom Navigation Tabs
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.currentView = btn.dataset.view;
      state.activePlaylistId = null;
      state.activeAlbum = null;
      state.activeArtist = null;
      renderCurrentView();
    });
  });

  // Sort, Play All, Shuffle All
  document.getElementById('sortSelect').addEventListener('change', (e) => { state.sortBy = e.target.value; renderCurrentView(); });
  document.getElementById('playAllBtn').addEventListener('click', () => { const l = getSortedTracks(); if (l.length) playTrackAtIndex(0, l); });
  document.getElementById('shuffleAllBtn').addEventListener('click', () => { const l = getSortedTracks().sort(() => Math.random() - 0.5); if (l.length) playTrackAtIndex(0, l); });

  // Create Playlist Sheet
  document.getElementById('confirmCreatePlaylistBtn').addEventListener('click', async () => {
    const name = document.getElementById('newPlaylistNameInput').value.trim();
    if (!name) return;
    const pl = { id: `pl-${Date.now()}`, name, trackIds: [] };
    state.playlists.push(pl);
    await dbPut('playlists', pl);
    document.getElementById('createPlaylistModal').hidden = true;
    renderCurrentView();
  });

  // Transport Controls
  document.getElementById('miniPlayPauseBtn').addEventListener('click', togglePlayPause);
  document.getElementById('fsPlayPauseBtn').addEventListener('click', togglePlayPause);
  document.getElementById('miniNextBtn').addEventListener('click', playNext);
  document.getElementById('fsNextBtn').addEventListener('click', playNext);
  document.getElementById('fsPrevBtn').addEventListener('click', playPrev);

  document.getElementById('miniLikeBtn').addEventListener('click', () => {
    const t = state.queue[state.currentIndex];
    if (!t) return;
    t.liked = !t.liked;
    persistTrack(t);
    updatePlayerUI();
    renderCurrentView();
  });
  document.getElementById('fsLikeBtn').addEventListener('click', () => document.getElementById('miniLikeBtn').click());

  document.getElementById('fsShuffleBtn').addEventListener('click', (e) => {
    state.isShuffle = !state.isShuffle;
    e.currentTarget.classList.toggle('active', state.isShuffle);
  });

  document.getElementById('fsRepeatBtn').addEventListener('click', (e) => {
    const modes = ['off', 'all', 'one'];
    state.repeatMode = modes[(modes.indexOf(state.repeatMode) + 1) % modes.length];
    e.currentTarget.classList.toggle('active', state.repeatMode !== 'off');
    document.getElementById('fsRepeatOneBadge').hidden = state.repeatMode !== 'one';
  });

  // Progress & Seek
  const fsSeek = document.getElementById('fsSeekSlider');
  audio.addEventListener('timeupdate', () => {
    const pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
    document.getElementById('miniProgressFill').style.width = `${pct}%`;
    fsSeek.value = pct;
    document.getElementById('fsCurrentTime').textContent = formatTime(audio.currentTime);
    document.getElementById('fsDuration').textContent = formatTime(audio.duration);
    syncLyrics(audio.currentTime);
  });
  fsSeek.addEventListener('input', (e) => { if (audio.duration) audio.currentTime = (e.target.value / 100) * audio.duration; });
  audio.addEventListener('ended', () => {
    if (state.repeatMode === 'one') { audio.currentTime = 0; audio.play(); }
    else playNext();
  });

  // Fullscreen Sheet
  document.getElementById('openFullscreenBtn').addEventListener('click', () => document.getElementById('fullscreenPlayer').classList.add('open'));
  document.getElementById('closeFullscreenBtn').addEventListener('click', () => document.getElementById('fullscreenPlayer').classList.remove('open'));

  // EQ, Speed, Sleep, Lyrics
  document.getElementById('fsEqBtn').addEventListener('click', () => { initAudioEngine(); document.getElementById('eqModal').hidden = false; });
  document.querySelectorAll('.eq-range').forEach((s) => s.addEventListener('input', (e) => {
    const b = parseInt(e.target.dataset.band, 10);
    if (eqFilters[b]) eqFilters[b].gain.value = parseFloat(e.target.value);
  }));
  document.querySelectorAll('.preset-chip').forEach((c) => c.addEventListener('click', () => {
    document.querySelectorAll('.preset-chip').forEach((x) => x.classList.remove('active'));
    c.classList.add('active');
    const vals = EQ_PRESETS[c.dataset.preset];
    document.querySelectorAll('.eq-range').forEach((s, i) => { s.value = vals[i]; if (eqFilters[i]) eqFilters[i].gain.value = vals[i]; });
  }));

  const rates = [1.0, 1.25, 1.5, 2.0, 0.75];
  document.getElementById('fsSpeedBtn').addEventListener('click', (e) => {
    state.playbackRate = rates[(rates.indexOf(state.playbackRate) + 1) % rates.length];
    audio.playbackRate = state.playbackRate;
    e.currentTarget.textContent = `${state.playbackRate}x`;
  });

  document.getElementById('fsSleepBtn').addEventListener('click', () => (document.getElementById('sleepModal').hidden = false));
  document.querySelectorAll('[data-sleep]').forEach((b) => b.addEventListener('click', () => {
    const mins = parseInt(b.dataset.sleep, 10);
    clearInterval(state.sleepTimerId);
    if (mins === 0) {
      document.getElementById('fsSleepBtn').textContent = '⏱ Sleep';
    } else {
      state.sleepEndTime = Date.now() + mins * 60000;
      state.sleepTimerId = setInterval(() => {
        const rem = Math.max(0, Math.ceil((state.sleepEndTime - Date.now()) / 60000));
        document.getElementById('fsSleepBtn').textContent = `⏱ ${rem}m`;
        if (Date.now() >= state.sleepEndTime) {
          clearInterval(state.sleepTimerId);
          audio.pause();
          state.isPlaying = false;
          updatePlayerUI();
          document.getElementById('fsSleepBtn').textContent = '⏱ Sleep';
        }
      }, 1000);
    }
    document.getElementById('sleepModal').hidden = true;
  }));

  document.getElementById('fsEditLyricsBtn').addEventListener('click', () => {
    const t = state.queue[state.currentIndex];
    if (!t) return;
    document.getElementById('lyricsTextarea').value = t.lyrics || '';
    document.getElementById('lyricsModal').hidden = false;
  });
  document.getElementById('saveLyricsBtn').addEventListener('click', async () => {
    const t = state.queue[state.currentIndex];
    if (!t) return;
    t.lyrics = document.getElementById('lyricsTextarea').value;
    await persistTrack(t);
    renderLyrics(t);
    document.getElementById('lyricsModal').hidden = true;
  });
  document.getElementById('fsImportLrcBtn').addEventListener('click', () => document.getElementById('lrcInput').click());
  document.getElementById('lrcInput').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    const t = state.queue[state.currentIndex];
    if (!f || !t) return;
    t.lyrics = await f.text();
    await persistTrack(t);
    renderLyrics(t);
  });

  // Theme Toggle
  document.getElementById('themeToggleBtn').addEventListener('click', (e) => {
    const html = document.documentElement;
    const isDark = html.getAttribute('data-theme') === 'dark';
    html.setAttribute('data-theme', isDark ? 'light' : 'dark');
    e.currentTarget.textContent = isDark ? '🌙' : '☀️';
  });

  // Close Bottom Sheets
  document.querySelectorAll('[data-close-modal]').forEach((b) => {
    b.addEventListener('click', () => (document.getElementById(b.dataset.closeModal).hidden = true));
  });
  document.querySelectorAll('.sheet-backdrop').forEach((bg) => {
    bg.addEventListener('click', (e) => { if (e.target === bg) bg.hidden = true; });
  });
}

async function bootstrap() {
  bindEvents();
  const saved = await dbGetAll('tracks');
  state.tracks = saved.map((t) => ({
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
