/* Hand-drawn canvas charts. devicePixelRatio aware. Canvas only. */
(function (global) {
  "use strict";

  const GREEN = "#00d35a";
  const RED = "#ff453a";
  const GRID = "rgba(84,84,88,0.35)";
  const MUTED = "rgba(235,235,245,0.3)";

  function reduceMotion() {
    try {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (_) {
      return false;
    }
  }

  function sizeCanvas(canvas) {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    const cssW = Math.max(1, Math.floor(rect.width || canvas.clientWidth || 300));
    const cssH = Math.max(1, Math.floor(rect.height || canvas.clientHeight || 160));
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w: cssW, h: cssH, dpr };
  }

  function normalizePoints(raw) {
    if (!raw) return [];
    let arr = raw;
    if (!Array.isArray(arr)) {
      // Plan B exact keys first, then defensive aliases
      if (Array.isArray(raw.balance_series)) arr = raw.balance_series;
      else if (Array.isArray(raw.prices)) arr = raw.prices;
      else if (Array.isArray(raw.points)) arr = raw.points;
      else if (Array.isArray(raw.balance)) arr = raw.balance;
      else if (Array.isArray(raw.series)) arr = raw.series;
      else return [];
    }
    const out = [];
    for (const p of arr) {
      if (p == null) continue;
      if (typeof p === "number") {
        out.push({ t: out.length, v: p });
        continue;
      }
      const v = p.stack_usd ?? p.price_usd ?? p.v ?? p.value ?? p.y ?? p.price ?? p.balance ?? p.close;
      const t = p.ts ?? p.t ?? p.time ?? p.x ?? out.length;
      if (typeof v === "number" && Number.isFinite(v)) {
        out.push({ t, v });
      }
    }
    return out;
  }

  function drawLineChart(canvas, raw, opts) {
    opts = opts || {};
    const points = normalizePoints(raw);
    const emptyEl = opts.emptyEl || null;
    if (!canvas) return;

    if (points.length < 2) {
      const { ctx, w, h } = sizeCanvas(canvas);
      ctx.clearRect(0, 0, w, h);
      if (emptyEl) emptyEl.classList.remove("hidden");
      canvas.classList.add("hidden");
      return;
    }
    if (emptyEl) emptyEl.classList.add("hidden");
    canvas.classList.remove("hidden");

    const { ctx, w, h } = sizeCanvas(canvas);
    ctx.clearRect(0, 0, w, h);

    const pad = { t: 12, r: 12, b: 16, l: 12 };
    const iw = w - pad.l - pad.r;
    const ih = h - pad.t - pad.b;
    let min = Infinity;
    let max = -Infinity;
    for (const p of points) {
      if (p.v < min) min = p.v;
      if (p.v > max) max = p.v;
    }
    if (min === max) {
      min -= 1;
      max += 1;
    }
    const first = points[0].v;
    const last = points[points.length - 1].v;
    const up = last >= first;
    const color = opts.color || (up ? GREEN : RED);

    // subtle baseline
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.l, pad.t + ih);
    ctx.lineTo(pad.l + iw, pad.t + ih);
    ctx.stroke();

    const n = points.length;
    function xAt(i) {
      return pad.l + (iw * i) / (n - 1);
    }
    function yAt(v) {
      return pad.t + ih - ((v - min) / (max - min)) * ih;
    }

    // draw-in animation via clip progress
    const progress = opts._progress == null ? 1 : opts._progress;
    const drawCount = Math.max(2, Math.floor(1 + (n - 1) * progress));

    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < drawCount; i++) {
      const x = xAt(i);
      const y = yAt(points[i].v);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // end dot
    const ei = drawCount - 1;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(xAt(ei), yAt(points[ei].v), 3, 0, Math.PI * 2);
    ctx.fill();
  }

  function animateLineChart(canvas, raw, opts) {
    opts = opts || {};
    if (reduceMotion()) {
      drawLineChart(canvas, raw, Object.assign({}, opts, { _progress: 1 }));
      return;
    }
    const start = performance.now();
    const dur = opts.duration || 600;
    function frame(now) {
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      drawLineChart(canvas, raw, Object.assign({}, opts, { _progress: eased }));
      if (t < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  // Keep chart sharp on resize
  const watched = new Map();
  function watch(canvas, rawGetter, optsGetter) {
    if (!canvas) return;
    watched.set(canvas, { rawGetter, optsGetter });
  }
  let resizeTimer = null;
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      watched.forEach(function (w, canvas) {
        drawLineChart(canvas, w.rawGetter(), w.optsGetter ? w.optsGetter() : {});
      });
    }, 100);
  });

  global.DeskChart = {
    drawLineChart,
    animateLineChart,
    normalizePoints,
    watch,
    sizeCanvas,
  };
})(window);
