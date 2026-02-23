const Auth = {
  TOKEN_KEY: 'spooltag_token',
  _refreshing: false,

  getToken() {
    // Prefer localStorage, fallback to sessionStorage
    return localStorage.getItem(this.TOKEN_KEY) || sessionStorage.getItem(this.TOKEN_KEY) || '';
  },

  setToken(token, remember = true) {
    if (token) {
      if (remember) {
        localStorage.setItem(this.TOKEN_KEY, token);
        sessionStorage.removeItem(this.TOKEN_KEY);
      } else {
        sessionStorage.setItem(this.TOKEN_KEY, token);
        localStorage.removeItem(this.TOKEN_KEY);
      }
    } else {
      localStorage.removeItem(this.TOKEN_KEY);
      sessionStorage.removeItem(this.TOKEN_KEY);
    }
  },

  clearToken() {
    localStorage.removeItem(this.TOKEN_KEY);
    sessionStorage.removeItem(this.TOKEN_KEY);
  },

  isLoggedIn() {
    return !!this.getToken();
  },

  getHeaders() {
    const token = this.getToken();
    const h = { 'Content-Type': 'application/json' };
    if (token) h['Authorization'] = 'Bearer ' + token;
    return h;
  },

  // Decode JWT payload without verification (client-side only for expiry check)
  _decodeToken(token) {
    try {
      const payload = token.split('.')[1];
      return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    } catch { return null; }
  },

  // Check if token expires within next 3 days → proactively refresh
  _shouldRefresh() {
    const token = this.getToken();
    if (!token) return false;
    const payload = this._decodeToken(token);
    if (!payload || !payload.exp) return false;
    const secsLeft = payload.exp - (Date.now() / 1000);
    return secsLeft < 3 * 24 * 3600; // less than 3 days left
  },

  async _tryRefresh() {
    if (this._refreshing) return false;
    this._refreshing = true;
    try {
      const loc = window.location;
      const resp = await fetch(`${loc.protocol}//${loc.host}/api/auth/refresh`, {
        method: 'POST',
        headers: this.getHeaders()
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data.token) {
          // Keep same storage type (remember vs session)
          const inLocal = !!localStorage.getItem(this.TOKEN_KEY);
          this.setToken(data.token, inLocal);
          return true;
        }
      }
    } catch { /* ignore */ }
    finally { this._refreshing = false; }
    return false;
  },

  async fetch(url, options = {}) {
    // Proactively refresh if token is about to expire
    if (this._shouldRefresh()) {
      await this._tryRefresh();
    }

    const headers = { ...(options.headers || {}), ...this.getHeaders() };
    if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    const opts = { ...options };
    delete opts.headers;
    const resp = await fetch(url, { ...opts, headers });

    if (resp.status === 401) {
      // Try one refresh before giving up
      const refreshed = await this._tryRefresh();
      if (refreshed) {
        // Retry the original request with new token
        const retryHeaders = { ...(options.headers || {}), ...this.getHeaders() };
        delete opts.headers;
        const retryResp = await fetch(url, { ...opts, headers: retryHeaders });
        if (retryResp.status !== 401) return retryResp;
      }
      // Truly unauthorized — clear and redirect to login
      this.clearToken();
      window.location.reload();
    }
    return resp;
  }
};
