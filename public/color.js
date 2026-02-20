const ColorPicker = {
  state: {},
  _resizeHandlers: [],

  hsvToRgb(h, s, v) {
    let r, g, b;
    const i = Math.floor(h * 6);
    const f = h * 6 - i;
    const p = v * (1 - s);
    const q = v * (1 - f * s);
    const t = v * (1 - (1 - f) * s);
    switch (i % 6) {
      case 0: r = v; g = t; b = p; break;
      case 1: r = q; g = v; b = p; break;
      case 2: r = p; g = v; b = t; break;
      case 3: r = p; g = q; b = v; break;
      case 4: r = t; g = p; b = v; break;
      case 5: r = v; g = p; b = q; break;
    }
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
  },

  rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s, v = max;
    const d = max - min;
    s = max === 0 ? 0 : d / max;
    if (max === min) {
      h = 0;
    } else {
      switch (max) {
        case r: h = (g - b) / d + (g < b ? 6 : 0); break;
        case g: h = (b - r) / d + 2; break;
        case b: h = (r - g) / d + 4; break;
      }
      h /= 6;
    }
    return [h, s, v];
  },

  hexToHsv(hex) {
    const val = hex.replace('#', '').trim();
    if (!/^[0-9a-fA-F]{6}$/.test(val)) return null;
    return this.rgbToHsv(
      parseInt(val.slice(0, 2), 16),
      parseInt(val.slice(2, 4), 16),
      parseInt(val.slice(4, 6), 16)
    );
  },

  hsvToHex(h, s, v) {
    return this.hsvToRgb(h, s, v)
      .map(c => c.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();
  },

  drawHueArea(ctx, w, h) {
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    for (let i = 0; i <= 6; i++) {
      const stop = i / 6;
      const [r, g, b] = this.hsvToRgb(stop, 1, 1);
      grad.addColorStop(stop, `rgb(${r},${g},${b})`);
    }
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
  },

  drawSVSquare(ctx, w, h, hue) {
    const [r, g, b] = this.hsvToRgb(hue, 1, 1);
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(0, 0, w, h);
    const white = ctx.createLinearGradient(0, 0, w, 0);
    white.addColorStop(0, 'rgba(255,255,255,1)');
    white.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = white;
    ctx.fillRect(0, 0, w, h);
    const black = ctx.createLinearGradient(0, 0, 0, h);
    black.addColorStop(0, 'rgba(0,0,0,0)');
    black.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.fillStyle = black;
    ctx.fillRect(0, 0, w, h);
  },

  drawSVMarker(ctx, w, h, s, v) {
    const x = Math.max(0, Math.min(w, Math.round(s * w)));
    const y = Math.max(0, Math.min(h, Math.round((1 - v) * h)));
    const r = Math.max(4, Math.floor(Math.min(w, h) * 0.02));
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, r - 2, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0,0,0,0.65)';
    ctx.stroke();
    ctx.restore();
  },

  drawHueMarker(ctx, w, h, hue) {
    const x = Math.max(0, Math.min(w, Math.round(hue * w)));
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + 3, 0);
    ctx.lineTo(x + 3, h);
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.stroke();
    ctx.restore();
  },

  setupCanvas(canvas, drawFn) {
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const resize = () => {
      const cssW = canvas.clientWidth || canvas.width;
      const cssH = canvas.clientHeight || canvas.height;
      canvas.width = Math.floor(cssW * dpr);
      canvas.height = Math.floor(cssH * dpr);
      drawFn(ctx, canvas.width, canvas.height);
    };
    resize();
    window.addEventListener('resize', resize);
    this._resizeHandlers.push(resize);
    return ctx;
  },

  addTouchDrag(element, pickFn) {
    element.style.touchAction = 'none';

    let startX, startY, lastX, lastY, timer;
    let phase = 'idle';

    const end = () => {
      clearTimeout(timer);
      phase = 'idle';
    };

    element.addEventListener('touchstart', (e) => {
      end();
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      startX = lastX = t.clientX;
      startY = lastY = t.clientY;
      phase = 'pending';
      timer = setTimeout(() => {
        if (phase !== 'pending') return;
        phase = 'picking';
        if (navigator.vibrate) try { navigator.vibrate(15); } catch {}
        pickFn(t);
      }, 300);
    });

    element.addEventListener('touchmove', (e) => {
      const t = e.touches[0];

      if (phase === 'pending') {
        if (Math.abs(t.clientX - startX) > 8 || Math.abs(t.clientY - startY) > 8) {
          clearTimeout(timer);
          phase = 'scrolling';
        } else {
          return;
        }
      }

      if (phase === 'scrolling') {
        window.scrollBy(lastX - t.clientX, lastY - t.clientY);
        lastX = t.clientX;
        lastY = t.clientY;
        return;
      }

      if (phase === 'picking') {
        pickFn(t);
      }
    });

    element.addEventListener('touchend', end);
    element.addEventListener('touchcancel', end);
  },

  redraw(i) {
    const st = this.state[i];
    if (!st) return;

    const sv = document.getElementById(`colorSV${i}`);
    const hueBar = document.getElementById(`colorHue${i}`);
    if (!sv || !hueBar) return;

    const svCtx = sv.getContext('2d');
    const hueCtx = hueBar.getContext('2d');

    this.drawSVSquare(svCtx, sv.width, sv.height, st.hue);
    this.drawSVMarker(svCtx, sv.width, sv.height, st.s, st.v);
    this.drawHueArea(hueCtx, hueBar.width, hueBar.height);
    this.drawHueMarker(hueCtx, hueBar.width, hueBar.height, st.hue);
  },

  setFromHex(index, hex) {
    const i = parseInt(index, 10);
    if (!i) return;
    const hsv = this.hexToHsv(hex);
    if (!hsv) return;

    this.state[i] = this.state[i] || {};
    [this.state[i].hue, this.state[i].s, this.state[i].v] = hsv;
    this.redraw(i);
  },

  FILAMENT_COLORS: [
    { name: 'Weiss', hex: 'FFFFFF' },
    { name: 'Elfenbein', hex: 'FFFFF0' },
    { name: 'Beige', hex: 'F5F5DC' },
    { name: 'Creme', hex: 'FFFDD0' },
    { name: 'Hellgrau', hex: 'D3D3D3' },
    { name: 'Grau', hex: '808080' },
    { name: 'Dunkelgrau', hex: '404040' },
    { name: 'Schwarz', hex: '000000' },
    { name: 'Rot', hex: 'FF0000' },
    { name: 'Dunkelrot', hex: '8B0000' },
    { name: 'Weinrot', hex: '722F37' },
    { name: 'Karmin', hex: 'DC143C' },
    { name: 'Orange', hex: 'FF8C00' },
    { name: 'Neon Orange', hex: 'FF6600' },
    { name: 'Gelb', hex: 'FFFF00' },
    { name: 'Gold', hex: 'FFD700' },
    { name: 'Zitrone', hex: 'FFF44F' },
    { name: 'Hellgrün', hex: '90EE90' },
    { name: 'Grün', hex: '008000' },
    { name: 'Dunkelgrün', hex: '006400' },
    { name: 'Lime', hex: '32CD32' },
    { name: 'Neon Grün', hex: '39FF14' },
    { name: 'Oliv', hex: '808000' },
    { name: 'Wald', hex: '228B22' },
    { name: 'Teal', hex: '008080' },
    { name: 'Türkis', hex: '40E0D0' },
    { name: 'Cyan', hex: '00FFFF' },
    { name: 'Himmelblau', hex: '87CEEB' },
    { name: 'Blau', hex: '0000FF' },
    { name: 'Königsblau', hex: '4169E1' },
    { name: 'Marineblau', hex: '000080' },
    { name: 'Violett', hex: '8A2BE2' },
    { name: 'Lila', hex: '800080' },
    { name: 'Lavendel', hex: 'E6E6FA' },
    { name: 'Magenta', hex: 'FF00FF' },
    { name: 'Pink', hex: 'FF69B4' },
    { name: 'Rosa', hex: 'FFB6C1' },
    { name: 'Braun', hex: '8B4513' },
    { name: 'Schokolade', hex: 'D2691E' },
    { name: 'Sand', hex: 'D2B48C' },
    { name: 'Silber', hex: 'C0C0C0' },
    { name: 'Bronze', hex: 'CD7F32' },
    { name: 'Kupfer', hex: 'B87333' },
    { name: 'Hautfarbe', hex: 'FFCBA4' },
    { name: 'Transparent', hex: 'FDFDFD' },
  ],

  buildSwatchGrid(index, appRef) {
    const grid = document.getElementById(`colorSwatchGrid${index}`);
    if (!grid) return;
    grid.innerHTML = '';

    this.FILAMENT_COLORS.forEach(c => {
      const el = document.createElement('div');
      el.className = 'cs';
      el.title = c.name;
      el.style.background = '#' + c.hex;

      if (c.hex === '000000' || c.hex === '000080' || c.hex === '0000FF'
        || c.hex === '8B0000' || c.hex === '006400' || c.hex === '722F37'
        || c.hex === '800080' || c.hex === '404040' || c.hex === '008000'
        || c.hex === '008080' || c.hex === '228B22') {
        el.style.border = '2px solid rgba(255,255,255,0.15)';
      }

      el.addEventListener('click', () => {
        grid.querySelectorAll('.cs').forEach(s => s.classList.remove('selected'));
        el.classList.add('selected');
        this.selectColor(index, c.hex, appRef);
      });
      grid.appendChild(el);
    });
  },

  selectColor(index, hex, appRef) {
    const inputEl = document.getElementById(`colorHex${index}`);
    if (inputEl) inputEl.value = hex;
    const preview = document.getElementById(`colorPreview${index}`);
    if (preview) preview.style.background = '#' + hex;

    const hsv = this.hexToHsv(hex);
    if (hsv) {
      this.state[index] = this.state[index] || {};
      [this.state[index].hue, this.state[index].s, this.state[index].v] = hsv;
    }

    if (appRef && typeof appRef.updateColor === 'function') appRef.updateColor('#' + hex, index);
    if (appRef && typeof appRef.updateRecordSize === 'function') appRef.updateRecordSize();
  },

  highlightSwatch(index) {
    const grid = document.getElementById(`colorSwatchGrid${index}`);
    if (!grid) return;
    const inputEl = document.getElementById(`colorHex${index}`);
    const currentHex = (inputEl && inputEl.value || 'FFFFFF').toUpperCase();
    grid.querySelectorAll('.cs').forEach(s => {
      const swatchHex = s.style.background
        ? this._bgToHex(s.style.background)
        : '';
      s.classList.toggle('selected', swatchHex === currentHex);
    });
  },

  _bgToHex(bg) {
    const m = bg.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (m) {
      return [m[1], m[2], m[3]]
        .map(x => parseInt(x).toString(16).padStart(2, '0'))
        .join('').toUpperCase();
    }
    return bg.replace('#', '').toUpperCase();
  },

  init(appRef, count = 4) {
    for (let i = 1; i <= count; i++) {
      const inputEl = document.getElementById(`colorHex${i}`);
      const initialHex = (inputEl && inputEl.value) || 'FFFFFF';
      const hsv = this.hexToHsv(initialHex) || [0, 0, 1];
      this.state[i] = { hue: hsv[0], s: hsv[1], v: hsv[2] };

      this.buildSwatchGrid(i, appRef);

      if (inputEl) {
        inputEl.addEventListener('input', () => {
          const hex = inputEl.value.trim();
          if (!/^[0-9a-fA-F]{6}$/.test(hex)) return;
          const hsv = this.hexToHsv(hex);
          if (!hsv) return;
          [this.state[i].hue, this.state[i].s, this.state[i].v] = hsv;
          const preview = document.getElementById(`colorPreview${i}`);
          if (preview) preview.style.background = '#' + hex;
          if (appRef && typeof appRef.updateColor === 'function') appRef.updateColor('#' + hex, i);
          this.highlightSwatch(i);
        });
      }

      this.highlightSwatch(i);
    }
  }
};
