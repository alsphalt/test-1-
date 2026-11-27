/* ============================================================================
   DARKNOTE NEXUS bridge
   ----------------------------------------------------------------------------
   Replaces this page's localStorage simulation with the real backend:
     - accounts/sessions  → /api/auth/*
     - bot state          → /api/bots
     - WhatsApp numbers   → /api/whatsapp/sessions (+ SSE /api/events)
   The original markup, CSS and animations are untouched; only the data layer
   and the three bot buttons are rewired.
   ========================================================================== */
(function () {
  'use strict';

  var state = { me: null, bots: [], sessions: [], botId: null, es: null, busy: false, installEvent: null };
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var esc = window.esc || function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); };

  async function api(path, opts) {
    opts = opts || {};
    var headers = {};
    if (opts.body) headers['content-type'] = 'application/json';
    var res;
    try {
      res = await fetch(path, { method: opts.method || 'GET', headers: headers, body: opts.body, credentials: 'same-origin', cache: 'no-store' });
    } catch (e) {
      throw new Error('Cannot reach the server. Check your connection.');
    }
    var data = null;
    try { data = await res.json(); } catch (e) { /* empty body */ }
    if (!res.ok) {
      var err = new Error((data && data.error && data.error.message) || ('Request failed (' + res.status + ')'));
      err.status = res.status;
      err.code = data && data.error && data.error.code;
      throw err;
    }
    return data;
  }

  /* ------------------------------- local UI seed --------------------------- */
  function seedLocal(user) {
    try {
      var users = window.load('dn_users') || {};
      users[user.email] = { name: user.name, salt: '', hash: '', avatar: user.avatar || null, avatarAt: Date.now() };
      window.save('dn_users', users);
      window.save('dn_session', { email: user.email });
    } catch (e) { /* storage may be disabled */ }
  }

  function enterApp(user) {
    seedLocal(user);
    state.me = user;
    try { window.enter(user.email); } catch (e) {
      var auth = document.getElementById('dn-auth');
      var main = document.getElementById('dn-main');
      if (auth) auth.classList.remove('show');
      if (main) main.classList.add('show');
    }
    var nameEl = document.getElementById('who-name');
    if (nameEl && user.name) nameEl.textContent = user.name;
  }

  /* --------------------------------- refresh ------------------------------- */
  var refreshTimer = null;
  async function refresh() {
    var results = await Promise.all([
      api('/api/auth/me').catch(function () { return null; }),
      api('/api/bots').catch(function () { return { bots: [] }; }),
      api('/api/whatsapp/sessions').catch(function () { return { sessions: [] }; })
    ]);
    if (results[0] && results[0].user) state.me = results[0].user;
    state.bots = (results[1] && results[1].bots) || [];
    state.sessions = (results[2] && results[2].sessions) || [];
    var preferred = state.bots.filter(function (b) { return b.paired && b.enabled; })[0] || state.bots[0];
    state.botId = preferred ? preferred.id : null;

    paintState();
    try { window.drawPairState(); } catch (e) {}
    try { window.drawRows(); } catch (e) {}
    paintProvision();
    var rows = document.getElementById('pp-rows');
    if (rows && !rows.children.length) {
      var pairs = window.activePairs ? window.activePairs() : [];
      if (pairs.length) try { window.drawRows(); } catch (e) {}
    }
  }
  /** The page's own badge renderer lives in a closure, so paint it directly. */
  function paintState() {
    var el = document.getElementById('pp-state');
    if (!el) return;
    var n = connectedSessions().length;
    var max = window.MAX_PAIRS || 200;
    if (agentOnline()) {
      el.textContent = 'ONLINE \u00b7 ' + n + ' / ' + max + ' NUMBERS';
      el.className = 'pp-state on';
    } else {
      el.textContent = 'OFFLINE';
      el.className = 'pp-state off';
    }
  }

  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(function () { refreshTimer = null; refresh(); }, 400);
  }

  /* ------------------------------- bot state ------------------------------- */
  function activeBot() {
    return state.bots.filter(function (b) { return b.id === state.botId; })[0] || null;
  }
  function agentOnline() {
    var bot = activeBot();
    if (!bot) return false;
    var seen = bot.lastSeenAt ? Date.now() - Date.parse(bot.lastSeenAt) : Infinity;
    return Boolean(bot.enabled) && seen < 45000 && bot.status !== 'PAUSED' && bot.status !== 'OFFLINE';
  }
  function connectedSessions() {
    return state.sessions.filter(function (s) { return s.status === 'CONNECTED'; });
  }

  /* --------------------------- override page logic ------------------------- */
  window.botLinked = function () { return agentOnline(); };
  window.pairList = function () {
    return connectedSessions().map(function (s) {
      return { num: s.meNumber || s.phone, at: Date.parse(s.connectedAt || s.createdAt) || Date.now(), status: 'connected' };
    });
  };
  window.activePairs = function () { return window.pairList(); };
  window.endAllPairs = function () { /* server is the source of truth */ };
  window.logPair = function () { /* pairing happens on the server */ };

  window.botStatus = function () {
    var bot = activeBot();
    var panel = document.getElementById('pp-panel');
    if (!panel) return;
    panel.innerHTML = '<div class="pp-note">Bot: <b>' + esc(bot ? bot.name : 'none') +
      '</b><br>Agent: <b>' + (agentOnline() ? 'online' : 'offline') +
      '</b><br>Last seen: <b>' + esc(bot && bot.lastSeenAt ? new Date(bot.lastSeenAt).toLocaleString() : 'never') +
      '</b><br>Version: <b>' + esc(bot && bot.version ? bot.version : '—') +
      '</b><br>Numbers linked: <b>' + connectedSessions().length +
      '</b><br>Signed in as: <b>' + esc(state.me ? state.me.email : '—') + '</b></div>';
    paintState();
    paintState();
    try { window.drawPairState(); } catch (e) {}
  };

  window.botReconnect = async function () {
    var panel = document.getElementById('pp-panel');
    var bot = activeBot();
    if (!bot) {
      if (panel) panel.innerHTML = '<div class="pp-offline">No bot is registered on this account. Create one in the website dashboard first.</div>';
      return;
    }
    var target = connectedSessions()[0] || state.sessions[0];
    if (!target) {
      if (panel) panel.innerHTML = '<div class="pp-offline">The agent is ' + (agentOnline() ? 'online' : 'offline') +
        ', but no WhatsApp number is linked yet. Add a number below — the bot process itself is started on its host.</div>';
      return;
    }
    try {
      if (panel) panel.innerHTML = '<div class="pp-note">Asking the bot to reconnect…</div>';
      await api('/api/whatsapp/sessions/' + target.id + '/restart', { method: 'POST' });
      await sleep(1200);
      await refresh();
      if (panel) panel.innerHTML = '<div class="pp-note">Reconnect requested. The bot reports back within one sync cycle (~10s).</div>';
    } catch (e) {
      if (panel) panel.innerHTML = '<div class="pp-offline">' + esc(e.message) + '</div>';
    }
  };

  window.botDisconnect = async function () {
    var panel = document.getElementById('pp-panel');
    var target = connectedSessions()[0];
    if (!target) {
      if (panel) panel.innerHTML = '<div class="pp-note">No connected number to unlink.</div>';
      return;
    }
    if (!window.confirm('Unlink +' + (target.meNumber || target.phone) + '? It must be paired again.')) return;
    try {
      await api('/api/whatsapp/sessions/' + target.id + '/logout', { method: 'POST' });
      await refresh();
      if (panel) panel.innerHTML = '<div class="pp-note">Unlink queued. The bot will close that session on its next sync.</div>';
    } catch (e) {
      if (panel) panel.innerHTML = '<div class="pp-offline">' + esc(e.message) + '</div>';
    }
  };

  async function waitForCode(id, out) {
    for (var i = 0; i < 24; i++) {
      await sleep(1500);
      var res = await api('/api/whatsapp/sessions/' + id);
      var s = res.session;
      if (s.status === 'CONNECTED') {
        out.innerHTML = '<div class="pp-note">+' + esc(s.meNumber || s.phone) + ' is already linked.</div>';
        return null;
      }
      if (s.pairingCode) return s.pairingCode;
      if (s.status === 'ERROR') {
        out.innerHTML = '<div class="pp-offline">' + esc(s.pairError || s.statusDetail || 'The bot could not issue a code.') + '</div>';
        return null;
      }
    }
    out.innerHTML = '<div class="pp-note">Still waiting for the bot. Make sure it is running, then try again.</div>';
    return null;
  }

  window.getPairCode = async function () {
    var input = document.getElementById('pp-num');
    var out = document.getElementById('pp-out');
    if (!input || !out) return;
    var num = input.value.replace(/\D/g, '');

    if (!/^\d{9,15}$/.test(num)) { out.innerHTML = '<p class="pp-err">Enter the full number with country code.</p>'; return; }
    if (!window.botLinked()) {
      out.innerHTML = '<div class="pp-offline">No bot agent is reporting right now. Start the bot process (it links to this site with its token), then try again.</div>';
      paintState();
    try { window.drawPairState(); } catch (e) {}
      return;
    }
    if (!state.botId) { out.innerHTML = '<div class="pp-offline">Create a bot in the dashboard first.</div>'; return; }
    if (window.activePairs().some(function (x) { return x.num === num; })) {
      out.innerHTML = '<p class="pp-err">+' + esc(num) + ' is already paired.</p>';
      return;
    }

    out.innerHTML = '<div class="pp-note">Contacting the bot — WhatsApp is generating the code…</div>';
    try {
      var created = await api('/api/whatsapp/sessions', {
        method: 'POST',
        body: JSON.stringify({ label: '+' + num, phone: num, botId: state.botId })
      });
      var code = await waitForCode(created.session.id, out);
      if (!code) { await refresh(); return; }
      out.innerHTML =
        '<div class="pp-code">' + esc(code) + '</div>' +
        '<div class="pp-note">On the phone: <b>WhatsApp → Linked devices → Link with phone number</b>. The code expires in about 60 seconds — press Get pairing code again for a fresh one.</div>';
      await refresh();
    } catch (e) {
      out.innerHTML = '<div class="pp-offline">' + esc(e.message) + '</div>';
    }
  };

  /* ----------------------------- auth interception ------------------------- */
  function showErr(id, message) {
    var el = document.getElementById(id);
    if (el) el.textContent = message || '';
  }

  window.addEventListener('submit', async function (event) {
    var form = event.target;
    if (!form || (form.id !== 'form-login' && form.id !== 'form-signup')) return;
    event.preventDefault();
    event.stopImmediatePropagation();

    if (form.id === 'form-login') {
      var email = (document.getElementById('li-email').value || '').trim();
      var pass = document.getElementById('li-pass').value || '';
      showErr('li-err', '');
      if (!email || !pass) return showErr('li-err', 'Enter your email and password.');
      try {
        var res = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: email, password: pass }) });
        enterApp(res.user);
        await refresh();
      } catch (e) {
        showErr('li-err', e.message);
      }
      return;
    }

    var name = (document.getElementById('su-name').value || '').trim();
    var suEmail = (document.getElementById('su-email').value || '').trim();
    var suPass = document.getElementById('su-pass').value || '';
    var suPass2 = document.getElementById('su-pass2').value || '';
    showErr('su-err', '');
    if (name.length < 2) return showErr('su-err', 'Enter a name (2+ characters).');
    if (suPass !== suPass2) return showErr('su-err', 'Those passwords do not match.');
    if (suPass.length < 10 || !/[a-zA-Z]/.test(suPass) || !/[0-9]/.test(suPass)) {
      return showErr('su-err', 'Passwords need 10+ characters with a letter and a number.');
    }
    try {
      var createdUser = await api('/api/auth/register', { method: 'POST', body: JSON.stringify({ name: name, email: suEmail, password: suPass }) });
      enterApp(createdUser.user);
      await refresh();
    } catch (e) {
      showErr('su-err', e.message);
    }
  }, true);

  /* ------------------------------- wiring ---------------------------------- */
  function rebind() {
    var map = { 'pp-status': window.botStatus, 'pp-disc': window.botDisconnect, 'pp-reconn': window.botReconnect, 'pp-get': window.getPairCode };
    Object.keys(map).forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.onclick = map[id];
    });
  }

  var observer = new MutationObserver(function () { rebind(); });
  observer.observe(document.body, { childList: true, subtree: true });

  document.addEventListener('click', function (event) {
    var btn = event.target.closest && event.target.closest('#bd-pair, #pp-pair');
    if (btn) setTimeout(function () { rebind(); refresh(); }, 60);
  });

  /* --------------------------- bot provisioning ---------------------------- */
  /* The deployed page has no dashboard routes, so a signed-in owner can create
     the bot record and get a one-time code here. The code is redeemed by the
     operator on the bot host; the token is never rendered in the page. */
  window.provisionBot = async function () {
    try {
      var bot = state.bots[0];
      if (!bot) {
        var created = await api('/api/bots', {
          method: 'POST',
          body: JSON.stringify({ name: 'DARKNOTE bot', description: 'Provisioned from the panel' })
        });
        bot = created.bot;
      }
      var pair = await api('/api/bots/' + bot.id + '/pair', { method: 'POST' });
      await refresh();
      showCode(pair.code, pair.expiresAt);
    } catch (e) {
      alert('Could not create the bot: ' + e.message);
    }
  };

  function showCode(code, expiresAt) {
    var existing = document.getElementById('nx-provision');
    if (existing) existing.remove();
    var box = document.createElement('div');
    box.id = 'nx-provision';
    box.style.cssText = 'position:fixed;inset:0;z-index:80;display:grid;place-items:center;background:rgba(0,0,0,.82);padding:20px;font-family:Inter,system-ui,sans-serif';
    var when = expiresAt ? new Date(expiresAt).toLocaleTimeString() : 'in 10 minutes';
    box.innerHTML =
      '<div style="max-width:380px;background:#120a0e;border:1px solid rgba(255,122,200,.35);border-radius:16px;padding:20px;color:#fff;text-align:center">' +
        '<div style="font:700 12px Orbitron,Inter,sans-serif;letter-spacing:.14em;color:#ff7ac8;margin-bottom:10px">BOT PAIRING CODE</div>' +
        '<div style="font:800 30px Orbitron,Inter,monospace;letter-spacing:.18em;padding:12px;border:1px dashed rgba(255,122,200,.5);border-radius:10px">' + esc(code) + '</div>' +
        '<p style="font-size:12px;line-height:1.6;color:#b0b0bb;margin:12px 0 0">Send this code to your operator. It lets the bot authenticate to this site; it expires ' + esc(when) + ' and can be reissued.</p>' +
        '<button id="nx-copy" style="margin-top:14px;border:0;border-radius:9px;padding:10px 16px;background:linear-gradient(90deg,#ff2e4d,#ff7ac8);color:#fff;font-weight:700;cursor:pointer">Copy code</button>' +
        '<button id="nx-close" style="margin-top:14px;margin-left:8px;border:1px solid rgba(255,255,255,.25);border-radius:9px;padding:10px 16px;background:none;color:#fff;cursor:pointer">Close</button>' +
      '</div>';
    document.body.appendChild(box);
    document.getElementById('nx-copy').onclick = function () {
      navigator.clipboard.writeText(code).then(function () {
        document.getElementById('nx-copy').textContent = 'Copied';
      }).catch(function () {});
    };
    document.getElementById('nx-close').onclick = function () { box.remove(); };
  }

  function paintProvision() {
    var btn = document.getElementById('pp-connect');
    if (!btn) return;
    // Show whenever no agent is reporting, so a lost/rotated token can be re-linked.
    btn.hidden = !state.me || window.botLinked();
  }

  /* ------------------------------ live updates ----------------------------- */
  function startStream() {
    if (state.es) return;
    try {
      state.es = new EventSource('/api/events');
      state.es.onmessage = function (event) {
        try {
          var data = JSON.parse(event.data);
          if (data.type && data.type !== 'ready' && data.type !== 'ping' && data.type !== 'bye') scheduleRefresh();
        } catch (e) {}
      };
      state.es.onerror = function () { /* EventSource reconnects itself */ };
    } catch (e) {}
  }

  /* ------------------------------- PWA ------------------------------------- */
  function markInstalled() {
    var go = document.getElementById('install-go');
    var card = document.getElementById('open-install');
    if (go) go.textContent = 'Installed';
    if (card) card.classList.add('installed');
  }

  function installHelp() {
    var existing = document.getElementById('nx-install-help');
    if (existing) existing.remove();
    var ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    var box = document.createElement('div');
    box.id = 'nx-install-help';
    box.style.cssText = 'position:fixed;inset:0;z-index:80;display:grid;place-items:center;background:rgba(0,0,0,.82);padding:20px;font-family:Inter,system-ui,sans-serif';
    box.innerHTML =
      '<div style="max-width:380px;background:#120a0e;border:1px solid rgba(255,122,200,.35);border-radius:16px;padding:20px;color:#fff">' +
        '<div style="font:700 12px Orbitron,Inter,sans-serif;letter-spacing:.14em;color:#ff7ac8;margin-bottom:10px">INSTALL DARKNOTE</div>' +
        '<p style="font-size:13px;line-height:1.65;color:#c9c9d2;margin:0">' +
          (ios
            ? 'On iPhone/iPad with Safari: tap <b>Share</b>, then <b>Add to Home Screen</b>. It opens full screen with the Darknote icon.'
            : 'Open the browser menu and choose <b>Install app</b> (Chrome/Edge) or <b>Add to Home screen</b> (Firefox). If the entry is missing, reload the page once and try again.') +
        '</p>' +
        '<button id="nx-install-close" style="margin-top:14px;border:0;border-radius:9px;padding:10px 16px;background:linear-gradient(90deg,#ff2e4d,#ff7ac8);color:#fff;font-weight:700;cursor:pointer">Got it</button>' +
      '</div>';
    document.body.appendChild(box);
    document.getElementById('nx-install-close').onclick = function () { box.remove(); };
  }

  window.installDarknote = async function () {
    if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) {
      markInstalled();
      return;
    }
    if (state.installEvent) {
      try {
        await state.installEvent.prompt();
        var choice = await state.installEvent.userChoice;
        state.installEvent = null;
        if (choice && choice.outcome === 'accepted') markInstalled();
        return;
      } catch (e) { /* fall through to help */ }
    }
    installHelp();
  };

  function installPwa() {
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function () {});
    }
    if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) markInstalled();

    window.addEventListener('beforeinstallprompt', function (event) {
      event.preventDefault();
      state.installEvent = event;
      var go = document.getElementById('install-go');
      if (go) go.textContent = 'Install →';
    });
    window.addEventListener('appinstalled', function () {
      state.installEvent = null;
      markInstalled();
    });

    document.addEventListener('click', function (event) {
      var card = event.target.closest && event.target.closest('#open-install');
      if (!card) return;
      event.preventDefault();
      window.installDarknote();
    });
    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      var card = event.target.closest && event.target.closest('#open-install');
      if (!card) return;
      event.preventDefault();
      window.installDarknote();
    });
  }

  /* -------------------------------- boot ----------------------------------- */
  async function boot() {
    installPwa();
    if (!document.getElementById('pp-connect')) {
      var b = document.createElement('button');
      b.id = 'pp-connect';
      b.type = 'button';
      b.textContent = 'Connect bot';
      b.hidden = true;
      b.style.cssText = 'position:fixed;left:14px;bottom:14px;z-index:60;border:1px solid rgba(255,122,200,.5);border-radius:999px;padding:11px 16px;background:rgba(20,6,12,.92);color:#fff;font:700 12px Inter,system-ui,sans-serif;letter-spacing:.06em;cursor:pointer';
      b.onclick = function () { window.provisionBot(); };
      document.body.appendChild(b);
    }
    var me = await api('/api/auth/me').catch(function () { return null; });
    if (me && me.user) {
      enterApp(me.user);
      await refresh();
      startStream();
    } else {
      var auth = document.getElementById('dn-auth');
      var main = document.getElementById('dn-main');
      if (main) main.classList.remove('show');
      if (auth) auth.classList.add('show');
      var demo = document.getElementById('demo-go');
      if (demo) demo.style.display = 'none';
      var member = document.getElementById('mem-login');
      if (member) member.style.display = 'none';
    }
    rebind();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
