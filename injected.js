/* ─────────────────────────────────────────────
   Slot Sentinel – Network Interceptor
   运行在 MAIN world，拦截 fetch/XHR
   在 API 响应阶段（DOM 渲染前）检测 slot 可用性
   ───────────────────────────────────────────── */

(() => {
  "use strict";

  // 精确匹配 capacity 端点（Noon FBN slot 可用性 API）
  const CAPACITY_RE = /\/inbound-scheduler\/.*\/capacity/i;

  // 通用备用匹配
  const SLOT_URL_RE = /slot|schedule|shipment|booking|availability|inbound|delivery/i;

  // 排除已知非 slot API，避免误触发
  const EXCLUDE_RE = /partner_asn_details|partner_warehouse|warehouse_list|countries|whoami|navigation|cluster|collect/i;

  const SOLD_OUT_STRINGS = [
    "no slots available", "no slot available", "sold out", "fully booked",
    "no available", "unavailable", "no capacity", "all slots taken",
    "no time slots", "no delivery slots", "not available", "slots are full",
  ];

  function analyzeResponse(url, data) {
    let pathname;
    try { pathname = new URL(url, location.href).pathname; } catch (_) { pathname = url; }

    // 精确匹配 capacity 端点
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

    // 通用备用：其他可能的 slot 相关接口（排除已知非 slot API）
    if (!SLOT_URL_RE.test(pathname) || EXCLUDE_RE.test(pathname)) return;
    const str = JSON.stringify(data).toLowerCase();
    const relevant = ["slot", "schedule", "shipment", "time", "delivery", "inbound", "booking"]
      .some((k) => str.includes(k));
    if (!relevant) return;

    const isSoldOut = SOLD_OUT_STRINGS.some((s) => str.includes(s));
    window.postMessage({ type: "SS_API_RESPONSE", subtype: "generic", url, isSoldOut }, "*");
  }

  // 判断 URL 是否值得拦截
  function shouldIntercept(url) {
    try {
      const p = new URL(url, location.href).pathname;
      return CAPACITY_RE.test(p) || SLOT_URL_RE.test(p);
    } catch (_) {
      return CAPACITY_RE.test(url) || SLOT_URL_RE.test(url);
    }
  }

  // ── Patch fetch ────────────────────────────────────────────────────

  const origFetch = window.fetch;

  window.fetch = async function (...args) {
    const result = await origFetch.apply(this, args);
    try {
      const url = args[0] instanceof Request ? args[0].url : String(args[0] || "");
      if (shouldIntercept(url)) {
        const ct = result.headers.get("content-type") || "";
        if (ct.includes("json")) {
          result.clone().json().then((data) => analyzeResponse(url, data)).catch(() => {});
        }
      }
    } catch (_) {}
    return result;
  };

  // ── Patch XHR ─────────────────────────────────────────────────────

  const OrigOpen = XMLHttpRequest.prototype.open;
  const OrigSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._ssUrl = String(url || "");
    return OrigOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
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
