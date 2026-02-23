// NFC Reading Module - Event-based continuous scanning
const nfcReader = {
  controller: null,
  reader: null,

  async start(onRead, onError) {
    if (this.controller) return;

    try {
      this.controller = new AbortController();
      this.reader = new NDEFReader();

      await this.reader.scan({ signal: this.controller.signal });

      this.reader.addEventListener('reading', ({ message, serialNumber }) => {
        onRead(message, serialNumber);
      });

      this.reader.addEventListener('readingerror', () => {
        onError('Fehler beim Lesen des NFC-Tags');
      });

    } catch (error) {
      if (error.name !== 'AbortError') {
        onError(error.message);
      }
      this.controller = null;
      this.reader = null;
    }
  },

  stop() {
    if (this.controller) {
      this.controller.abort();
      this.controller = null;
      this.reader = null;
    }
  },

  isScanning() {
    return this.controller !== null;
  }
};

// NFC Writing Module - Promise-based single write operation
const nfcWriter = {
  controller: null,

  async write(records, onProgress) {
    if (this.controller) {
      throw new Error('Write operation already in progress');
    }

    const writer = new NDEFReader();
    this.controller = new AbortController();

    try {
      if (onProgress) onProgress('reading');
      if (onProgress) onProgress('writing');
      await writer.write({ records, signal: this.controller.signal });
      if (onProgress) onProgress('success');
      this.controller = null;
      return true;
    } catch (error) {
      this.controller = null;
      if (onProgress) onProgress('error', error);
      throw error;
    }
  },

  cancel() {
    if (this.controller) {
      this.controller.abort();
      this.controller = null;
    }
  },

  isWriting() {
    return this.controller !== null;
  }
};

// Platform Detection
const platform = {
  _ua: navigator.userAgent || '',

  get isIOS() {
    return /iPad|iPhone|iPod/.test(this._ua) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  },

  get isAndroid() {
    return /Android/i.test(this._ua);
  },

  get isChromeAndroid() {
    return this.isAndroid && /Chrome\/\d+/i.test(this._ua) && !/EdgA|OPR|SamsungBrowser/i.test(this._ua);
  },

  get isMobile() {
    return this.isIOS || this.isAndroid || /Mobi/i.test(this._ua);
  },

  get hasWebNFC() {
    return 'NDEFReader' in window;
  },

  get hasWebShare() {
    return 'share' in navigator && 'canShare' in navigator;
  },

  get nfcStatusMessage() {
    if (this.hasWebNFC) return '✅ NFC bereit – Tags können direkt beschrieben werden';
    if (this.isAndroid && !this.isChromeAndroid)
      return '📱 Öffne die Seite in Chrome für direktes NFC-Schreiben';
    if (this.isChromeAndroid && window.location.protocol !== 'https:')
      return '🔒 NFC braucht HTTPS – öffne: https://' + window.location.hostname + ':8443';
    if (this.isIOS) return '📱 iOS: Lade die Datei herunter und schreibe mit «NFC Tools» App';
    if (this.isAndroid) return '📱 Öffne in Chrome für direktes NFC-Schreiben';
    return '💻 Desktop: Lade die Datei herunter und schreibe mit einem NFC-Schreiber';
  },

  get platformName() {
    if (this.isIOS) return 'iOS';
    if (this.isAndroid) return 'Android';
    return 'Desktop';
  }
};

