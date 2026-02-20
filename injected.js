/* ─────────────────────────────────────────────
   Slot Sentinel – Network Interceptor
   运行在 MAIN world，拦截 fetch/XHR
   在 API 响应阶段（DOM 渲染前）检测 slot 可用性
   支持 capacity API 高频轮询
   ───────────────────────────────────────────── */

(() => {
  "use strict";

  const CAPACITY_RE = /\/inbound-scheduler\/.*\/capacity/i;
  const SLOT_URL_RE = /slot|schedule|shipment|booking|availability|inbound|delivery/i;
  const EXCLUDE_RE = /partner_asn_details|partner_warehouse|warehouse_list|countries|whoami|navigation|cluster|collect/i;

  const SOLD_OUT_STRINGS = [
    "no slots available", "no slot available", "sold out", "fully booked",
    "no available", "unavailable", "no capacity", "all slots taken",
    "no time slots", "no delivery slots", "not available", "slots are full",
  ];

  // ── 轮询状态 ─────────────────────────────────────────────────────

  let lastCapacityReq = null; // { url, body, headers }
  let pollTimer = null;
  let pollInterval = 0; // 0 = 不轮询
  let pollPaused = false;
  const origFetch = window.fetch;

  // ── 分析响应 ─────────────────────────────────────────────────────

  function analyzeResponse(url, data) {
    let pathname;
    try { pathname = new URL(url, location.href).pathname; } catch (_) { pathname = url; }

    if (CAPACITY_RE.test(pathname)) {
      const hasSlots = Array.isArray(data) && data.length > 0;
      window.postMessage({
        type: "SS_API_RESPONSE",
        subtype: "capacity",
        url,
        isSoldOut: !hasSlots,
        slotCount: hasSlots ? data.length : 0,
        slots: hasSlots ? data : [],
      }, "*");
      return;
    }

    if (!SLOT_URL_RE.test(pathname) || EXCLUDE_RE.test(pathname)) return;
    const str = JSON.stringify(data).toLowerCase();
    const relevant = ["slot", "schedule", "shipment", "time", "delivery", "inbound", "booking"]
      .some((k) => str.includes(k));
    if (!relevant) return;

    const isSoldOut = SOLD_OUT_STRINGS.some((s) => str.includes(s));
    window.postMessage({ type: "SS_API_RESPONSE", subtype: "generic", url, isSoldOut }, "*");
  }

  // ── 高频轮询 capacity API ────────────────────────────────────────

  function startPoll(ms) {
    stopPoll();
    if (!ms || ms < 100) return;
    pollInterval = ms;
    pollTimer = setInterval(pollCapacity, ms);
  }

  function stopPoll() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  let pollTickCount = 0;

  async function pollCapacity() {
    if (!lastCapacityReq || pollPaused) return;
    pollTickCount++;
    try {
      const resp = await origFetch(lastCapacityReq.url, {
        method: "POST",
        headers: lastCapacityReq.headers || { "Content-Type": "application/json" },
        body: lastCapacityReq.body,
        credentials: "include",
      });
      if (!resp.ok) {
        // 上报 HTTP 错误
        window.postMessage({ type: "SS_POLL_ERROR", tick: pollTickCount, error: "HTTP " + resp.status }, "*");
        return;
      }
      const data = await resp.json();
      analyzeResponse(lastCapacityReq.url, data);
    } catch (err) {
      // 上报异常
      window.postMessage({ type: "SS_POLL_ERROR", tick: pollTickCount, error: err.message || String(err) }, "*");
    }
  }

  // 捕获 capacity 请求参数
  function captureCapacityReq(url, init) {
    let pathname;
    try { pathname = new URL(url, location.href).pathname; } catch (_) { pathname = url; }
    if (!CAPACITY_RE.test(pathname)) return;

    const headers = {};
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((v, k) => { headers[k] = v; });
      } else if (typeof init.headers === "object") {
        Object.assign(headers, init.headers);
      }
    }
    if (!headers["Content-Type"] && !headers["content-type"]) {
      headers["Content-Type"] = "application/json";
    }

    lastCapacityReq = { url, body: init?.body || null, headers };

    // 首次捕获到请求参数，如果已配置轮询间隔则启动
    if (pollInterval > 0 && !pollTimer) startPoll(pollInterval);

    window.postMessage({ type: "SS_POLL_READY" }, "*");
  }

  // ── 监听 content_script 配置 ─────────────────────────────────────

  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data) return;

    if (e.data.type === "SS_SET_POLL") {
      const ms = e.data.interval || 0;
      pollPaused = !!e.data.paused;
      if (ms > 0 && ms !== pollInterval) {
        pollInterval = ms;
        if (lastCapacityReq && !pollPaused) startPoll(ms);
      } else if (ms === 0) {
        stopPoll();
        pollInterval = 0;
      }
      if (pollPaused) stopPoll();
      else if (pollInterval > 0 && lastCapacityReq) startPoll(pollInterval);
    }
  });

  // ── 判断是否拦截 ─────────────────────────────────────────────────

  function shouldIntercept(url) {
    try {
      const p = new URL(url, location.href).pathname;
      return CAPACITY_RE.test(p) || SLOT_URL_RE.test(p);
    } catch (_) {
      return CAPACITY_RE.test(url) || SLOT_URL_RE.test(url);
    }
  }

  // ── Patch fetch ──────────────────────────────────────────────────

  window.fetch = async function (...args) {
    const url = args[0] instanceof Request ? args[0].url : String(args[0] || "");

    // 捕获 capacity 请求参数用于轮询
    try { captureCapacityReq(url, args[1]); } catch (_) {}

    const result = await origFetch.apply(this, args);
    try {
      if (shouldIntercept(url)) {
        const ct = result.headers.get("content-type") || "";
        if (ct.includes("json")) {
          result.clone().json().then((data) => analyzeResponse(url, data)).catch(() => {});
        }
      }
    } catch (_) {}
    return result;
  };

  // ── Patch XHR ────────────────────────────────────────────────────

  const OrigOpen = XMLHttpRequest.prototype.open;
  const OrigSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._ssUrl = String(url || "");
    this._ssMethod = method;
    return OrigOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    // 捕获 capacity XHR 请求参数
    try {
      if (this._ssMethod?.toUpperCase() === "POST") {
        captureCapacityReq(this._ssUrl, { body: args[0] });
      }
    } catch (_) {}

    this.addEventListener("load", function () {
      try {
        const url = this._ssUrl || "";
        if (!shouldIntercept(url)) return;
        if (this.status < 200 || this.status >= 300) return;
        const ct = this.getResponseHeader("content-type") || "";
        if (!ct.includes("json")) return;
        analyzeResponse(url, JSON.parse(this.responseText));
      } catch (_) {}
    });
    return OrigSend.apply(this, args);
  };
})();
