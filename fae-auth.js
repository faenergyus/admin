// fae-auth.js — shared auth helper for every gated analyst page.
//
// Why this exists: a fresh Google ID token (response.credential) lives ~60 min,
// so any page that ships it as `Authorization: Bearer <google_jwt>` starts 401-ing
// after roughly an hour of idle time. The analyst API mints a long-lived FAE
// session token at POST /auth/session (Authorization: Bearer <google_jwt>) and
// every gated endpoint accepts either token. Once the FAE token is in hand
// (saved on the existing fae_user session under `faeToken`), all API calls
// should use it — and a 30-day expiry means one Google sign-in is enough.
//
// Public surface (window.faeAuth):
//   getApiToken(apiBase)  → async, returns the cached fae1.* token; lazily
//                           exchanges the cached Google JWT once if needed;
//                           returns null when neither is present.
//   readSessionToken()    → sync, returns the cached fae1.* token or null.
//   ensureSessionToken(apiBase) → async, mints a fae token if missing but a
//                           Google JWT is cached. Returns the token or null.
//   fetchAuthed(apiBase, url, opts) → fetch with Bearer <session_token> set
//                           automatically. Retries once on 401 after a fresh
//                           exchange. Caller still gets the final Response.

(function () {
  var SESSION_KEY = 'fae_user';

  function loadSession() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); }
    catch (e) { return null; }
  }
  function saveSession(s) {
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (e) {}
  }

  function readSessionToken() {
    var s = loadSession();
    return (s && s.faeToken) ? s.faeToken : null;
  }

  function readGoogleCredential() {
    var s = loadSession();
    if (!s) return null;
    return s.credential || s.token || null;
  }

  // Coalesce concurrent callers so we only POST /auth/session once.
  var _exchanging = null;
  function exchange(apiBase, googleJwt) {
    if (_exchanging) return _exchanging;
    _exchanging = (async function () {
      try {
        if (!apiBase || !googleJwt) return null;
        var r = await fetch(apiBase + '/auth/session', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + googleJwt }
        });
        if (!r.ok) return null;
        var j = await r.json();
        var tok = j && j.session_token;
        if (!tok) return null;
        var s = loadSession() || {};
        s.faeToken = tok;
        saveSession(s);
        return tok;
      } catch (e) { return null; }
    })().finally(function () { _exchanging = null; });
    return _exchanging;
  }

  async function ensureSessionToken(apiBase) {
    var cached = readSessionToken();
    if (cached) return cached;
    var cred = readGoogleCredential();
    if (!cred) return null;
    return await exchange(apiBase, cred);
  }

  async function getApiToken(apiBase) {
    return await ensureSessionToken(apiBase);
  }

  // ── Soft-retry banner + offline-aware fetch ─────────────────────────
  // When the API is offline (network error or 502/503/504 gateway from
  // Cloudflare) we keep the failed fetch pending, show a top-of-page
  // banner, poll /health every 5 s, and re-fire the original request
  // once it comes back. UI state is preserved — no page reload.
  // Server-side healer (FAE-API-Healer on svrxspoc, every 2 min) is what
  // actually brings the API back; this is the client-side counterpart
  // that keeps the user from having to refresh manually.
  var _retryCount = 0;
  var _banner = null;
  function _ensureBanner() {
    if (_banner) return _banner;
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', _ensureBanner);
      return null;
    }
    _banner = document.createElement('div');
    _banner.id = 'fae-offline-banner';
    _banner.style.cssText =
      'position:fixed;top:0;left:0;right:0;z-index:99999;' +
      'background:#e0a64a;color:#1a1a1a;font-weight:600;' +
      'padding:8px 12px;text-align:center;' +
      'font-family:"Segoe UI",Roboto,Helvetica,Arial,sans-serif;' +
      'box-shadow:0 1px 6px rgba(0,0,0,0.25);display:none;' +
      'animation:fae-pulse 1.8s ease-in-out infinite;';
    _banner.textContent = 'API offline — reconnecting…';
    if (!document.getElementById('fae-pulse-kf')) {
      var st = document.createElement('style');
      st.id = 'fae-pulse-kf';
      st.textContent =
        '@keyframes fae-pulse{0%,100%{opacity:1}50%{opacity:0.55}}';
      document.head.appendChild(st);
    }
    document.body.appendChild(_banner);
    return _banner;
  }
  function _showBanner() {
    _retryCount++;
    var b = _ensureBanner();
    if (b) b.style.display = 'block';
  }
  function _hideBanner() {
    _retryCount = Math.max(0, _retryCount - 1);
    if (_retryCount === 0 && _banner) _banner.style.display = 'none';
  }
  function _delay(ms) {
    return new Promise(function (res) { setTimeout(res, ms); });
  }
  // Single-shot health probe — distinguishes a real full outage from a
  // single endpoint flapping. Returns true if /health answers 200.
  function _healthOk(apiBase) {
    return fetch(apiBase + '/health', { cache: 'no-store' })
      .then(function (r) { return r.ok; })
      .catch(function () { return false; });
  }
  // One shared polling loop — N concurrent failed fetches share it. Used
  // ONLY for a real full outage (/health itself down); resolves when the
  // whole API comes back.
  var _apiWait = null;
  function _waitForApi(apiBase) {
    if (_apiWait) return _apiWait;
    _apiWait = (async function () {
      while (true) {
        if (await _healthOk(apiBase)) return;
        await _delay(5000);
      }
    })().finally(function () { _apiWait = null; });
    return _apiWait;
  }
  function _looksOffline(err, resp) {
    if (err) return true;  // network / TypeError
    if (!resp) return true;
    var s = resp.status;
    return (s === 502 || s === 503 || s === 504);
  }
  // Endpoint-level flapping (502/503/504 while /health is fine) gets a
  // bounded retry with backoff so a transient gateway blip can't turn into
  // an infinite hammer-loop that pulses the banner forever AND floods the
  // origin with connections (which makes the blip worse).
  var MAX_ENDPOINT_RETRIES = 5;

  async function fetchAuthed(apiBase, url, opts) {
    opts = Object.assign({}, opts || {});
    opts.headers = Object.assign({}, opts.headers || {});
    var inRetry = false;
    var endpointTries = 0;
    while (true) {
      var tok = await ensureSessionToken(apiBase);
      if (tok) opts.headers['Authorization'] = 'Bearer ' + tok;
      var r = null, err = null;
      try { r = await fetch(url, opts); }
      catch (e) { err = e; }
      if (_looksOffline(err, r)) {
        // Is the whole API down, or is just this one request flapping?
        var healthy = await _healthOk(apiBase);
        if (!healthy) {
          // Real full outage: keep the request pending, show the banner,
          // and resume the instant the API recovers (unbounded — this is
          // the genuine "reconnecting" case).
          endpointTries = 0;
          if (!inRetry) { _showBanner(); inRetry = true; }
          try { await _waitForApi(apiBase); } catch (e) {}
          continue;
        }
        // /health is fine but this endpoint returned a gateway error —
        // a transient localhost/proxy blip. Retry with backoff, capped.
        endpointTries++;
        if (endpointTries > MAX_ENDPOINT_RETRIES) {
          // Give up gracefully: drop the banner and hand the failed
          // response (or a thrown error) back to the caller so it can
          // show its own normal error state instead of pulsing forever.
          if (inRetry) { _hideBanner(); inRetry = false; }
          if (r) return r;
          throw (err || new Error('network error'));
        }
        if (!inRetry) { _showBanner(); inRetry = true; }
        await _delay(Math.min(endpointTries * 1200, 5000));
        continue;  // re-fire the original request
      }
      endpointTries = 0;
      if (inRetry) { _hideBanner(); inRetry = false; }
      if (r.status === 401 && tok) {
        // Treat the cached fae token as bad and re-exchange from the
        // Google JWT.
        var s = loadSession() || {};
        delete s.faeToken;
        saveSession(s);
        var fresh = await ensureSessionToken(apiBase);
        if (fresh && fresh !== tok) {
          opts.headers['Authorization'] = 'Bearer ' + fresh;
          try { r = await fetch(url, opts); } catch (e) {}
        }
      }
      return r;
    }
  }

  // ── Role lookup via /wbd/whoami (the canonical FAE auth endpoint) ─────
  // Do NOT fetch the Accounts spreadsheet from the client — the api_server
  // already exposes /wbd/whoami which returns {email, role, can_edit}. The
  // server keeps a 5-min in-memory cache of the Accounts sheet, so role
  // revocations propagate within ~5 min without a sign-out. We mirror that
  // window in sessionStorage so a quick page-to-page click doesn't repay
  // the round-trip on every nav. Per the fae-auth-roles skill:
  //   * UI gating is convenience; enforcement is server-side
  //   * role must NOT be baked into the long-lived session blob
  var WHOAMI_PATH = '/wbd/whoami';
  var ROLE_CACHE_KEY = 'fae_role_v1';   // sessionStorage, NOT local
  var ROLE_TTL_MS    = 5 * 60 * 1000;   // matches server _fetch_accounts cache

  function _readRoleCache(email) {
    try {
      var raw = sessionStorage.getItem(ROLE_CACHE_KEY);
      if (!raw) return null;
      var c = JSON.parse(raw);
      if (!c || c.email !== email) return null;
      if (Date.now() - (c.ts || 0) > ROLE_TTL_MS) return null;
      return c;   // { email, role, canEdit, ts }
    } catch (e) { return null; }
  }
  function _writeRoleCache(email, role, canEdit) {
    try {
      sessionStorage.setItem(ROLE_CACHE_KEY, JSON.stringify({
        email: email, role: (role || '').toLowerCase(),
        canEdit: !!canEdit, ts: Date.now(),
      }));
    } catch (e) {}
  }

  function userEmail() {
    var s = loadSession();
    return (s && s.email) ? String(s.email).toLowerCase() : null;
  }
  // Synchronous read of the cached role — null if cache is cold/expired.
  // Callers that need a definitive answer should `await ensureUserRole()`.
  function userRole() {
    var email = userEmail();
    if (!email) return null;
    var c = _readRoleCache(email);
    return c ? c.role : null;
  }

  // Resolve the analyst's API base URL. The auth helper isn't told about
  // it directly, so we sniff window.faeApiBase (set by pages that load
  // config.json). Falls back to api.40ac.us which is correct for prod.
  function _apiBase() {
    if (window.faeApiBase) return String(window.faeApiBase).replace(/\/$/, '');
    return 'https://api.40ac.us';
  }

  var _roleFetch = null;
  async function ensureUserRole(force) {
    var email = userEmail();
    if (!email) return null;
    if (!force) {
      var cached = _readRoleCache(email);
      if (cached) return cached.role;
    }
    if (_roleFetch) return _roleFetch;
    _roleFetch = (async function () {
      try {
        var r = await fetchAuthed(_apiBase(), _apiBase() + WHOAMI_PATH);
        if (!r.ok) return null;
        var j = await r.json();
        var role = (j && j.role ? String(j.role) : '').toLowerCase();
        _writeRoleCache(email, role, !!(j && j.can_edit));
        return role;
      } catch (e) { return null; }
      finally { setTimeout(function () { _roleFetch = null; }, 0); }
    })();
    return _roleFetch;
  }

  // ── Nav gating: role-based UI hides ─────────────────────────────────
  // (Server enforcement is the real protection — see get_non_pumper in
  // api_server.py. These hides are convenience.)
  //
  //   role NOT in {admin, engineer, tech}  → hide Sales Analysis (sidebar + cards)
  //   role NOT in {admin, engineer, tech}  → hide Lonewolf filter + map visual
  //
  // Both gates only fire when role is KNOWN — `null` (cache cold) leaves the
  // UI alone so engineers don't see a flash of hidden state on first paint.
  // The boot path calls this twice: once sync with whatever's cached, once
  // after ensureUserRole() resolves with the canonical answer from
  // /wbd/whoami.
  function applyRoleNavGates() {
    var role = userRole();
    if (!role) return;  // unknown — don't touch the DOM yet

    // ── 1) Financial Analysis: admin / engineer / tech / land / accounting ──
    // One section now holds Gas Sales, Gas Futures, Gas Statement Hist, Oil
    // Sales and GL. Items tagged .nav-financial; section header .nav-sec-financial.
    // Server mirror: get_non_pumper now allows FINANCIAL_ROLES.
    var financialOk = (role === 'admin' || role === 'engineer' || role === 'tech'
                       || role === 'land' || role === 'accounting');
    if (!financialOk) {
      document.querySelectorAll('a.nav-i.nav-financial, .nav-sec.nav-sec-financial')
        .forEach(function (el) { el.style.display = 'none'; });
      ['gas_analysis.html', 'gas_futures.html', 'meter_detail.html',
       'oil_analysis.html', 'cost_report.html'].forEach(function (h) {
        document.querySelectorAll('a.ncard[href="' + h + '"]')
          .forEach(function (a) { a.style.display = 'none'; });
      });
    }

    // ── 2) Land: admin / engineer / tech / land ──────────────────────
    // Lease Report. Items tagged .nav-land; header .nav-sec-land.
    // Server mirror: get_land (LAND_ROLES).
    var landOk = (role === 'admin' || role === 'engineer' || role === 'tech'
                  || role === 'land');
    if (!landOk) {
      document.querySelectorAll('a.nav-i.nav-land, .nav-sec.nav-sec-land')
        .forEach(function (el) { el.style.display = 'none'; });
      document.querySelectorAll('a.ncard[href="lease_report.html"]')
        .forEach(function (a) { a.style.display = 'none'; });
    }

    // ── 2b) Subsurface: admin / engineer / subsurface / tech / land ───
    // Pools (geologic pools / reservoir boundaries). Items tagged
    // .nav-subsurface; collapsible header .nav-sec-subsurface. NOTE:
    // server-side enforcement for /map/pools lives in the map lane —
    // coordinate there for true protection (this is UI convenience).
    var subsurfaceOk = (role === 'admin' || role === 'engineer'
                        || role === 'subsurface' || role === 'tech'
                        || role === 'land');
    if (!subsurfaceOk) {
      document.querySelectorAll('a.nav-i.nav-subsurface, .nav-sec.nav-sec-subsurface')
        .forEach(function (el) { el.style.display = 'none'; });
      document.querySelectorAll('a.ncard[href="pools.html"]')
        .forEach(function (a) { a.style.display = 'none'; });
    }

    // ── 3) Lonewolf gate: admin / engineer / tech only ───────────────
    var lonewolfOk = (role === 'admin' || role === 'engineer' || role === 'tech');
    if (!lonewolfOk) {
      // "Only Lonewolf-offer wells" filter checkbox (wrapped in <label>)
      var lwt = document.getElementById('lonewolfWellsToggle');
      if (lwt) {
        var lbl = lwt.closest('label');
        if (lbl) lbl.style.display = 'none';
        // Force the filter off so hidden state can't leak through saved views
        if (lwt.checked) {
          lwt.checked = false;
          try { lwt.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
        }
      }
      // "Lonewolf offer" map visual checkbox (wrapped in <h3>)
      var lot = document.getElementById('lonewolfToggle');
      if (lot) {
        var h3 = lot.closest('h3');
        if (h3) h3.style.display = 'none';
        if (lot.checked) {
          lot.checked = false;
          try { lot.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
        }
      }
    }
    // (Futures + Accounting are now folded into the Financial Analysis
    //  section above — no separate gates.)
  }

  // Collapsible nav section — generic. Clicking the section header toggles a
  // body-level class (persisted in localStorage) that hides the section's
  // items. One helper drives every collapsible section (Financial,
  // Subsurface, …); pages need only the .nav-sec-<x> header + .nav-<x> items.
  //   secCls  : section-header class      e.g. 'nav-sec-financial'
  //   itemCls : item class to hide        e.g. 'nav-financial'
  //   bodyCls : body toggle class         e.g. 'fin-collapsed'
  //   storeKey: localStorage persist key  e.g. 'fae_fin_collapsed'
  function _wireSectionCollapse(secCls, itemCls, bodyCls, storeKey) {
    var cssId = 'fae-collapse-css-' + bodyCls;
    if (!document.getElementById(cssId)) {
      var st = document.createElement('style');
      st.id = cssId;
      st.textContent =
        '.' + secCls + '{cursor:pointer;user-select:none;}'
      + '.' + secCls + '::after{content:" \\25BE";font-size:.7em;opacity:.65;}'
      + 'body.' + bodyCls + ' .' + secCls + '::after{content:" \\25B8";}'
      + 'body.' + bodyCls + ' a.nav-i.' + itemCls + '{display:none !important;}';
      document.head.appendChild(st);
    }
    try {
      if (localStorage.getItem(storeKey) === '1')
        document.body.classList.add(bodyCls);
    } catch (e) {}
    document.querySelectorAll('.' + secCls).forEach(function (sec) {
      if (sec.dataset.collapseWired) return;
      sec.dataset.collapseWired = '1';
      sec.addEventListener('click', function () {
        var c = document.body.classList.toggle(bodyCls);
        try { localStorage.setItem(storeKey, c ? '1' : '0'); } catch (e) {}
      });
    });
  }

  // Auto-apply on every page load. Fire once now (in case role is already on
  // the cached session), then again after the lazy CSV lookup resolves so
  // legacy sessions without role pick up gating without a refresh.
  function _bootRoleGating() {
    try { applyRoleNavGates(); } catch (e) {}
    try {
      _wireSectionCollapse('nav-sec-financial',  'nav-financial',  'fin-collapsed',  'fae_fin_collapsed');
      _wireSectionCollapse('nav-sec-subsurface', 'nav-subsurface', 'sub-collapsed',  'fae_sub_collapsed');
      _wireSectionCollapse('nav-sec-land',       'nav-land',       'land-collapsed', 'fae_land_collapsed');
    } catch (e) {}
    ensureUserRole().then(function () {
      try { applyRoleNavGates(); } catch (e) {}
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _bootRoleGating);
  } else {
    _bootRoleGating();
  }

  window.faeAuth = {
    SESSION_KEY: SESSION_KEY,
    readSessionToken: readSessionToken,
    readGoogleCredential: readGoogleCredential,
    exchange: exchange,
    ensureSessionToken: ensureSessionToken,
    getApiToken: getApiToken,
    fetchAuthed: fetchAuthed,
    userRole: userRole,
    userEmail: userEmail,
    ensureUserRole: ensureUserRole,
    applyRoleNavGates: applyRoleNavGates,
  };
})();
