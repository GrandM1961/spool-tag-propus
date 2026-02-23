const ProfileDB = {
  BASE_URL: '',

  init() {
    const loc = window.location;
    this.BASE_URL = `${loc.protocol}//${loc.host}/api`;
  },

  async fetchJson(path, params = {}) {
    const url = new URL(`${this.BASE_URL}/${path}`);
    Object.entries(params).forEach(([k, v]) => {
      if (v) url.searchParams.set(k, v);
    });
    const fetchFn = (typeof Auth !== 'undefined' && Auth.fetch) ? Auth.fetch.bind(Auth) : fetch;
    const resp = await fetchFn(url, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
  },

  async getProfileVendors() {
    return this.fetchJson('profiles/vendors');
  },

  async getProfileMaterials(vendor) {
    return this.fetchJson('profiles/materials', { vendor });
  },

  async searchProfiles(params) {
    return this.fetchJson('profiles', params);
  },

  async getProfile(id) {
    return this.fetchJson(`profiles/${id}`);
  },

  getDownloadUrl(id) {
    return `${this.BASE_URL}/profiles/${id}/download`;
  },

  async getFilamentBrands() {
    return this.fetchJson('filaments/brands');
  },

  async getFilamentMaterials(brand) {
    return this.fetchJson('filaments/materials', { brand });
  },

  async searchFilaments(params) {
    return this.fetchJson('filaments', params);
  },

  async getFilament(id) {
    return this.fetchJson(`filaments/${id}`);
  },

  async getSyncStatus() {
    return this.fetchJson('sync/status');
  },

  async triggerSync() {
    const url = `${this.BASE_URL}/sync/trigger`;
    const fetchFn = (typeof Auth !== 'undefined' && Auth.fetch) ? Auth.fetch.bind(Auth) : fetch;
    const resp = await fetchFn(url, { method: 'POST' });
    return resp.json();
  }
};

ProfileDB.init();
