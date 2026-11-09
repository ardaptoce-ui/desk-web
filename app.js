/* Desk Plan B client. No frameworks.
   Private path comes from #d= once, then localStorage. Never logged.
*/
(function () {
  "use strict";

  const POLL_MS = 15000;
  const AGENTS = ["scanner", "auditor", "analyst", "executor", "risk"];
  // Canonical 8 auditor layers (order matches main.py / auditor agent)
  const AUDIT_LAYERS = [
    { key: "mint_authority", label: "Mint authority" },
    { key: "freeze_authority", label: "Freeze authority" },
    { key: "dev_wallet", label: "Dev wallet" },
    { key: "top10", label: "Top 10" },
    { key: "liquidity_lp", label: "Liquidity / LP" },
    { key: "pool_age", label: "Pool age" },
    { key: "bundles", label: "Bundles" },
    { key: "delegations", label: "Delegations" },
  ];
  // Alternate keys / name strings the server may use for the same layer
  const LAYER_ALIASES = {
    mint_authority: ["mint_authority", "mintAuthority", "mint", "Mint authority", "mint authority"],
    freeze_authority: ["freeze_authority", "freezeAuthority", "freeze", "Freeze authority", "freeze authority"],
    dev_wallet: ["dev_wallet", "devWallet", "creator", "dev", "Dev wallet", "dev wallet"],
    top10: ["top10", "top_10", "topHolders", "Top 10", "top 10"],
    liquidity_lp: ["liquidity_lp", "liquidity", "lp", "lp_locked", "lpLocked", "Liquidity / LP", "liquidity / lp", "Liquidity"],
    pool_age: ["pool_age", "poolAge", "age", "Pool age", "pool age"],
    bundles: ["bundles", "bundled", "insiders", "Bundles", "bundled wallets"],
    delegations: ["delegations", "delegate", "delegates", "Delegations"],
  };

  const LS_PATH = "desk_data_path";
  const LS_TOKEN = "desk_token";

  const state = {
    dataPath: null,
    token: null,
    tab: "home",
    route: { name: "home" }, // home|agents|activity|account|auditor|coin
    lastGood: { state: null, activity: null, chart: null },
    coinCache: {},
    pollTimer: null,
    loading: false,
    error: null,
  };

  // ——— helpers ———
  function $(id) { return document.getElementById(id); }
  function dash(v) {
    if (v == null || v === "") return "—";
    return v;
  }
  function fmtUsd(n) {
    if (typeof n !== "number" || !Number.isFinite(n)) return "—";
    const abs = Math.abs(n);
    const opts = abs >= 1000
      ? { minimumFractionDigits: 0, maximumFractionDigits: 0 }
      : { minimumFractionDigits: 2, maximumFractionDigits: 2 };
    return (n < 0 ? "-" : "") + "$" + abs.toLocaleString("en-US", opts);
  }
  function fmtPct(n) {
    if (typeof n !== "number" || !Number.isFinite(n)) return "—";
    const sign = n > 0 ? "+" : "";
    return sign + n.toFixed(2) + "%";
  }
  function fmtMelbourne(ts) {
    if (ts == null || ts === "") return "—";
    let d;
    if (typeof ts === "number") {
      d = new Date(ts > 1e12 ? ts : ts * 1000);
    } else {
      d = new Date(ts);
    }
    if (Number.isNaN(d.getTime())) return "—";
    try {
      return new Intl.DateTimeFormat("en-AU", {
        timeZone: "Australia/Melbourne",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(d) + " AEDT";
    } catch (_) {
      return d.toISOString();
    }
  }
  function ageSeconds(ts) {
    if (ts == null) return null;
    let ms;
    if (typeof ts === "number") ms = ts > 1e12 ? ts : ts * 1000;
    else {
      const d = new Date(ts);
      if (Number.isNaN(d.getTime())) return null;
      ms = d.getTime();
    }
    return Math.max(0, Math.floor((Date.now() - ms) / 1000));
  }
  function fmtAge(sec) {
    if (sec == null) return "—";
    if (sec < 60) return sec + "s";
    if (sec < 3600) return Math.floor(sec / 60) + "m";
    return Math.floor(sec / 3600) + "h";
  }
  function shortMint(m) {
    if (!m || typeof m !== "string") return "";
    if (m.length <= 10) return m;
    return m.slice(0, 4) + "…" + m.slice(-4);
  }
  function activityItems(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if (Array.isArray(raw.items)) return raw.items;
    if (Array.isArray(raw.activity)) return raw.activity;
    return [];
  }
  function openPositions(s) {
    if (!s) return [];
    if (Array.isArray(s.open_positions)) return s.open_positions;
    if (Array.isArray(s.positions)) return s.positions;
    return [];
  }

  // ——— private path from fragment ———
  function ingestFragment() {
    const hash = window.location.hash || "";
    if (!hash || hash === "#") return;
    // Support #d=PATH&t=TOKEN or #d=PATH or #/coin/MINT after path already set
    const body = hash.charAt(0) === "#" ? hash.slice(1) : hash;
    // If it looks like a route (#/coin/.. or #coin/..) leave for router, unless d=
    if (body.indexOf("d=") === -1 && body.indexOf("t=") === -1) return;

    const params = {};
    body.split("&").forEach(function (part) {
      const i = part.indexOf("=");
      if (i < 0) return;
      const k = decodeURIComponent(part.slice(0, i));
      const v = decodeURIComponent(part.slice(i + 1));
      params[k] = v;
    });
    // also allow #d=PATH/t=TOKEN style without & — already covered by &
    let changed = false;
    if (params.d) {
      try { localStorage.setItem(LS_PATH, params.d); } catch (_) {}
      state.dataPath = params.d;
      changed = true;
    }
    if (params.t) {
      try { localStorage.setItem(LS_TOKEN, params.t); } catch (_) {}
      state.token = params.t;
      changed = true;
    }
    if (changed) {
      // Clear the fragment so the secret is not left in the URL bar / history entry
      try {
        history.replaceState(null, "", window.location.pathname + window.location.search);
      } catch (_) {
        window.location.hash = "";
      }
    }
  }

  function loadStored() {
    try {
      state.dataPath = localStorage.getItem(LS_PATH) || null;
      state.token = localStorage.getItem(LS_TOKEN) || null;
    } catch (_) {
      state.dataPath = null;
      state.token = null;
    }
  }

  function forgetDevice() {
    try {
      localStorage.removeItem(LS_PATH);
      localStorage.removeItem(LS_TOKEN);
    } catch (_) {}
    state.dataPath = null;
    state.token = null;
    state.lastGood = { state: null, activity: null, chart: null };
    state.coinCache = {};
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
    showSetup();
  }

  // ——— routing ———
  function parseHashRoute() {
    const hash = window.location.hash || "";
    const body = hash.charAt(0) === "#" ? hash.slice(1) : hash;
    if (!body || body.indexOf("d=") !== -1) {
      return { name: state.tab || "home" };
    }
    const path = body.charAt(0) === "/" ? body.slice(1) : body;
    const parts = path.split("/").filter(Boolean);
    if (parts[0] === "coin" && parts[1]) {
      return { name: "coin", mint: decodeURIComponent(parts[1]) };
    }
    if (parts[0] === "auditor" && parts[1]) {
      return { name: "auditor", mint: decodeURIComponent(parts[1]) };
    }
    if (["home", "agents", "activity", "account"].indexOf(parts[0]) >= 0) {
      return { name: parts[0] };
    }
    return { name: state.tab || "home" };
  }

  function setHashRoute(route) {
    let h = "";
    if (route.name === "coin" && route.mint) h = "#/coin/" + encodeURIComponent(route.mint);
    else if (route.name === "auditor" && route.mint) h = "#/auditor/" + encodeURIComponent(route.mint);
    else if (route.name && route.name !== "home") h = "#/" + route.name;
    else h = "";
    try {
      if ((window.location.hash || "") !== h) {
        history.pushState(null, "", (window.location.pathname + window.location.search) + h);
      }
    } catch (_) {}
  }

  function applyRoute(route) {
    state.route = route;
    const detail = route.name === "coin" || route.name === "auditor";
    const tabName = detail ? state.tab : route.name;
    if (!detail) state.tab = route.name;

    document.querySelectorAll(".view").forEach(function (el) {
      el.classList.toggle("active", el.getAttribute("data-view") === route.name);
    });
    document.querySelectorAll(".tab").forEach(function (btn) {
      const on = btn.getAttribute("data-tab") === (detail ? state.tab : route.name);
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });

    const titles = {
      home: "Home",
      agents: "Agents",
      activity: "Activity",
      account: "Account",
      auditor: "Auditor",
      coin: "Coin",
    };
    const titleEl = $("topbar-title");
    if (titleEl) titleEl.textContent = titles[route.name] || "Desk";

    if (route.name === "coin" && route.mint) loadCoin(route.mint);
    if (route.name === "auditor" && route.mint) renderAuditor(route.mint);
  }

  // ——— fetch ———
  function dataUrl(file) {
    // Relative to the site root on GitHub Pages: ./d/{DATA_PATH}/file
    // Never log the path.
    const base = "./d/" + state.dataPath + "/";
    const bust = "t=" + Date.now();
    return base + file + (file.indexOf("?") >= 0 ? "&" : "?") + bust;
  }

  async function fetchJson(file) {
    const url = dataUrl(file);
    const headers = {};
    if (state.token) headers["Authorization"] = "Bearer " + state.token;
    const res = await fetch(url, { cache: "no-store", headers: headers });
    if (!res.ok) throw new Error(file + " " + res.status);
    return res.json();
  }

  async function pollOnce() {
    if (!state.dataPath) return;
    state.loading = true;
    try {
      const results = await Promise.allSettled([
        fetchJson("state.json"),
        fetchJson("activity.json"),
        fetchJson("chart.json"),
      ]);
      let anyOk = false;
      let errMsg = null;
      if (results[0].status === "fulfilled") {
        state.lastGood.state = results[0].value;
        anyOk = true;
      } else {
        errMsg = "state.json unavailable";
      }
      if (results[1].status === "fulfilled") {
        state.lastGood.activity = results[1].value;
        anyOk = true;
      }
      if (results[2].status === "fulfilled") {
        state.lastGood.chart = results[2].value;
        anyOk = true;
      }
      if (anyOk) {
        setError(null);
        renderAll();
      } else {
        setError(errMsg || "Data unavailable");
        // keep last good numbers on screen
      }
    } catch (e) {
      setError("Network error");
    } finally {
      state.loading = false;
    }
  }

  function setError(msg) {
    state.error = msg;
    const banner = $("error-banner");
    if (!banner) return;
    if (msg) {
      banner.textContent = msg + " — showing last good data";
      banner.classList.remove("hidden");
    } else {
      banner.classList.add("hidden");
      banner.textContent = "";
    }
  }

  // ——— odometer ———
  function reduceMotion() {
    try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; }
    catch (_) { return false; }
  }

  function setOdometer(el, text) {
    if (!el) return;
    const next = String(text);
    if (reduceMotion() || el.dataset.raw === undefined) {
      el.textContent = next;
      el.dataset.raw = next;
      return;
    }
    if (el.dataset.raw === next) return;
    // Simple digit-roll for numeric chars; non-digits stay static
    const prev = el.dataset.raw;
    el.dataset.raw = next;
    el.innerHTML = "";
    const len = Math.max(prev.length, next.length);
    const prevPad = prev.padStart(len, " ");
    const nextPad = next.padStart(len, " ");
    for (let i = 0; i < len; i++) {
      const a = prevPad.charAt(i);
      const b = nextPad.charAt(i);
      if (a === b || !/\d/.test(b)) {
        const span = document.createElement("span");
        span.textContent = b === " " ? "" : b;
        el.appendChild(span);
        continue;
      }
      const digit = document.createElement("span");
      digit.className = "digit";
      const strip = document.createElement("span");
      strip.className = "digit-strip";
      for (let d = 0; d <= 9; d++) {
        const s = document.createElement("span");
        s.textContent = String(d);
        strip.appendChild(s);
      }
      digit.appendChild(strip);
      el.appendChild(digit);
      const from = /\d/.test(a) ? parseInt(a, 10) : 0;
      const to = parseInt(b, 10);
      strip.style.transform = "translateY(-" + from + "em)";
      // force reflow then animate
      void strip.offsetHeight;
      strip.style.transform = "translateY(-" + to + "em)";
    }
  }

  // ——— renderers ———
  function renderAll() {
    renderHome();
    renderAgents();
    renderActivity();
    renderAccount();
    if (state.route.name === "coin" && state.route.mint) renderCoin(state.route.mint);
    if (state.route.name === "auditor" && state.route.mint) renderAuditor(state.route.mint);
    const s = state.lastGood.state || {};
    const updated = s.updated_at || s.written_at || s.ts || null;
    const ua = $("updated-at");
    if (ua) ua.textContent = updated ? fmtMelbourne(updated) : "";
  }

  function renderHome() {
    const s = state.lastGood.state || {};
    const bal = s.balance ?? s.stack_usd ?? s.stack ?? null;
    setOdometer($("balance"), fmtUsd(typeof bal === "number" ? bal : null));

    const badge = $("paper-badge");
    if (badge) {
      const mode = (s.mode || "PAPER").toString().toUpperCase();
      badge.textContent = mode;
      badge.classList.toggle("hidden", false);
    }

    const pnlEl = $("day-pnl");
    if (pnlEl) {
      const pnl = s.day_pnl ?? s.daily_pnl ?? s.pnl_day ?? null;
      const pnlPct = s.day_pnl_pct ?? s.daily_pnl_pct ?? null;
      if (typeof pnl === "number") {
        let text = fmtUsd(pnl);
        if (typeof pnlPct === "number") text += " (" + fmtPct(pnlPct) + ")";
        pnlEl.textContent = text;
        pnlEl.classList.remove("up", "down", "secondary");
        if (pnl > 0) pnlEl.classList.add("up");
        else if (pnl < 0) pnlEl.classList.add("down");
        else pnlEl.classList.add("secondary");
      } else {
        pnlEl.textContent = "—";
        pnlEl.classList.remove("up", "down");
        pnlEl.classList.add("secondary");
      }
    }

    // chart
    const canvas = $("balance-chart");
    const empty = $("balance-chart-empty");
    if (window.DeskChart && canvas) {
      const raw = state.lastGood.chart;
      DeskChart.animateLineChart(canvas, raw, { emptyEl: empty });
      DeskChart.watch(canvas, function () { return state.lastGood.chart; }, function () { return { emptyEl: empty }; });
    }

    // positions
    const posEl = $("positions");
    if (posEl) {
      const positions = openPositions(s);
      if (!positions.length) {
        posEl.innerHTML = '<div class="empty-state">No open positions</div>';
      } else {
        posEl.innerHTML = "";
        positions.forEach(function (p) {
          const row = document.createElement("button");
          row.type = "button";
          row.className = "pos-row tap row-link";
          row.style.width = "100%";
          row.style.textAlign = "left";
          row.style.color = "inherit";
          const sym = document.createElement("span");
          sym.className = "pos-sym";
          sym.textContent = p.symbol || shortMint(p.mint) || "—";
          const meta = document.createElement("span");
          meta.className = "pos-meta";
          const ticket = p.ticket_usd ?? p.size_usd ?? p.notional;
          const entry = p.entry_price ?? p.entry;
          const bits = [];
          if (typeof ticket === "number") bits.push(fmtUsd(ticket));
          if (typeof entry === "number") bits.push("@ " + fmtUsd(entry));
          meta.textContent = bits.join(" · ");
          const pnl = document.createElement("span");
          const pv = p.pnl_pct ?? p.pnl ?? p.unrealized_pct;
          pnl.className = "pos-pnl num";
          if (typeof pv === "number") {
            pnl.textContent = fmtPct(pv);
            pnl.classList.add(pv >= 0 ? "up" : "down");
          } else {
            pnl.textContent = "—";
          }
          row.appendChild(sym);
          row.appendChild(meta);
          row.appendChild(pnl);
          if (p.mint) {
            row.addEventListener("click", function () {
              setHashRoute({ name: "coin", mint: p.mint });
              applyRoute({ name: "coin", mint: p.mint });
            });
          }
          posEl.appendChild(row);
        });
      }
    }

    // last activity
    const la = $("last-activity");
    if (la) {
      const items = activityItems(state.lastGood.activity);
      if (!items.length) {
        la.innerHTML = '<div class="empty-state">No activity yet</div>';
      } else {
        la.innerHTML = "";
        la.appendChild(renderActivityItem(items[0]));
      }
    }
  }

  function renderActivityItem(item) {
    const el = document.createElement("div");
    el.className = "activity-item";
    const top = document.createElement("div");
    top.className = "act-top";
    const agent = document.createElement("span");
    agent.className = "act-agent";
    agent.textContent = item.agent || item.source || "desk";
    const ts = document.createElement("span");
    ts.className = "act-ts";
    ts.textContent = fmtMelbourne(item.ts || item.time || item.at);
    top.appendChild(agent);
    top.appendChild(ts);
    const text = document.createElement("div");
    text.className = "act-text";
    text.textContent = item.message || item.text || item.msg || "—";
    el.appendChild(top);
    el.appendChild(text);
    if (item.mint) {
      const mint = document.createElement("button");
      mint.type = "button";
      mint.className = "act-mint row-link";
      mint.textContent = shortMint(item.mint);
      mint.addEventListener("click", function () {
        setHashRoute({ name: "coin", mint: item.mint });
        applyRoute({ name: "coin", mint: item.mint });
      });
      el.appendChild(mint);
    }
    return el;
  }

  function renderAgents() {
    const list = $("agents-list");
    if (!list) return;
    const s = state.lastGood.state || {};
    // Plan B exact key is heartbeats; keep agents as fallback
    const agents = s.heartbeats || s.agents || {};
    list.innerHTML = "";
    AGENTS.forEach(function (name) {
      const info = agents[name] || {};
      const ts = info.ts || info.t || info.heartbeat || null;
      const status = (info.status || info.state || "").toString().toLowerCase();
      const age = (typeof info.age_s === "number") ? Math.floor(info.age_s) : ageSeconds(ts);
      const row = document.createElement("div");
      row.className = "agent-row";
      const dot = document.createElement("span");
      dot.className = "status-dot";
      if (age == null) dot.classList.add("stale");
      else if (age > 120) dot.classList.add("stale");
      else if (status === "error" || status === "err" || status === "down") dot.classList.add("err");
      else if (status === "warn" || status === "warning") dot.classList.add("warn");
      else dot.classList.add("ok");
      const nm = document.createElement("span");
      nm.className = "agent-name";
      nm.textContent = name;
      const ageEl = document.createElement("span");
      ageEl.className = "agent-age";
      ageEl.textContent = age == null ? "no beat" : fmtAge(age) + " ago";
      row.appendChild(dot);
      row.appendChild(nm);
      row.appendChild(ageEl);
      list.appendChild(row);
    });
  }

  function renderActivity() {
    const feed = $("activity-feed");
    if (!feed) return;
    const items = activityItems(state.lastGood.activity);
    if (!items.length) {
      feed.innerHTML = '<div class="empty-state">No activity yet</div>';
      return;
    }
    feed.innerHTML = "";
    items.slice(0, 100).forEach(function (item) {
      feed.appendChild(renderActivityItem(item));
    });
  }

  function renderAccount() {
    const s = state.lastGood.state || {};
    const settings = s.settings || {};
    const set = function (id, v) {
      const el = $(id);
      if (el) el.textContent = dash(v);
    };
    set("acct-mode", (s.mode || settings.mode || "PAPER").toString().toUpperCase());
    set("acct-chain", settings.chain || s.chain || "—");
    set("acct-analyst", settings.analyst_mode || s.analyst_mode || "—");
    set("acct-notifier", settings.notifier || s.notifier || "—");
    const slots = settings.max_open_positions ?? s.max_open_positions;
    const open = openPositions(s).length;
    set("acct-slots", typeof slots === "number" ? open + " / " + slots : "—");
    const poll = settings.poll_seconds ?? s.poll_seconds;
    set("acct-poll", typeof poll === "number" ? poll + "s" : "—");
  }

  // ——— auditor ———
  function pickCheck(checks, layerKey) {
    if (checks == null) return null;
    const aliases = LAYER_ALIASES[layerKey] || [layerKey];
    const aliasLower = aliases.map(function (a) { return String(a).toLowerCase(); });
    // Plan B exact: audit.layers is an array of {name,status,reason,threshold,value}
    if (Array.isArray(checks)) {
      for (let i = 0; i < checks.length; i++) {
        const layer = checks[i];
        if (!layer || typeof layer !== "object") continue;
        const n = String(layer.name || layer.key || "").toLowerCase();
        if (aliasLower.indexOf(n) >= 0) return layer;
      }
      // fall back to positional match
      const idx = AUDIT_LAYERS.findIndex(function (l) { return l.key === layerKey; });
      if (idx >= 0 && checks[idx] != null) return checks[idx];
      return null;
    }
    if (typeof checks !== "object") return null;
    for (let i = 0; i < aliases.length; i++) {
      if (Object.prototype.hasOwnProperty.call(checks, aliases[i])) {
        return checks[aliases[i]];
      }
    }
    const idx = AUDIT_LAYERS.findIndex(function (l) { return l.key === layerKey; });
    if (idx >= 0 && checks[String(idx + 1)] != null) return checks[String(idx + 1)];
    if (idx >= 0 && checks[idx + 1] != null) return checks[idx + 1];
    return null;
  }

  function checkStatus(c) {
    if (c == null) return "unchecked";
    if (typeof c === "boolean") return c ? "pass" : "fail";
    if (typeof c === "string") {
      const t = c.toLowerCase();
      // Plan B exact: green|red|grey
      if (t === "green" || t === "pass" || t === "ok" || t === "true") return "pass";
      if (t === "red" || t === "fail" || t === "false" || t === "reject") return "fail";
      if (t === "grey" || t === "gray" || t === "unchecked" || t === "skip") return "unchecked";
      return "unchecked";
    }
    if (typeof c === "object") {
      if (c.status != null) return checkStatus(c.status);
      if (c.passed === true || c.ok === true) return "pass";
      if (c.passed === false || c.ok === false) return "fail";
      return "unchecked";
    }
    return "unchecked";
  }

  function checkValue(c) {
    if (c == null) return null;
    if (typeof c !== "object") return null;
    return c.value ?? c.actual ?? c.pct ?? c.amount ?? null;
  }

  function checkThreshold(c, thresholds, layerKey) {
    if (c && typeof c === "object" && (c.threshold != null || c.limit != null)) {
      return c.threshold ?? c.limit;
    }
    if (thresholds && typeof thresholds === "object") {
      const aliases = LAYER_ALIASES[layerKey] || [layerKey];
      for (let i = 0; i < aliases.length; i++) {
        if (thresholds[aliases[i]] != null) return thresholds[aliases[i]];
      }
    }
    return null;
  }

  function getAuditForMint(mint) {
    // Prefer coin cache, then state.audits[mint], then null
    const coin = state.coinCache[mint];
    if (coin && coin.audit) return coin.audit;
    const s = state.lastGood.state || {};
    if (s.audits && s.audits[mint]) return s.audits[mint];
    if (s.audit && s.audit.mint === mint) return s.audit;
    return null;
  }

  function renderAuditor(mint) {
    const title = $("auditor-title");
    if (title) title.textContent = "Auditor · " + shortMint(mint);

    const audit = getAuditForMint(mint);
    const scoreEl = $("auditor-score");
    const beam = $("audit-beam");
    const details = $("audit-details");
    if (!beam || !details) return;

    if (!audit) {
      if (scoreEl) scoreEl.textContent = "—";
      beam.innerHTML = "";
      details.innerHTML = '<div class="empty-state">No audit data</div>';
      // still draw grey lamps
      AUDIT_LAYERS.forEach(function (layer, i) {
        const cell = document.createElement("div");
        cell.className = "beam-cell";
        const lamp = document.createElement("div");
        lamp.className = "beam-lamp unchecked";
        const n = document.createElement("div");
        n.className = "beam-n";
        n.textContent = String(i + 1);
        cell.appendChild(lamp);
        cell.appendChild(n);
        beam.appendChild(cell);
      });
      return;
    }

    // Plan B exact: audit.layers[]; keep checks/thresholds as fallbacks
    const checks = audit.layers || audit.checks || {};
    const thresholds = audit.thresholds || {};
    const score = audit.score || null;
    if (scoreEl) scoreEl.textContent = score != null ? String(score) : "—";

    beam.innerHTML = "";
    details.innerHTML = "";

    const statuses = AUDIT_LAYERS.map(function (layer) {
      return checkStatus(pickCheck(checks, layer.key));
    });

    AUDIT_LAYERS.forEach(function (layer, i) {
      const cell = document.createElement("div");
      cell.className = "beam-cell";
      const lamp = document.createElement("div");
      lamp.className = "beam-lamp " + statuses[i];
      const n = document.createElement("div");
      n.className = "beam-n";
      n.textContent = String(i + 1);
      cell.appendChild(lamp);
      cell.appendChild(n);
      beam.appendChild(cell);

      const row = document.createElement("div");
      row.className = "audit-layer-row";
      const name = document.createElement("span");
      name.className = "layer-name";
      name.textContent = (i + 1) + ". " + layer.label;
      const val = document.createElement("span");
      val.className = "layer-val num";
      const c = pickCheck(checks, layer.key);
      const v = checkValue(c);
      const reason = (c && typeof c === "object") ? (c.reason || null) : null;
      if (v != null) val.textContent = String(v);
      else if (reason) val.textContent = String(reason);
      else val.textContent = statuses[i] === "unchecked" ? "—" : statuses[i];
      const thr = checkThreshold(c, thresholds, layer.key);
      row.appendChild(name);
      row.appendChild(val);
      if (thr != null) {
        const pill = document.createElement("span");
        pill.className = "pill pill-mono";
        pill.textContent = String(thr);
        row.appendChild(pill);
      }
      details.appendChild(row);
    });

    // beam light-up animation
    if (!reduceMotion()) {
      const lamps = beam.querySelectorAll(".beam-lamp");
      lamps.forEach(function (lamp, i) {
        lamp.classList.remove("lit");
        setTimeout(function () {
          lamp.classList.add("lit");
        }, 80 * i);
      });
    }
  }

  // ——— coin ———
  async function loadCoin(mint) {
    if (!state.dataPath || !mint) return;
    try {
      const data = await fetchJson("coin/" + encodeURIComponent(mint) + ".json");
      state.coinCache[mint] = data;
      if (state.route.name === "coin" && state.route.mint === mint) renderCoin(mint);
    } catch (_) {
      // keep empty / last cache; show dashes
      if (state.route.name === "coin" && state.route.mint === mint) renderCoin(mint);
    }
  }

  function renderCoin(mint) {
    const data = state.coinCache[mint] || {};
    const symEl = $("coin-symbol");
    const mintEl = $("coin-mint");
    const priceEl = $("coin-price");
    if (symEl) symEl.textContent = data.symbol || shortMint(mint) || "—";
    if (mintEl) mintEl.textContent = mint || "";
    const price = data.price_usd ?? data.price ?? null;
    setOdometer(priceEl, typeof price === "number" ? fmtUsd(price) : "—");

    const canvas = $("coin-chart");
    const empty = $("coin-chart-empty");
    if (window.DeskChart && canvas) {
      // Plan B exact: prices[{ts,price_usd}]; keep chart/series fallbacks
      const raw = data.prices || data.chart || data.series || null;
      DeskChart.animateLineChart(canvas, raw, { emptyEl: empty });
    }

    const pipe = $("coin-pipeline");
    if (pipe) {
      pipe.innerHTML = "";
      function addRow(label, value, linkMint) {
        const row = document.createElement("div");
        row.className = "row";
        const l = document.createElement("span");
        l.className = "row-label";
        l.textContent = label;
        const v = document.createElement("span");
        v.className = "row-value";
        if (linkMint) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "row-link";
          btn.textContent = value;
          btn.addEventListener("click", function () {
            setHashRoute({ name: "auditor", mint: linkMint });
            applyRoute({ name: "auditor", mint: linkMint });
          });
          v.appendChild(btn);
        } else {
          v.textContent = value;
        }
        row.appendChild(l);
        row.appendChild(v);
        pipe.appendChild(row);
      }
      const scan = data.scan || data.candidate || null;
      addRow("Scan", scan ? (scan.source || scan.status || "seen") : "—");
      const audit = data.audit || null;
      addRow("Audit", audit ? String(audit.score || (audit.passed ? "pass" : "fail")) : "—", audit ? mint : null);
      const verdict = data.verdict || null;
      if (verdict) {
        const g = verdict.go === true ? "GO" : verdict.go === false ? "NO" : "—";
        const sc = verdict.score != null ? " " + verdict.score : "";
        addRow("Verdict", g + sc);
      } else {
        addRow("Verdict", "—");
      }
      if (!scan && !audit && !verdict) {
        pipe.innerHTML = '<div class="empty-state">No data</div>';
      }
    }

    const posEl = $("coin-position");
    if (posEl) {
      const pos = data.position || null;
      // also check open positions in state
      let p = pos;
      if (!p) {
        openPositions(state.lastGood.state || {}).forEach(function (x) {
          if (x.mint === mint) p = x;
        });
      }
      if (!p) {
        posEl.innerHTML = '<div class="empty-state">No position</div>';
      } else {
        posEl.innerHTML = "";
        function row(label, value) {
          const r = document.createElement("div");
          r.className = "row";
          r.innerHTML = '<span class="row-label">' + label + '</span><span class="row-value num"></span>';
          r.querySelector(".row-value").textContent = value;
          posEl.appendChild(r);
        }
        row("Side", p.side || "long");
        row("Size", typeof p.ticket_usd === "number" ? fmtUsd(p.ticket_usd) : (typeof p.size_usd === "number" ? fmtUsd(p.size_usd) : "—"));
        row("Entry", typeof p.entry_price === "number" ? fmtUsd(p.entry_price) : (typeof p.entry === "number" ? fmtUsd(p.entry) : "—"));
        const pnl = p.pnl_pct ?? p.pnl;
        row("PnL", typeof pnl === "number" ? fmtPct(pnl) : "—");
      }
    }

    const fomo = $("coin-fomo");
    if (fomo) {
      // ONLY render a FOMO link if the JSON supplies a url. Never build client-side.
      // Plan B exact key is fomo_url — never build client-side
      const url = data.fomo_url || data.url || (data.links && data.links.fomo) || null;
      if (url && typeof url === "string" && /^https:\/\//i.test(url)) {
        fomo.classList.remove("hidden");
        fomo.innerHTML = "";
        const a = document.createElement("a");
        a.className = "fomo-link tap";
        a.href = url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = "Open on FOMO";
        fomo.appendChild(a);
      } else {
        fomo.classList.add("hidden");
        fomo.innerHTML = "";
      }
    }
  }

  // ——— chrome ———
  function showSetup() {
    $("setup").classList.remove("hidden");
    $("topbar").classList.add("hidden");
    $("main").classList.add("hidden");
    $("tabbar").classList.add("hidden");
    $("error-banner").classList.add("hidden");
  }

  function showApp() {
    $("setup").classList.add("hidden");
    $("topbar").classList.remove("hidden");
    $("main").classList.remove("hidden");
    $("tabbar").classList.remove("hidden");
  }

  function startPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    pollOnce();
    state.pollTimer = setInterval(pollOnce, POLL_MS);
  }

  function bindUi() {
    document.querySelectorAll(".tab").forEach(function (btn) {
      btn.addEventListener("click", function () {
        const tab = btn.getAttribute("data-tab");
        setHashRoute({ name: tab });
        applyRoute({ name: tab });
      });
    });
    document.querySelectorAll("[data-back]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        setHashRoute({ name: state.tab || "home" });
        applyRoute({ name: state.tab || "home" });
      });
    });
    const forget = $("forget-device");
    if (forget) forget.addEventListener("click", forgetDevice);

    window.addEventListener("hashchange", function () {
      // If hash contains d=, ingest it (open-once)
      if ((window.location.hash || "").indexOf("d=") !== -1) {
        ingestFragment();
        if (state.dataPath) {
          showApp();
          startPolling();
          applyRoute(parseHashRoute());
        }
        return;
      }
      applyRoute(parseHashRoute());
    });
    window.addEventListener("popstate", function () {
      applyRoute(parseHashRoute());
    });
  }

  function registerSw() {
    if (!("serviceWorker" in navigator)) return;
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("./sw.js").catch(function () {
        /* ignore — Plan B may be file:// or blocked */
      });
    });
  }

  function init() {
    ingestFragment();
    loadStored();
    bindUi();
    registerSw();

    if (!state.dataPath) {
      showSetup();
      return;
    }
    showApp();
    applyRoute(parseHashRoute());
    startPolling();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
