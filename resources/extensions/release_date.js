/* Optimized + Resilient Now Playing Release Date (NPRD)
   - Performance: caching, debouncing, rAF batching
   - Unique: age since release, album type badge, calendar icon, anniversary highlight
   - Robustness: stronger readiness checks, resilient DOM attachment with retries + MutationObserver, guarded API usage
*/

(() => {
  const DEBUG = false;
  const log = (...args) => { if (DEBUG) console.log('[NPRD]', ...args); };
  const warn = (...args) => { if (DEBUG) console.warn('[NPRD]', ...args); };
  const error = (...args) => console.error('[NPRD]', ...args);

  console.log('[Now Playing Release Date] loaded');

  // Async wait with exponential backoff and cap
  async function waitUntil(predicate, opts = {}) {
    const { initial = 50, max = 500, timeout = 20000 } = opts;
    let delay = initial;
    const start = Date.now();
    if (predicate()) return;
    while (!predicate()) {
      if (Date.now() - start > timeout) throw new Error('waitUntil timeout');
      await new Promise(r => setTimeout(r, delay));
      delay = Math.min(max, Math.floor(delay * 1.6));
    }
  }

  async function waitForSpicetify() {
    await waitUntil(() => typeof Spicetify !== 'undefined' && Spicetify?.Player && Spicetify?.Platform && typeof Spicetify.showNotification !== 'undefined');
  }

  async function waitForTrackData() {
    await waitUntil(() => Spicetify?.Player?.data?.item);
  }

  const positions = [
    { value: ".main-nowPlayingWidget-nowPlaying:not(#upcomingSongDiv) .main-trackInfo-artists", text: "Artist" },
    { value: ".main-nowPlayingWidget-nowPlaying:not(#upcomingSongDiv) .main-trackInfo-name", text: "Song name" }
  ];
  const dateformat = [
    { value: "DD-MM-YYYY", text: "DD-MM-YYYY" },
    { value: "MM-DD-YYYY", text: "MM-DD-YYYY" },
    { value: "YYYY-MM-DD", text: "YYYY-MM-DD" }
  ];
  const separatorOpts = [
    { value: "•", text: "Dot" },
    { value: "-", text: "Dash" },
    { value: "\u200E", text: "None" },
  ];

  // Feature toggles
  const featureDefaults = {
    showAge: 'true',
    showAlbumBadge: 'true',
    showCalendarIcon: 'true',
    highlightAnniversary: 'true',
  };

  // Defaults
  if (!localStorage.getItem('position')) {
    localStorage.setItem('position', positions[1].value);
    localStorage.setItem('dateFormat', dateformat[0].value);
    localStorage.setItem('separator', separatorOpts[0].value);
  } else if (localStorage.getItem('position') !== positions[0].value && localStorage.getItem('position') !== positions[1].value) {
    localStorage.setItem('position', positions[1].value);
  }
  for (const [k, v] of Object.entries(featureDefaults)) {
    if (localStorage.getItem(k) == null) localStorage.setItem(k, v);
  }

  // Album metadata cache and in-flight registry
  const albumCache = new Map(); // albumId -> { album, releaseDate }
  const inflight = new Map(); // albumId -> Promise
  const CACHE_MAX = 100;

  function cacheSet(albumId, value) {
    if (albumCache.size >= CACHE_MAX) {
      const firstKey = albumCache.keys().next().value;
      if (firstKey) albumCache.delete(firstKey);
    }
    albumCache.set(albumId, value);
  }

  async function getTrackDetailsRD() {
    await waitForTrackData();

    const playerData = Spicetify.Player.data;
    if (!playerData?.item?.uri) throw new Error('No track data available');
    const albumUri = playerData.item.album?.uri;
    if (!albumUri) throw new Error('No album URI available in player data');

    const albumId = albumUri.split(':')[2];

    if (albumCache.has(albumId)) {
      const cached = albumCache.get(albumId);
      return {
        trackDetails: playerData.item,
        album: cached.album,
        releaseDate: cached.releaseDate,
        operatingSystem: await (Spicetify.Platform?.operatingSystem ?? 'Unknown'),
      };
    }

    if (inflight.has(albumId)) {
      log('Coalescing in-flight album request for', albumId);
      await inflight.get(albumId);
      const cached = albumCache.get(albumId);
      if (cached) {
        return {
          trackDetails: playerData.item,
          album: cached.album,
          releaseDate: cached.releaseDate,
          operatingSystem: await (Spicetify.Platform?.operatingSystem ?? 'Unknown'),
        };
      }
    }

    const p = (async () => {
      let albumDetails = null;
      try {
        const idObj = Spicetify.URI?.from?.(albumUri);
        const hexAlbumId = idObj?.id ? Spicetify.URI.idToHex(idObj.id) : null;
        if (hexAlbumId) {
          const rb = Spicetify.Platform?.RequestBuilder?.build?.();
          if (rb?.withHost && rb?.withPath && rb?.send) {
            const albumResponse = await rb
              .withHost("https://spclient.wg.spotify.com/metadata/4")
              .withPath(`/album/${hexAlbumId}`)
              .send();
            albumDetails = await albumResponse.body;
          }
        }
      } catch (internalAlbumError) {
        if (internalAlbumError?.message?.includes('DUPLICATE_REQUEST_ERROR')) {
          await new Promise(r => setTimeout(r, 100));
          try {
            const idObj2 = Spicetify.URI?.from?.(albumUri);
            const hexAlbumId2 = idObj2?.id ? Spicetify.URI.idToHex(idObj2.id) : null;
            const rb2 = Spicetify.Platform?.RequestBuilder?.build?.();
            if (hexAlbumId2 && rb2?.withHost && rb2?.withPath && rb2?.send) {
              const albumResponse2 = await rb2
                .withHost("https://spclient.wg.spotify.com/metadata/4")
                .withPath(`/album/${hexAlbumId2}`)
                .send();
              albumDetails = await albumResponse2.body;
            }
          } catch {
            albumDetails = null;
          }
        } else {
          albumDetails = null;
        }
      }

      if (albumDetails && albumDetails.code === 429) {
        albumDetails = null;
      }

      let album;
      let releaseDate;
      if (albumDetails?.date) {
        const dateInfo = albumDetails.date;
        let normalizedImages = [];
        if (albumDetails.cover_group?.image) {
          normalizedImages = albumDetails.cover_group.image.map(img => ({
            url: `https://i.scdn.co/image/${img.file_id}`,
            width: img.width,
            height: img.height
          }));
        }
        album = {
          name: albumDetails.name || playerData.item.album.name,
          artists: albumDetails.artist || playerData.item.album.artists,
          album_type: albumDetails.type || 'album',
          gid: albumDetails.gid || albumId,
          external_urls: { spotify: albumDetails.canonical_uri || albumUri },
          images: normalizedImages.length > 0 ? normalizedImages : playerData.item.album.images
        };
        releaseDate = new Date(dateInfo.year, (dateInfo.month || 1) - 1, dateInfo.day || 1);
      } else {
        album = {
          name: playerData.item.album.name || 'Unknown Album',
          artists: playerData.item.album.artists ? playerData.item.album.artists.map(artist => ({ name: artist.name })) : [{ name: 'Unknown Artist' }],
          album_type: 'album',
          gid: albumId || 'unknown',
          external_urls: { spotify: albumUri || '' },
          images: playerData.item.album.images || []
        };
        releaseDate = new Date();
      }

      cacheSet(albumId, { album, releaseDate });
      return {
        trackDetails: playerData.item,
        album,
        releaseDate,
        operatingSystem: await (Spicetify.Platform?.operatingSystem ?? 'Unknown'),
      };
    })();

    inflight.set(albumId, p);
    try {
      return await p;
    } finally {
      inflight.delete(albumId);
    }
  }

  // OS cache on window to preserve behavior
  window.operatingSystem = window.operatingSystem || null;
  (async function bootstrapOS() {
    try {
      await waitForTrackData();
      if (window.operatingSystem == null) {
        const details = await getTrackDetailsRD();
        window.operatingSystem = details.operatingSystem || 'Unknown';
      }
    } catch (e) {
      error('Failed to get operating system:', e);
      window.operatingSystem = 'Unknown';
    }
  })();

  function releaseDateCSS() {
    const styleId = 'nprd-style';
    if (document.getElementById(styleId)) return null;
    const style = document.createElement('style');
    style.id = styleId;
    style.innerHTML = `
      .main-nowPlayingWidget-nowPlaying:not(#upcomingSongDiv) .main-nowPlayingWidget-trackInfo { min-width: 14rem; }
      #settingsMenu { display: none; position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); overflow: auto; max-height: 80vh; background-color: var(--spice-main); padding: 20px; margin: 0; border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,0.7); flex-direction: column; width: min(90vw, 520px); z-index: 10001; gap: 12px; border: 1px solid var(--spice-subtext); }
      #nprd-backdrop, .nprd-backdrop { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.75); z-index: 10000; }
      #settingsMenu h2 { padding: 0; margin: 0; color: var(--spice-text); font-size: 1.1rem; }
      #settingsMenu .nprd-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-bottom: 12px; border-bottom: 1px solid var(--spice-subtext); }
      #settingsMenu .nprd-close { background: transparent; border: 1px solid var(--spice-subtext); color: var(--spice-text); border-radius: 6px; width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
      #settingsMenu .nprd-close:hover { background: var(--spice-subtext); }
      #settingsMenu label { color: var(--spice-text); opacity: 0.9; }
      #settingsMenu select, #settingsMenu input[type="checkbox"] { background: var(--spice-main); color: var(--spice-text); border: 1px solid var(--spice-subtext); border-radius: 6px; }
      #settingsMenu select { padding: 6px; }
      #optionsDiv { display: flex; flex-direction: column; padding: 10px 0; }
      #settingsMenu a { display: flex; align-items: center; max-width: 100%; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--spice-text); text-decoration: none; }
      #settingsMenu a:hover { color: var(--spice-text-bright-accent); }
      .Dropdown-container { overflow: visible; display: flex; justify-content: space-between; align-items: center; margin-top: 10px; gap: 10px; }
      .releaseDateDropdown-control { flex-grow: 1; display: inline; justify-content: space-between; border: 1px solid var(--spice-subtext); padding: 5px; cursor: pointer; min-width: fit-content; max-width: 10rem; background-color: var(--spice-main); color: var(--spice-text); }
      .Dropdown-optionsList { position: fixed; background-color: var(--spice-main); z-index: 1; border: 1px solid var(--spice-subtext); box-shadow: 0 4px 8px rgba(0,0,0,0.1); }
      .Dropdown-option { padding: 5px; cursor: pointer; color: var(--spice-text); }
      .Dropdown-option:hover { background-color: var(--spice-subtext); }
      .main-nowPlayingWidget-nowPlaying:not(#upcomingSongDiv) .main-trackInfo-artists,
      .main-nowPlayingWidget-nowPlaying:not(#upcomingSongDiv) .main-trackInfo-name,
      #releaseDate { display: flex; gap: 4px; white-space: nowrap; align-items: center; }
      #releaseDate { display: contents; margin-right: 8px; }
      #releaseDate a, #releaseDate p { color: var(--text-subdued); }
      /* Hide Music video label/badge if present */
      [aria-label="Music video"], [title="Music video"], [aria-label*="Music video" i], [title*="Music video" i] { display: none !important; }
      .nprd-hidden { display: none !important; }
      .nprd-badge { padding: 1px 6px; border-radius: 10px; font-size: 10px; text-transform: capitalize; background: var(--spice-subtext); color: var(--spice-text); opacity: 0.85; }
      .nprd-age { font-size: 11px; opacity: 0.8; }
      .nprd-icon { opacity: 0.8; }
      .nprd-anniv { animation: nprdPulse 1.6s ease-in-out 3; }
      @keyframes nprdPulse { 0% { text-shadow: 0 0 0 var(--spice-text-bright-accent);} 50% { text-shadow: 0 0 10px var(--spice-text-bright-accent);} 100% { text-shadow: 0 0 0 var(--spice-text-bright-accent);} }
    `;
    return style;
  }

  async function initializeRD() {
    try {
      await waitForSpicetify();

      const css = releaseDateCSS();
      if (css) document.head.appendChild(css);

      createSettingsMenu();
      hideElementById('settingsMenu');

      // Debounced render on song change
      let scheduled = false;
      const scheduleRender = () => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(async () => {
          try {
            removeExistingReleaseDateElement();
            await displayReleaseDate();
            updateSettingsMenuAlbumInfo();
            hideMusicVideoBadge();
            ensureMVObserver();
          } catch (e) {
            error('Error in song change render:', e);
          } finally {
            scheduled = false;
          }
        });
      };

      try { Spicetify.Player.addEventListener('songchange', scheduleRender); } catch {}

      // Initial render regardless of OS
      try {
        await displayReleaseDate();
        updateSettingsMenuAlbumInfo();
        hideMusicVideoBadge();
        ensureMVObserver();
      } catch (e) {
        error('Initial display failed:', e);
      }
    } catch (e) {
      error('Error initializing:', e, '\nCreate a new issue on the github repo to get this resolved');
    }
  }

  function hideElementById(id) { const el = document.getElementById(id); if (el) el.style.display = 'none'; }
  function removeElementById(id) { const el = document.getElementById(id); if (el) el.remove(); }
  function removeExistingReleaseDateElement() { removeElementById('releaseDate'); }
  function createDivElement(id) { const div = document.createElement('div'); if (id) div.id = id; return div; }
  function createAnchorElement(textContent) { const a = document.createElement('a'); a.textContent = textContent; a.style.cursor = 'pointer'; return a; }
  function setElementStyles(element, styles) { element.style.fontSize = styles.fontSize; element.style.fontWeight = styles.fontWeight; element.style.minWidth = '75px'; }

  function formatDate(date, fmt) {
    const dd = String(date.getDate()).padStart(2, '0');
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const yyyy = date.getFullYear();
    switch (fmt) {
      case 'DD-MM-YYYY': return `${dd}-${mm}-${yyyy}`;
      case 'MM-DD-YYYY': return `${mm}-${dd}-${yyyy}`;
      case 'YYYY-MM-DD': return `${yyyy}-${mm}-${dd}`;
      default: return `${yyyy}-${mm}-${dd}`;
    }
  }

  function computeAgeString(date) {
    const now = new Date();
    let years = now.getFullYear() - date.getFullYear();
    let months = now.getMonth() - date.getMonth();
    let days = now.getDate() - date.getDate();
    if (days < 0) months -= 1;
    if (months < 0) { years -= 1; months += 12; }
    if (years > 0) return `${years}y${months > 0 ? ` ${months}m` : ''}`;
    if (months > 0) return `${months}m`;
    const diffDays = Math.max(0, Math.floor((now - date) / (1000*60*60*24)));
    if (diffDays >= 7) return `${Math.floor(diffDays/7)}w`;
    if (diffDays >= 1) return `${diffDays}d`;
    const hours = Math.floor((now - date) / (1000*60*60));
    if (hours >= 1) return `${hours}h`;
    const mins = Math.floor((now - date) / (1000*60));
    return `${Math.max(0, mins)}m`;
  }

  function isAnniversary(date) {
    const now = new Date();
    return now.getMonth() === date.getMonth() && now.getDate() === date.getDate();
  }

  function titleForDate(date, albumType, artists) {
    const full = date.toDateString();
    const artist = Array.isArray(artists) ? (artists[0]?.name || '') : (artists?.name || '');
    return `${full}${albumType ? ` • ${albumType}` : ''}${artist ? ` • ${artist}` : ''}`;
  }

  // Hide any visible "Music video" text/badges in the now playing area
  function hideMusicVideoBadge() {
    const root = document.querySelector('.main-nowPlayingWidget-nowPlaying');
    if (!root) return;

    // Attribute-based hide (fast path via CSS already), ensure any non-attributed text is hidden too
    try {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => node.nodeValue && /music\s*video/i.test(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
      });
      const toHide = new Set();
      let n;
      while ((n = walker.nextNode())) {
        const el = n.parentElement;
        if (el) toHide.add(el);
      }
      toHide.forEach(el => { el.classList.add('nprd-hidden'); pruneDanglingSeparatorsAround(el); });
    } catch {}

    // Generic fallback: any element whose trimmed text is exactly "Music video"
    try {
      const nodes = root.querySelectorAll('*:not(script):not(style)');
      for (const el of nodes) {
        const t = (el.textContent || '').trim();
        if (t.length && /^music\s*video$/i.test(t)) {
          el.classList.add('nprd-hidden'); pruneDanglingSeparatorsAround(el);
        }
      }
    } catch {}
  }

  // Remove dangling separator characters around a removed/hidden element
  function pruneDanglingSeparatorsAround(el) {
    if (!el || !el.parentNode) return;
    const isSepText = (t) => /^[\s]*[•·\-–—|]+[\s]*$/.test(t || '');
    const pruneNodeIfSep = (node) => {
      if (!node) return false;
      if (node.nodeType === Node.TEXT_NODE) {
        if (isSepText(node.nodeValue)) { node.remove(); return true; }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const txt = (node.textContent || '').trim();
        if (isSepText(txt)) { node.remove(); return true; }
      }
      return false;
    };
    pruneNodeIfSep(el.previousSibling);
    pruneNodeIfSep(el.nextSibling);
  }

  // Persistent observer to keep Music video elements hidden
  let __nprdMVObserver = null;
  function ensureMVObserver() {
    if (__nprdMVObserver) return;
    const root = document.querySelector('.main-nowPlayingWidget-nowPlaying');
    if (!root) return;
    let timer = null;
    __nprdMVObserver = new MutationObserver(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        hideMusicVideoBadge();
      }, 50);
    });
    __nprdMVObserver.observe(root, { childList: true, subtree: true, characterData: true });
  }

  // Attach a node to the first found selector, with retries and a short-lived MutationObserver fallback
  async function attachWithRetries(node, selectors, { attempts = 50, interval = 100, observeMs = 8000 } = {}) {
    let container = null;
    for (let i = 0; i < attempts; i++) {
      for (const sel of selectors) {
        container = document.querySelector(sel);
        if (container) break;
      }
      if (container) break;
      await new Promise(r => setTimeout(r, interval));
    }
    if (container) {
      container.appendChild(node);
      return true;
    }

    // Fallback: Observe for a short period for any matching selector to appear
    const found = await new Promise(resolve => {
      const start = Date.now();
      const mo = new MutationObserver(() => {
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el) {
            el.appendChild(node);
            mo.disconnect();
            resolve(true);
            return;
          }
        }
        if (Date.now() - start > observeMs) {
          mo.disconnect();
          resolve(false);
        }
      });
      mo.observe(document.body, { childList: true, subtree: true });
      // Also stop after observeMs even if no mutations
      setTimeout(() => { mo.disconnect(); resolve(false); }, observeMs);
    });

    if (!found) warn('Container not found after retries and observation');
    return found;
  }

  async function displayReleaseDate() {
    try {
      const { releaseDate, album } = await getTrackDetailsRD();
      const lsPosition = localStorage.getItem('position');
      const lsSeparator = localStorage.getItem('separator');
      const lsDateFormat = localStorage.getItem('dateFormat');

      const formattedReleaseDate = formatDate(releaseDate, lsDateFormat);

      // Preserve settings menu open state across re-render
      const settingsMenuRef = document.getElementById('settingsMenu');
      const backdropRef = document.getElementById('nprd-backdrop');
      const wasOpen = !!settingsMenuRef && settingsMenuRef.style.display !== 'none' && settingsMenuRef.style.display !== '';

      removeExistingReleaseDateElement();

      const releaseDateElement = createReleaseDateElement(lsSeparator, formattedReleaseDate, releaseDate, album);

      const selectors = [
        lsPosition,
        '.main-trackInfo-name',
        '.main-nowPlayingWidget .main-trackInfo-name',
        '[data-encore-id="trackInfo"]',
        '.main-trackInfo-container .main-trackInfo-name',
        '.main-trackInfo-container [class*="name"]',
        '.main-nowPlayingWidget-trackInfo [class*="name"]',
      ].filter(Boolean);

      const attached = await attachWithRetries(releaseDateElement, selectors, { attempts: 50, interval: 100, observeMs: 8000 });
      if (!attached) {
        setTimeout(() => {
          if (!releaseDateElement.isConnected) {
            attachWithRetries(releaseDateElement, selectors, { attempts: 50, interval: 100, observeMs: 8000 });
          }
        }, 1000);
      }

      // Restore settings menu visibility if it was open
      if (wasOpen && settingsMenuRef) {
        settingsMenuRef.style.display = 'flex';
        if (backdropRef) backdropRef.style.display = 'block';
      }
    } catch (e) { error('Error displaying release date:', e); }
  }

  function createReleaseDateElement(separator, formattedReleaseDate, releaseDate, album) {
    const root = createDivElement('releaseDate');

    if (localStorage.getItem('showCalendarIcon') === 'true') {
      const icon = document.createElement('span');
      icon.textContent = '📅';
      icon.className = 'nprd-icon';
      root.appendChild(icon);
    }

    if (separator && separator.trim() !== '') {
      const sep = document.createElement('p');
      sep.textContent = separator;
      root.appendChild(sep);
    }

    const dateA = createAnchorElement(formattedReleaseDate);
    dateA.title = titleForDate(releaseDate, album?.album_type, album?.artists);
    if (localStorage.getItem('highlightAnniversary') === 'true' && isAnniversary(releaseDate)) {
      dateA.classList.add('nprd-anniv');
      try { Spicetify.showNotification?.('🎉 Album anniversary!'); } catch {}
    }
    root.appendChild(dateA);

    if (localStorage.getItem('showAge') === 'true') {
      const age = document.createElement('span');
      age.className = 'nprd-age';
      age.textContent = `(${computeAgeString(releaseDate)})`;
      age.title = 'Time since release';
      root.appendChild(age);
    }

    if (localStorage.getItem('showAlbumBadge') === 'true' && album?.album_type) {
      const badge = document.createElement('span');
      badge.className = 'nprd-badge';
      badge.textContent = album.album_type;
      root.appendChild(badge);
    }

    const posSel = localStorage.getItem('position');
    if (posSel) {
      const targetA = document.querySelector(`${posSel} a`);
      if (targetA) setElementStyles(root, window.getComputedStyle(targetA));
    }

    let settingsMenu = document.getElementById('settingsMenu');
    if (!settingsMenu) createSettingsMenu();
    settingsMenu = document.getElementById('settingsMenu');

    dateA.addEventListener('click', (ev) => { ev.preventDefault(); toggleSettingsMenu(dateA, settingsMenu); });

    return root;
  }

  function createSettingsMenu() {
    const existing = document.getElementById('settingsMenu');
    if (existing) existing.remove();

    const settingsMenu = createDivElement('settingsMenu');

    const header = document.createElement('div');
    header.className = 'nprd-header';
    const title = document.createElement('h2');
    title.textContent = 'NPRD Settings';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'nprd-close';
    closeBtn.setAttribute('aria-label', 'Close settings');
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', () => {
      const backdrop = document.getElementById('nprd-backdrop');
      settingsMenu.style.display = 'none';
      if (backdrop) backdrop.style.display = 'none';
    });
    header.appendChild(title);
    header.appendChild(closeBtn);
    settingsMenu.appendChild(header);

    const optionsDiv = document.createElement('div');
    optionsDiv.id = 'optionsDiv';

    optionsDiv.appendChild(createNativeDropdown('position', 'Position', positions));
    optionsDiv.appendChild(createNativeDropdown('dateFormat', 'Date Format', dateformat));
    optionsDiv.appendChild(createNativeDropdown('separator', 'Separator style', separatorOpts));

    optionsDiv.appendChild(createToggle('showCalendarIcon', 'Calendar Icon'));
    optionsDiv.appendChild(createToggle('showAge', 'Show Age Since Release'));
    optionsDiv.appendChild(createToggle('showAlbumBadge', 'Album Type Badge'));
    optionsDiv.appendChild(createToggle('highlightAnniversary', 'Anniversary Highlight'));

    settingsMenu.appendChild(optionsDiv);

    const albumInfoAnchor = document.createElement('a');
    albumInfoAnchor.id = 'nprd-album-info';
    settingsMenu.appendChild(albumInfoAnchor);

    document.body.appendChild(settingsMenu);

    updateSettingsMenuAlbumInfo();
  }

  function createToggle(key, labelText) {
    const container = document.createElement('div');
    container.classList.add('Dropdown-container');

    const label = document.createElement('label');
    label.textContent = labelText;
    container.appendChild(label);

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = localStorage.getItem(key) === 'true';
    input.addEventListener('change', async () => {
      localStorage.setItem(key, input.checked ? 'true' : 'false');
      await displayReleaseDate();
    });

    container.appendChild(input);
    return container;
  }

  async function updateSettingsMenuAlbumInfo() {
    try {
      const container = document.getElementById('nprd-album-info');
      if (!container) return;
      container.textContent = '';

      const { album, releaseDate } = await getTrackDetailsRD();
      container.href = album.external_urls.spotify || '#';

      let albumImage;
      if (Array.isArray(album.images) && album.images.length > 0) {
        const smallImage = [...album.images].sort((a, b) => (a.width * a.height) - (b.width * b.height))[0];
        if (smallImage?.url) {
          albumImage = document.createElement('img');
          albumImage.src = smallImage.url;
          albumImage.width = 50;
          albumImage.height = 50;
          albumImage.style.marginRight = '1rem';
          albumImage.style.borderRadius = '4px';
          albumImage.style.objectFit = 'cover';
        }
      }

      const albumNameElement = document.createElement('p');
      const mainArtist = Array.isArray(album.artists) ? album.artists[0]?.name : (album.artists?.name || 'Unknown Artist');
      albumNameElement.textContent = `${album.name} - ${mainArtist}`;

      const albumTypeElement = document.createElement('p');
      const df = localStorage.getItem('dateFormat');
      albumTypeElement.textContent = `${album.album_type || ''} • ${formatDate(releaseDate, df)}`;
      albumTypeElement.style.cssText = 'text-transform: capitalize;';

      const albumContainer = document.createElement('div');
      albumContainer.appendChild(albumNameElement);
      albumContainer.appendChild(albumTypeElement);

      if (albumImage) container.appendChild(albumImage);
      container.appendChild(albumContainer);
    } catch (e) {
      error('Error updating album info:', e);
      const container = document.getElementById('nprd-album-info');
      if (container) {
        const fallback = document.createElement('p');
        fallback.textContent = 'Album information unavailable';
        fallback.style.color = 'var(--spice-subtext)';
        container.appendChild(fallback);
      }
    }
  }

  function createNativeDropdown(id, label, options) {
    const dropdownContainer = document.createElement('div');
    dropdownContainer.classList.add('Dropdown-container');

    const labelElement = document.createElement('label');
    labelElement.textContent = label;
    dropdownContainer.appendChild(labelElement);

    const selectElement = document.createElement('select');
    selectElement.id = id;
    selectElement.classList.add('releaseDateDropdown-control');

    const current = localStorage.getItem(id);
    for (const opt of options) {
      const optionElement = document.createElement('option');
      optionElement.value = opt.value;
      optionElement.textContent = opt.text;
      if (current === opt.value) optionElement.selected = true;
      selectElement.appendChild(optionElement);
    }

    selectElement.addEventListener('change', async () => {
      localStorage.setItem(id, selectElement.value);
      await displayReleaseDate();
      if (id === 'dateFormat') updateSettingsMenuAlbumInfo();
    });

    dropdownContainer.appendChild(selectElement);
    return dropdownContainer;
  }

  function toggleSettingsMenu(dateElement, settingsMenu) {
    // Ensure backdrop exists
    let backdrop = document.getElementById('nprd-backdrop');
    if (!backdrop) {
      backdrop = document.createElement('div');
      backdrop.id = 'nprd-backdrop';
      backdrop.className = 'nprd-backdrop';
      document.body.appendChild(backdrop);
    }

    const show = () => {
      function close() {
        settingsMenu.style.display = 'none';
        backdrop.style.display = 'none';
        document.removeEventListener('keydown', escHandler);
      }
      const escHandler = (e) => { if (e.key === 'Escape') close(); };

      backdrop.addEventListener('click', close, { once: true });
      document.addEventListener('keydown', escHandler);

      settingsMenu.style.display = 'flex';
      backdrop.style.display = 'block';
    };

    const hide = () => {
      settingsMenu.style.display = 'none';
      backdrop.style.display = 'none';
    };

    const isHidden = settingsMenu.style.display === '' || settingsMenu.style.display === 'none';
    if (isHidden) show(); else hide();
  }

  (async function main() { await initializeRD(); })();
})();
