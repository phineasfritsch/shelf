// Login page: JSON POST to /api/login from a real <form> (so password managers offer autofill),
// show/hide toggle, 429 countdown driven by Retry-After, and the QR "#link=<token>" claim flow.
// Classic script (loaded with `defer`); no inline handlers - CSP forbids them.
(function () {
  'use strict';

  const form = document.getElementById('login');
  const pw = document.getElementById('password');
  const toggle = document.getElementById('toggle-pw');
  const errorLine = document.getElementById('login-error');
  const linkStatus = document.getElementById('link-status');
  const submit = document.getElementById('login-submit');
  if (!form || !pw || !submit) return;

  const LINK_RE = /^#link=([A-Za-z0-9_-]{20,64})$/;
  let busy = false;
  let countdownTimer = null;

  // ---------- UI helpers ----------

  function setBusy(v) {
    busy = v;
    submit.disabled = v || countdownTimer !== null;
    form.classList.toggle('is-busy', v);
  }

  function showError(msg) {
    if (!errorLine) return;
    errorLine.textContent = msg || '';
    errorLine.hidden = !msg;
  }

  function showNote(msg) {
    if (!linkStatus) return;
    linkStatus.textContent = msg || '';
    linkStatus.hidden = !msg;
  }

  function stopCountdown() {
    if (countdownTimer !== null) { clearInterval(countdownTimer); countdownTimer = null; }
    submit.disabled = busy;
  }

  // "Too many attempts - try again in N s", ticking once a second until the lock lifts.
  function startCountdown(seconds) {
    stopCountdown();
    let left = Math.max(1, Math.ceil(seconds));
    const render = () => { showError(`Too many attempts - try again in ${left} s`); };
    render();
    submit.disabled = true;
    countdownTimer = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        stopCountdown();
        showError('You can try again now');
        return;
      }
      render();
    }, 1000);
  }

  function retryAfterSeconds(res, data) {
    const h = res.headers.get('retry-after');
    const n = Number(h);
    if (Number.isFinite(n) && n > 0) return n;
    // Retry-After may be an HTTP date; fall back to the message the server put in the JSON body.
    const m = /in (\d+)\s*s/.exec((data && data.message) || '');
    if (m) return Number(m[1]);
    return 15;
  }

  // ---------- network ----------

  // POST JSON; resolves { res, data } (data = parsed JSON body or null). Rejects only on a network failure.
  async function postJson(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    let data = null;
    const ct = res.headers.get('content-type') || '';
    if (ct.indexOf('application/json') !== -1) {
      try { data = await res.json(); } catch { data = null; }
    }
    return { res, data };
  }

  // Shared outcome handling for /api/login and /api/link/claim. Returns true when the session was created.
  function handleOutcome({ res, data }, { wrong }) {
    if (res.status === 204) {
      showError('');
      // The server set the session cookie; load the app. replace() keeps /login out of the history.
      location.replace('/');
      return true;
    }
    if (res.status === 401) { showError(wrong); return false; }
    if (res.status === 429) { startCountdown(retryAfterSeconds(res, data)); return false; }
    if (res.status === 403) { showError('Request blocked by the origin check - open Shelf by its own address, not through another site.'); return false; }
    const detail = data && (data.message || data.error);
    showError(`Login failed (HTTP ${res.status}${detail ? ': ' + detail : ''})`);
    return false;
  }

  // ---------- password form ----------

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy || countdownTimer !== null) return;
    const password = pw.value;
    if (!password) { showError('Enter the password'); pw.focus(); return; }
    showError('');
    setBusy(true);
    try {
      const outcome = await postJson('/api/login', { password });
      const ok = handleOutcome(outcome, { wrong: 'Wrong password' });
      if (!ok) { pw.focus(); try { pw.select(); } catch { /* ignore */ } }
    } catch {
      showError('Cannot reach the server - check the connection and try again');
    } finally {
      setBusy(false);
    }
  });

  if (toggle) {
    toggle.addEventListener('click', () => {
      const show = pw.type === 'password';
      pw.type = show ? 'text' : 'password';
      toggle.textContent = show ? 'Hide' : 'Show';
      toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      toggle.setAttribute('aria-pressed', show ? 'true' : 'false');
      // Keep the caret where it was so toggling mid-typing does not lose the position.
      const s = pw.selectionStart, en = pw.selectionEnd;
      pw.focus({ preventScroll: true });
      try { if (s != null && en != null) pw.setSelectionRange(s, en); } catch { /* not every type supports it */ }
    });
  }

  // ---------- QR link claim ----------
  // The phone scanned `${origin}/#link=<token>`; the server 302'd GET / to /login and the browser kept the
  // fragment. The token lives only in the fragment (never in a Referer or proxy log). Claim it once.

  function stripFragment() {
    try { history.replaceState(null, '', location.pathname + location.search); } catch { /* ignore */ }
  }

  async function claimLink(token) {
    showNote('Linking this device…');
    setBusy(true);
    try {
      const outcome = await postJson('/api/link/claim', { token });
      // Whatever the answer, the token is spent (or invalid): drop it from the URL and history.
      stripFragment();
      const ok = handleOutcome(outcome, { wrong: 'This link has expired or was already used - scan a new code or enter the password.' });
      if (ok) return;
      showNote('');
    } catch {
      showNote('');
      showError('Cannot reach the server - reload this page to try the link again, or enter the password.');
    } finally {
      setBusy(false);
    }
  }

  const m = LINK_RE.exec(location.hash || '');
  if (m) {
    claimLink(m[1]);
  } else if (location.hash && location.hash.indexOf('#link=') === 0) {
    // A mangled token: nothing to claim, do not leave junk in the URL.
    stripFragment();
    showError('This link is not valid - enter the password instead.');
  }
})();