// Error Reporter - captures errors and sends to backend
const ErrorReporter = {
  _lastError: null,

  capture(message, source, lineno, colno, error) {
    this._lastError = {
      message: String(message || ''),
      stack: (error && error.stack) || '',
      source: source || '',
      line: lineno,
      col: colno
    };
  },

  capturePromise(reason) {
    const msg = reason && (reason.message || String(reason));
    const stack = reason && reason.stack ? reason.stack : '';
    this._lastError = { message: msg, stack, source: '', line: 0, col: 0 };
  },

  getLastError() {
    return this._lastError;
  },

  clear() {
    this._lastError = null;
  },

  async send(userMessage = '', screenshot = null) {
    const err = this._lastError || {};
    const loc = window.location;
    const apiBase = `${loc.protocol}//${loc.host}/api`;
    const payload = {
      errorMessage: err.message || '',
      errorStack: err.stack || '',
      userMessage: (userMessage || '').trim().slice(0, 2000),
      pageUrl: window.location.href,
      url: (typeof app !== 'undefined' && app.spoolmanUrl) ? app.spoolmanUrl : ''
    };
    if (screenshot) payload.screenshot = screenshot;

    const fetchFn = (typeof Auth !== 'undefined' && Auth.fetch) ? Auth.fetch.bind(Auth) : fetch;
    const headers = (typeof Auth !== 'undefined' && Auth.getHeaders) ? Auth.getHeaders() : { 'Content-Type': 'application/json' };
    const resp = await fetchFn(`${apiBase}/error-report`, {
      method: 'POST',
      headers,
      // Avoid hanging forever on slow mobile networks / tunnels.
      signal: (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(15000) : undefined,
      body: JSON.stringify(payload)
    });

    const data = await resp.json().catch(() => ({}));
    if (resp.ok && data.status === 'ok') return true;
    throw new Error(data.message || `HTTP ${resp.status}`);
  }
};


// Event-Delegation (läuft beim Laden, unabhängig von init-Return)
document.addEventListener('click', function(e) {
  if (typeof app === 'undefined') return;
  const btn = e.target.closest('.lang-btn');
  if (btn) {
    e.preventDefault();
    e.stopPropagation();
    app.setLanguage(btn.dataset.lang || 'de');
    return;
  }
  if (e.target.closest('#themeToggle') || e.target.closest('.theme-toggle')) {
    e.preventDefault();
    app.toggleTheme();
    return;
  }
  if (e.target.closest('#logoutBtn')) {
    e.preventDefault();
    app.logout();
    return;
  }
  if (e.target.closest('#spoolmanLink')) {
    e.preventDefault();
    app.openSpoolman();
    return;
  }
  if (e.target.closest('#showRegisterLink')) {
    e.preventDefault();
    app.showRegister();
    return;
  }
  if (e.target.closest('#showLoginLink')) {
    e.preventDefault();
    app.showLogin();
    return;
  }
}, true);

// Main Application
const app = {
  nfcSupported: false,
  spoolmanUrl: localStorage.getItem('spoolmanUrl') || '',

  materialPresets: {
    'PLA': { minTemp: 190, maxTemp: 220, bedTempMin: 50, bedTempMax: 60 },
    'PETG': { minTemp: 220, maxTemp: 250, bedTempMin: 70, bedTempMax: 80 },
    'ABS': { minTemp: 230, maxTemp: 260, bedTempMin: 90, bedTempMax: 110 },
    'ASA': { minTemp: 240, maxTemp: 270, bedTempMin: 90, bedTempMax: 110 },
    'TPU': { minTemp: 210, maxTemp: 230, bedTempMin: 30, bedTempMax: 60 },
    'PA': { minTemp: 240, maxTemp: 270, bedTempMin: 70, bedTempMax: 90 },
    'PA12': { minTemp: 240, maxTemp: 270, bedTempMin: 70, bedTempMax: 90 },
    'PC': { minTemp: 270, maxTemp: 310, bedTempMin: 100, bedTempMax: 120 },
    'PEEK': { minTemp: 360, maxTemp: 400, bedTempMin: 120, bedTempMax: 150 },
    'PVA': { minTemp: 190, maxTemp: 220, bedTempMin: 50, bedTempMax: 60 },
    'HIPS': { minTemp: 230, maxTemp: 250, bedTempMin: 90, bedTempMax: 110 },
    'PCTG': { minTemp: 220, maxTemp: 250, bedTempMin: 70, bedTempMax: 80 },
    'PLA-CF': { minTemp: 190, maxTemp: 220, bedTempMin: 50, bedTempMax: 60 },
    'PETG-CF': { minTemp: 230, maxTemp: 260, bedTempMin: 70, bedTempMax: 80 },
    'PA-CF': { minTemp: 250, maxTemp: 280, bedTempMin: 70, bedTempMax: 90 }
  },

  brandCatalog: {
    'Bambu Lab': {
      materials: ['PLA', 'PETG', 'ABS', 'ASA', 'TPU', 'PA', 'PC', 'PVA', 'PLA-CF', 'PETG-CF', 'PA-CF'],
      variants: ['Basic', 'Matte', 'Silk', 'HF', 'Support', '95A', '95A HF'],
    },
    'Hatchbox': {
      materials: ['PLA', 'PETG', 'ABS', 'TPU', 'PLA-CF'],
      variants: ['Basic', 'Silk', 'Matte'],
    },
    'eSun': {
      materials: ['PLA', 'PETG', 'ABS', 'ASA', 'TPU', 'PA', 'PVA', 'HIPS', 'PCTG', 'PLA-CF', 'PETG-CF', 'PA-CF'],
      variants: ['Basic', 'Silk', 'Matte', 'HF'],
    },
    'Overture': {
      materials: ['PLA', 'PETG', 'ABS', 'TPU', 'PLA-CF'],
      variants: ['Basic', 'Matte', 'Silk'],
    },
    'SUNLU': {
      materials: ['PLA', 'PETG', 'ABS', 'ASA', 'TPU', 'PLA-CF'],
      variants: ['Basic', 'Silk', 'Matte'],
    },
    'Polymaker': {
      materials: ['PLA', 'PETG', 'ABS', 'ASA', 'TPU', 'PA', 'PC', 'PVA', 'HIPS', 'PLA-CF', 'PETG-CF', 'PA-CF', 'PCTG'],
      variants: ['Basic', 'Matte', 'Silk'],
    },
    'Prusament': {
      materials: ['PLA', 'PETG', 'ABS', 'ASA', 'PA', 'PC', 'PVA', 'PCTG'],
      variants: ['Basic'],
    },
    'Snapmaker': {
      materials: ['PLA', 'PETG', 'ABS', 'TPU'],
      variants: ['Basic'],
    },
    'Jayo': {
      materials: ['PLA', 'PETG', 'ABS', 'TPU', 'PLA-CF'],
      variants: ['Basic', 'Silk', 'Matte'],
    },
  },

  palettes: {
    material: {
      paletteId: 'materialPalette',
      inputId: 'materialType',
      items: () => Object.keys(app.materialPresets),
      defaultValue: 'PLA',
      onSelect() { app.applyTemperaturePreset(); app.updateVisibility(); app.refreshAllowedColors(); },
    },
    brand: {
      paletteId: 'brandPalette',
      inputId: 'brandValue',
      items: ['Generic', 'Bambu Lab', 'Hatchbox', 'eSun', 'Overture', 'SUNLU', 'Polymaker', 'Prusament', 'Snapmaker', 'Jayo'],
      defaultValue: 'Generic',
      customInputId: 'brandInput',
      onSelect(value) { app.filterPalettesForBrand(value); app.refreshAllowedColors(); },
    },
    variant: {
      paletteId: 'variantPalette',
      inputId: 'extendedSubType',
      items: ['Basic', 'Matte', 'SnapSpeed', 'Silk', 'Support', 'HF', '95A', '95A HF'],
      defaultValue: 'Basic',
      onSelect() { app.refreshAllowedColors(); },
    },
  },

  _errorReportScreenshot: null,

  showErrorReportModal() {
    const overlay = document.getElementById('errorReportOverlay');
    const preview = document.getElementById('errorReportPreview');
    const textarea = document.getElementById('errorReportUserMessage');
    const status = document.getElementById('errorReportStatus');
    if (!overlay) return;

    const err = ErrorReporter.getLastError();
    if (err && (err.message || err.stack)) {
      preview.style.display = 'block';
      preview.textContent = (err.message || '(keine Nachricht)') + (err.stack ? '\n\n' + err.stack.slice(0, 500) : '');
      preview.title = 'Letzter erfasster Fehler';
    } else {
      preview.style.display = 'none';
    }
    if (textarea) textarea.value = '';
    if (status) { status.textContent = ''; status.className = 'status-message'; }
    this.clearErrorReportFile();
    overlay.classList.remove('hidden');
  },

  closeErrorReportModal() {
    const overlay = document.getElementById('errorReportOverlay');
    if (overlay) overlay.classList.add('hidden');
    this.clearErrorReportFile();
  },

  clearErrorReportFile() {
    this._errorReportScreenshot = null;
    const fileInput = document.getElementById('errorReportFile');
    const thumb = document.getElementById('errorReportThumb');
    const label = document.getElementById('errorReportDropLabel');
    const info = document.getElementById('errorReportFileInfo');
    if (fileInput) fileInput.value = '';
    if (thumb) thumb.style.display = 'none';
    if (label) label.style.display = 'block';
    if (info) info.textContent = '';
  },

  handleErrorReportFileDrop(files) {
    if (files && files.length > 0) this._processErrorReportFile(files[0]);
  },

  handleErrorReportFileChange(files) {
    if (files && files.length > 0) this._processErrorReportFile(files[0]);
  },

  _canvasToDataUrl(canvas, type, quality) {
    // toBlob is async and less janky than toDataURL on mobile.
    return new Promise((resolve, reject) => {
      try {
        canvas.toBlob((blob) => {
          if (!blob) return reject(new Error('Bild konnte nicht codiert werden'));
          const r = new FileReader();
          r.onload = () => resolve(String(r.result || ''));
          r.onerror = () => reject(new Error('Bild konnte nicht gelesen werden'));
          r.readAsDataURL(blob);
        }, type, quality);
      } catch (e) {
        reject(e);
      }
    });
  },

  async _processErrorReportFile(file) {
    const info = document.getElementById('errorReportFileInfo');
    const MAX_BYTES = 5 * 1024 * 1024;

    if (!file.type.startsWith('image/')) {
      if (info) info.textContent = '⚠️ Nur Bilddateien erlaubt (PNG, JPG, WebP).';
      return;
    }
    if (file.size > MAX_BYTES) {
      if (info) info.textContent = '⚠️ Datei zu groß (max. 5 MB).';
      return;
    }
    if (info) info.textContent = '⏳ Bild wird vorbereitet…';

    try {
      const reader = new FileReader();
      const fileDataUrl = await new Promise((resolve, reject) => {
        reader.onload = (e) => resolve(e && e.target ? e.target.result : '');
        reader.onerror = () => reject(new Error('Datei konnte nicht gelesen werden'));
        reader.readAsDataURL(file);
      });

      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error('Bild konnte nicht geladen werden'));
        img.src = fileDataUrl;
      });

      // Keep payload small for mobile + tunnels.
      const MAX_DIM = 1280;
      let w = img.width, h = img.height;
      if (w > MAX_DIM || h > MAX_DIM) {
        const ratio = Math.min(MAX_DIM / w, MAX_DIM / h);
        w = Math.round(w * ratio);
        h = Math.round(h * ratio);
      }

      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);

      // Try a couple qualities to keep it reasonably small.
      let dataUrl = await this._canvasToDataUrl(canvas, 'image/jpeg', 0.72);
      let kb = Math.round(dataUrl.length * 0.75 / 1024);
      if (kb > 900) {
        dataUrl = await this._canvasToDataUrl(canvas, 'image/jpeg', 0.6);
        kb = Math.round(dataUrl.length * 0.75 / 1024);
      }

      this._errorReportScreenshot = dataUrl;

      const thumb = document.getElementById('errorReportThumb');
      const thumbImg = document.getElementById('errorReportThumbImg');
      const label = document.getElementById('errorReportDropLabel');
      if (thumbImg) thumbImg.src = dataUrl;
      if (thumb) thumb.style.display = 'inline-block';
      if (label) label.style.display = 'none';
      if (info) info.textContent = `✅ ${file.name} · ${w}×${h}px · ~${kb} KB`;
    } catch (e) {
      this._errorReportScreenshot = null;
      if (info) info.textContent = '❌ Screenshot konnte nicht vorbereitet werden.';
    }
  },

  async submitErrorReport() {
    const textarea = document.getElementById('errorReportUserMessage');
    const status = document.getElementById('errorReportStatus');
    const submitBtn = document.getElementById('errorReportSubmitBtn');
    const cancelBtn = document.getElementById('errorReportCancelBtn');
    const userMessage = textarea ? textarea.value : '';

    if (status) { status.textContent = ''; status.className = 'status-message'; }

    try {
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.dataset.originalText = submitBtn.textContent;
        submitBtn.textContent = 'Wird gesendet…';
      }
      if (cancelBtn) cancelBtn.disabled = true;
      if (status) { status.textContent = '⏳ Sende…'; status.className = 'status-message warning'; }

      await ErrorReporter.send(userMessage, this._errorReportScreenshot);
      if (status) {
        status.textContent = '✅ Danke! Der Fehlerbericht wurde gesendet.';
        status.className = 'status-message success';
      }
      this.showMobileToast && this.showMobileToast('Fehlerbericht gesendet', 'success');
      setTimeout(() => this.closeErrorReportModal(), 1500);
    } catch (e) {
      if (status) {
        status.textContent = '❌ Senden fehlgeschlagen: ' + (e.message || 'Netzwerkfehler');
        status.className = 'status-message error';
      }
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = submitBtn.dataset.originalText || 'Absenden';
      }
      if (cancelBtn) cancelBtn.disabled = false;
    }
  },

  async checkAuth() {
    const authSection = document.getElementById('authSection');
    const appContainer = document.getElementById('appContainer');
    const logoutBtn = document.getElementById('logoutBtn');
    const themeToggle = document.getElementById('themeToggle');

    if (!Auth || !Auth.isLoggedIn()) {
      if (authSection) authSection.style.display = 'block';
      if (appContainer) appContainer.style.display = 'none';
      if (logoutBtn) logoutBtn.style.display = 'none';
      return false;
    }

    const loc = window.location;
    const apiBase = `${loc.protocol}//${loc.host}/api`;
    try {
      const resp = await Auth.fetch(`${apiBase}/auth/me`);
      if (!resp.ok) {
        Auth.clearToken();
        if (authSection) authSection.style.display = 'block';
        if (appContainer) appContainer.style.display = 'none';
        if (logoutBtn) logoutBtn.style.display = 'none';
        const wrap = document.getElementById('profileMenuWrap');
        if (wrap) wrap.style.display = 'none';
        return false;
      }
      const user = await resp.json();
      this._user = user;
      this._loadSpoolmanImportState();
      if (user.settings) {
        this.spoolmanUrl = user.settings.spoolmanUrl || '';
        if (user.settings.theme) {
          document.documentElement.setAttribute('data-theme', user.settings.theme);
          localStorage.setItem('theme', user.settings.theme);
          const tog = document.getElementById('themeToggle');
          if (tog) tog.textContent = user.settings.theme === 'dark' ? '☀️' : '🌙';
          const meta = document.querySelector('meta[name="theme-color"]');
          if (meta) meta.content = user.settings.theme === 'dark' ? '#0b1120' : '#f0f4f8';
        }
        if (user.settings.language && typeof I18n !== 'undefined' && I18n.setLanguage) {
          I18n.setLanguage(user.settings.language);
        }
      }
      this._migrateLocalStorageToBackend().catch(() => {});
      if (authSection) authSection.style.display = 'none';
      if (appContainer) appContainer.style.display = 'block';
      if (logoutBtn) logoutBtn.style.display = 'none';
      this._updateProfileUI();
      if (typeof I18n !== 'undefined' && I18n.refreshElements) I18n.refreshElements();
      document.querySelectorAll('.lang-btn').forEach(btn => {
        const lang = I18n && I18n.getLanguage ? I18n.getLanguage() : 'de';
        btn.classList.toggle('accent-card', btn.dataset.lang === lang);
        btn.classList.toggle('btn-secondary', btn.dataset.lang !== lang);
      });
      return true;
    } catch (e) {
      Auth.clearToken();
      if (authSection) authSection.style.display = 'block';
      if (appContainer) appContainer.style.display = 'none';
      if (logoutBtn) logoutBtn.style.display = 'none';
      return false;
    }
  },

  async _migrateLocalStorageToBackend() {
    const oldUrl = localStorage.getItem('spoolmanUrl');
    const oldTheme = localStorage.getItem('theme');
    if (!oldUrl && !oldTheme) return;
    const loc = window.location;
    const apiBase = `${loc.protocol}//${loc.host}/api`;
    const payload = {
      spoolmanUrl: this._normalizeSpoolmanUrl(oldUrl || this.spoolmanUrl || ''),
      theme: oldTheme || 'dark',
      language: 'de'
    };
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    try {
      await Auth.fetch(`${apiBase}/user/settings`, {
        method: 'PUT',
        body: JSON.stringify(payload),
        signal: ctrl.signal
      });
      this.spoolmanUrl = payload.spoolmanUrl;
      localStorage.removeItem('spoolmanUrl');
    } catch (e) {}
    clearTimeout(t);
  },

  async exportUserData() {
    const loc = window.location;
    const apiBase = `${loc.protocol}//${loc.host}/api`;
    try {
      const resp = await Auth.fetch(`${apiBase}/user/export`);
      if (!resp.ok) throw new Error('Export failed');
      const data = await resp.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'spooltagpropus-backup.json';
      a.click();
      URL.revokeObjectURL(a.href);
      this.showStatus('backupStatus', 'success', typeof I18n !== 'undefined' ? I18n.t('backup.exportSuccess') : 'Daten exportiert');
    } catch (e) {
      this.showStatus('backupStatus', 'error', e.message || 'Export fehlgeschlagen');
    }
  },

  async importUserData(ev) {
    const file = ev && ev.target && ev.target.files && ev.target.files[0];
    if (!file) return;
    const el = ev.target;
    el.value = '';
    const loc = window.location;
    const apiBase = `${loc.protocol}//${loc.host}/api`;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const resp = await Auth.fetch(`${apiBase}/user/import`, {
        method: 'POST',
        body: JSON.stringify(data)
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.message || 'Import fehlgeschlagen');
      }
      await this._applyRestoredSettings(data);
      this.showStatus('backupStatus', 'success', typeof I18n !== 'undefined' ? I18n.t('backup.importSuccess') : 'Daten wiederhergestellt');
    } catch (e) {
      this.showStatus('backupStatus', 'error', e.message || 'Import fehlgeschlagen');
    }
  },

  async _applyRestoredSettings(data) {
    const theme = (data.theme || 'dark').slice(0, 20);
    const lang = (data.language === 'en' ? 'en' : 'de');
    this.spoolmanUrl = this._normalizeSpoolmanUrl((data.spoolmanUrl || data.spoolman_url || '') || '');
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
    if (typeof I18n !== 'undefined' && I18n.setLanguage) I18n.setLanguage(lang);
    if (typeof I18n !== 'undefined' && I18n.refreshElements) I18n.refreshElements();
    const loc = window.location;
    await Auth.fetch(`${loc.protocol}//${loc.host}/api/user/settings`, {
      method: 'PUT',
      body: JSON.stringify({ spoolmanUrl: this.spoolmanUrl, theme, language: lang })
    });
  },

  async loadBackupList() {
    const listEl = document.getElementById('backupList');
    const statusEl = document.getElementById('backupStatus');
    if (!listEl) return;
    listEl.innerHTML = '<p style="color: var(--text-secondary);">' + (typeof I18n !== 'undefined' ? I18n.t('backup.loading') : 'Lade Backups...') + '</p>';
    const loc = window.location;
    const apiBase = `${loc.protocol}//${loc.host}/api`;
    try {
      const resp = await Auth.fetch(`${apiBase}/user/backups`);
      if (!resp.ok) throw new Error('Fehler beim Laden');
      const { backups } = await resp.json();
      if (!backups || backups.length === 0) {
        listEl.innerHTML = '<p style="color: var(--text-secondary);">' + (typeof I18n !== 'undefined' ? I18n.t('backup.noBackups') : 'Keine Server-Backups vorhanden.') + '</p>';
        return;
      }
      listEl.innerHTML = backups.map(b => {
        const d = b.createdAt ? new Date(b.createdAt).toLocaleString() : '-';
        return `<div style="display:flex;align-items:center;justify-content:space-between;padding:0.5rem 0;border-bottom:1px solid var(--border-color);">
          <span>${d}</span>
          <button class="btn-secondary" onclick="app.restoreBackup(${b.id})">${typeof I18n !== 'undefined' && I18n.t ? I18n.t('common.restore') : 'Wiederherstellen'}</button>
        </div>`;
      }).join('');
    } catch (e) {
      listEl.innerHTML = `<p style="color: var(--error);">${e.message || 'Fehler'}</p>`;
    }
  },

  async restoreBackup(id) {
    const loc = window.location;
    const apiBase = `${loc.protocol}//${loc.host}/api`;
    try {
      const resp = await Auth.fetch(`${apiBase}/user/restore/${id}`, { method: 'POST' });
      if (!resp.ok) throw new Error('Wiederherstellung fehlgeschlagen');
      const data = await resp.json();
      if (data.settings) {
        await this._applyRestoredSettings(data.settings);
      }
      this.showStatus('backupStatus', 'success', typeof I18n !== 'undefined' ? I18n.t('backup.importSuccess') : 'Backup wiederhergestellt');
      this.loadBackupList();
    } catch (e) {
      this.showStatus('backupStatus', 'error', e.message || 'Fehler');
    }
  },

  showLogin() {
    document.getElementById('loginForm').classList.remove('hidden');
    document.getElementById('registerForm').classList.add('hidden');
    document.getElementById('authError').style.display = 'none';
    document.getElementById('registerError').style.display = 'none';
  },

  showRegister() {
    document.getElementById('registerForm').classList.remove('hidden');
    document.getElementById('loginForm').classList.add('hidden');
    document.getElementById('authError').style.display = 'none';
    document.getElementById('registerError').style.display = 'none';
  },

  async doLogin() {
    const identifier = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    const remember = document.getElementById('loginRemember')?.checked !== false;
    const errEl = document.getElementById('authError');
    const btn = document.getElementById('loginBtn');
    errEl.style.display = 'none';

    if (!identifier || !password) {
      errEl.textContent = 'Bitte E-Mail/Benutzername und Passwort eingeben.';
      errEl.style.display = 'block';
      return;
    }

    if (btn) {
      btn.disabled = true;
      btn.dataset.originalText = btn.textContent;
      btn.textContent = 'Wird angemeldet…';
    }
    const loc = window.location;
    const apiBase = `${loc.protocol}//${loc.host}/api`;
    try {
      const resp = await fetch(`${apiBase}/auth/login`, {
        method: 'POST',
        credentials: 'include',   // receive HttpOnly cookie from server
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier, password })
      });
      const data = await resp.json();
      if (!resp.ok) {
        errEl.textContent = data.message || 'Anmeldung fehlgeschlagen.';
        errEl.style.display = 'block';
        if (btn) { btn.disabled = false; btn.textContent = btn.dataset.originalText || 'Anmelden'; }
        return;
      }
      // Store token in localStorage (remember=true) or sessionStorage (remember=false)
      Auth.setToken(data.token, remember);
      Auth.setSessionFlag();   // mark that a cookie session exists
      if (btn) btn.textContent = 'Weiterleitung…';
      location.reload();
    } catch (e) {
      errEl.textContent = 'Netzwerkfehler. Bitte später erneut versuchen.';
      errEl.style.display = 'block';
      if (btn) {
        btn.disabled = false;
        btn.textContent = btn.dataset.originalText || 'Anmelden';
      }
    }
  },

  async doRegister() {
    const firstName = (document.getElementById('registerFirstName')?.value || '').trim();
    const lastName = (document.getElementById('registerLastName')?.value || '').trim();
    const birthDate = (document.getElementById('registerBirthDate')?.value || '').trim();
    const address = (document.getElementById('registerAddress')?.value || '').trim();
    const username = (document.getElementById('registerUsername')?.value || '').trim();
    const email = document.getElementById('registerEmail').value.trim();
    const password = document.getElementById('registerPassword').value;
    const passwordConfirm = document.getElementById('registerPasswordConfirm').value;
    const errEl = document.getElementById('registerError');
    errEl.style.display = 'none';

    if (!firstName || !lastName) {
      errEl.textContent = 'Bitte Vor- und Nachname eingeben.';
      errEl.style.display = 'block';
      return;
    }
    if (!birthDate) {
      errEl.textContent = 'Bitte Geburtsdatum eingeben.';
      errEl.style.display = 'block';
      return;
    }
    if (!username) {
      errEl.textContent = 'Bitte einen Benutzernamen eingeben.';
      errEl.style.display = 'block';
      return;
    }
    if (!email || !password) {
      errEl.textContent = 'Bitte E-Mail, Benutzername und Passwort eingeben.';
      errEl.style.display = 'block';
      return;
    }
    if (password.length < 8) {
      errEl.textContent = 'Passwort muss mindestens 8 Zeichen haben.';
      errEl.style.display = 'block';
      return;
    }
    if (password !== passwordConfirm) {
      errEl.textContent = 'Passwörter stimmen nicht überein.';
      errEl.style.display = 'block';
      return;
    }

    const loc = window.location;
    const apiBase = `${loc.protocol}//${loc.host}/api`;
    try {
      const resp = await fetch(`${apiBase}/auth/register`, {
        method: 'POST',
        credentials: 'include',   // receive HttpOnly cookie from server
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, username, password, firstName, lastName, address, birthDate })
      });
      const data = await resp.json();
      if (!resp.ok) {
        errEl.textContent = data.message || 'Registrierung fehlgeschlagen.';
        errEl.style.display = 'block';
        return;
      }
      Auth.setToken(data.token, true);
      Auth.setSessionFlag();
      location.reload();
    } catch (e) {
      errEl.textContent = 'Netzwerkfehler. Bitte später erneut versuchen.';
      errEl.style.display = 'block';
    }
  },

  logout() {
    Auth.logout().finally(() => location.reload());
  },

  async setLanguage(lang) {
    if (typeof I18n === 'undefined' || !I18n.setLanguage) return;
    I18n.setLanguage(lang);
    if (I18n.refreshElements) I18n.refreshElements();
    document.querySelectorAll('.lang-btn').forEach(btn => {
      btn.classList.toggle('accent-card', btn.dataset.lang === lang);
      btn.classList.toggle('btn-secondary', btn.dataset.lang !== lang);
    });
    if (Auth && Auth.isLoggedIn() && this._user) {
      const loc = window.location;
      try {
        await Auth.fetch(`${loc.protocol}//${loc.host}/api/user/settings`, {
          method: 'PUT',
          body: JSON.stringify({
            spoolmanUrl: this.spoolmanUrl || '',
            theme: document.documentElement.getAttribute('data-theme') || 'dark',
            language: lang
          })
        });
      } catch (e) {}
    }
  },

  async init() {
    const authSection = document.getElementById('authSection');
    const appContainer = document.getElementById('appContainer');

    // Auth-Forms/Links immer verbinden (vor checkAuth, da init sonst vorher returniert)
    const loginForm = document.getElementById('loginForm');
    const registerForm = document.getElementById('registerForm');
    const showRegisterLink = document.getElementById('showRegisterLink');
    const showLoginLink = document.getElementById('showLoginLink');
    if (loginForm) loginForm.addEventListener('submit', (e) => { e.preventDefault(); this.doLogin(); });
    if (registerForm) registerForm.addEventListener('submit', (e) => { e.preventDefault(); this.doRegister(); });
    if (showRegisterLink) showRegisterLink.addEventListener('click', (e) => { e.preventDefault(); this.showRegister(); });
    if (showLoginLink) showLoginLink.addEventListener('click', (e) => { e.preventDefault(); this.showLogin(); });
    const langDe = document.getElementById('langBtnDe');
    const langEn = document.getElementById('langBtnEn');
    const themeToggle = document.getElementById('themeToggle');
    const logoutBtn = document.getElementById('logoutBtn');
    const spoolmanLink = document.getElementById('spoolmanLink');
    if (langDe) langDe.addEventListener('click', () => this.setLanguage('de'));
    if (langEn) langEn.addEventListener('click', () => this.setLanguage('en'));
    if (themeToggle) themeToggle.addEventListener('click', () => this.toggleTheme());
    if (logoutBtn) logoutBtn.addEventListener('click', (e) => { e.preventDefault(); this.logout(); });
    if (spoolmanLink) spoolmanLink.addEventListener('click', (e) => { e.preventDefault(); this.openSpoolman(); });

    // Profile dropdown
    const avatarBtn = document.getElementById('profileAvatarBtn');
    if (avatarBtn) avatarBtn.addEventListener('click', (e) => { e.stopPropagation(); this._toggleProfileDrop(); });
    const profileLogoutBtn = document.getElementById('profileLogoutBtn');
    if (profileLogoutBtn) profileLogoutBtn.addEventListener('click', () => { this._closeProfileDrop(); this.logout(); });
    document.addEventListener('click', () => this._closeProfileDrop());

    // Spoolman Import (Einstellungen): Auswahl + "Jetzt importieren"
    const importNowBtn = document.getElementById('spoolmanImportNowBtn');
    if (importNowBtn) importNowBtn.addEventListener('click', () => this.importSelectedSpoolmanSettings());
    const importClearBtn = document.getElementById('spoolmanImportClearBtn');
    if (importClearBtn) importClearBtn.addEventListener('click', () => this.clearSpoolmanSelectionSettings());
    const spoolList = document.getElementById('spoolmanSpoolListSettings');
    if (spoolList && !this._spoolmanSettingsListBound) {
      this._spoolmanSettingsListBound = true;
      spoolList.addEventListener('click', (e) => {
        const row = e.target.closest('[data-spool-id]');
        if (!row) return;
        if (row.classList.contains('is-imported')) return;
        const sid = parseInt(row.getAttribute('data-spool-id') || '0', 10);
        if (!sid) return;
        this.selectSpoolmanSpoolSettings(sid);
      });
    }

    if (typeof Auth === 'undefined') {
      if (authSection) authSection.style.display = 'none';
      if (appContainer) appContainer.style.display = 'block';
    } else {
      const ok = await this.checkAuth();
      if (!ok) return;
    }

    this.loadTheme();
    this.checkNFC();
    if (typeof ColorPicker !== 'undefined' && ColorPicker && typeof ColorPicker.init === 'function') {
      ColorPicker.init(this);
    }
    for (const name in this.palettes) this.initPalette(name);
    this.populateFormats();
    this.initEventListeners();
    this.updateFormat();
    this.updateVisibility();
    for (let i = 1; i <= 4; i++) {
      this.updateColor('#FFFFFF', i);
    }
    this.applyTemperaturePreset();
    this.updateRecordSize();
    this.initSpoolman();
    this.checkURLParams();
  },

  // === Spoolman Integration ===

  _normalizeSpoolmanUrl(url) {
    if (!url || typeof url !== 'string') return '';
    const trimmed = url.trim().replace(/\/+$/, '');
    if (!trimmed) return '';
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    return `http://${trimmed}`;
  },

  initSpoolman() {
    const urlInput = document.getElementById('spoolmanUrl');
    if (urlInput && this.spoolmanUrl) {
      urlInput.value = this.spoolmanUrl;
    }
    this.updateSpoolmanLink();
  },

  updateSpoolmanLink() {
    const link = document.getElementById('spoolmanLink');
    const url = this._normalizeSpoolmanUrl(this.spoolmanUrl);
    if (link && url) {
      link.href = url;
      link.onclick = null;
    }
    // Update "Mein Spoolman" dashboard card subtitle
    const card = document.getElementById('mySpoolmanCard');
    if (card) {
      const desc = card.querySelector('.mode-card-desc');
      if (desc) desc.textContent = url ? 'Meine Filamente verwalten' : 'Spoolman URL konfigurieren';
    }
  },

  openSpoolman() {
    const url = this._normalizeSpoolmanUrl(this.spoolmanUrl);
    if (url) {
      window.open(url, '_blank');
    } else {
      this.showSpoolmanSetup();
    }
  },

  showSpoolmanSetup() {
    document.getElementById('modeSelection').classList.add('hidden');
    document.getElementById('spoolmanSetup').classList.remove('hidden');
    document.getElementById('spoolmanSection').classList.add('hidden');
    const urlInput = document.getElementById('spoolmanUrl');
    if (urlInput) urlInput.value = this.spoolmanUrl || '';
  },

  closeSpoolmanSetup() {
    document.getElementById('spoolmanSetup').classList.add('hidden');
    document.getElementById('modeSelection').classList.remove('hidden');
  },

  async testSpoolman() {
    const url = this._normalizeSpoolmanUrl(document.getElementById('spoolmanUrl').value);
    if (!url) {
      this.showStatus('spoolmanTestStatus', 'error', 'Bitte URL eingeben');
      return;
    }

    this.showStatus('spoolmanTestStatus', 'warning', 'Verbinde...');

    try {
      const resp = await fetch(`${url}/api/v1/info`, { signal: AbortSignal.timeout(5000) });
      if (resp.ok) {
        const info = await resp.json();
        this.showStatus('spoolmanTestStatus', 'success',
          `Verbunden! Spoolman v${info.version || '?'}`);
      } else {
        this.showStatus('spoolmanTestStatus', 'error', `HTTP ${resp.status}`);
      }
    } catch (e) {
      try {
        const resp2 = await fetch(`${url}/api/v1/spool`, { signal: AbortSignal.timeout(5000) });
        if (resp2.ok) {
          this.showStatus('spoolmanTestStatus', 'success', 'Verbunden mit Spoolman!');
          return;
        }
      } catch {}
      this.showStatus('spoolmanTestStatus', 'error', `Fehler: ${e.message}`);
    }
  },

  async saveSpoolmanUrl() {
    const url = this._normalizeSpoolmanUrl(document.getElementById('spoolmanUrl').value);
    if (!url) {
      this.showMobileToast('Bitte gültige URL eingeben', 'error');
      return;
    }
    this.spoolmanUrl = url;
    localStorage.setItem('spoolmanUrl', url);
    if (Auth && Auth.isLoggedIn()) {
      const loc = window.location;
      try {
        await Auth.fetch(`${loc.protocol}//${loc.host}/api/user/settings`, {
          method: 'PUT',
          body: JSON.stringify({
            spoolmanUrl: url,
            theme: document.documentElement.getAttribute('data-theme') || 'dark',
            language: 'de'
          })
        });
      } catch (e) {}
    }
    this.updateSpoolmanLink();
    this.closeSpoolmanSetup();
    this.showMobileToast('Spoolman URL gespeichert', 'success');
  },

  _spoolmanSpools: [],

  async loadSpoolmanSpools() {
    const url = this._normalizeSpoolmanUrl(this.spoolmanUrl);
    if (!url) {
      this.showSpoolmanSetup();
      return;
    }

    const listEl = document.getElementById('spoolmanSpoolList');
    listEl.innerHTML = '<p style="color: var(--text-secondary);">Lade Spulen...</p>';
    this.showStatus('spoolmanStatus', 'warning', 'Verbinde mit Spoolman...');
    const searchEl = document.getElementById('spoolmanSearch');
    if (searchEl) searchEl.value = '';

    try {
      const resp = await fetch(`${url}/api/v1/spool`, {
        signal: AbortSignal.timeout(10000)
      });

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const spools = await resp.json();
      this._spoolmanSpools = spools;

      if (!spools.length) {
        listEl.innerHTML = '<p style="color: var(--text-secondary);">Keine Spulen in Spoolman gefunden.</p>';
        this.showStatus('spoolmanStatus', 'warning', 'Keine Spulen vorhanden');
        return;
      }

      this.showStatus('spoolmanStatus', 'success', `${spools.length} Spule(n) geladen`);
      this.renderSpoolmanList(spools);
    } catch (e) {
      listEl.innerHTML = '';
      this.showStatus('spoolmanStatus', 'error', `Fehler: ${e.message}`);
    }
  },

  renderSpoolmanList(spools) {
    const listEl = document.getElementById('spoolmanSpoolList');
    listEl.innerHTML = '';

    if (!spools.length) {
      listEl.innerHTML = '<p style="color: var(--text-secondary);">Keine Spulen gefunden.</p>';
      return;
    }

    spools.forEach(spool => {
      const filament = spool.filament || {};
      const vendor = filament.vendor || {};
      const color = filament.color_hex || 'CCCCCC';
      const material = filament.material || 'Unknown';
      const brand = vendor.name || 'Unbekannt';
      const name = filament.name || material;
      const remaining = spool.remaining_weight != null
        ? `${Math.round(spool.remaining_weight)}g übrig`
        : '';

      const card = document.createElement('div');
      card.className = 'spool-card';
      card.onclick = () => this.importFromSpoolman(spool);
      card.innerHTML = `
        <div class="spool-color-dot" style="background: #${color};"></div>
        <div class="spool-info">
          <strong>${brand} ${name}</strong>
          <small>${material} | ID: ${spool.id}${spool.lot_nr ? ` | Lot: ${spool.lot_nr}` : ''}</small>
        </div>
        <div class="spool-weight">${remaining}</div>
      `;
      listEl.appendChild(card);
    });
  },

  filterSpoolmanSpools() {
    const q = (document.getElementById('spoolmanSearch').value || '').toLowerCase().trim();
    if (!q) {
      this.renderSpoolmanList(this._spoolmanSpools);
      return;
    }
    const filtered = this._spoolmanSpools.filter(spool => {
      const f = spool.filament || {};
      const v = f.vendor || {};
      const text = [
        v.name, f.name, f.material, spool.id,
        spool.lot_nr, f.color_hex
      ].filter(Boolean).join(' ').toLowerCase();
      return text.includes(q);
    });
    this.renderSpoolmanList(filtered);
  },

  importFromSpoolman(spool) {
    const filament = spool.filament || {};
    const vendor = filament.vendor || {};

    const data = {
      materialType: (filament.material || 'PLA').toUpperCase(),
      brand: vendor.name || 'Generic',
      colorHex: (filament.color_hex || 'FFFFFF').replace('#', ''),
      minTemp: filament.settings_extruder_temp || '',
      maxTemp: filament.settings_extruder_temp || '',
      bedTempMin: filament.settings_bed_temp || '',
      bedTempMax: filament.settings_bed_temp || '',
      spoolmanId: spool.id || 0,
      lotNr: spool.lot_nr || '',
      materialName: filament.name || '',
      density: filament.density || '',
      filamentDiameter: filament.diameter || '1.75',
      nominalWeight: filament.weight || '',
      actualWeight: spool.remaining_weight != null ? Math.round(spool.remaining_weight) : '',
      emptySpoolWeight: filament.spool_weight || '',
    };

    this.setMode('create');
    this.populateForm(data, 'openspool_extended');
    this.showStatus('writeStatus', 'success', `Spoolman Spule #${spool.id} importiert`);
  },

  importFromSpoolmanFilament(filament) {
    const vendor = filament.vendor || {};
    const data = {
      materialType: (filament.material || 'PLA').toUpperCase(),
      brand: vendor.name || 'Generic',
      colorHex: (filament.color_hex || 'FFFFFF').replace('#', ''),
      minTemp: filament.settings_extruder_temp || '',
      maxTemp: filament.settings_extruder_temp || '',
      bedTempMin: filament.settings_bed_temp || '',
      bedTempMax: filament.settings_bed_temp || '',
      spoolmanId: 0,
      lotNr: '',
      materialName: filament.name || '',
      density: filament.density || '',
      filamentDiameter: filament.diameter || '1.75',
      nominalWeight: filament.weight || '',
      actualWeight: '',
      emptySpoolWeight: filament.spool_weight || '',
    };
    this.setMode('create');
    this.populateForm(data, 'openspool_extended');
    this.showStatus('writeStatus', 'success', `Spoolman Filament #${filament.id} übernommen`);
  },

  // === Spoolman Picker (Create Tag) ===
  _spoolmanPickerTab: 'spools',
  _spoolmanPickerSpools: null,
  _spoolmanPickerFilaments: null,
  _spoolmanPickerFilamentById: null,

  openSpoolmanPicker(tab) {
    const overlay = document.getElementById('spoolmanPickerOverlay');
    if (!overlay) return;
    overlay.classList.remove('hidden');
    this.setSpoolmanPickerTab(tab || 'spools');
  },

  closeSpoolmanPicker() {
    const overlay = document.getElementById('spoolmanPickerOverlay');
    if (overlay) overlay.classList.add('hidden');
  },

  setSpoolmanPickerTab(tab) {
    const next = tab === 'filaments' ? 'filaments' : 'spools';
    this._spoolmanPickerTab = next;
    const b1 = document.getElementById('spoolmanPickerTabSpools');
    const b2 = document.getElementById('spoolmanPickerTabFilaments');
    if (b1 && b2) {
      b1.className = next === 'spools' ? 'btn-primary' : 'btn-secondary';
      b2.className = next === 'filaments' ? 'btn-primary' : 'btn-secondary';
    }
    const search = document.getElementById('spoolmanPickerSearch');
    if (search) search.value = '';
    if (next === 'spools') this.loadSpoolmanSpoolsForPicker();
    else this.loadSpoolmanFilamentsForPicker();
  },

  async loadSpoolmanSpoolsForPicker() {
    const status = document.getElementById('spoolmanPickerStatus');
    const list = document.getElementById('spoolmanPickerList');
    const apiBase = `${location.protocol}//${location.host}/api`;
    if (status) { status.textContent = 'Lade Spulen…'; status.className = 'status-message warning show'; }
    if (list) list.innerHTML = '';
    try {
      // Ensure filaments map exists for better labels when needed.
      if (!this._spoolmanPickerFilamentById) {
        await this.loadSpoolmanFilamentsForPicker(true);
      }
      const resp = await Auth.fetch(`${apiBase}/spoolman/spools`);
      const spools = await resp.json();
      if (!resp.ok) throw new Error(spools.message || spools.error || `HTTP ${resp.status}`);
      this._spoolmanPickerSpools = Array.isArray(spools) ? spools : [];
      if (status) { status.textContent = `${this._spoolmanPickerSpools.length} Spule(n) geladen`; status.className = 'status-message success show'; }
      this.renderSpoolmanPicker();
    } catch (e) {
      if (status) { status.textContent = `Fehler: ${e.message}`; status.className = 'status-message error show'; }
    }
  },

  async loadSpoolmanFilamentsForPicker(silent) {
    const status = document.getElementById('spoolmanPickerStatus');
    const list = document.getElementById('spoolmanPickerList');
    const apiBase = `${location.protocol}//${location.host}/api`;
    if (!silent) {
      if (status) { status.textContent = 'Lade Filamente…'; status.className = 'status-message warning show'; }
      if (list) list.innerHTML = '';
    }
    try {
      const resp = await Auth.fetch(`${apiBase}/spoolman/filaments`);
      const filaments = await resp.json();
      if (!resp.ok) throw new Error(filaments.message || filaments.error || `HTTP ${resp.status}`);
      this._spoolmanPickerFilaments = Array.isArray(filaments) ? filaments : [];
      const map = new Map();
      this._spoolmanPickerFilaments.forEach(f => { if (f && f.id != null) map.set(String(f.id), f); });
      this._spoolmanPickerFilamentById = map;
      if (!silent) {
        if (status) { status.textContent = `${this._spoolmanPickerFilaments.length} Filament(e) geladen`; status.className = 'status-message success show'; }
        this.renderSpoolmanPicker();
      }
    } catch (e) {
      if (!silent && status) { status.textContent = `Fehler: ${e.message}`; status.className = 'status-message error show'; }
    }
  },

  filterSpoolmanPicker() {
    this.renderSpoolmanPicker();
  },

  renderSpoolmanPicker() {
    const list = document.getElementById('spoolmanPickerList');
    if (!list) return;
    const q = (document.getElementById('spoolmanPickerSearch')?.value || '').toLowerCase().trim();
    list.innerHTML = '';

    const addCard = (title, subtitle, colorHex, onClick) => {
      const card = document.createElement('div');
      card.className = 'spool-card';
      card.onclick = onClick;
      card.innerHTML = `
        <div class="spool-color-dot" style="background: #${(colorHex || 'CCCCCC').replace('#','')};"></div>
        <div class="spool-info">
          <strong>${title}</strong>
          <small>${subtitle}</small>
        </div>
        <div class="spool-weight">antippen</div>
      `;
      list.appendChild(card);
    };

    if (this._spoolmanPickerTab === 'spools') {
      const spools = Array.isArray(this._spoolmanPickerSpools) ? this._spoolmanPickerSpools : [];
      const filtered = !q ? spools : spools.filter(spool => {
        const f = spool.filament || {};
        const v = f.vendor || {};
        const text = [spool.id, spool.lot_nr, f.name, f.material, f.color_hex, v.name].filter(Boolean).join(' ').toLowerCase();
        return text.includes(q);
      });
      if (!filtered.length) {
        list.innerHTML = '<p style="color:var(--text-secondary);">Keine Spulen gefunden.</p>';
        return;
      }
      filtered.forEach(spool => {
        let filament = spool.filament || {};
        // Some spoolman instances may return filament as id; try map.
        if (typeof filament === 'number' || typeof filament === 'string') {
          filament = this._spoolmanPickerFilamentById?.get(String(filament)) || {};
        } else if (filament && filament.id != null && this._spoolmanPickerFilamentById) {
          filament = this._spoolmanPickerFilamentById.get(String(filament.id)) || filament;
        }
        const vendor = filament.vendor || {};
        const brand = vendor.name || 'Unbekannt';
        const name = filament.name || (filament.material || 'Filament');
        const material = filament.material || 'Unknown';
        const color = filament.color_hex || 'CCCCCC';
        const remaining = spool.remaining_weight != null ? `${Math.round(spool.remaining_weight)}g übrig` : '';
        addCard(
          `${brand} ${name}`,
          `${material} | ID: ${spool.id}${spool.lot_nr ? ` | Lot: ${spool.lot_nr}` : ''}${remaining ? ` | ${remaining}` : ''}`,
          color,
          () => { this.closeSpoolmanPicker(); this.importFromSpoolman(spool); }
        );
      });
      return;
    }

    const filaments = Array.isArray(this._spoolmanPickerFilaments) ? this._spoolmanPickerFilaments : [];
    const filtered = !q ? filaments : filaments.filter(f => {
      const v = f.vendor || {};
      const text = [f.id, f.name, f.material, f.color_hex, v.name].filter(Boolean).join(' ').toLowerCase();
      return text.includes(q);
    });
    if (!filtered.length) {
      list.innerHTML = '<p style="color:var(--text-secondary);">Keine Filamente gefunden.</p>';
      return;
    }
    filtered.forEach(filament => {
      const vendor = filament.vendor || {};
      const brand = vendor.name || 'Unbekannt';
      const name = filament.name || (filament.material || 'Filament');
      const material = filament.material || 'Unknown';
      const color = filament.color_hex || 'CCCCCC';
      addCard(
        `${brand} ${name}`,
        `${material} | Filament-ID: ${filament.id}`,
        color,
        () => { this.closeSpoolmanPicker(); this.importFromSpoolmanFilament(filament); }
      );
    });
  },

  // === Mein Spoolman ===

  _mySpoolmanSpools: [],

  // === Filament Database Integration ===

  _dbState: {
    brands: [],
    brandSlug: '',
    brandName: '',
    materials: [],
    materialSlug: '',
    materialName: '',
    filaments: [],
    filamentSlug: '',
    filamentName: '',
    variants: [],
    selectedVariant: null,
    density: null
  },

  async loadFilamentDbBrands() {
    const select = document.getElementById('dbBrandSelect');
    if (select.options.length > 1) return;

    this.showStatus('dbStatus', 'warning', 'Lade Marken...');

    try {
      const brands = await FilamentDB.getBrands();
      this._dbState.brands = brands;

      select.innerHTML = '<option value="">-- Marke wählen --</option>';
      brands.forEach(b => {
        const opt = document.createElement('option');
        opt.value = b.slug;
        opt.textContent = `${b.name} (${b.material_count} Materialien)`;
        select.appendChild(opt);
      });

      this.showStatus('dbStatus', 'success', `${brands.length} Marken geladen`);
      setTimeout(() => this.showStatus('dbStatus', '', ''), 2000);
    } catch (e) {
      this.showStatus('dbStatus', 'error', `Fehler: ${e.message}`);
    }
  },

  async onDbBrandChange() {
    const slug = document.getElementById('dbBrandSelect').value;
    document.getElementById('dbMaterialGroup').classList.add('hidden');
    document.getElementById('dbFilamentGroup').classList.add('hidden');
    document.getElementById('dbVariantGroup').classList.add('hidden');
    document.getElementById('dbPreview').classList.add('hidden');

    if (!slug) return;

    this._dbState.brandSlug = slug;
    this.showStatus('dbStatus', 'warning', 'Lade Materialien...');

    try {
      const { brand, materials } = await FilamentDB.getMaterials(slug);
      this._dbState.brandName = brand.name;
      this._dbState.materials = materials;

      const select = document.getElementById('dbMaterialSelect');
      select.innerHTML = '<option value="">-- Material wählen --</option>';
      materials.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.slug;
        opt.textContent = `${m.material} (${m.filament_count} Varianten)`;
        select.appendChild(opt);
      });

      document.getElementById('dbMaterialGroup').classList.remove('hidden');
      this.showStatus('dbStatus', '', '');
    } catch (e) {
      this.showStatus('dbStatus', 'error', `Fehler: ${e.message}`);
    }
  },

  async onDbMaterialChange() {
    const slug = document.getElementById('dbMaterialSelect').value;
    document.getElementById('dbFilamentGroup').classList.add('hidden');
    document.getElementById('dbVariantGroup').classList.add('hidden');
    document.getElementById('dbPreview').classList.add('hidden');

    if (!slug) return;

    this._dbState.materialSlug = slug;
    const mat = this._dbState.materials.find(m => m.slug === slug);
    this._dbState.materialName = mat ? mat.material : slug.toUpperCase();

    this.showStatus('dbStatus', 'warning', 'Lade Filamente...');

    try {
      const { filaments, density } = await FilamentDB.getFilaments(
        this._dbState.brandSlug, slug
      );
      this._dbState.filaments = filaments;
      this._dbState.density = density;

      const select = document.getElementById('dbFilamentSelect');
      select.innerHTML = '<option value="">-- Filament wählen --</option>';
      filaments.forEach(f => {
        const opt = document.createElement('option');
        opt.value = f.slug;
        opt.textContent = `${f.name} (${f.variant_count} Farben)`;
        select.appendChild(opt);
      });

      document.getElementById('dbFilamentGroup').classList.remove('hidden');
      this.showStatus('dbStatus', '', '');
    } catch (e) {
      this.showStatus('dbStatus', 'error', `Fehler: ${e.message}`);
    }
  },

  async onDbFilamentChange() {
    const slug = document.getElementById('dbFilamentSelect').value;
    document.getElementById('dbVariantGroup').classList.add('hidden');
    document.getElementById('dbPreview').classList.add('hidden');

    if (!slug) return;

    this._dbState.filamentSlug = slug;
    const fil = this._dbState.filaments.find(f => f.slug === slug);
    this._dbState.filamentName = fil ? fil.name : slug;

    this.showStatus('dbStatus', 'warning', 'Lade Farbvarianten...');

    try {
      const { variants, density } = await FilamentDB.getVariants(
        this._dbState.brandSlug,
        this._dbState.materialSlug,
        slug
      );
      this._dbState.variants = variants;
      if (density) this._dbState.density = density;

      const listEl = document.getElementById('dbVariantList');
      listEl.innerHTML = '';

      variants.forEach(v => {
        const swatch = document.createElement('div');
        swatch.className = 'color-variant-swatch';
        swatch.dataset.slug = v.slug;
        const hex = (v.color_hex || '#CCCCCC').replace('#', '');
        swatch.innerHTML = `
          <div class="cv-dot" style="background: #${hex};"></div>
          <span class="cv-name">${v.color_name || 'Unknown'}</span>
        `;
        swatch.onclick = () => this.selectDbVariant(v, swatch);
        listEl.appendChild(swatch);
      });

      document.getElementById('dbVariantGroup').classList.remove('hidden');
      this.showStatus('dbStatus', '', '');
    } catch (e) {
      this.showStatus('dbStatus', 'error', `Fehler: ${e.message}`);
    }
  },

  selectDbVariant(variant, element) {
    document.querySelectorAll('#dbVariantList .color-variant-swatch')
      .forEach(el => el.classList.remove('selected'));
    element.classList.add('selected');

    this._dbState.selectedVariant = variant;

    const hex = (variant.color_hex || '#CCCCCC').replace('#', '');
    document.getElementById('dbPreviewColor').style.background = `#${hex}`;
    document.getElementById('dbPreviewName').textContent =
      `${this._dbState.brandName} ${this._dbState.materialName} ${this._dbState.filamentName}`;
    document.getElementById('dbPreviewDetails').textContent =
      `Farbe: ${variant.color_name || '?'} (#${hex})` +
      (this._dbState.density ? ` | Dichte: ${this._dbState.density} g/cm³` : '');

    document.getElementById('dbPreview').classList.remove('hidden');
  },

  applyDbSelection() {
    const st = this._dbState;
    if (!st.selectedVariant) return;

    const hex = (st.selectedVariant.color_hex || 'FFFFFF').replace('#', '');
    const materialType = st.materialName.toUpperCase();

    const data = {
      materialType: materialType,
      brand: st.brandName,
      colorHex: hex,
      materialName: `${st.filamentName}`,
      density: st.density || '',
      filamentDiameter: '1.75',
    };

    const preset = this.materialPresets[materialType];
    if (preset) {
      data.minTemp = preset.minTemp;
      data.maxTemp = preset.maxTemp;
      data.bedTempMin = preset.bedTempMin;
      data.bedTempMax = preset.bedTempMax;
    }

    this.setMode('create');
    this.populateForm(data, 'openspool_extended');
    this.showStatus('writeStatus', 'success',
      `${st.brandName} ${st.materialName} ${st.filamentName} - ${st.selectedVariant.color_name} importiert`);
  },

  populateFormats(withHidden = false, selectedId = 0) {
    const select = document.getElementById('formatSelect');
    if (!select) return;
    while (select.firstChild) select.removeChild(select.firstChild);

    const list = formats.availableFormats(withHidden);
    list.forEach((f, idx) => {
      const opt = document.createElement('option');
      opt.value = f.id;
      opt.textContent = f.label;
      if (selectedId ? f.id === selectedId : idx === 0) opt.selected = true;
      select.appendChild(opt);
    });
  },

  async checkNFC() {
    if (platform.hasWebNFC) {
      try {
        await navigator.permissions.query({ name: "nfc" });
        this.nfcSupported = true;
      } catch {
        this.nfcSupported = true;
      }
      document.getElementById('scanBtn').disabled = false;
      document.getElementById('writeBtn').disabled = false;
    }

    this.updateNFCStatus(this.nfcSupported, platform.nfcStatusMessage);
    this.updatePlatformUI();
  },

  updateNFCStatus(ready, message) {
    const pairs = [
      ['nfcIndicator', 'nfcStatusText'],
      ['nfcIndicatorMain', 'nfcStatusMain'],
    ];
    pairs.forEach(([indId, txtId]) => {
      const ind = document.getElementById(indId);
      const txt = document.getElementById(txtId);
      if (ind) ind.classList.toggle('ready', ready);
      if (txt) txt.textContent = message;
    });
  },

  updatePlatformUI() {
    const writeBtn = document.getElementById('writeBtn');
    const downloadBtn = document.getElementById('downloadBtn');
    const shareBtn = document.getElementById('shareBtn');
    const altMethodBox = document.getElementById('altNfcMethod');

    if (this.nfcSupported) {
      if (writeBtn) writeBtn.classList.remove('hidden');
    } else {
      if (writeBtn) writeBtn.classList.add('hidden');
    }

    if (downloadBtn) downloadBtn.classList.remove('hidden');
    if (shareBtn) {
      shareBtn.classList.toggle('hidden', !platform.hasWebShare);
    }

    if (altMethodBox) {
      altMethodBox.classList.toggle('hidden', this.nfcSupported);
    }
  },

  setMode(mode) {
    this.stopScanning();
    if (typeof QR !== 'undefined' && QR.isScanning()) {
      QR.stopScan(document.getElementById('qrVideo'));
    }

    const sections = [
      'modeSelection', 'readSection', 'tagSummarySection', 'formSection',
      'spoolmanSection', 'spoolmanSetup', 'filamentDbSection',
      'profilesSection', 'filamentListSection', 'dryingSection', 'qrScanSection',
      'aboutSection', 'backupSection', 'settingsSection', 'mySpoolmanSection'
    ];
    sections.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.add('hidden');
    });

    // Update sub-navigation bar
    const subNav = document.getElementById('subNav');
    const subNavTitle = document.getElementById('subNavTitle');
    const modeLabels = {
      'read': '📖 Tag Lesen', 'create': '✏️ Neuer Tag', 'update': '✏️ Tag Bearbeiten',
      'tagsummary': '🏷️ Tag Zusammenfassung',
      'profiles': '⬇️ Slicer Profile', 'filamentlist': '🗄️ Alle Filamente',
      'drying': '🌡️ Trocknung', 'qrscan': '📷 QR-Scanner', 'about': 'ℹ️ Über',
      'backup': '💾 Backup', 'settings': '⚙️ Einstellungen',
      'spoolman-import': '📦 Spoolman Import', 'myspoolman': '🧵 Mein Spoolman'
    };
    if (subNav) {
      if (mode === 'menu' || mode === 'home') {
        subNav.style.display = 'none';
        document.body.classList.remove('sub-mode');
      } else {
        subNav.style.display = 'flex';
        document.body.classList.add('sub-mode');
        if (subNavTitle) subNavTitle.textContent = modeLabels[mode] || mode;
      }
    }

    const formatSelect = document.getElementById('formatSelect');

    if (mode === 'menu') {
      document.getElementById('modeSelection').classList.remove('hidden');
    } else if (mode === 'read') {
      document.getElementById('readSection').classList.remove('hidden');
      this.clearReadData();
      this.startScanning();
    } else if (mode === 'update') {
      document.getElementById('formSection').classList.remove('hidden');
      document.getElementById('formTitle').textContent = 'Tag Daten Aktualisieren';
      const current = formatSelect.value;
      this.populateFormats(true, current);
    } else if (mode === 'create') {
      document.getElementById('formSection').classList.remove('hidden');
      document.getElementById('formTitle').textContent = 'Neuen Tag Erstellen';
      this.populateFormats(false);
      this.updateFormat();
      this.randomizeLotNr();
    } else if (mode === 'tagsummary') {
      document.getElementById('tagSummarySection').classList.remove('hidden');
    } else if (mode === 'filamentdb') {
      document.getElementById('filamentDbSection').classList.remove('hidden');
      this.loadFilamentDbBrands();
    } else if (mode === 'profiles') {
      document.getElementById('profilesSection').classList.remove('hidden');
      this.initProfilesPage();
    } else if (mode === 'filamentlist') {
      document.getElementById('filamentListSection').classList.remove('hidden');
      this.initFilamentListPage();
    } else if (mode === 'about') {
      document.getElementById('aboutSection').classList.remove('hidden');
      this.loadReleaseNotes();
    } else if (mode === 'drying') {
      document.getElementById('dryingSection').classList.remove('hidden');
      this.renderDryingProfiles();
    } else if (mode === 'qrscan') {
      document.getElementById('qrScanSection').classList.remove('hidden');
    } else if (mode === 'spoolman-import') {
      if (!this.spoolmanUrl) {
        this.showSpoolmanSetup();
        return;
      }
      document.getElementById('spoolmanSection').classList.remove('hidden');
      this.loadSpoolmanSpools();
    } else if (mode === 'backup') {
      document.getElementById('backupSection').classList.remove('hidden');
      if (typeof I18n !== 'undefined' && I18n.refreshElements) I18n.refreshElements();
      this.loadBackupList();
    } else if (mode === 'settings') {
      document.getElementById('settingsSection').classList.remove('hidden');
      this.switchSettingsTab('spoolman');
    } else if (mode === 'myspoolman') {
      document.getElementById('mySpoolmanSection').classList.remove('hidden');
      this.loadMySpoolman();
    }

    const floatBtn = document.getElementById('floatingWriteBtn');
    if (floatBtn) {
      const show = (mode === 'create' || mode === 'update');
      floatBtn.classList.toggle('hidden', !show);
    }
  },

  clearReadData() {
    document.getElementById('fileInput').value = '';
    document.getElementById('decodedData').textContent = '';
    document.getElementById('decodedDataContainer').classList.add('hidden');
    this.showStatus('readStatus', '', '');
  },

  toggleScan() {
    if (nfcReader.isScanning()) {
      this.stopScanning();
    } else {
      this.startScanning();
    }
  },

  startScanning() {
    if (!this.nfcSupported) {
      this.showStatus('readStatus', 'error', 'NFC wird auf diesem Gerät nicht unterstützt. Lade eine Datei hoch.');
      return;
    }

    this.showStatus('readStatus', 'warning', 'Halte das Gerät an den NFC-Tag...');

    nfcReader.start(
      (message, serialNumber) => this.handleTagRead(message, serialNumber),
      (errorMsg) => this.handleScanError(errorMsg)
    );

    document.getElementById('scanBtn').textContent = '⏹ Scannen Stoppen';
    document.getElementById('scanBtn').classList.remove('btn-success');
    document.getElementById('scanBtn').classList.add('btn-secondary');
  },

  stopScanning() {
    nfcReader.stop();
    document.getElementById('scanBtn').textContent = '🔍 NFC Scannen';
    document.getElementById('scanBtn').classList.remove('btn-secondary');
    document.getElementById('scanBtn').classList.add('btn-success');
    this.showStatus('readStatus', '', '');
  },

  handleScanError(errorMsg) {
    this.stopScanning();
    this.showStatus('readStatus', 'error', errorMsg);
  },

  _lastTagData: null,
  _lastTagFormat: null,

  handleTagRead(message, serialNumber) {
    let result = null;

    for (const record of message.records) {
      result = formats.parseNDEFRecord(record);
      if (result) break;
    }

    if (result) {
      this._lastTagData = result.data;
      this._lastTagFormat = result.format;
      this.stopScanning();
      this.showTagSummary(result.data, result.format, serialNumber);
    } else {
      this.showStatus('readStatus', 'warning', 'Kein erkanntes Format. Weiter scannen...');
    }
  },

  showTagSummary(data, format, serial) {
    this.setMode('tagsummary');

    const container = document.getElementById('tagSummaryContent');
    const color = '#' + (data.colorHex || 'FFFFFF');
    const formatName = formats.getDisplayName(format);

    const items = [];

    items.push({ label: 'Format', value: formatName, full: true });
    items.push({ label: 'Material', value: data.materialType || '—' });
    items.push({ label: 'Marke', value: data.brand || '—' });

    if (data.extendedSubType && data.extendedSubType !== 'Basic')
      items.push({ label: 'Variante', value: data.extendedSubType });

    if (data.materialName)
      items.push({ label: 'Filament Name', value: data.materialName, full: true });

    if (data.minTemp || data.maxTemp)
      items.push({ label: 'Düsen-Temp.', value: `${data.minTemp || '?'} – ${data.maxTemp || '?'} °C` });

    if (data.bedTempMin || data.bedTempMax)
      items.push({ label: 'Bett-Temp.', value: `${data.bedTempMin || '?'} – ${data.bedTempMax || '?'} °C` });

    if (data.density)
      items.push({ label: 'Dichte', value: `${data.density} g/cm³` });

    if (data.filamentDiameter)
      items.push({ label: 'Durchmesser', value: `${data.filamentDiameter} mm` });

    if (data.lotNr)
      items.push({ label: 'Lot Nr.', value: data.lotNr });

    if (data.spoolmanId && data.spoolmanId !== '0')
      items.push({ label: 'Spoolman ID', value: data.spoolmanId });

    if (data.nominalWeight)
      items.push({ label: 'Gewicht', value: `${data.nominalWeight} g` });

    if (data.gtin)
      items.push({ label: 'GTIN', value: data.gtin });

    if (serial)
      items.push({ label: 'Tag Serial', value: serial, full: true });

    const colors = [color];
    if (data.colorHex2 && data.colorHex2 !== 'FFFFFF') colors.push('#' + data.colorHex2);
    if (data.colorHex3 && data.colorHex3 !== 'FFFFFF') colors.push('#' + data.colorHex3);
    if (data.colorHex4 && data.colorHex4 !== 'FFFFFF') colors.push('#' + data.colorHex4);
    const multiColor = colors.length > 1;
    const colorDisplay = multiColor
      ? colors.map(c => `<div style="width:20px;height:20px;border-radius:4px;background:${c};border:1px solid var(--border);"></div>`).join('')
      : '';

    container.innerHTML = `
      <div class="tag-summary-header">
        <div class="tag-summary-color" style="background:${color};"></div>
        <div>
          <div class="tag-summary-title">${data.brand || 'Unbekannt'} ${data.materialType || ''}</div>
          <div class="tag-summary-subtitle">${data.materialName || formatName}${data.extendedSubType && data.extendedSubType !== 'Basic' ? ' · ' + data.extendedSubType : ''}</div>
          ${multiColor ? `<div style="display:flex;gap:4px;margin-top:4px;">${colorDisplay}</div>` : ''}
        </div>
      </div>
      <div class="tag-summary-grid">
        ${items.map(i => `
          <div class="tag-summary-item${i.full ? ' full' : ''}">
            <div class="tag-summary-label">${i.label}</div>
            <div class="tag-summary-value">${i.value}</div>
          </div>
        `).join('')}
      </div>
    `;

    const rewriteBtn = document.getElementById('rewriteBtn');
    if (rewriteBtn) {
      rewriteBtn.classList.toggle('hidden', !this.nfcSupported);
    }
  },

  async rewriteTag() {
    if (!this._lastTagData || !this._lastTagFormat) return;

    const data = formats.generateData(this._lastTagFormat, this._lastTagData);
    const records = formats.createNDEFRecord(this._lastTagFormat, data);
    const btn = document.getElementById('rewriteBtn');
    const original = btn.textContent;

    try {
      btn.textContent = '📱 Tag an Handy halten...';
      btn.classList.remove('btn-success');
      btn.classList.add('btn-secondary');
      this.showStatus('rewriteStatus', 'warning', 'Halte den neuen NFC-Tag an dein Handy...');

      await nfcWriter.write(records, (status, error) => {
        if (status === 'success') {
          btn.textContent = original;
          btn.classList.remove('btn-secondary');
          btn.classList.add('btn-success');
          this.showStatus('rewriteStatus', 'success', 'Tag erfolgreich kopiert!');
          this.showMobileToast('Tag kopiert!', 'success');
        } else if (status === 'error') {
          btn.textContent = original;
          btn.classList.remove('btn-secondary');
          btn.classList.add('btn-success');
          this.showStatus('rewriteStatus', 'error', error?.message || 'Schreiben fehlgeschlagen');
        }
      });
    } catch (e) {
      btn.textContent = original;
      btn.classList.remove('btn-secondary');
      btn.classList.add('btn-success');
      this.showStatus('rewriteStatus', 'error', e.message);
    }
  },

  editTagData() {
    if (this._lastTagData && this._lastTagFormat) {
      this.populateForm(this._lastTagData, this._lastTagFormat);
      this.setMode('update');
    }
  },

  showDecodedData(text) {
    document.getElementById('decodedData').textContent = text;
    document.getElementById('decodedDataContainer').classList.remove('hidden');
  },

  initEventListeners() {
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('a.profile-dl-btn');
      if (btn && btn.href && Auth && Auth.isLoggedIn()) {
        e.preventDefault();
        this.downloadProfileByUrl(btn.href);
      }
    });

    const fileInput = document.getElementById('fileInput');
    if (fileInput) fileInput.addEventListener('change', (e) => {
      this.handleFileUpload(e.target.files[0]);
    });

    for (let i = 1; i <= 4; i++) {
      document.getElementById(`colorHex${i}`).addEventListener('input', (e) => {
        this.updateColor('#' + e.target.value, i);
        this.updateRecordSize();
      });
    }

    document.getElementById('materialType').addEventListener('change', () => {
      this.applyTemperaturePreset();
      this.updateVisibility();
    });

    document.getElementById('showAdditionalColors').addEventListener('change', (e) => {
      this.toggleAdditionalColors(e.target.checked);
    });

    document.getElementById('brandInput').addEventListener('input', () => {
      document.getElementById('brandValue').value = document.getElementById('brandInput').value || '';
      this.updateRecordSize();
    });

    const inputFields = ['minTemp', 'maxTemp', 'bedTempMin', 'bedTempMax',
      'spoolmanId', 'lotNr',
      'materialName', 'gtin', 'materialAbbr', 'density',
      'diameter', 'preheatTemp', 'mfgDate', 'nominalWeight',
      'actualWeight', 'spoolWeight', 'countryCode'];

    inputFields.forEach(id => {
      const element = document.getElementById(id);
      if (element) {
        element.addEventListener('input', () => this.updateRecordSize());
      }
    });

    document.getElementById('matteFinish').addEventListener('change', () => {
      this.updateRecordSize();
    });
  },

  async downloadProfileByUrl(url) {
    try {
      const resp = await Auth.fetch(url);
      if (!resp.ok) throw new Error('Download failed');
      const blob = await resp.blob();
      const cd = resp.headers.get('Content-Disposition');
      let filename = 'profile.json';
      if (cd && cd.includes('filename=')) {
        const m = cd.match(/filename="?([^";]+)"?/);
        if (m) filename = m[1];
      }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      this.showMobileToast && this.showMobileToast('Download fehlgeschlagen', 'error');
    }
  },

  handleFileUpload(file) {
    if (!file) return;

    nfcReader.stop();

    const format = formats.detectFormatFromFilename(file.name);
    if (!format) {
      this.showStatus('readStatus', 'error', 'Unsupported file type');
      return;
    }

    let output = `File: ${file.name}\n\n`;
    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        const data = formats.parseData(format, e.target.result);
        this._lastTagData = data;
        this._lastTagFormat = format;
        this.showTagSummary(data, format, null);
      } catch (err) {
        this.showStatus('readStatus', 'error', `Ungültige ${format} Datei`);
      }
    };

    reader.readAsArrayBuffer(file);
  },

  transitionToForm(format) {
    this.showStatus('writeStatus', 'success', `File loaded (${format})`);
    this.setMode('update');
  },

  populateForm(data, format) {
    document.getElementById('formatSelect').value = data.format || format;
    this.setPaletteValue('material', data.materialType || 'PLA');

    document.getElementById('colorHex1').value = data.colorHex || 'FFFFFF';
    this.updateColor('#' + (data.colorHex || 'FFFFFF'), 1);

    document.getElementById('colorHex2').value = data.colorHex2 || 'FFFFFF';
    this.updateColor('#' + (data.colorHex2 || 'FFFFFF'), 2);

    document.getElementById('colorHex3').value = data.colorHex3 || 'FFFFFF';
    this.updateColor('#' + (data.colorHex3 || 'FFFFFF'), 3);

    document.getElementById('colorHex4').value = data.colorHex4 || 'FFFFFF';
    this.updateColor('#' + (data.colorHex4 || 'FFFFFF'), 4);

    const hasAdditionalColors = (data.colorHex2 && data.colorHex2 !== 'FFFFFF') ||
      (data.colorHex3 && data.colorHex3 !== 'FFFFFF') ||
      (data.colorHex4 && data.colorHex4 !== 'FFFFFF');
    if (hasAdditionalColors) {
      document.getElementById('showAdditionalColors').checked = true;
      this.toggleAdditionalColors(true);
    }

    if (data.brand && this.palettes.brand.items.includes(data.brand)) {
      this.setPaletteValue('brand', data.brand);
    } else if (data.brand) {
      document.getElementById('brandInput').value = data.brand;
      this.setPaletteValue('brand', 'custom');
    } else {
      this.setPaletteValue('brand', 'Generic');
    }

    document.getElementById('minTemp').value = data.minTemp || '';
    document.getElementById('maxTemp').value = data.maxTemp || '';
    document.getElementById('bedTempMin').value = data.bedTempMin || '';
    document.getElementById('bedTempMax').value = data.bedTempMax || '';
    document.getElementById('spoolmanId').value = data.spoolmanId || '';
    document.getElementById('lotNr').value = data.lotNr || '';
    this.setPaletteValue('variant', data.extendedSubType || 'Basic');

    document.getElementById('materialName').value = data.materialName || '';
    document.getElementById('gtin').value = data.gtin || '';
    document.getElementById('materialAbbr').value = data.materialAbbreviation || '';
    document.getElementById('density').value = data.density || '';
    document.getElementById('diameter').value = data.filamentDiameter || '1.75';
    document.getElementById('preheatTemp').value = data.preheatTemp || '';
    document.getElementById('mfgDate').value = data.manufacturedDate || '';
    document.getElementById('nominalWeight').value = data.nominalWeight || '';
    document.getElementById('actualWeight').value = data.actualWeight || '';
    document.getElementById('spoolWeight').value = data.emptySpoolWeight || '';
    document.getElementById('countryCode').value = data.countryOfOrigin || '';
    document.getElementById('matteFinish').checked = data.matteFinish || false;
    document.getElementById('silkFinish').checked = data.silkFinish || false;
    document.getElementById('translucent').checked = data.translucent || false;
    document.getElementById('transparent').checked = data.transparent || false;
    document.getElementById('glitter').checked = data.glitter || false;
    document.getElementById('gradualColorChange').checked = data.gradualColorChange || false;
    document.getElementById('coextruded').checked = data.coextruded || false;

    this.updateFormat();
    this.updateVisibility();
    this.updateRecordSize();
  },

  getFormData() {
    const brandHidden = document.getElementById('brandValue');
    const brandInput = document.getElementById('brandInput');
    const brand = brandHidden.value || brandInput.value || 'Generic';

    const data = {
      format: document.getElementById('formatSelect').value,

      materialType: document.getElementById('materialType').value,
      brand: brand || 'Generic',
      colorHex: document.getElementById('colorHex1').value.replace('#', ''),
      colorHex2: document.getElementById('colorHex2').value.replace('#', ''),
      colorHex3: document.getElementById('colorHex3').value.replace('#', ''),
      colorHex4: document.getElementById('colorHex4').value.replace('#', ''),

      minTemp: document.getElementById('minTemp').value,
      maxTemp: document.getElementById('maxTemp').value,
      bedTempMin: document.getElementById('bedTempMin').value,
      bedTempMax: document.getElementById('bedTempMax').value,
      spoolmanId: document.getElementById('spoolmanId').value,
      lotNr: document.getElementById('lotNr').value,
      extendedSubType: document.getElementById('extendedSubType').value,

      materialName: document.getElementById('materialName').value,
      gtin: document.getElementById('gtin').value,
      materialAbbreviation: document.getElementById('materialAbbr').value,
      density: document.getElementById('density').value,
      filamentDiameter: document.getElementById('diameter').value,
      preheatTemp: document.getElementById('preheatTemp').value,
      manufacturedDate: document.getElementById('mfgDate').value,
      nominalWeight: document.getElementById('nominalWeight').value,
      actualWeight: document.getElementById('actualWeight').value,
      emptySpoolWeight: document.getElementById('spoolWeight').value,
      countryOfOrigin: document.getElementById('countryCode').value,

      matteFinish: document.getElementById('matteFinish').checked,
      silkFinish: document.getElementById('silkFinish').checked,
      translucent: document.getElementById('translucent').checked,
      transparent: document.getElementById('transparent').checked,
      glitter: document.getElementById('glitter').checked,
      gradualColorChange: document.getElementById('gradualColorChange').checked,
      coextruded: document.getElementById('coextruded').checked
    };

    const currentFormat = document.getElementById('formatSelect').value;

    const available = formats.availableFields(currentFormat, data);
    if (available && available.size) {
      const filtered = {};
      Object.keys(data).forEach(k => {
        if (available.has(k)) filtered[k] = data[k];
      });
      return filtered;
    }
    return data;
  },

  downloadFile() {
    const format = document.getElementById('formatSelect').value;
    const formData = this.getFormData();

    const data = formats.generateData(format, formData);
    formats.download(format, data);

    this.showStatus('writeStatus', 'success', `${formats.getDisplayName(format)} Datei heruntergeladen`);
  },

  async shareFile() {
    const format = document.getElementById('formatSelect').value;
    const formData = this.getFormData();
    const data = formats.generateData(format, formData);

    const ext = formats.getFileExtension(format);
    const displayName = formats.getDisplayName(format);
    const filename = `filament-tag${ext}`;

    let blob;
    if (ext === '.json') {
      blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    } else {
      const ndefBytes = NDEF.serialize(data, 'application/vnd.openprinttag');
      blob = new Blob([ndefBytes], { type: 'application/octet-stream' });
    }

    const file = new File([blob], filename, { type: blob.type });

    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({
          title: 'Spool Tag Propus – Filament Tag',
          text: `${displayName} Tag-Daten für NFC`,
          files: [file]
        });
        this.showStatus('writeStatus', 'success', 'Datei geteilt');
      } else {
        this.downloadFile();
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        this.downloadFile();
      }
    }
  },

  handleWriteProgress(writeBtn, originalText, format) {
    const floatBtn = document.getElementById('floatingWriteBtn');
    const floatingOriginal = floatBtn ? floatBtn.textContent : '📝 NFC Beschreiben';
    return (status, error) => {
      writeBtn.disabled = false;
      if (floatBtn) floatBtn.disabled = false;
      if (status === 'reading') {
        writeBtn.textContent = '❌ Abbrechen';
        writeBtn.classList.remove('btn-success');
        writeBtn.classList.add('btn-secondary');
        if (floatBtn) floatBtn.textContent = '❌ Abbrechen';
        this.showStatus('writeStatus', 'warning', 'Halte das Gerät an den NFC-Tag...');
      } else if (status === 'writing') {
        writeBtn.disabled = true;
        writeBtn.textContent = '⏳ Schreibe...';
        if (floatBtn) {
          floatBtn.disabled = true;
          floatBtn.textContent = '⏳ Schreibe...';
        }
        this.showStatus('writeStatus', 'warning', 'Tag wird beschrieben...');
      } else if (status === 'success') {
        writeBtn.textContent = originalText;
        writeBtn.classList.remove('btn-secondary');
        writeBtn.classList.add('btn-success');
        if (floatBtn) {
          floatBtn.disabled = false;
          floatBtn.textContent = floatingOriginal;
        }
        this.showStatus('writeStatus', 'success', `Tag erfolgreich beschrieben (${format})`);
        if (typeof this.showMobileToast === 'function') this.showMobileToast('Tag erfolgreich beschrieben!', 'success');
      } else if (status === 'error') {
        writeBtn.textContent = originalText;
        writeBtn.classList.remove('btn-secondary');
        writeBtn.classList.add('btn-success');
        if (floatBtn) {
          floatBtn.disabled = false;
          floatBtn.textContent = floatingOriginal;
        }

        const errorMsg = error && error.name === 'NotAllowedError' ? 'NFC-Berechtigung verweigert' :
          error && error.name === 'AbortError' ? 'Schreibvorgang abgebrochen' :
          (error && error.message) || 'Schreiben fehlgeschlagen';
        this.showStatus('writeStatus', 'error', errorMsg);
        if (typeof this.showMobileToast === 'function') this.showMobileToast(errorMsg, 'error');
      }
    };
  },

  toggleWrite() {
    if (nfcWriter.isWriting()) {
      this.cancelWrite();
    } else {
      this.writeNFC();
    }
  },

  cancelWrite() {
    nfcWriter.cancel();
    const writeBtn = document.getElementById('writeBtn');
    writeBtn.textContent = '📝 NFC Beschreiben';
    writeBtn.classList.remove('btn-secondary');
    writeBtn.classList.add('btn-success');
    this.showStatus('writeStatus', '', '');
    const floatBtn = document.getElementById('floatingWriteBtn');
    if (floatBtn) {
      floatBtn.disabled = false;
      floatBtn.textContent = '📝 NFC Beschreiben';
    }
  },

  async writeNFC() {
    if (!this.nfcSupported) {
      this.showStatus('writeStatus', 'error', 'NFC wird auf diesem Gerät/Browser nicht unterstützt. Nutze die Datei-Download-Option.');
      return;
    }

    const writeBtn = document.getElementById('writeBtn');
    const originalText = writeBtn.textContent;
    const format = document.getElementById('formatSelect').value;
    const formData = this.getFormData();

    const data = formats.generateData(format, formData);
    const records = formats.createNDEFRecord(format, data);

    try {
      await nfcWriter.write(records, this.handleWriteProgress(writeBtn, originalText, format));
    } catch (error) {
      writeBtn.textContent = originalText;
      writeBtn.classList.remove('btn-secondary');
      writeBtn.classList.add('btn-success');
      this.showStatus('writeStatus', 'error', error.message);
    }
  },

  updateFormat() {
    this.updateRecordSize();
    this.updateVisibility();
  },

  updateVisibility() {
    const format = document.getElementById('formatSelect').value;
    const formData = this.getFormData();
    const available = formats.availableFields(format, formData);

    document.querySelectorAll('[data-field]')
      .forEach(el => {
        const key = el.getAttribute('data-field');
        if (!available || available.has(key)) {
          el.classList.remove('hidden');
        } else {
          el.classList.add('hidden');
        }
      });

    const advancedSection = document.getElementById('advancedSection');
    if (advancedSection) {
      const advancedFields = Array.from(advancedSection.querySelectorAll('[data-field]'))
        .map(el => el.getAttribute('data-field'));
      const hasAdvanced = !!(available && advancedFields.some(k => available.has(k)));
      advancedSection.classList.toggle('hidden', !hasAdvanced);
    }
  },

  applyTemperaturePreset() {
    const materialType = document.getElementById('materialType').value;
    const preset = this.materialPresets[materialType];

    if (preset) {
      document.getElementById('minTemp').value = preset.minTemp;
      document.getElementById('maxTemp').value = preset.maxTemp;
      document.getElementById('bedTempMin').value = preset.bedTempMin;
      document.getElementById('bedTempMax').value = preset.bedTempMax;
    }
    this.updateRecordSize();
  },

  updateRecordSize() {
    try {
      const format = document.getElementById('formatSelect').value;
      const formData = this.getFormData();
      const size = formats.calculateRecordSize(format, formData);

      const sizeInfo = document.getElementById('recordSizeInfo');
      let tagType = '';
      let colorStyle = '';

      if (size > 888) {
        colorStyle = 'rgba(244, 67, 54, 0.2)';
        sizeInfo.style.borderColor = 'var(--error)';
        tagType = 'Too large for any supported tag';
      } else if (size > 504) {
        colorStyle = 'rgba(255, 152, 0, 0.2)';
        sizeInfo.style.borderColor = 'var(--warning)';
        tagType = 'NTAG216 required';
      } else if (size > 144) {
        colorStyle = 'rgba(76, 175, 80, 0.1)';
        sizeInfo.style.borderColor = 'var(--success)';
        tagType = 'NTAG215/216';
      } else {
        colorStyle = 'rgba(76, 175, 80, 0.1)';
        sizeInfo.style.borderColor = 'var(--success)';
        tagType = 'NTAG213/215/216';
      }

      sizeInfo.style.background = colorStyle;
      document.getElementById('recordSize').textContent = `${size} bytes (${tagType})`;
    } catch (e) {
      // Silently fail if form is incomplete
    }
  },

  toggleAdvanced() {
    const collapsible = document.querySelector('.collapsible');
    const content = document.querySelector('.collapsible-content');
    collapsible.classList.toggle('collapsed');
    content.classList.toggle('collapsed');
  },

  initPalette(name) {
    this.rebuildPalette(name);
  },

  rebuildPalette(name, filterItems) {
    const config = this.palettes[name];
    const palette = document.getElementById(config.paletteId);
    if (!palette) return;
    palette.innerHTML = '';
    const allItems = typeof config.items === 'function' ? config.items() : config.items;
    const items = filterItems ? allItems.filter(i => filterItems.includes(i)) : allItems;
    const select = (val) => this.setPaletteValue(name, val);
    items.forEach(item => {
      palette.appendChild(this._createSwatch(item, item, select));
    });
    if (config.customInputId) {
      palette.appendChild(this._createSwatch('Custom', 'custom', select));
    }
    const currentVal = document.getElementById(config.inputId).value;
    const validDefault = items.includes(currentVal) ? currentVal : (items[0] || config.defaultValue);
    select(validDefault);
  },

  filterPalettesForBrand(brand) {
    const catalog = this.brandCatalog[brand];
    if (!catalog || brand === 'Generic' || brand === 'custom') {
      this.rebuildPalette('material');
      this.rebuildPalette('variant');
    } else {
      this.rebuildPalette('material', catalog.materials);
      this.rebuildPalette('variant', catalog.variants);
    }
  },

  _allowedColorsTimer: null,
  _allowedColorsLastKey: '',
  _allowedColorsActive: false,

  refreshAllowedColors() {
    // Only apply when logged in (filament DB endpoints are protected)
    if (typeof Auth === 'undefined' || !Auth.isLoggedIn()) return;
    if (typeof ColorPicker === 'undefined' || !ColorPicker) return;

    const brand = (document.getElementById('brandValue')?.value || '').trim();
    const material = (document.getElementById('materialType')?.value || '').trim();
    const variant = (document.getElementById('extendedSubType')?.value || '').trim();
    if (!brand || !material) return;

    const key = `${brand}|${material}|${variant}`;
    this._allowedColorsLastKey = key;
    if (this._allowedColorsTimer) clearTimeout(this._allowedColorsTimer);
    this._allowedColorsTimer = setTimeout(() => {
      this._refreshAllowedColorsNow(key, brand, material, variant);
    }, 200);
  },

  async _refreshAllowedColorsNow(key, brand, material, variant) {
    // If selection changed since scheduling, skip.
    if (key !== this._allowedColorsLastKey) return;
    const apiBase = `${location.protocol}//${location.host}/api`;
    try {
      const url = new URL(`${apiBase}/filaments/colors`);
      url.searchParams.set('brand', brand);
      url.searchParams.set('material', material);
      if (variant) url.searchParams.set('variant', variant);

      const resp = await Auth.fetch(url.toString());
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.message || data.error || `HTTP ${resp.status}`);

      const colors = Array.isArray(data.colors) ? data.colors : [];
      if (!colors.length) {
        if (this._allowedColorsActive) {
          for (let i = 1; i <= 4; i++) {
            ColorPicker.buildSwatchGrid(i, this);
            ColorPicker.highlightSwatch(i);
          }
          this._allowedColorsActive = false;
        }
        return;
      }

      this._allowedColorsActive = true;
      const allowed = colors.map(h => String(h || '').replace('#', '').trim().toUpperCase()).filter(Boolean);
      for (let i = 1; i <= 4; i++) {
        ColorPicker.buildSwatchGrid(i, this, allowed);
        ColorPicker.highlightSwatch(i);
      }

      // If current primary color isn't available, pick the first allowed.
      const current = (document.getElementById('colorHex1')?.value || '').trim().toUpperCase();
      if (allowed.length && current && !allowed.includes(current)) {
        ColorPicker.selectColor(1, allowed[0], this);
      }
    } catch (e) {
      // On any error, keep existing swatches (avoid thrashing).
    }
  },

  _createSwatch(label, value, onSelect) {
    const box = document.createElement('div');
    box.className = 'material-swatch';
    box.textContent = label;
    box.dataset.value = value;
    box.setAttribute('role', 'button');
    box.setAttribute('tabindex', '0');
    box.title = `Select ${label}`;
    box.onclick = () => onSelect(value);
    box.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onSelect(value);
      }
    };
    return box;
  },

  setPaletteValue(name, value) {
    const config = this.palettes[name];
    const input = document.getElementById(config.inputId);
    const isCustom = config.customInputId && value === 'custom';
    if (config.customInputId) {
      const customInput = document.getElementById(config.customInputId);
      if (isCustom) {
        customInput.classList.remove('hidden');
        customInput.focus();
        input.value = customInput.value || '';
      } else {
        input.value = value;
        customInput.classList.add('hidden');
      }
    } else {
      input.value = value;
    }
    document.querySelectorAll(`#${config.paletteId} .material-swatch`).forEach(el => {
      const isSelected = isCustom ? el.dataset.value === 'custom' : el.dataset.value === value;
      el.classList.toggle('selected', isSelected);
      el.setAttribute('aria-selected', isSelected ? 'true' : 'false');
    });
    if (config.onSelect) config.onSelect(value);
    this.updateRecordSize();
  },

  updateColor(color, paletteId) {
    const preview = document.getElementById(`colorPreview${paletteId}`);
    if (preview) {
      preview.style.background = color;
    }
    if (typeof ColorPicker !== 'undefined' && ColorPicker) {
      if (typeof ColorPicker.setFromHex === 'function') {
        ColorPicker.setFromHex(paletteId, color);
      }
      if (typeof ColorPicker.highlightSwatch === 'function') {
        ColorPicker.highlightSwatch(paletteId);
      }
    }
  },

  _toastTimer: null,
  showMobileToast(message, type) {
    const el = document.getElementById('mobileToast');
    if (!el) return;
    el.textContent = message;
    el.className = `mobile-toast show ${type || ''}`.trim();
    if (this._toastTimer) clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      el.classList.remove('show');
    }, 3500);
  },

  rgbToHex(rgb) {
    const result = rgb.match(/\d+/g);
    if (!result) return rgb;
    return '#' + result.slice(0, 3).map(x => parseInt(x).toString(16).padStart(2, '0')).join('');
  },

  toggleAdditionalColors(show) {
    const additionalColorFields = document.querySelectorAll('.additional-colors');
    additionalColorFields.forEach(field => {
      field.style.display = show ? 'block' : 'none';
    });
  },

  showStatus(id, type, message) {
    const element = document.getElementById(id);
    element.className = `status-message ${type ? 'show ' + type : ''}`;
    element.textContent = message;
    if (type === 'success') {
      setTimeout(() => element.classList.remove('show'), 5000);
    }
  },

  randomizeLotNr() {
    const lotNr = Array.from({length: 8}, () =>
      Math.floor(Math.random() * 16).toString(16).toUpperCase()
    ).join('');
    document.getElementById('lotNr').value = lotNr;
    this.updateRecordSize();
  },

  // === Slicer Profiles Page ===

  _profilePage: 1,
  _profilesInitialized: false,

  async initProfilesPage() {
    if (!this._profilesInitialized) {
      try {
        const vendors = await ProfileDB.getProfileVendors();
        const sel = document.getElementById('profileVendorFilter');
        vendors.forEach(v => {
          const opt = document.createElement('option');
          opt.value = v.name;
          opt.textContent = `${v.name} (${v.count})`;
          sel.appendChild(opt);
        });
        this._profilesInitialized = true;
      } catch (e) {
        document.getElementById('profileSyncInfo').innerHTML =
          '⚠️ Backend nicht erreichbar. Datenbank wird gerade aufgebaut – bitte in einigen Minuten erneut versuchen.';
        return;
      }
    }

    this.loadProfileSyncInfo();
    this.loadProfiles();
  },

  async onProfileVendorChange() {
    const vendor = document.getElementById('profileVendorFilter').value;
    const matSel = document.getElementById('profileMaterialFilter');
    matSel.innerHTML = '<option value="">Alle Materialien</option>';

    if (vendor) {
      try {
        const materials = await ProfileDB.getProfileMaterials(vendor);
        materials.forEach(m => {
          const opt = document.createElement('option');
          opt.value = m.name;
          opt.textContent = `${m.name} (${m.count})`;
          matSel.appendChild(opt);
        });
      } catch (e) {}
    }
    this._profilePage = 1;
    this.loadProfiles();
  },

  async loadProfiles() {
    const container = document.getElementById('profileResults');
    container.innerHTML = '<p style="text-align:center; color: var(--text-secondary);">Lade Profile...</p>';

    try {
      const data = await ProfileDB.searchProfiles({
        vendor: document.getElementById('profileVendorFilter').value,
        material: document.getElementById('profileMaterialFilter').value,
        q: document.getElementById('profileSearch').value,
        page: this._profilePage,
        per_page: 30
      });

      if (data.total === 0) {
        container.innerHTML = '<p style="text-align:center; color: var(--text-secondary);">Keine Profile gefunden.</p>';
        document.getElementById('profilePagination').innerHTML = '';
        return;
      }

      container.innerHTML = '';

      const grouped = {};
      data.profiles.forEach(p => {
        const isBase = p.source_path && p.source_path.includes('@base');
        if (isBase) return;

        const key = `${p.vendor}|${p.filament_name}|${p.material_type}`;
        if (!grouped[key]) grouped[key] = { ...p, printers: [], _bestData: p };
        grouped[key].printers.push({
          id: p.id,
          printer: p.printer,
          nozzle_temp_min: p.nozzle_temp_min,
          nozzle_temp_max: p.nozzle_temp_max,
          bed_temp_min: p.bed_temp_min,
          bed_temp_max: p.bed_temp_max,
          max_volumetric_speed: p.max_volumetric_speed,
          source_path: p.source_path || ''
        });
        const best = grouped[key]._bestData;
        if (!best.nozzle_temp_min && p.nozzle_temp_min) grouped[key]._bestData = p;
        else if (!best.bed_temp_min && p.bed_temp_min) grouped[key]._bestData = p;
      });

      Object.values(grouped).forEach(g => {
        const card = document.createElement('div');
        card.className = 'profile-card';

        const d = g._bestData || g;
        const nozzle = (d.nozzle_temp_min || d.nozzle_temp_max)
          ? `${d.nozzle_temp_min || '?'}–${d.nozzle_temp_max || '?'}°C` : null;
        const bed = (d.bed_temp_min || d.bed_temp_max)
          ? `${d.bed_temp_min || '?'}–${d.bed_temp_max || '?'}°C` : null;
        const mvs = d.max_volumetric_speed ? `${d.max_volumetric_speed} mm³/s` : null;
        const density = g.filament_density ? `${g.filament_density} g/cm³` : null;
        const cost = g.filament_cost ? `${g.filament_cost} €/kg` : null;

        const infoChips = [];
        if (nozzle) infoChips.push(`<span class="pcard-chip">🌡️ Düse ${nozzle}</span>`);
        if (bed) infoChips.push(`<span class="pcard-chip">🛏️ Bett ${bed}</span>`);
        if (mvs) infoChips.push(`<span class="pcard-chip">⚡ ${mvs}</span>`);
        if (density) infoChips.push(`<span class="pcard-chip">⚖️ ${density}</span>`);
        if (cost) infoChips.push(`<span class="pcard-chip">💰 ${cost}</span>`);

        const printerMap = new Map();
        g.printers.forEach(p => {
          let printerName = p.printer || null;
          if (printerName && /^\d+\.?\d*\s+nozzle$/i.test(printerName)) {
            printerName = null;
          }

          let nozzleSize = null;
          const nzMatch = (p.source_path || '').match(/(\d+\.?\d*)\s*nozzle/i);
          if (nzMatch) nozzleSize = nzMatch[1];

          const mapKey = `${printerName || '__default__'}|${nozzleSize || 'std'}`;
          if (!printerMap.has(mapKey)) {
            printerMap.set(mapKey, { id: p.id, printer: printerName, nozzleSize });
          }
        });

        const entries = Array.from(printerMap.values());
        const hasSpecific = entries.some(e => e.printer);
        const filtered = hasSpecific ? entries.filter(e => e.printer || e.nozzleSize) : entries;
        const dedupPrinters = new Map();
        (filtered.length ? filtered : entries).forEach(e => {
          const key = e.printer || '__default__';
          if (!dedupPrinters.has(key)) dedupPrinters.set(key, []);
          dedupPrinters.get(key).push(e);
        });

        let printerBtns = '';
        dedupPrinters.forEach((variants, key) => {
          if (key !== '__default__') {
            const label = key.replace(/^BBL\s*/i, '').replace(/^@\s*/, '').trim();
            if (variants.length === 1) {
              const v = variants[0];
              const nzLabel = v.nozzleSize ? ` (${v.nozzleSize}mm)` : '';
              printerBtns += `<a href="${ProfileDB.getDownloadUrl(v.id)}" class="profile-dl-btn" download title="${key}${nzLabel}">📥 ${label}${nzLabel}</a>`;
            } else {
              variants.forEach(v => {
                const nzLabel = v.nozzleSize ? ` ${v.nozzleSize}mm` : '';
                printerBtns += `<a href="${ProfileDB.getDownloadUrl(v.id)}" class="profile-dl-btn" download title="${key}${nzLabel}">📥 ${label}${nzLabel}</a>`;
              });
            }
          } else {
            if (variants.length === 1 && !hasSpecific) {
              printerBtns += `<a href="${ProfileDB.getDownloadUrl(variants[0].id)}" class="profile-dl-btn" download>📥 Download</a>`;
            } else {
              variants.forEach(v => {
                const nzLabel = v.nozzleSize ? ` ${v.nozzleSize}mm` : '';
                printerBtns += `<a href="${ProfileDB.getDownloadUrl(v.id)}" class="profile-dl-btn" download>📥 Standard${nzLabel}</a>`;
              });
            }
          }
        });

        card.innerHTML = `
          <div class="pcard-top">
            <div class="pcard-title-row">
              <span class="profile-badge pcard-mat">${g.material_type || '?'}</span>
              <strong class="pcard-name">${g.filament_name}</strong>
            </div>
            <span class="pcard-vendor">${g.vendor}</span>
          </div>
          ${infoChips.length ? `<div class="pcard-chips">${infoChips.join('')}</div>` : ''}
          <div class="pcard-downloads">${printerBtns}</div>
        `;
        container.appendChild(card);
      });

      const totalPages = Math.ceil(data.total / data.per_page);
      const pag = document.getElementById('profilePagination');
      pag.innerHTML = '';
      if (totalPages > 1) {
        if (this._profilePage > 1) {
          const prev = document.createElement('button');
          prev.className = 'btn-secondary';
          prev.style.cssText = 'width:auto;padding:0.4rem 0.8rem;';
          prev.textContent = '← Zurück';
          prev.onclick = () => { this._profilePage--; this.loadProfiles(); };
          pag.appendChild(prev);
        }
        const info = document.createElement('span');
        info.style.cssText = 'color:var(--text-secondary);align-self:center;';
        info.textContent = `Seite ${this._profilePage} / ${totalPages} (${data.total} Profile)`;
        pag.appendChild(info);
        if (this._profilePage < totalPages) {
          const next = document.createElement('button');
          next.className = 'btn-secondary';
          next.style.cssText = 'width:auto;padding:0.4rem 0.8rem;';
          next.textContent = 'Weiter →';
          next.onclick = () => { this._profilePage++; this.loadProfiles(); };
          pag.appendChild(next);
        }
      }
    } catch (e) {
      container.innerHTML = `<p style="color: var(--error);">Fehler beim Laden: ${e.message}</p>`;
    }
  },

  async loadProfileSyncInfo() {
    try {
      const status = await ProfileDB.getSyncStatus();
      const el = document.getElementById('profileSyncInfo');
      const src = status.sources || [];
      const orca = src.find(s => s.source === 'orca_profiles');
      const last = orca ? new Date(orca.last_sync).toLocaleString('de-CH') : 'Nie';
      el.innerHTML = `📊 <strong>${status.totals.profiles}</strong> Slicer-Profile · <strong>${status.totals.filaments}</strong> Filamente · Letzte Sync: ${last}`;
    } catch (e) {}
  },

  // === Filament List Page ===

  _filListPage: 1,
  _filListInitialized: false,

  async initFilamentListPage() {
    if (!this._filListInitialized) {
      try {
        const brands = await ProfileDB.getFilamentBrands();
        const sel = document.getElementById('filListBrandFilter');
        brands.forEach(b => {
          const opt = document.createElement('option');
          opt.value = b.name;
          opt.textContent = `${b.name} (${b.count})`;
          sel.appendChild(opt);
        });
        this._filListInitialized = true;
      } catch (e) {
        document.getElementById('filListSyncInfo').innerHTML =
          '⚠️ Backend nicht erreichbar. Datenbank wird gerade aufgebaut – bitte in einigen Minuten erneut versuchen.';
        return;
      }
    }

    this.loadFilListSyncInfo();
    // Pre-load Spoolman spools for the Spoolman filter (non-blocking)
    if (this.spoolmanUrl && (!this._mySpoolmanSpools || !this._mySpoolmanSpools.length) &&
        (!this._spoolmanSpools || !this._spoolmanSpools.length)) {
      const url = this._normalizeSpoolmanUrl(this.spoolmanUrl);
      if (url) {
        fetch(`${url}/api/v1/spool?allow_archived=false`, { signal: AbortSignal.timeout(8000) })
          .then(r => r.ok ? r.json() : [])
          .then(spools => { this._mySpoolmanSpools = spools; this._spoolmanSpools = spools; })
          .catch(() => {});
      }
    }
    this.loadFilamentList();
  },

  async onFilListBrandChange() {
    const brand = document.getElementById('filListBrandFilter').value;
    const matSel = document.getElementById('filListMaterialFilter');
    matSel.innerHTML = '<option value="">Alle Materialien</option>';

    if (brand) {
      try {
        const materials = await ProfileDB.getFilamentMaterials(brand);
        materials.forEach(m => {
          const opt = document.createElement('option');
          opt.value = m.name;
          opt.textContent = `${m.name} (${m.count})`;
          matSel.appendChild(opt);
        });
      } catch (e) {}
    }
    this._filListPage = 1;
    this.loadFilamentList();
  },

  async loadFilamentList() {
    const container = document.getElementById('filListResults');
    container.innerHTML = '<p style="text-align:center; color: var(--text-secondary);">Lade Filamente...</p>';

    try {
      const spoolmanFilterEl = document.getElementById('filListSpoolmanFilter');
      const spoolmanFilter = spoolmanFilterEl ? spoolmanFilterEl.value : '';

      // Spoolman-Modus: direkt Spoolman-Spulen anzeigen
      if (spoolmanFilter === 'spoolman') {
        const url = this._normalizeSpoolmanUrl(this.spoolmanUrl);
        if (!url) {
          container.innerHTML = `<div style="text-align:center;padding:2rem;">
            <p style="color:var(--text-secondary);margin-bottom:1rem;">⚠️ Keine Spoolman URL konfiguriert.</p>
            <button class="btn-primary" style="width:auto;" onclick="app.setMode('settings')">⚙️ Spoolman einrichten</button>
          </div>`;
          document.getElementById('filListPagination').innerHTML = '';
          return;
        }

        container.innerHTML = '<p style="text-align:center; color: var(--text-secondary);">Lade Spoolman-Spulen...</p>';
        let spools = [];
        try {
          const resp = await fetch(`${url}/api/v1/spool`, { signal: AbortSignal.timeout(10000) });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          spools = await resp.json();
          this._mySpoolmanSpools = spools;
        } catch (e) {
          container.innerHTML = `<p style="text-align:center;color:var(--error);">Spoolman-Fehler: ${e.message}</p>`;
          document.getElementById('filListPagination').innerHTML = '';
          return;
        }

        // Suchfilter anwenden
        const q = (document.getElementById('filListSearch').value || '').toLowerCase().trim();
        const matFilter = (document.getElementById('filListMaterialFilter').value || '').toLowerCase();
        if (q || matFilter) {
          spools = spools.filter(s => {
            const f = s.filament || {};
            const v = f.vendor || {};
            if (matFilter && (f.material || '').toLowerCase() !== matFilter) return false;
            if (q) {
              const text = [v.name, f.name, f.material, s.id, s.lot_nr, f.color_hex]
                .filter(Boolean).join(' ').toLowerCase();
              if (!text.includes(q)) return false;
            }
            return true;
          });
        }

        if (!spools.length) {
          container.innerHTML = '<p style="text-align:center; color: var(--text-secondary);">Keine Spulen in Spoolman gefunden.</p>';
          document.getElementById('filListPagination').innerHTML = '';
          return;
        }

        container.innerHTML = '';
        const grid = document.createElement('div');
        grid.className = 'filament-grid';

        spools.forEach(spool => {
          const f = spool.filament || {};
          const v = f.vendor || {};
          const color = f.color_hex || 'CCCCCC';
          const material = f.material || '?';
          const brand = v.name || 'Unbekannt';
          const name = f.name || material;
          const remaining = spool.remaining_weight != null ? `⚖️ ${Math.round(spool.remaining_weight)}g` : '';
          const density = f.density ? `· ${f.density} g/cm³` : '';

          const card = document.createElement('div');
          card.className = 'filament-card';
          card.innerHTML = `
            <div class="filament-color" style="background:#${color.replace('#','')};"></div>
            <div class="filament-info">
              <strong>${name}</strong>
              <span class="profile-badge" style="font-size:0.7rem;">${material}</span>
              <div style="font-size:0.75rem;color:var(--text-secondary);">${brand}</div>
              <div style="font-size:0.7rem;color:var(--text-secondary);margin-top:0.2rem;">
                ${remaining} ${density}
                ${spool.lot_nr ? `· Lot: ${spool.lot_nr}` : ''}
                · ID: ${spool.id}
              </div>
            </div>
            <button class="btn-primary" style="width:auto;padding:0.3rem 0.6rem;font-size:0.75rem;margin-top:0.3rem;"
              onclick="app.importFromSpoolman(${JSON.stringify(spool).replace(/"/g,'&quot;')})">
              → Tag erstellen
            </button>
          `;
          // onclick direkt über spool-id
          card.querySelector('button').onclick = () => this.importFromSpoolman(spool);
          grid.appendChild(card);
        });

        container.appendChild(grid);
        document.getElementById('filListPagination').innerHTML =
          `<p style="text-align:center;color:var(--text-secondary);font-size:0.8rem;">${spools.length} Spule(n) aus Spoolman</p>`;
        return;
      }

      // Standard-Modus: Open Filament Database
      const data = await ProfileDB.searchFilaments({
        brand: document.getElementById('filListBrandFilter').value,
        material: document.getElementById('filListMaterialFilter').value,
        q: document.getElementById('filListSearch').value,
        page: this._filListPage,
        per_page: 40
      });

      if (data.total === 0) {
        container.innerHTML = '<p style="text-align:center; color: var(--text-secondary);">Keine Filamente gefunden.</p>';
        document.getElementById('filListPagination').innerHTML = '';
        return;
      }

      container.innerHTML = '';
      const grid = document.createElement('div');
      grid.className = 'filament-grid';

      data.filaments.forEach(f => {
        const card = document.createElement('div');
        card.className = 'filament-card';

        const colorBox = f.color_hex
          ? `<div class="filament-color" style="background:${f.color_hex};"></div>`
          : `<div class="filament-color" style="background:#333;"></div>`;

        const temps = [];
        if (f.nozzle_temp_min && f.nozzle_temp_max)
          temps.push(`🌡️ ${f.nozzle_temp_min}–${f.nozzle_temp_max}°C`);
        if (f.bed_temp_min && f.bed_temp_max)
          temps.push(`🛏️ ${f.bed_temp_min}–${f.bed_temp_max}°C`);
        if (f.density)
          temps.push(`⚖️ ${f.density} g/cm³`);

        card.innerHTML = `
          ${colorBox}
          <div class="filament-info">
            <strong>${f.name}</strong>
            <span class="profile-badge" style="font-size:0.7rem;">${f.material}</span>
            <div style="font-size:0.75rem; color:var(--text-secondary);">${f.brand}</div>
            ${f.color_name ? `<div style="font-size:0.75rem;">${f.color_name}</div>` : ''}
            <div style="font-size:0.7rem; color:var(--text-secondary); margin-top:0.2rem;">${temps.join(' · ')}</div>
          </div>
          <button class="btn-primary" style="width:auto; padding:0.3rem 0.6rem; font-size:0.75rem; margin-top:0.3rem;"
            onclick="app.useFilamentForTag(${f.id})">
            → Tag erstellen
          </button>
        `;
        grid.appendChild(card);
      });

      container.appendChild(grid);

      const perPage = data.per_page || 40;
      const totalPages = Math.ceil(data.total / perPage);
      const pag = document.getElementById('filListPagination');
      pag.innerHTML = '';
      if (totalPages > 1) {
        if (this._filListPage > 1) {
          const prev = document.createElement('button');
          prev.className = 'btn-secondary';
          prev.style.cssText = 'width:auto;padding:0.4rem 0.8rem;';
          prev.textContent = '← Zurück';
          prev.onclick = () => { this._filListPage--; this.loadFilamentList(); };
          pag.appendChild(prev);
        }
        const info = document.createElement('span');
        info.style.cssText = 'color:var(--text-secondary);align-self:center;';
        info.textContent = `Seite ${this._filListPage} / ${totalPages} (${data.total} Filamente)`;
        pag.appendChild(info);
        if (this._filListPage < totalPages) {
          const next = document.createElement('button');
          next.className = 'btn-secondary';
          next.style.cssText = 'width:auto;padding:0.4rem 0.8rem;';
          next.textContent = 'Weiter →';
          next.onclick = () => { this._filListPage++; this.loadFilamentList(); };
          pag.appendChild(next);
        }
      }
    } catch (e) {
      container.innerHTML = `<p style="color: var(--error);">Fehler beim Laden: ${e.message}</p>`;
    }
  },

  async loadFilListSyncInfo() {
    const el = document.getElementById('filListSyncInfo');
    try {
      const status = await ProfileDB.getSyncStatus();
      const src = status.sources || [];
      const fdb = src.find(s => s.source === 'filament_database');
      const last = fdb ? new Date(fdb.last_sync).toLocaleString('de-CH') : 'Nie';
      el.innerHTML = `📊 <strong>${status.totals.filaments}</strong> Filamente in der Datenbank · Letzte Aktualisierung: ${last} · Sync alle 24h`;
    } catch (e) {
      el.innerHTML = '⚠️ Backend nicht erreichbar. Prüfe, ob die API läuft (bei Self-Hosting ggf. Docker-Container "spool-propus-api").';
    }
  },

  async useFilamentForTag(filamentId) {
    try {
      const f = await ProfileDB.getFilament(filamentId);
      const data = {
        materialType: (f.material || 'PLA').toUpperCase(),
        brand: f.brand || 'Generic',
        colorHex: (f.color_hex || '#FFFFFF').replace('#', ''),
        minTemp: f.nozzle_temp_min || '',
        maxTemp: f.nozzle_temp_max || '',
        bedTempMin: f.bed_temp_min || '',
        bedTempMax: f.bed_temp_max || '',
        materialName: f.name || '',
        density: f.density || '',
        filamentDiameter: f.diameter || '1.75',
      };
      this.setMode('create');
      this.populateForm(data, 'openspool_compat');
    } catch (e) {
      this.showMobileToast('Fehler beim Laden: ' + e.message, 'error');
    }
  },

  // === Theme Toggle ===

  loadTheme() {
    const saved = localStorage.getItem('theme') || 'dark';
    document.documentElement.setAttribute('data-theme', saved);
    const toggle = document.getElementById('themeToggle');
    if (toggle) toggle.textContent = saved === 'dark' ? '☀️' : '🌙';
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = saved === 'dark' ? '#0b1120' : '#f0f4f8';
  },

  toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
    const toggle = document.getElementById('themeToggle');
    if (toggle) toggle.textContent = next === 'dark' ? '☀️' : '🌙';
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = next === 'dark' ? '#0b1120' : '#f0f4f8';
    if (Auth && Auth.isLoggedIn() && this._user && this._user.settings) {
      const loc = window.location;
      Auth.fetch(`${loc.protocol}//${loc.host}/api/user/settings`, {
        method: 'PUT',
        body: JSON.stringify({
          spoolmanUrl: this.spoolmanUrl || '',
          theme: next,
          language: (this._user.settings.language || 'de')
        })
      }).catch(() => {});
    }
  },

  // === Release Notes ===

  async loadReleaseNotes() {
    const container = document.getElementById('releaseNotesList');
    const moreBtn = document.getElementById('releaseNotesMoreBtn');
    if (!container) return;
    if (container.dataset.loaded === '1') return;
    try {
      const resp = await fetch('changelog.json?v=' + (window._APP_VERSION || Date.now()));
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const entries = await resp.json();
      container.dataset.loaded = '1';
      this._renderReleaseNotes(entries, 5);
    } catch (e) {
      container.innerHTML = '<p style="color:var(--text-secondary);font-size:0.85rem;">Release Notes konnten nicht geladen werden.</p>';
    }
  },

  _renderReleaseNotes(entries, visibleCount) {
    const container = document.getElementById('releaseNotesList');
    const moreBtn = document.getElementById('releaseNotesMoreBtn');
    if (!container) return;
    this._allReleaseEntries = entries;
    container.innerHTML = '';
    entries.forEach((entry, idx) => {
      const div = document.createElement('div');
      div.className = 'release-entry' + (idx >= visibleCount ? ' release-notes-hidden' : '');
      const changes = entry.changes.map(c => `<li>${c}</li>`).join('');
      const currentLabel = (typeof I18n !== 'undefined' && I18n.t) ? I18n.t('about.releaseCurrent') : 'Aktuell';
      div.innerHTML = `
        <span class="release-version${idx === 0 ? ' latest' : ''}">${entry.version}</span>
        <span class="release-date">${entry.date}</span>
        ${idx === 0 ? `<span style="font-size:0.7rem;background:rgba(0,212,170,0.15);color:var(--accent);padding:0.1rem 0.4rem;border-radius:4px;margin-left:0.4rem;font-weight:600;">${currentLabel}</span>` : ''}
        <ul class="release-changes">${changes}</ul>
      `;
      container.appendChild(div);
    });
    if (moreBtn) {
      if (entries.length > visibleCount) {
        moreBtn.style.display = 'inline-flex';
        moreBtn.textContent = `▼ Ältere Versionen anzeigen (${entries.length - visibleCount} weitere)`;
      } else {
        moreBtn.style.display = 'none';
      }
    }
  },

  showAllReleaseNotes() {
    const container = document.getElementById('releaseNotesList');
    const moreBtn = document.getElementById('releaseNotesMoreBtn');
    if (!container) return;
    container.querySelectorAll('.release-notes-hidden').forEach(el => el.classList.remove('release-notes-hidden'));
    if (moreBtn) moreBtn.style.display = 'none';
  },

  // === URL Parameters (QR code deep links) ===

  checkURLParams() {
    const params = new URLSearchParams(window.location.search);
    const spoolData = params.get('spool') || params.get('d');
    if (spoolData && typeof QR !== 'undefined') {
      try {
        const decoded = QR.decodeData(atob(spoolData));
        if (decoded) {
          window.history.replaceState({}, '', window.location.pathname);
          this._lastTagData = decoded;
          this._lastTagFormat = 'openspool_extended';
          this.showTagSummary(decoded, 'openspool_extended', null);
        }
      } catch (e) {}
    }
  },

  // === QR Code Generator ===

  showQRCode() {
    const formData = this.getFormData();
    const container = document.getElementById('qrCodeContainer');
    const appUrl = `${window.location.origin}${window.location.pathname}`;
    QR.generate(container, formData, appUrl);
    document.getElementById('qrOverlay').classList.remove('hidden');
  },

  closeQRModal() {
    document.getElementById('qrOverlay').classList.add('hidden');
  },

  downloadQR() {
    const canvas = document.querySelector('#qrCodeContainer canvas');
    if (canvas) {
      const link = document.createElement('a');
      link.download = 'spool-propus-qr.png';
      link.href = canvas.toDataURL('image/png');
      link.click();
    } else {
      const img = document.querySelector('#qrCodeContainer img');
      if (img) {
        const link = document.createElement('a');
        link.download = 'spool-propus-qr.png';
        link.href = img.src;
        link.target = '_blank';
        link.click();
      }
    }
  },

  // === QR Code Scanner ===

  toggleQRScan() {
    if (typeof QR === 'undefined') return;
    if (QR.isScanning()) {
      this.stopQRScan();
    } else {
      this.startQRScan();
    }
  },

  async startQRScan() {
    const video = document.getElementById('qrVideo');
    const container = document.getElementById('qrScannerContainer');
    const btn = document.getElementById('qrScanBtn');

    if (!QR.hasCamera) {
      this.showStatus('qrScanStatus', 'error', 'Keine Kamera verfügbar');
      return;
    }

    if (!QR.hasBarcodeDetector) {
      this.showStatus('qrScanStatus', 'warning', 'Browser unterstützt kein QR-Scanning. Bitte Chrome 83+ oder Safari 17.2+ verwenden.');
      return;
    }

    container.classList.remove('hidden');
    btn.textContent = '⏹ Scanner stoppen';
    btn.classList.remove('btn-success');
    btn.classList.add('btn-secondary');
    this.showStatus('qrScanStatus', 'warning', 'Halte den QR-Code vor die Kamera...');

    await QR.startScan(video,
      (rawValue) => {
        this.handleQRResult(rawValue);
      },
      (error) => {
        this.stopQRScan();
        this.showStatus('qrScanStatus', 'error', error);
      }
    );
  },

  stopQRScan() {
    const video = document.getElementById('qrVideo');
    const container = document.getElementById('qrScannerContainer');
    const btn = document.getElementById('qrScanBtn');

    QR.stopScan(video);
    container.classList.add('hidden');
    btn.textContent = '📷 Kamera starten';
    btn.classList.remove('btn-secondary');
    btn.classList.add('btn-success');
    this.showStatus('qrScanStatus', '', '');
  },

  handleQRResult(rawValue) {
    this.stopQRScan();

    let data;
    try {
      if (rawValue.includes('spool=') || rawValue.includes('d=')) {
        const url = new URL(rawValue);
        const param = url.searchParams.get('spool') || url.searchParams.get('d');
        data = QR.decodeData(atob(param));
      } else {
        data = QR.decodeData(rawValue);
      }
    } catch (e) {}

    if (data) {
      this.showMobileToast('QR-Code erkannt!', 'success');
      this._lastTagData = data;
      this._lastTagFormat = 'openspool_extended';
      this.showTagSummary(data, 'openspool_extended', null);
    } else {
      this.showStatus('qrScanStatus', 'error', 'QR-Code erkannt, aber keine gültigen Filament-Daten gefunden.');
    }
  },

  // === Drying Profiles ===

  renderDryingProfiles(filter) {
    if (typeof DryingProfiles === 'undefined') return;

    const grid = document.getElementById('dryingGrid');
    let profiles = DryingProfiles.getAllSorted();

    if (filter) {
      const q = filter.toLowerCase();
      profiles = profiles.filter(p =>
        p.material.toLowerCase().includes(q) ||
        (p.notes && p.notes.toLowerCase().includes(q)) ||
        p.humidity.toLowerCase().includes(q)
      );
    }

    grid.innerHTML = '';
    profiles.forEach(p => {
      const card = document.createElement('div');
      card.className = 'drying-card';
      card.innerHTML = `
        <div class="drying-icon">${p.icon}</div>
        <div class="drying-info">
          <strong>${p.material}</strong>
          <div class="drying-chips">
            <span class="drying-chip">🌡️ ${p.temp}°C</span>
            <span class="drying-chip">⏱️ ${p.time}h</span>
            <span class="drying-chip">📈 max ${p.maxTemp}°C</span>
            <span class="drying-chip">💧 ${p.humidity}</span>
          </div>
          ${p.notes ? `<div class="drying-note">${p.notes}</div>` : ''}
        </div>
      `;
      grid.appendChild(card);
    });

    if (profiles.length === 0) {
      grid.innerHTML = '<p style="color:var(--text-secondary);text-align:center;">Kein Material gefunden.</p>';
    }
  },

  filterDryingProfiles() {
    const q = document.getElementById('dryingSearch').value;
    this.renderDryingProfiles(q);
  },

  // =========================
  //  Spoolman Import UX (Einstellungen)
  // =========================
  _spoolmanSettingsListBound: false,
  _spoolmanSelectedId: null,
  _spoolmanImportedIds: null,

  _spoolmanImportedStorageKey() {
    const uid = this._user && this._user.id ? String(this._user.id) : 'anon';
    return `spooltag_spoolman_imported_ids_${uid}`;
  },

  _loadSpoolmanImportState() {
    try {
      const raw = localStorage.getItem(this._spoolmanImportedStorageKey());
      const arr = raw ? JSON.parse(raw) : [];
      this._spoolmanImportedIds = new Set((Array.isArray(arr) ? arr : []).map(x => parseInt(x, 10)).filter(Boolean));
    } catch {
      this._spoolmanImportedIds = new Set();
    }
    this._updateSpoolmanImportActions();
  },

  _isSpoolmanImported(id) {
    const sid = parseInt(id, 10);
    if (!sid) return false;
    if (!this._spoolmanImportedIds) this._loadSpoolmanImportState();
    return this._spoolmanImportedIds.has(sid);
  },

  _markSpoolmanImported(id) {
    const sid = parseInt(id, 10);
    if (!sid) return;
    if (!this._spoolmanImportedIds) this._loadSpoolmanImportState();
    this._spoolmanImportedIds.add(sid);
    try {
      localStorage.setItem(this._spoolmanImportedStorageKey(), JSON.stringify(Array.from(this._spoolmanImportedIds)));
    } catch {}
  },

  _selectedSpoolmanObject() {
    const sid = parseInt(this._spoolmanSelectedId, 10);
    if (!sid) return null;
    return (this._spoolmanSpools || []).find(s => parseInt(s.id, 10) === sid) || null;
  },

  _updateSpoolmanImportActions() {
    const hint = document.getElementById('spoolmanImportHint');
    const nowBtn = document.getElementById('spoolmanImportNowBtn');
    const clrBtn = document.getElementById('spoolmanImportClearBtn');
    const spool = this._selectedSpoolmanObject();
    const hasSelection = !!spool;
    if (nowBtn) nowBtn.disabled = !hasSelection;
    if (clrBtn) clrBtn.disabled = !hasSelection;
    if (!hint) return;
    if (!hasSelection) {
      hint.textContent = 'Spule auswählen, dann „Jetzt importieren“.';
      return;
    }
    const f = spool.filament || {};
    const v = f.vendor || {};
    const name = [v.name, f.name].filter(Boolean).join(' – ') || `Spool #${spool.id}`;
    hint.textContent = `Ausgewählt: ${name}`;
  },

  selectSpoolmanSpoolSettings(spoolId) {
    const sid = parseInt(spoolId, 10);
    if (!sid) return;
    if (this._isSpoolmanImported(sid)) return;
    this._spoolmanSelectedId = sid;
    this.filterSpoolmanSpoolsSettings();
    this._updateSpoolmanImportActions();
  },

  clearSpoolmanSelectionSettings() {
    this._spoolmanSelectedId = null;
    this.filterSpoolmanSpoolsSettings();
    this._updateSpoolmanImportActions();
  },

  importSelectedSpoolmanSettings() {
    const spool = this._selectedSpoolmanObject();
    if (!spool) return;
    if (this._isSpoolmanImported(spool.id)) {
      this.showMobileToast && this.showMobileToast('Diese Spule wurde bereits importiert.', 'warning');
      return;
    }
    this.importFromSpoolman(spool);
    this._markSpoolmanImported(spool.id);
    this._spoolmanSelectedId = null;
    this._updateSpoolmanImportActions();
    this.filterSpoolmanSpoolsSettings();
  },

  // =====================
  //  Bulk-Import all Spoolman spools
  // =====================
  async importAllSpoolmanSpools() {
    const spools = this._spoolmanSpools;
    if (!spools || !spools.length) {
      this.showMobileToast('Zuerst Spulen laden.', 'warning');
      return;
    }
    const btn = document.getElementById('spoolmanImportAllBtn');
    const statusEl = document.getElementById('spoolmanImportAllStatus');
    if (btn) btn.disabled = true;
    if (statusEl) { statusEl.textContent = '⏳ Importiere…'; statusEl.style.cssText = 'font-size:0.85rem;color:var(--text-secondary);'; }
    let imported = 0;
    let skipped = 0;
    for (const spool of spools) {
      if (this._isSpoolmanImported(spool.id)) { skipped++; continue; }
      this.importFromSpoolman(spool);
      this._markSpoolmanImported(spool.id);
      imported++;
      if (statusEl) statusEl.textContent = `⏳ ${imported} importiert…`;
      await new Promise(r => setTimeout(r, 30));
    }
    if (btn) btn.disabled = false;
    const msg = `✅ ${imported} Spule(n) importiert${skipped ? `, ${skipped} bereits vorhanden` : ''}.`;
    if (statusEl) {
      statusEl.textContent = msg;
      statusEl.style.cssText = 'font-size:0.85rem;font-weight:600;color:var(--success,#26de81);background:rgba(38,222,129,0.12);padding:0.3rem 0.7rem;border-radius:8px;';
      setTimeout(() => {
        if (statusEl) { statusEl.textContent = ''; statusEl.style.cssText = 'font-size:0.8rem;color:var(--text-secondary);'; }
      }, 6000);
    }
    this.showMobileToast(msg, 'success');
    this._updateSpoolmanImportActions();
    this.filterSpoolmanSpoolsSettings();
  },

  // =====================
  //  My Spoolman Section
  // =====================
  _mySpoolmanSpools: [],
  _mySpoolmanEditSpool: null,

  async loadMySpoolman() {
    const listEl = document.getElementById('mySpoolmanList');
    const statusEl = document.getElementById('mySpoolmanStatus');
    const countEl = document.getElementById('mySpoolmanCount');

    const url = this._normalizeSpoolmanUrl(this.spoolmanUrl);
    if (!url) {
      if (listEl) listEl.innerHTML = `<div style="text-align:center;padding:2rem 1rem;">
        <div style="font-size:2rem;margin-bottom:0.75rem;">🧵</div>
        <p style="color:var(--text-secondary);margin-bottom:1rem;">Keine Spoolman-URL konfiguriert.</p>
        <button class="btn-primary" onclick="app.setMode('settings')" style="width:auto;">⚙️ Spoolman URL einrichten</button>
      </div>`;
      if (countEl) countEl.textContent = '';
      return;
    }

    if (listEl) listEl.innerHTML = '<p style="color:var(--text-secondary);">⏳ Lade Spulen…</p>';
    if (statusEl) { statusEl.textContent = ''; statusEl.className = 'status-message'; }
    if (countEl) countEl.textContent = '';

    try {
      const resp = await fetch(`${url}/api/v1/spool?allow_archived=false`, { signal: AbortSignal.timeout(10000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const spools = await resp.json();
      this._mySpoolmanSpools = Array.isArray(spools) ? spools : [];

      const matSel = document.getElementById('mySpoolmanMaterialFilter');
      if (matSel) {
        const mats = [...new Set(this._mySpoolmanSpools.map(s => (s.filament || {}).material).filter(Boolean))].sort();
        matSel.innerHTML = '<option value="">Alle Materialien</option>' +
          mats.map(m => `<option value="${m}">${m}</option>`).join('');
      }

      if (countEl) countEl.textContent = `${this._mySpoolmanSpools.length} Spule(n) in Spoolman`;
      this.renderMySpoolman(this._mySpoolmanSpools);
    } catch (e) {
      const isBlocked = e.message === 'Failed to fetch' || e.name === 'TypeError';
      if (listEl) listEl.innerHTML = `<div style="text-align:center;padding:1.5rem 1rem;">
        <p style="color:var(--error);margin-bottom:0.5rem;">⚠️ Fehler: ${e.message}</p>
        ${isBlocked ? `<p style="color:var(--text-secondary);font-size:0.82rem;">Mögliche Ursache: Mixed Content (HTTPS → HTTP) oder Spoolman nicht erreichbar.<br>Prüfe die Spoolman-URL in den Einstellungen.</p>` : ''}
        <button class="btn-secondary" onclick="app.loadMySpoolman()" style="width:auto;margin-top:0.75rem;">🔄 Erneut versuchen</button>
      </div>`;
    }
  },

  filterMySpoolman() {
    const q = (document.getElementById('mySpoolmanSearch').value || '').toLowerCase().trim();
    const mat = (document.getElementById('mySpoolmanMaterialFilter').value || '').toLowerCase();
    const filtered = this._mySpoolmanSpools.filter(spool => {
      const f = spool.filament || {};
      const v = f.vendor || {};
      if (mat && (f.material || '').toLowerCase() !== mat) return false;
      if (!q) return true;
      return [v.name, f.name, f.material, spool.id, spool.lot_nr, f.color_hex, spool.comment]
        .filter(Boolean).join(' ').toLowerCase().includes(q);
    });
    this.renderMySpoolman(filtered);
  },

  renderMySpoolman(spools) {
    const listEl = document.getElementById('mySpoolmanList');
    if (!listEl) return;
    if (!spools || !spools.length) {
      listEl.innerHTML = '<p style="color:var(--text-secondary);text-align:center;padding:1.5rem 0;">Keine Spulen gefunden.</p>';
      return;
    }
    listEl.innerHTML = spools.map(spool => {
      const f = spool.filament || {};
      const v = f.vendor || {};
      const color = (f.color_hex || 'CCCCCC').replace('#', '');
      const name = [v.name, f.name].filter(Boolean).join(' – ') || `Spool #${spool.id}`;
      const mat = f.material || '';
      const rem = spool.remaining_weight != null ? `${Math.round(spool.remaining_weight)}g` : '—';
      const comment = spool.comment ? `<div style="font-size:0.75rem;color:var(--text-secondary);margin-top:0.2rem;font-style:italic;">${spool.comment}</div>` : '';
      const lot = spool.lot_nr ? `<span style="font-size:0.7rem;background:var(--bg-secondary);border-radius:4px;padding:0.1rem 0.35rem;">Lot: ${spool.lot_nr}</span>` : '';
      const archived = spool.archived ? `<span style="font-size:0.7rem;background:#ff6b6b22;color:#ff6b6b;border-radius:4px;padding:0.1rem 0.35rem;">archiviert</span>` : '';
      return `<div style="display:flex;align-items:flex-start;gap:0.75rem;padding:0.85rem 0.9rem;background:var(--bg-secondary);border-radius:12px;margin-bottom:0.5rem;border:1px solid var(--border);">
        <div style="width:36px;height:36px;border-radius:50%;background:#${color};flex-shrink:0;border:2px solid rgba(255,255,255,0.15);margin-top:0.1rem;"></div>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;font-size:0.9rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${name}</div>
          <div style="font-size:0.78rem;color:var(--text-secondary);margin-top:0.15rem;display:flex;gap:0.4rem;flex-wrap:wrap;align-items:center;">
            <span>${mat}</span>
            <span>·</span>
            <span>🧵 ${rem}</span>
            ${lot}${archived}
          </div>
          ${comment}
        </div>
        <div style="display:flex;flex-direction:column;gap:0.35rem;flex-shrink:0;">
          <button class="btn-primary" onclick="app.importFromSpoolman(${JSON.stringify(spool).replace(/"/g,'&quot;')})" style="width:auto;padding:0.3rem 0.6rem;font-size:0.75rem;">→ Tag</button>
          <button class="btn-secondary" onclick="app.openMySpoolmanEdit(${spool.id})" style="width:auto;padding:0.3rem 0.6rem;font-size:0.75rem;">✏️</button>
        </div>
      </div>`;
    }).join('');
  },

  openMySpoolmanEdit(spoolId) {
    const spool = this._mySpoolmanSpools.find(s => parseInt(s.id, 10) === parseInt(spoolId, 10));
    if (!spool) return;
    this._mySpoolmanEditSpool = spool;
    const f = spool.filament || {};
    const v = f.vendor || {};
    const name = [v.name, f.name].filter(Boolean).join(' – ') || `Spool #${spool.id}`;
    const fieldsEl = document.getElementById('mySpoolmanEditFields');
    if (!fieldsEl) return;
    fieldsEl.innerHTML = `
      <p style="color:var(--text-secondary);font-size:0.85rem;margin-bottom:0.75rem;">${name}</p>
      <div class="form-group">
        <label>Verbleibendes Gewicht (g)</label>
        <input type="number" id="editSpoolWeight" value="${spool.remaining_weight != null ? Math.round(spool.remaining_weight) : ''}" min="0" step="1">
      </div>
      <div class="form-group">
        <label>Lot-Nummer</label>
        <input type="text" id="editSpoolLot" value="${spool.lot_nr || ''}">
      </div>
      <div class="form-group">
        <label>Kommentar / Beschreibung</label>
        <textarea id="editSpoolComment" rows="3" style="width:100%;resize:vertical;">${spool.comment || ''}</textarea>
      </div>
    `;
    const overlay = document.getElementById('mySpoolmanEditOverlay');
    if (overlay) overlay.classList.remove('hidden');
    const statusEl = document.getElementById('mySpoolmanEditStatus');
    if (statusEl) { statusEl.textContent = ''; statusEl.className = 'status-message'; }
  },

  closeMySpoolmanEdit() {
    const overlay = document.getElementById('mySpoolmanEditOverlay');
    if (overlay) overlay.classList.add('hidden');
    this._mySpoolmanEditSpool = null;
  },

  async saveMySpoolmanEdit() {
    const spool = this._mySpoolmanEditSpool;
    if (!spool) return;
    const url = this._normalizeSpoolmanUrl(this.spoolmanUrl);
    if (!url) return;
    const weight = parseFloat(document.getElementById('editSpoolWeight').value);
    const lot = document.getElementById('editSpoolLot').value.trim();
    const comment = document.getElementById('editSpoolComment').value.trim();
    const statusEl = document.getElementById('mySpoolmanEditStatus');
    if (statusEl) { statusEl.textContent = 'Speichern…'; statusEl.className = 'status-message warning'; }
    try {
      const body = {};
      if (!isNaN(weight)) body.remaining_weight = weight;
      if (lot !== undefined) body.lot_nr = lot || null;
      if (comment !== undefined) body.comment = comment || null;
      const resp = await fetch(`${url}/api/v1/spool/${spool.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000)
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      if (statusEl) { statusEl.textContent = '✅ Gespeichert!'; statusEl.className = 'status-message success'; }
      this.showMobileToast('Spule gespeichert', 'success');
      setTimeout(() => {
        this.closeMySpoolmanEdit();
        this.loadMySpoolman();
      }, 800);
    } catch (e) {
      if (statusEl) { statusEl.textContent = `Fehler: ${e.message}`; statusEl.className = 'status-message error'; }
    }
  },

  // =====================
  //  Settings Section
  // =====================
  switchSettingsTab(tab) {
    document.querySelectorAll('.settings-tab-btn').forEach(btn => {
      const isActive = btn.dataset.stab === tab;
      btn.style.borderBottomColor = isActive ? 'var(--accent)' : 'transparent';
      btn.style.color = isActive ? 'var(--accent)' : 'var(--text-secondary)';
      btn.style.fontWeight = isActive ? '700' : '600';
    });
    const spoolTab = document.getElementById('stab-spoolman');
    const backupTab = document.getElementById('stab-backup');
    if (spoolTab) spoolTab.style.display = tab === 'spoolman' ? 'block' : 'none';
    if (backupTab) backupTab.style.display = tab === 'backup' ? 'block' : 'none';

    if (tab === 'spoolman') {
      const inp = document.getElementById('spoolmanUrlSettings');
      if (inp) inp.value = this.spoolmanUrl || '';
      if (this.spoolmanUrl) this.loadSpoolmanSpoolsSettings();
    } else if (tab === 'backup') {
      this._loadBackupListSettings();
    }
  },

  async testSpoolmanSettings() {
    const url = this._normalizeSpoolmanUrl(document.getElementById('spoolmanUrlSettings').value);
    if (!url) { this.showStatus('spoolmanSettingsTestStatus', 'error', t('spoolman.errorNoUrl') || 'Bitte URL eingeben'); return; }
    this.showStatus('spoolmanSettingsTestStatus', 'warning', t('spoolman.connecting') || 'Verbinde...');
    // Direct browser fetch – Spoolman runs locally at the user's side
    try {
      const resp = await fetch(`${url}/api/v1/info`, { signal: AbortSignal.timeout(6000) });
      if (resp.ok) {
        const info = await resp.json();
        this.showStatus('spoolmanSettingsTestStatus', 'success',
          `✅ ${t('spoolman.connected') || 'Verbunden!'} Spoolman v${info.version || '?'}`);
        return;
      }
      this.showStatus('spoolmanSettingsTestStatus', 'error', `HTTP ${resp.status}`);
    } catch (e) {
      // Mixed Content: app is HTTPS, Spoolman is HTTP → browser blocks it
      const isMixedContent = location.protocol === 'https:' && url.startsWith('http:');
      if (isMixedContent) {
        this.showStatus('spoolmanSettingsTestStatus', 'warning',
          t('spoolman.mixedContentWarning') ||
          '⚠️ Die App läuft über HTTPS, Spoolman über HTTP. Bitte Spoolman über HTTPS erreichbar machen oder die App lokal (http://) öffnen.');
      } else if (e.name === 'TimeoutError' || e.name === 'AbortError') {
        this.showStatus('spoolmanSettingsTestStatus', 'error',
          t('spoolman.errorTimeout') || 'Timeout – Spoolman antwortet nicht');
      } else {
        this.showStatus('spoolmanSettingsTestStatus', 'error',
          t('spoolman.errorConnectionRefused') || 'Spoolman nicht erreichbar – IP/Port prüfen');
      }
    }
  },

  async saveSpoolmanUrlSettings() {
    const url = this._normalizeSpoolmanUrl(document.getElementById('spoolmanUrlSettings').value);
    if (!url) { this.showMobileToast('Bitte gültige URL eingeben', 'error'); return; }
    this.spoolmanUrl = url;
    localStorage.setItem('spoolmanUrl', url);
    if (Auth && Auth.isLoggedIn()) {
      const loc = window.location;
      try {
        await Auth.fetch(`${loc.protocol}//${loc.host}/api/user/settings`, {
          method: 'PUT',
          body: JSON.stringify({
            spoolmanUrl: url,
            theme: document.documentElement.getAttribute('data-theme') || 'dark',
            language: typeof I18n !== 'undefined' ? (I18n.getLanguage ? I18n.getLanguage() : 'de') : 'de'
          })
        });
      } catch (e) {}
    }
    this.updateSpoolmanLink();
    this.showMobileToast('Spoolman URL gespeichert', 'success');
    this.showStatus('spoolmanSettingsTestStatus', 'success', '✅ URL gespeichert!');
    if (this.spoolmanUrl) this.loadSpoolmanSpoolsSettings();
  },

  async loadSpoolmanSpoolsSettings() {
    const url = this._normalizeSpoolmanUrl(this.spoolmanUrl);
    if (!url) return;
    const listEl = document.getElementById('spoolmanSpoolListSettings');
    const statusEl = document.getElementById('spoolmanSettingsStatus');
    if (listEl) listEl.innerHTML = '<p style="color:var(--text-secondary);">Lade Spulen...</p>';
    if (statusEl) { statusEl.textContent = ''; statusEl.className = 'status-message'; }
    try {
      const resp = await fetch(`${url}/api/v1/spool?allow_archived=false`, { signal: AbortSignal.timeout(8000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const spools = await resp.json();
      this._spoolmanSpools = spools;
      this._updateSpoolmanImportActions();
      this._renderSpoolmanListSettings(spools);
    } catch (e) {
      if (statusEl) this.showStatus('spoolmanSettingsStatus', 'error', `Fehler: ${e.message}`);
      if (listEl) listEl.innerHTML = '';
    }
  },

  filterSpoolmanSpoolsSettings() {
    const q = (document.getElementById('spoolmanSearchSettings').value || '').toLowerCase().trim();
    const filtered = !q ? this._spoolmanSpools : this._spoolmanSpools.filter(spool => {
      const f = spool.filament || {};
      const v = f.vendor || {};
      return [v.name, f.name, f.material, spool.id, spool.lot_nr, f.color_hex]
        .filter(Boolean).join(' ').toLowerCase().includes(q);
    });
    this._renderSpoolmanListSettings(filtered);
  },

  _renderSpoolmanListSettings(spools) {
    const listEl = document.getElementById('spoolmanSpoolListSettings');
    if (!listEl) return;
    if (!spools || !spools.length) {
      listEl.innerHTML = '<p style="color:var(--text-secondary);">Keine Spulen gefunden.</p>';
      return;
    }
    listEl.innerHTML = spools.map(spool => {
      const f = spool.filament || {};
      const v = f.vendor || {};
      const color = (f.color_hex || 'CCCCCC').replace('#', '');
      const name = [v.name, f.name].filter(Boolean).join(' – ') || `Spool #${spool.id}`;
      const mat = f.material || '';
      const rem = spool.remaining_weight != null ? `${Math.round(spool.remaining_weight)}g` : '—';
      const imported = this._isSpoolmanImported(spool.id);
      const selected = !imported && this._spoolmanSelectedId && parseInt(this._spoolmanSelectedId, 10) === parseInt(spool.id, 10);
      const cls = [
        'spool-import-row',
        imported ? 'is-imported' : '',
        selected ? 'is-selected' : ''
      ].filter(Boolean).join(' ');
      const badge = imported
        ? `<span class="spool-import-badge ok">✓ importiert</span>`
        : (selected ? `<span class="spool-import-badge sel">ausgewählt</span>` : `<span class="spool-import-badge">antippen</span>`);
      return `<div class="${cls}" data-spool-id="${spool.id}">
        <div style="width:14px;height:14px;border-radius:50%;background:#${color};flex-shrink:0;border:1px solid rgba(255,255,255,0.2);"></div>
        <div style="flex:1;min-width:0;">
          <div style="font-size:0.85rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${name}</div>
          <div style="font-size:0.75rem;color:var(--text-secondary);">${mat} · Verbleibend: ${rem}</div>
        </div>
        <div class="spool-import-right">${badge}</div>
      </div>`;
    }).join('');
  },

  async importUserDataSettings(ev) {
    const file = ev.target.files[0];
    if (!file) return;
    const text = await file.text();
    const fakeEv = { target: { files: [{ text: () => Promise.resolve(text) }] } };
    try {
      const data = JSON.parse(text);
      const loc = window.location;
      const apiBase = `${loc.protocol}//${loc.host}/api`;
      const resp = await Auth.fetch(`${apiBase}/user/import`, {
        method: 'POST',
        body: JSON.stringify(data)
      });
      if (resp.ok) {
        this.showMobileToast('Backup wiederhergestellt!', 'success');
        this.showStatus('backupSettingsStatus', 'success', '✅ Backup wiederhergestellt!');
        if (data.spoolmanUrl) { this.spoolmanUrl = data.spoolmanUrl; this.updateSpoolmanLink(); }
        if (data.theme) { document.documentElement.setAttribute('data-theme', data.theme); localStorage.setItem('theme', data.theme); this.loadTheme(); }
        if (data.language && typeof I18n !== 'undefined' && I18n.setLanguage) I18n.setLanguage(data.language);
      } else {
        this.showStatus('backupSettingsStatus', 'error', 'Fehler beim Wiederherstellen');
      }
    } catch (e) {
      this.showStatus('backupSettingsStatus', 'error', 'Ungültige JSON-Datei: ' + e.message);
    }
  },

  async _loadBackupListSettings() {
    const listEl = document.getElementById('backupListSettings');
    if (!listEl) return;
    if (!Auth || !Auth.isLoggedIn()) {
      listEl.innerHTML = '<p style="color:var(--text-secondary);">Nicht angemeldet.</p>';
      return;
    }
    listEl.innerHTML = '<p style="color:var(--text-secondary);">Lade Backups...</p>';
    const loc = window.location;
    const apiBase = `${loc.protocol}//${loc.host}/api`;
    try {
      const resp = await Auth.fetch(`${apiBase}/user/backups`);
      const data = await resp.json();
      const backups = data.backups || [];
      if (!backups.length) { listEl.innerHTML = '<p style="color:var(--text-secondary);">Keine Backups vorhanden.</p>'; return; }
      listEl.innerHTML = backups.map(b => {
        const d = new Date(b.createdAt + 'Z').toLocaleString('de-CH', { dateStyle: 'short', timeStyle: 'short' });
        return `<div style="display:flex;justify-content:space-between;align-items:center;padding:0.4rem 0;border-bottom:1px solid var(--border);font-size:0.85rem;">
          <span style="color:var(--text-secondary);">${d}</span>
          <span class="badge badge-ok" style="font-size:0.72rem;">✓ Gespeichert</span>
        </div>`;
      }).join('');
    } catch (e) {
      listEl.innerHTML = `<p style="color:var(--error);">Fehler: ${e.message}</p>`;
    }
  },

  // =====================
  //  Profile dropdown
  // =====================
  _profileDropOpen: false,

  _updateProfileUI() {
    const user = this._user;
    const wrap = document.getElementById('profileMenuWrap');
    const logoutBtn = document.getElementById('logoutBtn');
    if (!user) {
      if (wrap) wrap.style.display = 'none';
      if (logoutBtn) logoutBtn.style.display = 'inline-block';
      return;
    }
    if (wrap) wrap.style.display = 'inline-flex';
    if (logoutBtn) logoutBtn.style.display = 'none';
    const initials = document.getElementById('profileAvatarInitials');
    if (initials) {
      const fi = (user.firstName || '')[0] || '';
      const li = (user.lastName || '')[0] || '';
      initials.textContent = fi && li ? (fi + li).toUpperCase() : (user.email || '?')[0].toUpperCase();
    }
    const emailEl = document.getElementById('profileDropEmail');
    if (emailEl) {
      const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ');
      emailEl.innerHTML = fullName
        ? `<strong style="display:block;color:var(--text-primary)">${fullName}</strong>${user.email || ''}`
        : (user.email || '');
    }
    const adminBtn = document.getElementById('adminPanelBtn');
    if (adminBtn) {
      const perms = Array.isArray(user.permissions) ? user.permissions : [];
      const canSeeAdmin = !!user.isAdmin || perms.some(p => String(p || '').startsWith('admin.'));
      adminBtn.style.display = canSeeAdmin ? 'block' : 'none';
    }
  },

  _toggleProfileDrop() {
    const drop = document.getElementById('profileDropdown');
    if (!drop) return;
    this._profileDropOpen = !this._profileDropOpen;
    drop.style.display = this._profileDropOpen ? 'block' : 'none';
  },

  _closeProfileDrop() {
    const drop = document.getElementById('profileDropdown');
    if (drop) drop.style.display = 'none';
    this._profileDropOpen = false;
  },

  // =====================
  //  Profile modal
  // =====================
  openProfileModal() {
    this._closeProfileDrop();
    const overlay = document.getElementById('profileModalOverlay');
    if (!overlay) return;
    const u = this._user || {};
    document.getElementById('profileModalEmail').textContent = u.email || '';
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
    set('profileFirstName', u.firstName);
    set('profileLastName', u.lastName);
    set('profileUsername', u.username);
    set('profileBirthDate', u.birthDate);
    set('profileAddress', u.address);
    set('profileCurrentPw', '');
    set('profileNewEmail', '');
    set('profileNewPw', '');
    // Theme-Selector vorausfüllen
    const currentTheme = (u.settings && u.settings.theme) || localStorage.getItem('theme') || 'dark';
    this._selectProfileTheme(currentTheme, true);
    const st = document.getElementById('profileModalStatus');
    if (st) { st.textContent = ''; st.className = 'status-message'; }
    overlay.classList.remove('hidden');
  },

  _selectProfileTheme(theme, noPreview) {
    const hidden = document.getElementById('profileThemeValue');
    if (hidden) hidden.value = theme;
    const dark = document.getElementById('themeOptDark');
    const light = document.getElementById('themeOptLight');
    if (dark) {
      dark.style.borderColor = theme === 'dark' ? 'var(--accent)' : 'var(--border)';
      dark.style.background = theme === 'dark' ? 'rgba(0,212,170,0.12)' : 'var(--bg-tertiary)';
    }
    if (light) {
      light.style.borderColor = theme === 'light' ? 'var(--accent)' : 'var(--border)';
      light.style.background = theme === 'light' ? 'rgba(0,212,170,0.12)' : 'var(--bg-tertiary)';
    }
    if (!noPreview) {
      document.documentElement.setAttribute('data-theme', theme);
      const tog = document.getElementById('themeToggle');
      if (tog) tog.textContent = theme === 'dark' ? '☀️' : '🌙';
    }
  },

  closeProfileModal() {
    const overlay = document.getElementById('profileModalOverlay');
    if (overlay) overlay.classList.add('hidden');
  },

  async submitProfileUpdate() {
    const st = document.getElementById('profileModalStatus');
    const _st = (msg, cls) => {
      if (!st) return;
      st.textContent = msg;
      st.className = 'status-message' + (cls ? ' ' + cls : '');
      st.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    };

    const firstName = (document.getElementById('profileFirstName')?.value || '').trim();
    const lastName = (document.getElementById('profileLastName')?.value || '').trim();
    const username = (document.getElementById('profileUsername')?.value || '').trim();
    const birthDate = (document.getElementById('profileBirthDate')?.value || '').trim();
    const address = (document.getElementById('profileAddress')?.value || '').trim();
    const currentPw = (document.getElementById('profileCurrentPw')?.value || '');
    const newEmail = (document.getElementById('profileNewEmail')?.value || '').trim();
    const newPw = (document.getElementById('profileNewPw')?.value || '');

    if ((newEmail || newPw) && !currentPw) {
      _st('⚠️ Für E-Mail- oder Passwort-Änderung ist das aktuelle Passwort erforderlich.', 'error');
      return;
    }
    _st('⏳ Wird gespeichert…', '');

    const selectedTheme = document.getElementById('profileThemeValue')?.value || 'dark';
    const apiBase = `${location.protocol}//${location.host}/api`;
    try {
      const body = { firstName, lastName, birthDate, address, username };
      if (currentPw) body.currentPassword = currentPw;
      if (newEmail) body.email = newEmail;
      if (newPw) body.password = newPw;

      const resp = await Auth.fetch(`${apiBase}/user/profile`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        _st('❌ ' + (data.message || `Fehler beim Speichern (HTTP ${resp.status})`), 'error');
        return;
      }
      if (this._user) {
        if (data.email) this._user.email = data.email;
        if (data.username !== undefined) this._user.username = data.username;
        if (data.firstName !== undefined) this._user.firstName = data.firstName;
        if (data.lastName !== undefined) this._user.lastName = data.lastName;
        if (data.birthDate !== undefined) this._user.birthDate = data.birthDate;
        if (data.address !== undefined) this._user.address = data.address;
      }
      // Theme sofort anwenden + per Settings-API persistieren
      document.documentElement.setAttribute('data-theme', selectedTheme);
      localStorage.setItem('theme', selectedTheme);
      const tog = document.getElementById('themeToggle');
      if (tog) tog.textContent = selectedTheme === 'dark' ? '☀️' : '🌙';
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.content = selectedTheme === 'dark' ? '#0b1120' : '#f0f4f8';
      if (this._user) {
        if (!this._user.settings) this._user.settings = {};
        this._user.settings.theme = selectedTheme;
      }
      Auth.fetch(`${apiBase}/user/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          spoolmanUrl: this.spoolmanUrl || '',
          theme: selectedTheme,
          language: (this._user && this._user.settings && this._user.settings.language) || 'de'
        })
      }).catch(() => {});
      this._updateProfileUI();
      if (newPw) {
        _st('✅ Gespeichert – du wirst neu angemeldet…', 'success');
        setTimeout(() => { Auth.clearToken(); location.reload(); }, 1500);
      } else {
        this.closeProfileModal();
        this.showMobileToast('✅ Profil gespeichert', 'success');
      }
    } catch (e) {
      _st('❌ Netzwerkfehler: ' + (e && e.message ? e.message : String(e)), 'error');
    }
  },

  // =====================
  //  Admin Panel
  // =====================
  _adminTab: 'users',
  _adminGroups: null,

  _adminPerms() {
    const u = this._user || {};
    return Array.isArray(u.permissions) ? u.permissions : [];
  },

  _adminCan(tab) {
    const u = this._user || {};
    if (tab === 'chat') return !!u.isAdmin; // chat: only full admins
    if (u.isAdmin) return true;
    const need = {
      users: 'admin.users',
      status: 'admin.status',
      backups: 'admin.backups',
      errors: 'admin.errors',
      groups: 'admin.groups',
    }[tab];
    if (!need) return false;
    return this._adminPerms().includes(need);
  },

  _adminApplyTabVisibility() {
    document.querySelectorAll('.admin-tab-btn').forEach(b => {
      const tab = b.dataset.tab;
      b.style.display = this._adminCan(tab) ? '' : 'none';
    });
  },

  _adminFirstAllowedTab() {
    const order = ['users', 'status', 'backups', 'errors', 'groups', 'chat'];
    for (const t of order) if (this._adminCan(t)) return t;
    return null;
  },

  openAdminPanel() {
    this._closeProfileDrop();
    const overlay = document.getElementById('adminPanelOverlay');
    if (!overlay) return;
    overlay.classList.remove('hidden');
    this._adminApplyTabVisibility();
    const first = this._adminFirstAllowedTab();
    if (!first) {
      // Fallback: show users tab (will likely show forbidden message from API)
      this.switchAdminTab('users');
    } else {
      this.switchAdminTab(first);
    }
  },

  closeAdminPanel() {
    const overlay = document.getElementById('adminPanelOverlay');
    if (overlay) overlay.classList.add('hidden');
  },

  switchAdminTab(tab) {
    if (!this._adminCan(tab)) {
      const first = this._adminFirstAllowedTab();
      if (!first) return;
      tab = first;
    }
    this._adminTab = tab;
    document.querySelectorAll('.admin-tab-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === tab);
    });
    document.querySelectorAll('.admin-tab-panel').forEach(p => {
      p.classList.toggle('active', p.id === `adminTab-${tab}`);
    });
    if (tab === 'users') this.adminLoadUsers();
    else if (tab === 'status') this.adminLoadStatus();
    else if (tab === 'backups') this.adminLoadBackups();
    else if (tab === 'errors') this.adminLoadErrors();
    else if (tab === 'groups') this.adminLoadGroups();
    else if (tab === 'chat') this.chatInit();
  },

  _adminFmt(ts) {
    if (!ts) return '—';
    return new Date(ts + 'Z').toLocaleString('de-CH', { dateStyle: 'short', timeStyle: 'short' });
  },

  // =====================
  //  Admin: KI-Chat
  // =====================
  _chatConvId: null,
  _chatSending: false,

  async chatInit() {
    await this.chatLoadConversations();
    await this.chatCheckKey();
  },

  async chatCheckKey() {
    const apiBase = `${location.protocol}//${location.host}/api`;
    const el = document.getElementById('chatKeyStatus');
    try {
      const resp = await Auth.fetch(`${apiBase}/admin/chat/key`);
      const data = await resp.json();
      if (el) {
        if (data.has_key) {
          el.innerHTML = `<span style="color:var(--success,#26de81);">✅ Key gesetzt (${data.masked})</span>`;
        } else {
          el.innerHTML = `<span style="color:var(--warning,#f7b731);">⚠️ Kein Key – bitte eintragen</span>`;
        }
      }
    } catch (e) {
      if (el) el.textContent = 'Fehler beim Laden';
    }
  },

  async chatSaveKey() {
    const input = document.getElementById('chatKeyInput');
    const key = (input ? input.value : '').trim();
    if (!key) return;
    const apiBase = `${location.protocol}//${location.host}/api`;
    try {
      const resp = await Auth.fetch(`${apiBase}/admin/chat/key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: key })
      });
      const data = await resp.json();
      if (!resp.ok) { this.showMobileToast(data.error || 'Fehler', 'error'); return; }
      if (input) input.value = '';
      this.showMobileToast('API-Key gespeichert ✅', 'success');
      await this.chatCheckKey();
    } catch (e) {
      this.showMobileToast('Fehler: ' + e.message, 'error');
    }
  },

  async chatLoadConversations() {
    const apiBase = `${location.protocol}//${location.host}/api`;
    const list = document.getElementById('chatConvList');
    if (!list) return;
    try {
      const resp = await Auth.fetch(`${apiBase}/admin/chat/conversations`);
      const data = await resp.json();
      const convs = data.conversations || [];
      if (!convs.length) {
        list.innerHTML = '<div style="padding:0.75rem;font-size:0.78rem;color:var(--text-secondary);text-align:center;">Noch keine Gespräche</div>';
        return;
      }
      list.innerHTML = convs.map(c => {
        const active = c.id === this._chatConvId;
        return `<div onclick="app.chatLoadConversation(${c.id})"
          style="padding:0.55rem 0.75rem;cursor:pointer;border-radius:8px;margin:0.15rem 0.4rem;
                 font-size:0.8rem;line-height:1.3;transition:background .12s;
                 background:${active ? 'var(--accent)' : 'transparent'};
                 color:${active ? '#fff' : 'var(--text-primary)'};"
          onmouseover="if(${!active})this.style.background='var(--bg-tertiary)'"
          onmouseout="if(${!active})this.style.background='transparent'">
          <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${this._escHtml(c.title)}</div>
          <div style="font-size:0.7rem;opacity:0.6;margin-top:0.1rem;">${c.msg_count} Nachrichten</div>
        </div>`;
      }).join('');
    } catch (e) {
      if (list) list.innerHTML = `<div style="padding:0.75rem;font-size:0.78rem;color:var(--error);">Fehler: ${e.message}</div>`;
    }
  },

  async chatLoadConversation(cid) {
    const apiBase = `${location.protocol}//${location.host}/api`;
    this._chatConvId = cid;
    const messagesEl = document.getElementById('chatMessages');
    const titleEl = document.getElementById('chatTitle');
    const exportBtn = document.getElementById('chatExportBtn');
    const deleteBtn = document.getElementById('chatDeleteBtn');
    if (messagesEl) messagesEl.innerHTML = '<div style="text-align:center;color:var(--text-secondary);padding:1rem;">Lade…</div>';
    try {
      const resp = await Auth.fetch(`${apiBase}/admin/chat/conversations/${cid}`);
      const data = await resp.json();
      if (!resp.ok) { this.showMobileToast(data.error || 'Fehler', 'error'); return; }
      if (titleEl) titleEl.textContent = data.conversation.title;
      if (exportBtn) exportBtn.style.display = '';
      if (deleteBtn) deleteBtn.style.display = '';
      this._chatRenderMessages(data.messages || []);
      await this.chatLoadConversations();
    } catch (e) {
      this.showMobileToast('Fehler: ' + e.message, 'error');
    }
  },

  _chatRenderMessages(messages) {
    const el = document.getElementById('chatMessages');
    if (!el) return;
    if (!messages.length) {
      el.innerHTML = '<div style="text-align:center;color:var(--text-secondary);font-size:0.85rem;margin-top:2rem;">Noch keine Nachrichten in diesem Gespräch.</div>';
      return;
    }
    el.innerHTML = messages.map(m => {
      const isUser = m.role === 'user';
      const content = this._chatFormatContent(m.content);
      return `<div style="display:flex;flex-direction:column;align-items:${isUser ? 'flex-end' : 'flex-start'};">
        <div style="max-width:85%;padding:0.6rem 0.9rem;border-radius:${isUser ? '14px 14px 4px 14px' : '14px 14px 14px 4px'};
                    background:${isUser ? 'var(--accent)' : 'var(--bg-tertiary)'};
                    color:${isUser ? '#fff' : 'var(--text-primary)'};
                    font-size:0.88rem;line-height:1.55;word-break:break-word;">
          ${content}
        </div>
        <div style="font-size:0.68rem;color:var(--text-secondary);margin-top:0.2rem;padding:0 0.3rem;">
          ${isUser ? 'Du' : '🤖 KI'} · ${this._adminFmt(m.created_at)}
        </div>
      </div>`;
    }).join('');
    el.scrollTop = el.scrollHeight;
  },

  _chatFormatContent(text) {
    // Simple markdown: code blocks, bold, inline code
    let s = this._escHtml(text);
    s = s.replace(/```([\s\S]*?)```/g, '<pre style="background:var(--bg-secondary);padding:0.5rem 0.75rem;border-radius:8px;overflow-x:auto;font-size:0.8rem;margin:0.4rem 0;white-space:pre-wrap;">$1</pre>');
    s = s.replace(/`([^`]+)`/g, '<code style="background:var(--bg-secondary);padding:0.1rem 0.35rem;border-radius:4px;font-size:0.82rem;">$1</code>');
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\n/g, '<br>');
    return s;
  },

  _escHtml(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  },

  chatNewConversation() {
    this._chatConvId = null;
    const messagesEl = document.getElementById('chatMessages');
    const titleEl = document.getElementById('chatTitle');
    const exportBtn = document.getElementById('chatExportBtn');
    const deleteBtn = document.getElementById('chatDeleteBtn');
    if (titleEl) titleEl.textContent = 'Neues Gespräch';
    if (exportBtn) exportBtn.style.display = 'none';
    if (deleteBtn) deleteBtn.style.display = 'none';
    if (messagesEl) messagesEl.innerHTML = `<div style="text-align:center;color:var(--text-secondary);font-size:0.85rem;margin-top:2rem;">
      🤖 KI-Assistent für Spool Tag Propus<br>
      <span style="font-size:0.78rem;opacity:0.7;">Stelle Fragen zum Projekt, Code, Bugs oder Features.</span>
    </div>`;
    const input = document.getElementById('chatInput');
    if (input) input.focus();
  },

  chatInputKeydown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.chatSend();
    }
  },

  async chatSend() {
    if (this._chatSending) return;
    const input = document.getElementById('chatInput');
    const statusEl = document.getElementById('chatStatus');
    const sendBtn = document.getElementById('chatSendBtn');
    const message = (input ? input.value : '').trim();
    if (!message) return;

    this._chatSending = true;
    if (input) input.value = '';
    if (sendBtn) sendBtn.disabled = true;
    if (statusEl) statusEl.innerHTML = '<span style="color:var(--text-secondary);">⏳ KI denkt nach…</span>';

    // Optimistic: show user message immediately
    const messagesEl = document.getElementById('chatMessages');
    const tempId = 'chat-temp-' + Date.now();
    if (messagesEl) {
      const prev = messagesEl.querySelector('[data-welcome]');
      if (prev) prev.remove();
      const div = document.createElement('div');
      div.id = tempId;
      div.style.cssText = 'display:flex;flex-direction:column;align-items:flex-end;';
      div.innerHTML = `<div style="max-width:85%;padding:0.6rem 0.9rem;border-radius:14px 14px 4px 14px;
        background:var(--accent);color:#fff;font-size:0.88rem;line-height:1.55;word-break:break-word;">
        ${this._escHtml(message)}</div>
        <div style="font-size:0.68rem;color:var(--text-secondary);margin-top:0.2rem;padding:0 0.3rem;">Du · jetzt</div>`;
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    const apiBase = `${location.protocol}//${location.host}/api`;
    try {
      const resp = await Auth.fetch(`${apiBase}/admin/chat/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, conversation_id: this._chatConvId })
      });
      const data = await resp.json();
      if (!resp.ok) {
        if (statusEl) statusEl.innerHTML = `<span style="color:var(--error);">⚠️ ${this._escHtml(data.error || 'Fehler')}</span>`;
        const tmp = document.getElementById(tempId);
        if (tmp) tmp.remove();
        return;
      }
      this._chatConvId = data.conversation_id;
      if (statusEl) statusEl.textContent = '';
      // Reload full conversation to get proper timestamps
      await this.chatLoadConversation(this._chatConvId);
    } catch (e) {
      if (statusEl) statusEl.innerHTML = `<span style="color:var(--error);">⚠️ Netzwerkfehler: ${this._escHtml(e.message)}</span>`;
      const tmp = document.getElementById(tempId);
      if (tmp) tmp.remove();
    } finally {
      this._chatSending = false;
      if (sendBtn) sendBtn.disabled = false;
      if (input) input.focus();
    }
  },

  async chatExport() {
    if (!this._chatConvId) return;
    const apiBase = `${location.protocol}//${location.host}/api`;
    try {
      const resp = await Auth.fetch(`${apiBase}/admin/chat/conversations/${this._chatConvId}/export`);
      const data = await resp.json();
      if (!resp.ok) { this.showMobileToast(data.error || 'Fehler', 'error'); return; }
      // Download as .md file in browser
      const blob = new Blob([data.markdown], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `chat-${this._chatConvId}.md`;
      a.click();
      URL.revokeObjectURL(url);
      const saved = data.saved_path ? ` (auch gespeichert: ${data.saved_path})` : '';
      this.showMobileToast(`Exportiert${saved}`, 'success');
    } catch (e) {
      this.showMobileToast('Fehler: ' + e.message, 'error');
    }
  },

  async chatDeleteConversation() {
    if (!this._chatConvId) return;
    if (!confirm('Gespräch wirklich löschen?')) return;
    const apiBase = `${location.protocol}//${location.host}/api`;
    try {
      const resp = await Auth.fetch(`${apiBase}/admin/chat/conversations/${this._chatConvId}`, { method: 'DELETE' });
      if (!resp.ok) { this.showMobileToast('Fehler beim Löschen', 'error'); return; }
      this.showMobileToast('Gespräch gelöscht', 'success');
      this.chatNewConversation();
      await this.chatLoadConversations();
    } catch (e) {
      this.showMobileToast('Fehler: ' + e.message, 'error');
    }
  },

  async adminLoadUsers() {
    const body = document.getElementById('adminUsersBody');
    if (!body) return;
    body.innerHTML = '<p style="color:var(--text-secondary)">Wird geladen…</p>';
    const apiBase = `${location.protocol}//${location.host}/api`;
    try {
      await this.adminLoadGroupsCache();
      const resp = await Auth.fetch(`${apiBase}/admin/users`);
      const data = await resp.json();
      if (!resp.ok) { body.innerHTML = `<p style="color:var(--error)">Fehler: ${data.message||resp.status}</p>`; return; }
      const users = data.users || [];
      if (!users.length) { body.innerHTML = '<p>Keine Benutzer.</p>'; return; }
      let html = `<table class="admin-table"><thead><tr>
        <th>ID</th><th>Benutzername</th><th>E-Mail</th><th>Erstellt</th><th>Letzte Anmeldung</th><th>Rolle</th><th>Status</th><th>Gruppe</th><th>Backups</th><th>Aktionen</th>
      </tr></thead><tbody>`;
      for (const u of users) {
        const statusBadges = [
          u.is_admin ? '<span class="badge badge-admin">Admin</span>' : '',
          u.is_locked ? '<span class="badge badge-locked">Gesperrt</span>' : ''
        ].filter(Boolean).join(' ');
        const role = (u.role || 'user').toLowerCase();
        const roleSelect = `<select style="padding:0.25rem 0.4rem;border-radius:8px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);font-size:0.8rem;min-width:110px;"
                onchange="app._adminSetUserRole(${u.id}, this.value)">
              <option value="user" ${role==='user'?'selected':''}>User</option>
              <option value="viewer" ${role==='viewer'?'selected':''}>Viewer</option>
              <option value="manager" ${role==='manager'?'selected':''}>Manager</option>
              <option value="support" ${role==='support'?'selected':''}>Support</option>
            </select>`;
        const groups = Array.isArray(this._adminGroups) ? this._adminGroups : [];
        const groupOptions = [
          `<option value="">—</option>`,
          ...groups.map(g => `<option value="${g.id}" ${String(g.id)===String(u.group_id||'')?'selected':''}>${g.name}</option>`)
        ].join('');
        html += `<tr>
          <td>${u.id}</td>
          <td>${u.username || '<span style="color:var(--text-secondary);font-size:0.8rem;">—</span>'}</td>
          <td>${u.email}</td>
          <td>${this._adminFmt(u.created_at)}</td>
          <td title="${(u.last_login_ip || '').replace(/\"/g,'&quot;')}">${u.last_login_at ? this._adminFmt(u.last_login_at) : '<span style="color:var(--text-secondary);font-size:0.8rem;">—</span>'}</td>
          <td>${roleSelect}</td>
          <td>${statusBadges || '<span style="color:var(--text-secondary);font-size:0.8rem;">—</span>'}</td>
          <td>
            <select style="padding:0.25rem 0.4rem;border-radius:8px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);font-size:0.8rem;min-width:160px;"
                    onchange="app._adminSetUserGroup(${u.id}, this.value)">
              ${groupOptions}
            </select>
          </td>
          <td>${u.backup_count || 0}</td>
          <td style="white-space:nowrap;display:flex;gap:0.35rem;flex-wrap:wrap;">
            <button class="btn-secondary" style="font-size:0.75rem;padding:0.2rem 0.5rem;"
              onclick="app._adminToggleAdmin(${u.id},${u.is_admin?1:0},'${u.email}')"
              title="${u.is_admin?'Admin entziehen':'Admin vergeben'}">
              ${u.is_admin?'👑 Entziehen':'👑 Vergeben'}
            </button>
            <button class="btn-secondary" style="font-size:0.75rem;padding:0.2rem 0.5rem;"
              onclick="app._adminToggleLock(${u.id},${u.is_locked?1:0},'${u.email}')"
              title="${u.is_locked?'Entsperren':'Sperren'}">
              ${u.is_locked?'🔓 Freischalten':'🔒 Sperren'}
            </button>
            <button class="btn-secondary" style="font-size:0.75rem;padding:0.2rem 0.5rem;color:var(--error);"
              onclick="app._adminDeleteUser(${u.id},'${u.email}')">🗑️ Löschen</button>
          </td>
        </tr>`;
      }
      html += '</tbody></table>';
      body.innerHTML = html;
    } catch (e) {
      body.innerHTML = `<p style="color:var(--error)">Netzwerkfehler: ${e.message}</p>`;
    }
  },

  async adminLoadGroupsCache() {
    const apiBase = `${location.protocol}//${location.host}/api`;
    try {
      const resp = await Auth.fetch(`${apiBase}/admin/groups`);
      const data = await resp.json();
      if (!resp.ok) return;
      this._adminGroups = data.groups || [];
    } catch {}
  },

  async _adminSetUserGroup(uid, groupId) {
    const apiBase = `${location.protocol}//${location.host}/api`;
    const gid = groupId ? parseInt(groupId, 10) : null;
    await Auth.fetch(`${apiBase}/admin/users/${uid}/group`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId: gid })
    });
    // keep table up to date (also refreshes group names if changed)
    this.adminLoadUsers();
  },

  async _adminSetUserRole(uid, role) {
    const apiBase = `${location.protocol}//${location.host}/api`;
    try {
      const resp = await Auth.fetch(`${apiBase}/admin/users/${uid}/role`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role })
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      // keep table up to date
      this.adminLoadUsers();
    } catch (e) {
      this.showMobileToast(`Fehler: ${e.message}`, 'error');
      this.adminLoadUsers();
    }
  },

  async _adminToggleAdmin(uid, current, email) {
    if (!confirm(`Admin-Rolle für „${email}" ${current ? 'entziehen' : 'vergeben'}?`)) return;
    const apiBase = `${location.protocol}//${location.host}/api`;
    await Auth.fetch(`${apiBase}/admin/users/${uid}/admin`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isAdmin: !current })
    });
    this.adminLoadUsers();
  },

  async _adminToggleLock(uid, current, email) {
    if (!confirm(`Benutzer „${email}" ${current ? 'entsperren' : 'sperren'}?`)) return;
    const apiBase = `${location.protocol}//${location.host}/api`;
    await Auth.fetch(`${apiBase}/admin/users/${uid}/lock`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locked: !current })
    });
    this.adminLoadUsers();
  },

  async _adminDeleteUser(uid, email) {
    if (!confirm(`Benutzer „${email}" wirklich LÖSCHEN? Alle Daten werden entfernt.`)) return;
    const apiBase = `${location.protocol}//${location.host}/api`;
    await Auth.fetch(`${apiBase}/admin/users/${uid}`, { method: 'DELETE' });
    this.adminLoadUsers();
  },

  async adminLoadStatus() {
    const body = document.getElementById('adminStatusBody');
    if (!body) return;
    body.innerHTML = '<p style="color:var(--text-secondary)">Wird geladen…</p>';
    const apiBase = `${location.protocol}//${location.host}/api`;
    try {
      const resp = await Auth.fetch(`${apiBase}/admin/status`);
      const d = await resp.json();
      if (!resp.ok) { body.innerHTML = `<p style="color:var(--error)">Fehler: ${d.message||resp.status}</p>`; return; }
      const dbMB = d.dbSizeBytes ? (d.dbSizeBytes / 1024 / 1024).toFixed(2) : '—';
      body.innerHTML = `
        <div class="stat-grid">
          <div class="stat-card"><div class="stat-val">${d.version||'—'}</div><div class="stat-lbl">API-Version</div></div>
          <div class="stat-card"><div class="stat-val">${dbMB} MB</div><div class="stat-lbl">DB-Größe</div></div>
          <div class="stat-card"><div class="stat-val">${d.users?.total||0}</div><div class="stat-lbl">Benutzer</div></div>
          <div class="stat-card"><div class="stat-val">${d.users?.admins||0}</div><div class="stat-lbl">Admins</div></div>
          <div class="stat-card"><div class="stat-val">${d.users?.locked||0}</div><div class="stat-lbl">Gesperrt</div></div>
          <div class="stat-card"><div class="stat-val">${d.backups||0}</div><div class="stat-lbl">Backups gesamt</div></div>
          <div class="stat-card"><div class="stat-val">${d.errorReports||0}</div><div class="stat-lbl">Fehlerberichte</div></div>
          <div class="stat-card"><div class="stat-val">${d.slicerProfiles||0}</div><div class="stat-lbl">Slicer-Profile</div></div>
          <div class="stat-card"><div class="stat-val">${d.filaments||0}</div><div class="stat-lbl">Filamente (DB)</div></div>
        </div>
        <strong>Sync-Status</strong>
        <table class="admin-table" style="margin-top:0.5rem;">
          <thead><tr><th>Quelle</th><th>Letzter Sync</th><th>Einträge</th><th>Status</th></tr></thead>
          <tbody>${(d.sync||[]).map(s=>`
            <tr>
              <td>${s.source}</td>
              <td>${this._adminFmt(s.last_sync)}</td>
              <td>${s.items_count||0}</td>
              <td><span class="badge ${s.status==='ok'?'badge-ok':'badge-locked'}">${s.status}</span></td>
            </tr>`).join('')||'<tr><td colspan="4" style="color:var(--text-secondary)">Keine Sync-Daten.</td></tr>'}
          </tbody>
        </table>`;
    } catch (e) {
      body.innerHTML = `<p style="color:var(--error)">Netzwerkfehler: ${e.message}</p>`;
    }
  },

  async adminLoadBackups() {
    const body = document.getElementById('adminBackupsBody');
    if (!body) return;
    body.innerHTML = '<p style="color:var(--text-secondary)">Wird geladen…</p>';
    const apiBase = `${location.protocol}//${location.host}/api`;
    try {
      const resp = await Auth.fetch(`${apiBase}/admin/backups`);
      const data = await resp.json();
      if (!resp.ok) { body.innerHTML = `<p style="color:var(--error)">Fehler: ${data.message||resp.status}</p>`; return; }
      const backups = data.backups || [];
      if (!backups.length) { body.innerHTML = '<p>Keine Backups vorhanden.</p>'; return; }
      let html = `<table class="admin-table"><thead><tr>
        <th>ID</th><th>Benutzer</th><th>E-Mail</th><th>Erstellt</th>
      </tr></thead><tbody>`;
      for (const b of backups) {
        html += `<tr>
          <td>${b.id}</td>
          <td>${b.user_id}</td>
          <td>${b.email}</td>
          <td>${this._adminFmt(b.created_at)}</td>
        </tr>`;
      }
      html += '</tbody></table>';
      body.innerHTML = html;
    } catch (e) {
      body.innerHTML = `<p style="color:var(--error)">Netzwerkfehler: ${e.message}</p>`;
    }
  },

  _adminErrorReports: [],
  _adminErrorSort: { col: 'id', dir: 'desc' },
  _adminErrorFilter: 'all',

  async adminLoadErrors() {
    const body = document.getElementById('adminErrorsBody');
    if (!body) return;
    body.innerHTML = '<p style="color:var(--text-secondary)">Wird geladen…</p>';
    const apiBase = `${location.protocol}//${location.host}/api`;
    try {
      const resp = await Auth.fetch(`${apiBase}/admin/error-reports`);
      const data = await resp.json();
      if (!resp.ok) { body.innerHTML = `<p style="color:var(--error)">Fehler: ${data.message||resp.status}</p>`; return; }
      this._adminErrorReports = data.reports || [];
      this._adminRenderErrors();
    } catch (e) {
      body.innerHTML = `<p style="color:var(--error)">Netzwerkfehler: ${e.message}</p>`;
    }
  },

  _adminRenderErrors() {
    const body = document.getElementById('adminErrorsBody');
    if (!body) return;

    const STATUS_META = {
      'neu':           { label: '🆕 Neu',           color: '#6c8ef7', bg: 'rgba(108,142,247,0.15)' },
      'in_bearbeitung':{ label: '⚙️ In Bearbeitung', color: '#f7b731', bg: 'rgba(247,183,49,0.15)'  },
      'erledigt':      { label: '✅ Erledigt',       color: '#26de81', bg: 'rgba(38,222,129,0.15)'  },
      'archiviert':    { label: '📦 Archiviert',     color: '#a29bfe', bg: 'rgba(162,155,254,0.15)' },
    };
    const STATUS_ORDER = { 'neu': 0, 'in_bearbeitung': 1, 'erledigt': 2, 'archiviert': 3 };

    let reports = [...this._adminErrorReports];

    // Filter
    const f = this._adminErrorFilter || 'all';
    if (f !== 'all') reports = reports.filter(r => (r.status || 'neu') === f);

    // Sort
    const { col, dir } = this._adminErrorSort;
    reports.sort((a, b) => {
      let va, vb;
      if (col === 'id')      { va = a.id;          vb = b.id; }
      else if (col === 'status') { va = STATUS_ORDER[a.status||'neu'] ?? 99; vb = STATUS_ORDER[b.status||'neu'] ?? 99; }
      else if (col === 'date')   { va = a.created_at; vb = b.created_at; }
      else { va = a.id; vb = b.id; }
      if (va < vb) return dir === 'asc' ? -1 : 1;
      if (va > vb) return dir === 'asc' ? 1 : -1;
      return 0;
    });

    const arrow = (c) => {
      if (col !== c) return `<span style="opacity:0.3;font-size:0.7rem;"> ↕</span>`;
      return `<span style="font-size:0.7rem;"> ${dir === 'asc' ? '↑' : '↓'}</span>`;
    };
    const thBtn = (c, label) =>
      `<th style="cursor:pointer;user-select:none;white-space:nowrap;" onclick="app._adminErrorSortBy('${c}')">${label}${arrow(c)}</th>`;

    // Filter-Tabs
    const filterCounts = { all: this._adminErrorReports.length };
    for (const r of this._adminErrorReports) {
      const s = r.status || 'neu';
      filterCounts[s] = (filterCounts[s] || 0) + 1;
    }
    const filterTabs = [
      { key: 'all',           label: 'Alle' },
      { key: 'neu',           label: '🆕 Neu' },
      { key: 'in_bearbeitung',label: '⚙️ In Bearbeitung' },
      { key: 'erledigt',      label: '✅ Erledigt' },
      { key: 'archiviert',    label: '📦 Archiviert' },
    ].map(t => {
      const active = f === t.key;
      const cnt = filterCounts[t.key] || 0;
      return `<button onclick="app._adminErrorFilterBy('${t.key}')"
        style="font-size:0.75rem;padding:0.3rem 0.7rem;border-radius:999px;border:1.5px solid;cursor:pointer;
               background:${active ? 'var(--accent)' : 'var(--bg-secondary)'};
               color:${active ? '#fff' : 'var(--text-secondary)'};
               border-color:${active ? 'var(--accent)' : 'var(--border)'};
               font-weight:${active ? '700' : '400'};transition:all .15s;">
        ${t.label}${cnt > 0 ? ` <span style="opacity:0.75;">(${cnt})</span>` : ''}
      </button>`;
    }).join('');

    if (!reports.length) {
      body.innerHTML = `
        <div style="display:flex;gap:0.4rem;flex-wrap:wrap;margin-bottom:0.75rem;">${filterTabs}</div>
        <p style="color:var(--text-secondary);text-align:center;padding:1.5rem;">Keine Einträge für diesen Filter.</p>`;
      return;
    }

    let html = `
      <div style="display:flex;gap:0.4rem;flex-wrap:wrap;margin-bottom:0.75rem;">${filterTabs}</div>
      <div style="overflow-x:auto;">
      <table class="admin-table"><thead><tr>
        ${thBtn('id','ID')}
        <th>Meldung</th><th>Beschreibung</th><th>Screenshot</th>
        ${thBtn('status','Status')}
        ${thBtn('date','Erstellt')}
        <th>Aktionen</th>
      </tr></thead><tbody>`;

    for (const r of reports) {
      const msg = (r.error_message||'').slice(0,80) || '(kein)';
      const ub  = (r.user_message||'').slice(0,60)  || '—';
      const st  = r.status || 'neu';
      const sm  = STATUS_META[st] || STATUS_META['neu'];
      const statusBadge = `<span style="display:inline-block;padding:0.2rem 0.55rem;border-radius:999px;
        font-size:0.72rem;font-weight:700;background:${sm.bg};color:${sm.color};white-space:nowrap;">${sm.label}</span>`;
      const statusSelect = `<select onchange="app._adminSetErrorStatus(${r.id}, this.value)"
        style="font-size:0.75rem;padding:0.2rem 0.4rem;border-radius:8px;background:var(--bg-secondary);
               color:var(--text-primary);border:1px solid var(--border);cursor:pointer;margin-top:0.3rem;width:100%;">
        <option value="neu"            ${st==='neu'?'selected':''}>🆕 Neu</option>
        <option value="in_bearbeitung" ${st==='in_bearbeitung'?'selected':''}>⚙️ In Bearbeitung</option>
        <option value="erledigt"       ${st==='erledigt'?'selected':''}>✅ Erledigt</option>
        <option value="archiviert"     ${st==='archiviert'?'selected':''}>📦 Archiviert</option>
      </select>`;
      html += `<tr id="err-row-${r.id}">
        <td style="font-weight:700;">${r.id}</td>
        <td style="font-size:0.78rem;max-width:200px;word-break:break-word;">${msg}</td>
        <td style="font-size:0.78rem;max-width:180px;word-break:break-word;">${ub}</td>
        <td>${r.has_screenshot ? `<button class="btn-secondary" style="font-size:0.75rem;padding:0.2rem 0.5rem;width:auto;" onclick="app._adminShowScreenshot(${r.id})">📷 Ansehen</button>` : '—'}</td>
        <td style="min-width:140px;">${statusBadge}${statusSelect}</td>
        <td style="white-space:nowrap;font-size:0.78rem;">${this._adminFmt(r.created_at)}</td>
        <td>
          <button class="btn-secondary" style="font-size:0.75rem;padding:0.25rem 0.5rem;width:auto;color:var(--error);border-color:var(--error)33;"
            onclick="app._adminDeleteError(${r.id})">🗑️ Löschen</button>
        </td>
      </tr>`;
    }
    html += '</tbody></table></div>';
    body.innerHTML = html;
  },

  _adminErrorSortBy(col) {
    if (this._adminErrorSort.col === col) {
      this._adminErrorSort.dir = this._adminErrorSort.dir === 'asc' ? 'desc' : 'asc';
    } else {
      this._adminErrorSort = { col, dir: col === 'id' ? 'desc' : 'asc' };
    }
    this._adminRenderErrors();
  },

  _adminErrorFilterBy(key) {
    this._adminErrorFilter = key;
    this._adminRenderErrors();
  },

  async _adminSetErrorStatus(rid, status) {
    const apiBase = `${location.protocol}//${location.host}/api`;
    try {
      const resp = await Auth.fetch(`${apiBase}/admin/error-reports/${rid}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const entry = this._adminErrorReports.find(r => r.id === rid);
      if (entry) entry.status = status;
      this._adminRenderErrors();
    } catch (e) {
      this.showMobileToast(`Fehler: ${e.message}`, 'error');
    }
  },

  async _adminDeleteError(rid) {
    if (!confirm(`Fehlerbericht #${rid} wirklich löschen?`)) return;
    const apiBase = `${location.protocol}//${location.host}/api`;
    try {
      const resp = await Auth.fetch(`${apiBase}/admin/error-reports/${rid}`, { method: 'DELETE' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      this._adminErrorReports = this._adminErrorReports.filter(r => r.id !== rid);
      this._adminRenderErrors();
      this.showMobileToast(`Bericht #${rid} gelöscht`, 'success');
    } catch (e) {
      this.showMobileToast(`Fehler: ${e.message}`, 'error');
    }
  },

  // =====================
  //  Admin: Gruppen & Rechte
  // =====================
  _adminPermissionCatalog() {
    return [
      { key: 'admin.users', label: 'Benutzer verwalten (sperren/löschen/admin)' },
      { key: 'admin.status', label: 'Systemstatus ansehen' },
      { key: 'admin.backups', label: 'Backups ansehen' },
      { key: 'admin.errors', label: 'Fehlerberichte ansehen' },
      { key: 'admin.groups', label: 'Gruppen & Rechte verwalten' }
    ];
  },

  async adminLoadGroups() {
    const body = document.getElementById('adminGroupsBody');
    if (!body) return;
    body.innerHTML = '<p style="color:var(--text-secondary)">Wird geladen…</p>';
    const apiBase = `${location.protocol}//${location.host}/api`;

    // Icon + color per permission key
    const PERM_META = {
      'admin.users':  { icon: '👥', color: '#6c8ef7', bg: 'rgba(108,142,247,0.12)' },
      'admin.status': { icon: '📊', color: '#4ecdc4', bg: 'rgba(78,205,196,0.12)' },
      'admin.backups':{ icon: '💾', color: '#f7b731', bg: 'rgba(247,183,49,0.12)'  },
      'admin.errors': { icon: '🐛', color: '#fc5c65', bg: 'rgba(252,92,101,0.12)'  },
      'admin.groups': { icon: '🧩', color: '#a29bfe', bg: 'rgba(162,155,254,0.12)' },
    };

    try {
      const resp = await Auth.fetch(`${apiBase}/admin/groups`);
      const data = await resp.json();
      if (!resp.ok) { body.innerHTML = `<p style="color:var(--error)">Fehler: ${data.message||resp.status}</p>`; return; }
      const groups = data.groups || [];
      this._adminGroups = groups;
      const perms = this._adminPermissionCatalog();

      // Optional: load users so we can assign group/role from this tab.
      let users = [];
      try {
        const ur = await Auth.fetch(`${apiBase}/admin/users`);
        const ud = await ur.json();
        if (ur.ok) users = ud.users || [];
      } catch (e) {
        // ignore; user might not have admin.users permission
      }

      // Permission-Toggle-Chip
      const permCard = (p, cls, extra = '') => {
        const m = PERM_META[p.key] || { icon: '🔑', color: 'var(--accent)', bg: 'rgba(0,200,200,0.1)' };
        const shortLabel = { 'admin.users': 'Benutzer', 'admin.status': 'Status', 'admin.backups': 'Backups', 'admin.errors': 'Fehler', 'admin.groups': 'Gruppen' };
        const uid = `perm-${cls}-${p.key}-${Math.random().toString(36).slice(2,7)}`;
        const isChecked = extra.includes('checked');
        const checkedStyle = isChecked
          ? `background:${m.color};border-color:${m.color};color:#fff;`
          : `background:var(--bg-tertiary);border-color:var(--border);color:var(--text-secondary);`;
        return `
          <label for="${uid}" style="display:inline-flex;align-items:center;gap:0.45rem;
                        padding:0.45rem 0.85rem;border-radius:999px;border:1.5px solid;
                        ${checkedStyle}
                        cursor:pointer;transition:all .15s;user-select:none;
                        font-size:0.82rem;font-weight:600;white-space:nowrap;"
                 onclick="(function(lbl,color,bg){
                   var cb=lbl.querySelector('input');
                   var on=cb.checked;
                   lbl.style.background=on?color:'var(--bg-tertiary)';
                   lbl.style.borderColor=on?color:'var(--border)';
                   lbl.style.color=on?'#fff':'var(--text-secondary)';
                 })(this,'${m.color}','${m.bg}')">
            <input type="checkbox" id="${uid}" class="${cls}" value="${p.key}" ${extra}
                   style="display:none;">
            <span style="font-size:1rem;line-height:1;">${m.icon}</span>
            <span>${shortLabel[p.key] || p.key}</span>
          </label>`;
      };

      const createPerms = `<div style="display:flex;flex-wrap:wrap;gap:0.45rem;margin:0.6rem 0 0.9rem;">
        ${perms.map(p => permCard(p, 'adm-perm-create')).join('')}
      </div>`;

      const assignUserCard = (() => {
        if (!users.length) return '';
        const userOpts = users.map(u => {
          const label = `${u.email}${u.username ? ` (${u.username})` : ''}`;
          return `<option value="${u.id}">${label}</option>`;
        }).join('');
        const groupOpts = [
          `<option value="">— Keine Gruppe —</option>`,
          ...groups.map(g => `<option value="${g.id}">${g.name}</option>`)
        ].join('');
        return `
          <div style="border:1px solid var(--border);background:var(--bg-secondary);border-radius:14px;
                      padding:1.05rem;margin-bottom:1.25rem;">
            <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.85rem;">
              <span style="font-size:1.05rem;">👤</span>
              <strong style="font-size:0.95rem;">Benutzer zuweisen</strong>
              <span style="color:var(--text-secondary);font-size:0.8rem;">(Gruppe + Rolle)</span>
            </div>
            <div style="display:grid;grid-template-columns:1.6fr 1.2fr 0.9fr;gap:0.65rem;align-items:end;">
              <div>
                <label style="font-size:0.72rem;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.07em;font-weight:700;">Benutzer</label>
                <select id="admAssignUser" style="width:100%;margin-top:0.3rem;padding:0.5rem 0.75rem;border-radius:10px;font-size:0.9rem;">
                  ${userOpts}
                </select>
              </div>
              <div>
                <label style="font-size:0.72rem;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.07em;font-weight:700;">Gruppe</label>
                <select id="admAssignGroup" style="width:100%;margin-top:0.3rem;padding:0.5rem 0.75rem;border-radius:10px;font-size:0.9rem;">
                  ${groupOpts}
                </select>
              </div>
              <div>
                <label style="font-size:0.72rem;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.07em;font-weight:700;">Rolle</label>
                <select id="admAssignRole" style="width:100%;margin-top:0.3rem;padding:0.5rem 0.75rem;border-radius:10px;font-size:0.9rem;">
                  <option value="user">User</option>
                  <option value="viewer">Viewer</option>
                  <option value="manager">Manager</option>
                  <option value="support">Support</option>
                </select>
              </div>
            </div>
            <div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-top:0.85rem;">
              <button class="btn-success" style="width:auto;border-radius:10px;padding:0.5rem 1.1rem;"
                      onclick="app._adminAssignUserGroupRole()">✅ Zuweisen</button>
              <button class="btn-secondary" style="width:auto;border-radius:10px;padding:0.5rem 1.1rem;"
                      onclick="app.adminLoadGroups()">🔄 Aktualisieren</button>
            </div>
            <div id="admAssignStatus" class="status-message" style="margin-top:0.6rem;"></div>
          </div>`;
      })();

      const renderGroup = (g) => {
        const gp = Array.isArray(g.permissions) ? g.permissions : [];
        const checks = `<div style="display:flex;flex-wrap:wrap;gap:0.45rem;margin-top:0.5rem;">
          ${perms.map(p => permCard(p, 'adm-perm-edit', `data-gid="${g.id}" ${gp.includes(p.key) ? 'checked' : ''}`)).join('')}
        </div>`;
        const safeNameAttr = String(g.name || '').replace(/"/g, '&quot;');
        const safeNameJs = String(g.name || '').replace(/'/g, '&#39;');
        const initials = String(g.name || '?').slice(0, 2).toUpperCase();
        return `
          <div style="border:1px solid var(--border);background:var(--bg-tertiary);border-radius:14px;
                      padding:1rem 1.1rem;margin-bottom:0.85rem;box-shadow:0 2px 8px rgba(0,0,0,.15);">
            <!-- Header row -->
            <div style="display:flex;justify-content:space-between;align-items:center;gap:0.75rem;flex-wrap:wrap;margin-bottom:0.85rem;">
              <div style="display:flex;align-items:center;gap:0.6rem;">
                <div style="width:34px;height:34px;border-radius:50%;background:linear-gradient(135deg,var(--accent),#6c8ef7);
                            display:flex;align-items:center;justify-content:center;font-weight:700;font-size:0.8rem;color:#fff;flex-shrink:0;">
                  ${initials}
                </div>
                <div>
                  <div style="font-weight:700;font-size:0.95rem;">${g.name}</div>
                  <div style="font-size:0.72rem;color:var(--text-secondary);">ID ${g.id} · ${gp.length} Recht${gp.length !== 1 ? 'e' : ''}</div>
                </div>
              </div>
              <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
                <button class="btn-success" style="font-size:0.8rem;padding:0.3rem 0.75rem;width:auto;border-radius:8px;"
                        onclick="app._adminSaveGroup(${g.id})">💾 Speichern</button>
                <button class="btn-secondary" style="font-size:0.8rem;padding:0.3rem 0.75rem;width:auto;border-radius:8px;color:var(--error);border-color:var(--error)33;"
                        onclick="app._adminDeleteGroup(${g.id},'${safeNameJs}')">🗑️ Löschen</button>
              </div>
            </div>
            <hr style="border:none;border-top:1px solid var(--border);margin:0 0 0.75rem;">
            <!-- Name field -->
            <div style="margin-bottom:0.75rem;">
              <label style="font-size:0.72rem;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.07em;font-weight:700;">Gruppenname</label>
              <input type="text" id="admGroupName-${g.id}" value="${safeNameAttr}"
                     style="width:100%;margin-top:0.3rem;padding:0.5rem 0.75rem;border-radius:10px;font-size:0.9rem;">
            </div>
            <!-- Permissions -->
            <div>
              <label style="font-size:0.72rem;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.07em;font-weight:700;">Rechte</label>
              ${checks}
            </div>
          </div>`;
      };

      body.innerHTML = `
        ${assignUserCard}
        <!-- Create new group card -->
        <div style="border:1.5px dashed var(--accent)55;background:var(--bg-secondary);border-radius:14px;
                    padding:1.1rem;margin-bottom:1.25rem;">
          <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.85rem;">
            <span style="font-size:1.1rem;">➕</span>
            <strong style="font-size:0.95rem;">Neue Gruppe erstellen</strong>
          </div>
          <label style="font-size:0.72rem;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.07em;font-weight:700;">Name</label>
          <input type="text" id="admGroupCreateName" placeholder="z.B. Support / Viewer / Manager"
                 style="width:100%;margin-top:0.3rem;margin-bottom:0.75rem;padding:0.5rem 0.75rem;border-radius:10px;font-size:0.9rem;">
          <label style="font-size:0.72rem;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.07em;font-weight:700;">Rechte</label>
          ${createPerms}
          <button class="btn-primary" style="width:auto;margin-top:0.25rem;border-radius:10px;padding:0.5rem 1.1rem;"
                  onclick="app._adminCreateGroup()">➕ Gruppe erstellen</button>
          <div id="admGroupCreateStatus" class="status-message" style="margin-top:0.6rem;"></div>
        </div>
        <!-- Existing groups -->
        <div>
          ${groups.length
            ? groups.map(renderGroup).join('')
            : '<p style="color:var(--text-secondary);text-align:center;padding:1.5rem 0;">Noch keine Gruppen vorhanden.</p>'}
        </div>`;
    } catch (e) {
      body.innerHTML = `<p style="color:var(--error)">Netzwerkfehler: ${e.message}</p>`;
    }
  },

  async _adminAssignUserGroupRole() {
    const uid = document.getElementById('admAssignUser')?.value;
    const gid = document.getElementById('admAssignGroup')?.value || '';
    const role = document.getElementById('admAssignRole')?.value || 'user';
    const st = document.getElementById('admAssignStatus');
    if (st) { st.textContent = ''; st.className = 'status-message'; }
    if (!uid) {
      if (st) { st.textContent = 'Bitte Benutzer auswählen.'; st.className = 'status-message error'; }
      return;
    }
    try {
      await this._adminSetUserGroup(uid, gid);
      await this._adminSetUserRole(uid, role);
      if (st) { st.textContent = '✅ Gespeichert'; st.className = 'status-message success'; }
    } catch (e) {
      if (st) { st.textContent = '❌ Fehler: ' + (e.message || 'Netzwerkfehler'); st.className = 'status-message error'; }
    }
  },

  async _adminCreateGroup() {
    const nameEl = document.getElementById('admGroupCreateName');
    const st = document.getElementById('admGroupCreateStatus');
    const name = (nameEl && nameEl.value ? nameEl.value : '').trim();
    if (!name) { if (st) { st.textContent = 'Bitte Namen eingeben.'; st.className = 'status-message error'; } return; }
    const perms = Array.from(document.querySelectorAll('.adm-perm-create:checked')).map(i => i.value);
    const apiBase = `${location.protocol}//${location.host}/api`;
    try {
      const resp = await Auth.fetch(`${apiBase}/admin/groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, permissions: perms })
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.message || resp.status);
      if (st) { st.textContent = '✅ Gruppe erstellt'; st.className = 'status-message success'; }
      this.adminLoadGroups();
    } catch (e) {
      if (st) { st.textContent = '❌ Fehler: ' + (e.message || 'Netzwerkfehler'); st.className = 'status-message error'; }
    }
  },

  async _adminSaveGroup(gid) {
    const nameEl = document.getElementById(`admGroupName-${gid}`);
    const name = (nameEl && nameEl.value ? nameEl.value : '').trim();
    const perms = Array.from(document.querySelectorAll(`.adm-perm-edit[data-gid="${gid}"]:checked`)).map(i => i.value);
    const apiBase = `${location.protocol}//${location.host}/api`;
    await Auth.fetch(`${apiBase}/admin/groups/${gid}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, permissions: perms })
    });
    this.adminLoadGroups();
  },

  async _adminDeleteGroup(gid, name) {
    if (!confirm(`Gruppe „${name}“ löschen?`)) return;
    const apiBase = `${location.protocol}//${location.host}/api`;
    const resp = await Auth.fetch(`${apiBase}/admin/groups/${gid}`, { method: 'DELETE' });
    if (!resp.ok) {
      try {
        const data = await resp.json();
        alert('Löschen fehlgeschlagen: ' + (data.message || resp.status));
      } catch {
        alert('Löschen fehlgeschlagen.');
      }
    }
    this.adminLoadGroups();
  },

  async _adminShowScreenshot(rid) {
    const apiBase = `${location.protocol}//${location.host}/api`;
    try {
      const resp = await Auth.fetch(`${apiBase}/admin/error-reports/${rid}/screenshot`);
      const data = await resp.json();
      if (!resp.ok || !data.screenshot) { alert('Kein Screenshot verfügbar.'); return; }
      const win = window.open('', '_blank');
      win.document.write(`<img src="${data.screenshot}" style="max-width:100%;height:auto;">`);
    } catch (e) {
      alert('Fehler beim Laden: ' + e.message);
    }
  }
};

// Global error handlers - capture for ErrorReporter
window.addEventListener('error', (e) => {
  ErrorReporter.capture(e.message, e.filename, e.lineno, e.colno, e.error);
});

window.addEventListener('unhandledrejection', (e) => {
  ErrorReporter.capturePromise(e.reason);
});

// Initialize: load i18n, then app
(async function() {
  if (typeof I18n !== 'undefined' && I18n.init) {
    await I18n.init();
    if (I18n.refreshElements) I18n.refreshElements();
  }
  await app.init();
})();
