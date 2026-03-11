const I18n = {
    _lang: localStorage.getItem('spooltag_lang') || 'de',
    _strings: {},

    async init() {
        try {
            const [de, en, nl] = await Promise.all([
                fetch('i18n/de.json').then(r => r.json()),
                fetch('i18n/en.json').then(r => r.json()),
                fetch('i18n/nl.json').then(r => r.json())
            ]);
            this._strings = { de, en, nl };
            console.log('Loaded strings:', this._strings);
        } catch (e) {
            console.error('Failed to load language files:', e);
            alert('Could not load language translations. Defaulting to German.');
            this._strings = { de: {}, en: {}, nl: {} }; // Fallback
        }
    },

    t(key) {
    const keys = key.split('.');
    let obj = this._strings[this._lang] || this._strings.de;

    for (let i = 0; i < keys.length; i++) {
        const k = keys[i];

        // Wenn Array, nächsten Key als Index nehmen
        if (Array.isArray(obj)) {
            const index = parseInt(keys[i + 1]);
            if (!isNaN(index)) {
                obj = obj[index];
                i++; // Skip next key
                continue;
            }
        }

        obj = obj?.[k];
        if (obj === undefined) break;
    }
    return typeof obj === 'string' ? obj : key;
},

    setLanguage(lang) {
        const allowedLanguages = ['de', 'en', 'nl'];
        if (!allowedLanguages.includes(lang)) return;

        this._lang = lang;
        localStorage.setItem('spooltag_lang', lang);
        this.refreshElements();
    },

    getLanguage() {
        return this._lang;
    },

    refreshElements() {
        document.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.getAttribute('data-i18n');
            console.log('Translating key:', key);
            const val = this.t(key);
            el.textContent = val; // Use textContent for safety
        });
    }
};
