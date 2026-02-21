/* ─────────────────────────────────────────────
   Slot Sentinel – Network Interceptor
   运行在 MAIN world，拦截 fetch/XHR
   在 API 响应阶段（DOM 渲染前）检测 slot 可用性
   支持 capacity API 高频轮询
   ───────────────────────────────────────────── */

(() => {
  "use strict";

  if (window.__SS_INJECTED__) return;
  window.__SS_INJECTED__ = true;

  const CAPACITY_RE = /\/inbound-scheduler\/.*\/capacity/i;
  const BOOKING_RE = /\/inbound-scheduler\/.*(book|confirm|reserve|schedule|slot)/i;
  const SLOT_URL_RE = /slot|schedule|shipment|booking|availability|inbound|delivery/i;
  const EXCLUDE_RE = /partner_asn_details|partner_warehouse|warehouse_list|countries|whoami|navigation|cluster|collect/i;

  const SOLD_OUT_STRINGS = [
    "no slots available", "no slot available", "sold out", "fully booked",
    "no capacity", "all slots taken",
    "no time slots", "no delivery slots", "slots are full",
  ];

  // ── nonce 通信 ─────────────────────────────────────────────────────

  let _ssNonce = null;
  const _ssPendingQueue = [];
  const _SS_QUEUE_LIMIT = 100;

  function ssSend(data) {
    if (!_ssNonce) {
      if (_ssPendingQueue.length < _SS_QUEUE_LIMIT) _ssPendingQueue.push(data);
      return;
    }
    window.postMessage({ ...data, _ssNonce }, "*");
  }

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
      ssSend({
        type: "SS_API_RESPONSE",
        subtype: "capacity",
        url,
        isSoldOut: !hasSlots,
        slotCount: hasSlots ? data.length : 0,
        slots: hasSlots ? data : [],
      });
      return;
    }

    if (!SLOT_URL_RE.test(pathname) || EXCLUDE_RE.test(pathname)) return;
    const str = JSON.stringify(data).toLowerCase();
    const relevant = ["slot", "schedule", "shipment", "time", "delivery", "inbound", "booking"]
      .some((k) => str.includes(k));
    if (!relevant) return;

    const isSoldOut = SOLD_OUT_STRINGS.some((s) => str.includes(s));
    ssSend({ type: "SS_API_RESPONSE", subtype: "generic", url, isSoldOut });
  }

  // ── 高频轮询 capacity API（带 429 自动退避）─────────────────────

  let pollTickCount = 0;
  let baseInterval = 0;      // 用户设置的原始间隔
  let currentInterval = 0;   // 当前实际间隔（可能因退避而变大）
  let backoffLevel = 0;      // 退避等级：0=正常, 1=2x, 2=4x, 3=8x
  let consecutive429 = 0;    // 连续 429 计数
  let consecutiveOk = 0;     // 连续成功计数

  function startPoll(ms) {
    stopPoll();
    if (!ms || ms < 500) ms = 500; // 最低 500ms，防止被封
    baseInterval = ms;
    currentInterval = ms;
    backoffLevel = 0;
    pollTimer = setInterval(pollCapacity, ms);
  }

  function stopPoll() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  // 429 退避：递增间隔；连续成功后恢复
  function applyBackoff() {
    consecutive429++;
    consecutiveOk = 0;
    if (consecutive429 >= 3 && backoffLevel < 4) {
      backoffLevel++;
      const newInterval = Math.min(baseInterval * Math.pow(2, backoffLevel), 30000);
      if (newInterval !== currentInterval) {
        currentInterval = newInterval;
        stopPoll();
        pollTimer = setInterval(pollCapacity, currentInterval);
        ssSend({
          type: "SS_POLL_BACKOFF",
          level: backoffLevel,
          interval: currentInterval,
          reason: "429 限流，自动降速",
        });
      }
      consecutive429 = 0;
    }
  }

  function checkRecovery() {
    consecutiveOk++;
    consecutive429 = 0;
    if (backoffLevel > 0 && consecutiveOk >= 10) {
      backoffLevel = Math.max(0, backoffLevel - 1);
      const newInterval = backoffLevel === 0 ? baseInterval : baseInterval * Math.pow(2, backoffLevel);
      if (newInterval !== currentInterval) {
        currentInterval = newInterval;
        stopPoll();
        pollTimer = setInterval(pollCapacity, currentInterval);
        ssSend({
          type: "SS_POLL_BACKOFF",
          level: backoffLevel,
          interval: currentInterval,
          reason: "限流解除，恢复速度",
        });
      }
      consecutiveOk = 0;
    }
  }

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
      if (resp.status === 429) {
        applyBackoff();
        ssSend({ type: "SS_POLL_ERROR", tick: pollTickCount, error: "HTTP 429 限流" });
        return;
      }
      if (!resp.ok) {
        ssSend({ type: "SS_POLL_ERROR", tick: pollTickCount, error: "HTTP " + resp.status });
        return;
      }
      checkRecovery();
      const data = await resp.json();
      analyzeResponse(lastCapacityReq.url, data);
    } catch (err) {
      ssSend({ type: "SS_POLL_ERROR", tick: pollTickCount, error: err.message || String(err) });
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

    ssSend({ type: "SS_POLL_READY" });
  }

  // ── 自动捕获 booking/confirm API（方案B 自动学习）─────────────────

  function captureBookingReq(url, init, responseData) {
    let pathname;
    try { pathname = new URL(url, location.href).pathname; } catch (_) { pathname = url; }
    if (!BOOKING_RE.test(pathname)) return;
    if (CAPACITY_RE.test(pathname)) return; // 排除 capacity

    const method = (init?.method || "POST").toUpperCase();
    if (method !== "POST" && method !== "PUT") return;

    const headers = {};
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((v, k) => { headers[k] = v; });
      } else if (typeof init.headers === "object") {
        Object.assign(headers, init.headers);
      }
    }

    ssSend({
      type: "SS_BOOKING_API_CAPTURED",
      url,
      method,
      body: init?.body || null,
      headers,
      pathname,
      response: responseData,
    });
  }

  // ── 监听 content_script 配置 ─────────────────────────────────────

  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data) return;

    // #2 #3: 从 DOM 隐蔽通道读取 nonce，回复 ACK（ACK 携带 nonce 摘要防伪造）
    if (e.data.type === "SS_INIT" && !_ssNonce) {
      const meta = document.querySelector('meta[name="__ss"]');
      if (!meta?.content) return;
      _ssNonce = meta.content;
      meta.remove();
      // ACK 携带 nonce 前8字符作为校验摘要，防止页面脚本伪造
      window.postMessage({ type: "SS_INIT_ACK", _ssAck: _ssNonce.slice(0, 8) }, "*");
      while (_ssPendingQueue.length) {
        const msg = _ssPendingQueue.shift();
        window.postMessage({ ...msg, _ssNonce }, "*");
      }
      return;
    }

    if (e.data.type === "SS_SET_POLL") {
      if (e.data._ssNonce && e.data._ssNonce !== _ssNonce) return;
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
    let url, init;
    if (args[0] instanceof Request) {
      // #4: 异步克隆 body + 合并 args[1] 的覆盖参数
      const req = args[0];
      const override = args[1] || {};
      url = req.url;
      const baseHeaders = Object.fromEntries(req.headers.entries());
      // args[1] 可能覆盖 method/headers/body
      const mergedHeaders = override.headers
        ? { ...baseHeaders, ...(override.headers instanceof Headers ? Object.fromEntries(override.headers.entries()) : override.headers) }
        : baseHeaders;
      const mergedMethod = override.method || req.method;
      req.clone().text().then(bodyText => {
        captureCapacityReq(url, {
          method: mergedMethod,
          headers: mergedHeaders,
          body: override.body !== undefined ? override.body : bodyText,
        });
      }).catch(() => {});
      init = { method: mergedMethod, headers: mergedHeaders };
    } else {
      url = String(args[0] || "");
      init = args[1];
      try { captureCapacityReq(url, init); } catch (_) {}
    }

    const result = await origFetch.apply(this, args);
    try {
      if (shouldIntercept(url)) {
        const ct = result.headers.get("content-type") || "";
        if (ct.includes("json")) {
          result.clone().json().then((data) => {
            analyzeResponse(url, data);
            try { captureBookingReq(url, init, data); } catch (_) {}
          }).catch(() => {});
        }
      }
    } catch (_) {}
    return result;
  };

  // ── Patch XHR ────────────────────────────────────────────────────

  const OrigOpen = XMLHttpRequest.prototype.open;
  const OrigSend = XMLHttpRequest.prototype.send;
  const OrigSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._ssUrl = String(url || "");
    this._ssMethod = method;
    this._ssHeaders = {};
    return OrigOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (this._ssHeaders) this._ssHeaders[name] = value;
    return OrigSetRequestHeader.call(this, name, value);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    // 捕获 capacity XHR 请求参数
    try {
      if (this._ssMethod?.toUpperCase() === "POST") {
        captureCapacityReq(this._ssUrl, {
          body: args[0],
          headers: this._ssHeaders,
          method: this._ssMethod,
        });
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
