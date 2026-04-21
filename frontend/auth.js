// auth.js — Token management and auth helpers for SafeRoute frontend

const API_BASE = window.location.origin;

// ---------------------------------------------------------------------------
// Token / user persistence (localStorage)
// ---------------------------------------------------------------------------

function getToken() {
  return localStorage.getItem('sr_token');
}

function setToken(t) {
  localStorage.setItem('sr_token', t);
}

function clearToken() {
  localStorage.removeItem('sr_token');
}

function setUser(u) {
  localStorage.setItem('sr_user', JSON.stringify(u));
}

function getUser() {
  try {
    return JSON.parse(localStorage.getItem('sr_user'));
  } catch {
    return null;
  }
}

function clearUser() {
  localStorage.removeItem('sr_user');
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

/**
 * Build fetch headers.
 * @param {boolean} withContentType — include Content-Type: application/json
 * @returns {HeadersInit}
 */
function authHeaders(withContentType = true) {
  const headers = {};
  if (withContentType) {
    headers['Content-Type'] = 'application/json';
  }
  const token = getToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

// ---------------------------------------------------------------------------
// Token verification
// ---------------------------------------------------------------------------

/**
 * Verify the stored token by calling GET /auth/me.
 * Returns the user object if valid, null otherwise.
 * Clears token from storage if the server rejects it.
 */
async function verifyToken() {
  const token = getToken();
  if (!token) return null;

  try {
    const resp = await fetch(`${API_BASE}/auth/me`, {
      headers: authHeaders(false),
    });

    if (resp.ok) {
      const user = await resp.json();
      setUser(user);
      return user;
    }

    // 401 / 403 — token invalid or expired
    if (resp.status === 401 || resp.status === 403) {
      clearToken();
      clearUser();
    }
    return null;
  } catch {
    // Network error — don't clear token, just return null
    return null;
  }
}

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------

function logout() {
  // Stop geolocation watch if app.js has started one
  if (typeof stopPositionWatch === 'function') stopPositionWatch();
  clearToken();
  clearUser();
  window.location.href = 'login.html';
}
