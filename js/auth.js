/* PedalPace — "Sign in with Google" via Google Identity Services (no backend).
 * The ID token is decoded in the browser only to read name / email / photo.
 * It is NOT verified here; a production backend must verify it with Google
 * before trusting the account (see docs/SETUP_GOOGLE.md). */
(function () {
  'use strict';
  const clientId = ((window.PEDALPACE_CONFIG || {}).googleClientId || '').trim();
  let onSignIn = null, initialised = false;
  const waiters = [];

  /** Why sign-in can't work here, or '' if it can. */
  function unavailableReason() {
    if (!clientId) return 'Google sign-in isn’t configured yet. Add your Client ID in js/config.js.';
    if (location.protocol === 'file:') return 'Google sign-in needs a web address. Run “node serve.js” and open http://localhost:5173.';
    return '';
  }

  function decodeJwt(token) {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(atob(part).split('').map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join(''));
    return JSON.parse(json);
  }

  // Load the GSI script on first use, then poll briefly for it.
  function whenReady(fn) {
    if (window.google && google.accounts && google.accounts.id) return fn();
    waiters.push(fn);
    if (waiters.length > 1) return;
    if (!document.querySelector('script[data-gsi]')) {
      const sc = document.createElement('script');
      sc.src = 'https://accounts.google.com/gsi/client'; sc.async = true; sc.dataset.gsi = '1';
      document.head.appendChild(sc);
    }
    let tries = 0;
    const t = setInterval(() => {
      if (window.google && google.accounts && google.accounts.id) { clearInterval(t); waiters.splice(0).forEach((f) => f()); }
      else if (++tries > 60) { clearInterval(t); waiters.length = 0; } // ~15 s: offline or blocked
    }, 250);
  }

  function ensureInit() {
    if (initialised) return;
    initialised = true;
    google.accounts.id.initialize({
      client_id: clientId,
      ux_mode: 'popup',
      auto_select: false,
      cancel_on_tap_outside: true,
      callback: (resp) => {
        try {
          const p = decodeJwt(resp.credential);
          onSignIn && onSignIn({ sub: p.sub, name: p.name || p.email, givenName: p.given_name || p.name || '', email: p.email, picture: p.picture || '' });
        } catch (e) { console.error('Google sign-in: could not read token', e); }
      },
    });
  }

  window.Auth = {
    unavailableReason,
    /** Register the handler called with {sub, name, givenName, email, picture}. */
    init(handler) { onSignIn = handler; },
    /** Render the official Google button into `el` (or an explanation if unavailable). */
    renderButton(el, dark) {
      if (!el) return;
      const why = unavailableReason();
      if (why) { el.innerHTML = `<p class="small muted gsi-note">🔒 ${why}</p>`; return; }
      el.innerHTML = '<p class="small muted gsi-note">Loading Google sign-in…</p>';
      whenReady(() => {
        ensureInit();
        el.innerHTML = '';
        google.accounts.id.renderButton(el, {
          type: 'standard', theme: dark ? 'filled_black' : 'outline', size: 'large',
          text: 'continue_with', shape: 'pill', logo_alignment: 'left',
          width: Math.min(360, Math.max(220, el.clientWidth || 300)),
        });
      });
    },
    signOut() {
      if (window.google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect();
    },
  };
})();
