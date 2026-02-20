const QR = {
  _qrLib: null,
  _stream: null,
  _animFrame: null,

  get libLoaded() { return typeof qrcode === 'function'; },
  get hasBarcodeDetector() { return 'BarcodeDetector' in window; },
  get hasCamera() { return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia); },

  encodeData(formData) {
    const d = {};
    if (formData.materialType) d.m = formData.materialType;
    if (formData.brand && formData.brand !== 'Generic') d.b = formData.brand;
    if (formData.colorHex && formData.colorHex !== 'FFFFFF') d.c = formData.colorHex;
    if (formData.minTemp) d.tn = parseInt(formData.minTemp);
    if (formData.maxTemp) d.tx = parseInt(formData.maxTemp);
    if (formData.bedTempMin) d.bn = parseInt(formData.bedTempMin);
    if (formData.bedTempMax) d.bx = parseInt(formData.bedTempMax);
    if (formData.materialName) d.n = formData.materialName;
    if (formData.extendedSubType && formData.extendedSubType !== 'Basic') d.s = formData.extendedSubType;
    if (formData.density) d.de = parseFloat(formData.density);
    if (formData.lotNr) d.l = formData.lotNr;
    d.v = 1;
    return JSON.stringify(d);
  },

  decodeData(raw) {
    let obj;
    if (raw.startsWith('{')) {
      obj = JSON.parse(raw);
    } else if (raw.includes('?spool=') || raw.includes('?d=')) {
      const url = new URL(raw);
      const param = url.searchParams.get('spool') || url.searchParams.get('d');
      if (param) obj = JSON.parse(atob(param));
    } else if (raw.includes('?')) {
      const url = new URL(raw);
      obj = {};
      if (url.searchParams.get('m')) obj.m = url.searchParams.get('m');
      if (url.searchParams.get('b')) obj.b = url.searchParams.get('b');
      if (url.searchParams.get('c')) obj.c = url.searchParams.get('c');
    }
    if (!obj || !obj.m) return null;
    return {
      materialType: obj.m || 'PLA',
      brand: obj.b || 'Generic',
      colorHex: obj.c || 'FFFFFF',
      minTemp: obj.tn || '',
      maxTemp: obj.tx || '',
      bedTempMin: obj.bn || '',
      bedTempMax: obj.bx || '',
      materialName: obj.n || '',
      extendedSubType: obj.s || 'Basic',
      density: obj.de || '',
      lotNr: obj.l || '',
    };
  },

  generate(container, formData, appUrl) {
    const json = this.encodeData(formData);
    const urlData = appUrl
      ? `${appUrl}?spool=${btoa(json)}`
      : json;

    container.innerHTML = '';

    if (this.libLoaded) {
      try {
        const typeNumber = urlData.length > 150 ? 10 : urlData.length > 80 ? 6 : 4;
        const qr = qrcode(typeNumber, 'M');
        qr.addData(urlData);
        qr.make();

        const size = 8;
        const modules = qr.getModuleCount();
        const canvas = document.createElement('canvas');
        const total = modules * size + size * 2;
        canvas.width = total;
        canvas.height = total;
        canvas.style.cssText = 'max-width:280px;width:100%;height:auto;border-radius:12px;';
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, total, total);
        ctx.fillStyle = '#000000';
        for (let r = 0; r < modules; r++) {
          for (let c = 0; c < modules; c++) {
            if (qr.isDark(r, c)) {
              ctx.fillRect(c * size + size, r * size + size, size, size);
            }
          }
        }
        container.appendChild(canvas);
        return true;
      } catch (e) {
        console.warn('QR generation failed:', e);
      }
    }

    const img = document.createElement('img');
    img.src = `https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=${encodeURIComponent(urlData)}`;
    img.alt = 'QR Code';
    img.style.cssText = 'max-width:280px;width:100%;height:auto;border-radius:12px;background:#fff;';
    img.onerror = () => {
      container.innerHTML = '<p style="color:var(--error);font-size:0.85rem;">QR-Code konnte nicht erstellt werden (kein Internet?)</p>';
    };
    container.appendChild(img);
    return true;
  },

  async startScan(videoEl, onResult, onError) {
    if (!this.hasCamera) {
      onError('Keine Kamera verfügbar');
      return;
    }

    try {
      this._stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
      });
      videoEl.srcObject = this._stream;
      await videoEl.play();

      if (this.hasBarcodeDetector) {
        const detector = new BarcodeDetector({ formats: ['qr_code'] });
        const scan = async () => {
          try {
            const codes = await detector.detect(videoEl);
            if (codes.length > 0) {
              this.stopScan(videoEl);
              onResult(codes[0].rawValue);
              return;
            }
          } catch (e) {}
          this._animFrame = requestAnimationFrame(scan);
        };
        this._animFrame = requestAnimationFrame(scan);
      } else {
        this._scanWithCanvas(videoEl, onResult);
      }
    } catch (e) {
      onError(e.message === 'Permission denied'
        ? 'Kamera-Zugriff verweigert'
        : `Kamera-Fehler: ${e.message}`);
    }
  },

  _scanWithCanvas(videoEl, onResult) {
    if (typeof jsQR !== 'undefined') {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const scan = () => {
        if (!this._stream) return;
        canvas.width = videoEl.videoWidth;
        canvas.height = videoEl.videoHeight;
        ctx.drawImage(videoEl, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(imageData.data, canvas.width, canvas.height);
        if (code) {
          this.stopScan(videoEl);
          onResult(code.data);
          return;
        }
        this._animFrame = requestAnimationFrame(scan);
      };
      this._animFrame = requestAnimationFrame(scan);
    }
  },

  stopScan(videoEl) {
    if (this._animFrame) {
      cancelAnimationFrame(this._animFrame);
      this._animFrame = null;
    }
    if (this._stream) {
      this._stream.getTracks().forEach(t => t.stop());
      this._stream = null;
    }
    if (videoEl) {
      videoEl.srcObject = null;
    }
  },

  isScanning() {
    return this._stream !== null;
  }
};
