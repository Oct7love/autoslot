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

  // URL 安全检查：仅在 FBN 调度页面运行
  const _ssHost = location.hostname;
  if (_ssHost !== "fbn.noon.partners" && !_ssHost.endsWith(".noon.com")) {
    return;
  }

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

  // ── Worker 定时器（绕过 Chrome 后台标签页 setInterval 限流）────────

  const POLL_WORKER_CODE = `
    let timer = null;
    let interval = 500;
    let tickCount = 0;
    let paused = false;
    let pauseTimer = null;
    let baseInterval = 500;
    let backoffLevel = 0;
    let consecutive429 = 0;
    let consecutiveOk = 0;
    let recoveryTimer = null;
    let recoveryDelay = 45000;
    let lastRecoveryTime = 0;

    function startTimer() {
      if (timer) clearInterval(timer);
      timer = setInterval(() => {
        if (!paused) {
          tickCount++;
          postMessage({ type: "TICK", tick: tickCount });
        }
      }, interval);
    }

    function stopTimer() {
      if (timer) { clearInterval(timer); timer = null; }
      if (pauseTimer) { clearTimeout(pauseTimer); pauseTimer = null; }
      if (recoveryTimer) { clearTimeout(recoveryTimer); recoveryTimer = null; }
      tickCount = 0;
      paused = false;
    }

    function applyBackoff() {
      consecutive429++;
      consecutiveOk = 0;
      // 时间恢复后又立刻 429 → 说明恢复太激进，加大恢复等待
      if (lastRecoveryTime > 0 && (Date.now() - lastRecoveryTime) < 30000) {
        recoveryDelay = Math.min(Math.round(recoveryDelay * 1.5), 180000);
        lastRecoveryTime = 0;
      }
      if (consecutive429 >= 2) {
        if (backoffLevel < 5) {
          backoffLevel++;
          const newInterval = Math.min(Math.round(baseInterval * Math.pow(1.5, backoffLevel)), baseInterval * 5);
          if (newInterval !== interval) {
            interval = newInterval;
            if (timer) startTimer();
            postMessage({ type: "BACKOFF_CHANGED", level: backoffLevel, interval: interval, source: "backoff" });
          }
        }
        consecutive429 = 0;
        scheduleTimeRecovery();
      }
    }

    function checkRecovery() {
      consecutiveOk++;
      consecutive429 = 0;
      if (backoffLevel > 0 && consecutiveOk >= 20) {
        backoffLevel = Math.max(0, backoffLevel - 1);
        const newInterval = backoffLevel === 0 ? baseInterval : Math.round(baseInterval * Math.pow(1.5, backoffLevel));
        if (newInterval !== interval) {
          interval = newInterval;
          if (timer) startTimer();
          postMessage({ type: "BACKOFF_CHANGED", level: backoffLevel, interval: interval, source: "recovery" });
        }
        // 连续成功恢复 → 重置恢复延迟
        recoveryDelay = 45000;
        lastRecoveryTime = 0;
        consecutiveOk = 0;
      }
    }

    function scheduleTimeRecovery() {
      if (recoveryTimer) clearTimeout(recoveryTimer);
      if (backoffLevel <= 0) return;
      recoveryTimer = setTimeout(() => {
        recoveryTimer = null;
        if (backoffLevel > 0) {
          lastRecoveryTime = Date.now();
          consecutive429 = 0;
          consecutiveOk = 0;
          backoffLevel = Math.max(0, backoffLevel - 1);
          const newInterval = backoffLevel === 0 ? baseInterval : Math.round(baseInterval * Math.pow(1.5, backoffLevel));
          if (newInterval !== interval) {
            interval = newInterval;
            if (timer) startTimer();
            postMessage({ type: "BACKOFF_CHANGED", level: backoffLevel, interval: interval, source: "time_recovery" });
          }
          if (backoffLevel > 0) scheduleTimeRecovery();
        }
      }, recoveryDelay);
    }

    onmessage = function(e) {
      const msg = e.data;
      switch (msg.type) {
        case "START":
          if (recoveryTimer) { clearTimeout(recoveryTimer); recoveryTimer = null; }
          recoveryDelay = 45000;
          lastRecoveryTime = 0;
          baseInterval = msg.interval || 500;
          interval = baseInterval;
          backoffLevel = 0;
          consecutive429 = 0;
          consecutiveOk = 0;
          paused = false;
          startTimer();
          break;
        case "STOP":
          stopTimer();
          backoffLevel = 0;
          consecutive429 = 0;
          consecutiveOk = 0;
          break;
        case "PAUSE":
          paused = true;
          break;
        case "RESUME":
          paused = false;
          break;
        case "PAUSE_FOR":
          paused = true;
          if (pauseTimer) clearTimeout(pauseTimer);
          pauseTimer = setTimeout(() => {
            paused = false;
            pauseTimer = null;
            postMessage({ type: "RESUMED" });
          }, msg.ms || 16000);
          break;
        case "BACKOFF":
          applyBackoff();
          break;
        case "OK":
          checkRecovery();
          break;
        case "SET_INTERVAL":
          baseInterval = msg.interval || 500;
          if (backoffLevel === 0) {
            interval = baseInterval;
            if (timer) startTimer();
          }
          break;
      }
    };
  `;

  let pollWorker = null;
  let useWorkerFallback = false;

  function createPollWorker() {
    if (pollWorker) return true;
    try {
      const blob = new Blob([POLL_WORKER_CODE], { type: "application/javascript" });
      const url = URL.createObjectURL(blob);
      pollWorker = new Worker(url);
      URL.revokeObjectURL(url);
      pollWorker.onmessage = handleWorkerMessage;
      pollWorker.onerror = () => {
        pollWorker = null;
        useWorkerFallback = true;
      };
      return true;
    } catch (_) {
      useWorkerFallback = true;
      return false;
    }
  }

  function handleWorkerMessage(e) {
    const msg = e.data;
    switch (msg.type) {
      case "TICK":
        pollCapacity();
        break;
      case "BACKOFF_CHANGED":
        const reasons = {
          backoff: "429 限流，自动降速",
          recovery: "连续成功，恢复速度",
          time_recovery: "定时恢复，尝试提速",
        };
        ssSend({
          type: "SS_POLL_BACKOFF",
          level: msg.level,
          interval: msg.interval,
          reason: reasons[msg.source] || (msg.level > 0 ? "429 限流，自动降速" : "限流解除，恢复速度"),
        });
        break;
      case "RESUMED":
        ssSend({ type: "SS_POLL_RESUMED" });
        break;
    }
  }

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
  let consecutiveNetErrors = 0; // 连续网络错误计数

  function startPoll(ms) {
    stopPoll();
    if (!ms || ms < 500) ms = 500;
    if (!useWorkerFallback && createPollWorker()) {
      pollWorker.postMessage({ type: "START", interval: ms });
    } else {
      baseInterval = ms; currentInterval = ms; backoffLevel = 0;
      consecutive429 = 0; consecutiveOk = 0; consecutiveNetErrors = 0;
      pollTimer = setInterval(pollCapacity, ms);
    }
  }

  function stopPoll() {
    if (pollWorker) pollWorker.postMessage({ type: "STOP" });
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function pausePollFor(ms) {
    if (pollWorker && !useWorkerFallback) {
      pollWorker.postMessage({ type: "PAUSE_FOR", ms });
    } else {
      pollPaused = true;
      setTimeout(() => {
        pollPaused = false;
        ssSend({ type: "SS_POLL_RESUMED" });
      }, ms);
    }
  }

  // 429 退避：递增间隔；连续成功后恢复
  function applyBackoff() {
    consecutive429++;
    consecutiveOk = 0;
    if (consecutive429 >= 2 && backoffLevel < 5) {
      backoffLevel++;
      const newInterval = Math.min(Math.round(baseInterval * Math.pow(1.5, backoffLevel)), baseInterval * 5);
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
    if (backoffLevel > 0 && consecutiveOk >= 20) {
      backoffLevel = Math.max(0, backoffLevel - 1);
      const newInterval = backoffLevel === 0 ? baseInterval : Math.round(baseInterval * Math.pow(1.5, backoffLevel));
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
        cache: "no-store",
      });
      consecutiveNetErrors = 0;
      if (resp.status === 429) {
        if (pollWorker && !useWorkerFallback) {
          pollWorker.postMessage({ type: "BACKOFF" });
        } else {
          applyBackoff();
        }
        ssSend({ type: "SS_POLL_ERROR", tick: pollTickCount, error: "HTTP 429 限流" });
        return;
      }
      if (!resp.ok) {
        ssSend({ type: "SS_POLL_ERROR", tick: pollTickCount, error: "HTTP " + resp.status });
        return;
      }
      if (pollWorker && !useWorkerFallback) {
        pollWorker.postMessage({ type: "OK" });
      } else {
        checkRecovery();
      }
      const data = await resp.json();
      analyzeResponse(lastCapacityReq.url, data);
    } catch (err) {
      consecutiveNetErrors++;
      if (consecutiveNetErrors >= 5) {
        ssSend({ type: "SS_POLL_BACKOFF", level: -1, interval: 0, reason: "连续网络错误，暂停轮询 30s" });
        pausePollFor(30000);
        consecutiveNetErrors = 0;
      }
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

    // 首次捕获到请求参数，如果已配置轮询间隔且尚未启动则启动
    if (pollInterval > 0 && !pollTimer && !pollWorker) startPoll(pollInterval);

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

      // pauseDuration: 暂停指定时间后自动恢复（Worker 的 setTimeout 不受后台限流）
      if (e.data.paused && e.data.pauseDuration > 0) {
        if (ms > 0) pollInterval = ms;
        if (lastCapacityReq && !pollTimer && !pollWorker) startPoll(pollInterval || ms);
        pausePollFor(e.data.pauseDuration);
        return;
      }

      if (ms > 0 && ms !== pollInterval) {
        pollInterval = ms;
        if (lastCapacityReq && !pollPaused) startPoll(ms);
      } else if (ms === 0) {
        stopPoll();
        pollInterval = 0;
      }
      if (pollPaused) {
        if (pollWorker && !useWorkerFallback) {
          pollWorker.postMessage({ type: "PAUSE" });
        } else {
          stopPoll();
        }
      } else if (pollInterval > 0 && lastCapacityReq) {
        if (pollWorker && !useWorkerFallback) {
          pollWorker.postMessage({ type: "RESUME" });
        } else if (!pollTimer) {
          startPoll(pollInterval);
        }
      }
    }

    // ── 页面上下文点击（React fiber 直接调用 onClick）──────────────
    if (e.data.type === "SS_CLICK_AT") {
      if (!_ssNonce || (e.data._ssNonce && e.data._ssNonce !== _ssNonce)) return;
      const { clickId } = e.data;
      if (!clickId) return;
      const el = document.querySelector('[data-ss-click="' + clickId + '"]');
      if (!el) return;

      const rect = el.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;

      // 策略1: 沿 DOM 向上查找 React __reactProps$ / __reactEventHandlers$ 上的 onClick 直接调用
      let reactHandled = false;
      let cur = el;
      for (let depth = 0; depth < 15 && cur && cur !== document.body; depth++) {
        const keys = Object.keys(cur);
        for (const key of keys) {
          if (key.startsWith("__reactProps$") || key.startsWith("__reactEventHandlers$")) {
            const props = cur[key];
            if (props && typeof props.onClick === "function") {
              try {
                props.onClick({
                  type: "click", target: el, currentTarget: cur,
                  preventDefault() {}, stopPropagation() {},
                  isPropagationStopped() { return false; },
                  isDefaultPrevented() { return false; },
                  persist() {},
                  nativeEvent: new MouseEvent("click", { bubbles: true, clientX: x, clientY: y }),
                  bubbles: true, cancelable: true, clientX: x, clientY: y,
                });
                reactHandled = true;
              } catch (_) {}
              break;
            }
          }
        }
        if (reactHandled) break;
        cur = cur.parentElement;
      }

      // 策略2: 无 React handler → 分派完整原生事件序列 + 原生 .click()
      if (!reactHandled) {
        const evtInit = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
        el.dispatchEvent(new PointerEvent("pointerdown", evtInit));
        el.dispatchEvent(new MouseEvent("mousedown", evtInit));
        el.dispatchEvent(new PointerEvent("pointerup", evtInit));
        el.dispatchEvent(new MouseEvent("mouseup", evtInit));
        el.dispatchEvent(new MouseEvent("click", evtInit));
        el.click();
      }
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
