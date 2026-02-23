const I18n = {
  _lang: localStorage.getItem('spooltag_lang') || 'de',
  _strings: {},

  async init() {
    try {
      const [de, en] = await Promise.all([
        fetch('i18n/de.json').then(r => r.json()),
        fetch('i18n/en.json').then(r => r.json())
      ]);
      this._strings = { de, en };
    } catch (e) {
      this._strings = { de: {}, en: {} };
    }
  },

  t(key) {
    const keys = key.split('.');
    let obj = this._strings[this._lang] || this._strings.de;
    for (const k of keys) {
      obj = obj?.[k];
      if (obj === undefined) break;
    }
    return (typeof obj === 'string' ? obj : key);
  },

  setLanguage(lang) {
    if (lang !== 'de' && lang !== 'en') return;
    this._lang = lang;
    localStorage.setItem('spooltag_lang', lang);
  },

  getLanguage() {
    return this._lang;
  },

  refreshElements() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      const attr = el.getAttribute('data-i18n-attr') || (el.hasAttribute('data-i18n-placeholder') ? 'placeholder' : null);
      const val = this.t(key);
      if (attr) el.setAttribute(attr, val);
      else el.textContent = val;
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      const key = el.getAttribute('data-i18n-placeholder');
      el.setAttribute('placeholder', this.t(key));
    });
  }
};

function t(key) {
  return (typeof I18n !== 'undefined' && I18n.t) ? I18n.t(key) : key;
}
