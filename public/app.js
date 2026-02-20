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
      onSelect() { app.applyTemperaturePreset(); app.updateVisibility(); },
    },
    brand: {
      paletteId: 'brandPalette',
      inputId: 'brandValue',
      items: ['Generic', 'Bambu Lab', 'Hatchbox', 'eSun', 'Overture', 'SUNLU', 'Polymaker', 'Prusament', 'Snapmaker', 'Jayo'],
      defaultValue: 'Generic',
      customInputId: 'brandInput',
      onSelect(value) { app.filterPalettesForBrand(value); },
    },
    variant: {
      paletteId: 'variantPalette',
      inputId: 'extendedSubType',
      items: ['Basic', 'Matte', 'SnapSpeed', 'Silk', 'Support', 'HF', '95A', '95A HF'],
      defaultValue: 'Basic',
    },
  },

  init() {
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

  initSpoolman() {
    const urlInput = document.getElementById('spoolmanUrl');
    if (urlInput && this.spoolmanUrl) {
      urlInput.value = this.spoolmanUrl;
    }
    this.updateSpoolmanLink();
  },

  updateSpoolmanLink() {
    const link = document.getElementById('spoolmanLink');
    if (link && this.spoolmanUrl) {
      link.href = this.spoolmanUrl;
      link.onclick = null;
    }
  },

  openSpoolman() {
    if (this.spoolmanUrl) {
      window.open(this.spoolmanUrl, '_blank');
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
    const url = document.getElementById('spoolmanUrl').value.replace(/\/+$/, '');
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

  saveSpoolmanUrl() {
    const url = document.getElementById('spoolmanUrl').value.replace(/\/+$/, '');
    this.spoolmanUrl = url;
    localStorage.setItem('spoolmanUrl', url);
    this.updateSpoolmanLink();
    this.closeSpoolmanSetup();
    this.showMobileToast('Spoolman URL gespeichert', 'success');
  },

  _spoolmanSpools: [],

  async loadSpoolmanSpools() {
    if (!this.spoolmanUrl) {
      this.showSpoolmanSetup();
      return;
    }

    const listEl = document.getElementById('spoolmanSpoolList');
    listEl.innerHTML = '<p style="color: var(--text-secondary);">Lade Spulen...</p>';
    this.showStatus('spoolmanStatus', 'warning', 'Verbinde mit Spoolman...');
    const searchEl = document.getElementById('spoolmanSearch');
    if (searchEl) searchEl.value = '';

    try {
      const resp = await fetch(`${this.spoolmanUrl}/api/v1/spool`, {
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
      'aboutSection'
    ];
    sections.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.add('hidden');
    });

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
    document.getElementById('fileInput').addEventListener('change', (e) => {
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

      const orcaProfileInfo = document.getElementById('orcaProfileInfo');
      const orcaProfileName = document.getElementById('orcaProfileName');

      if (format === 'openspool_extended') {
        const brand = formData.brand || 'Generic';
        const material = formData.materialType || 'PLA';
        const subtype = formData.extendedSubType || 'Basic';
        const profileName = `${brand} ${material} ${subtype}`.trim();

        orcaProfileName.textContent = profileName;
        orcaProfileInfo.classList.remove('hidden');
      } else {
        orcaProfileInfo.classList.add('hidden');
      }
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

  copyOrcaProfile() {
    const profileName = document.getElementById('orcaProfileName').textContent;
    if (profileName && profileName !== '-') {
      navigator.clipboard.writeText(profileName).then(() => {
        this.showStatus('writeStatus', 'success', 'Profile name copied to clipboard!');
      }).catch(() => {
        this.showStatus('writeStatus', 'error', 'Failed to copy to clipboard');
      });
    }
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

      const totalPages = Math.ceil(data.total / data.per_page);
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
    try {
      const status = await ProfileDB.getSyncStatus();
      const el = document.getElementById('filListSyncInfo');
      const src = status.sources || [];
      const fdb = src.find(s => s.source === 'filament_database');
      const last = fdb ? new Date(fdb.last_sync).toLocaleString('de-CH') : 'Nie';
      el.innerHTML = `📊 <strong>${status.totals.filaments}</strong> Filamente in der Datenbank · Letzte Aktualisierung: ${last}`;
    } catch (e) {}
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
  }
};

// Initialize app
app.init();
