const Auth = {
  TOKEN_KEY: 'spooltag_token',
  _refreshing: false,

  getToken() {
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
    // Token in storage OR an auth cookie was set by the server
    if (this.getToken()) return true;
    // Check if the HttpOnly cookie likely exists by trying a cached flag
    // (we can't read HttpOnly cookies from JS, so we keep a non-sensitive
    //  "has_session" flag in localStorage that the login flow sets)
    return !!localStorage.getItem('spooltag_has_session');
  },

  setSessionFlag() {
    localStorage.setItem('spooltag_has_session', '1');
  },

  clearSessionFlag() {
    localStorage.removeItem('spooltag_has_session');
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
    return secsLeft < 3 * 24 * 3600;
  },

  async _tryRefresh() {
    if (this._refreshing) return false;
    this._refreshing = true;
    try {
      const loc = window.location;
      const resp = await fetch(`${loc.protocol}//${loc.host}/api/auth/refresh`, {
        method: 'POST',
        credentials: 'include',        // send + receive cookie
        headers: this.getHeaders()
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data.token) {
          const inLocal = !!localStorage.getItem(this.TOKEN_KEY);
          this.setToken(data.token, inLocal);
          this.setSessionFlag();
          return true;
        }
      }
    } catch { /* ignore */ }
    finally { this._refreshing = false; }
    return false;
  },

  async logout() {
    try {
      const loc = window.location;
      await fetch(`${loc.protocol}//${loc.host}/api/auth/logout`, {
        method: 'POST',
        credentials: 'include',
        headers: this.getHeaders()
      });
    } catch { /* ignore */ }
    this.clearToken();
    this.clearSessionFlag();
  },

  async fetch(url, options = {}) {
    // Proactively refresh if token is about to expire
    if (this._shouldRefresh()) {
      await this._tryRefresh();
    }

    const headers = { ...(options.headers || {}), ...this.getHeaders() };
    if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    const opts = { ...options, credentials: 'include' };  // always include cookies
    delete opts.headers;
    const resp = await fetch(url, { ...opts, headers });

    if (resp.status === 401) {
      // Try one refresh before giving up
      const refreshed = await this._tryRefresh();
      if (refreshed) {
        const retryHeaders = { ...(options.headers || {}), ...this.getHeaders() };
        const retryOpts = { ...options, credentials: 'include' };
        delete retryOpts.headers;
        const retryResp = await fetch(url, { ...retryOpts, headers: retryHeaders });
        if (retryResp.status !== 401) return retryResp;
      }
      // Truly unauthorized — clear and redirect to login
      this.clearToken();
      this.clearSessionFlag();
      window.location.reload();
    }
    return resp;
  }
};
