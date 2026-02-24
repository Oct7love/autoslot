/* ─────────────────────────────────────────────
   AutoSlot – Content Script
   Noon FBN 仓库 slot 专用自动抢位
   支持：自动检测、自动点击、自动刷新
   ───────────────────────────────────────────── */

(() => {
  "use strict";

  if (window.__SS_CONTENT_INJECTED__) return;
  window.__SS_CONTENT_INJECTED__ = true;

  // URL 安全检查：仅在 FBN 调度页面运行
  const _ssHost = location.hostname;
  if (_ssHost !== "fbn.noon.partners" && !_ssHost.endsWith(".noon.com")) {
    return;
  }

  // ── State ────────────────────────────────────────────────────────

  const _ssNonce = Array.from(crypto.getRandomValues(new Uint8Array(16)),
    b => b.toString(16).padStart(2, "0")).join("");

  let cfg = {};
  let armed = false;
  let highlightOn = true;
  let autoClickEnabled = false;
  let autoRefreshEnabled = false;
  let autoRefreshInterval = 30;
  let currentState = "UNKNOWN";
  let capacityLock = true; // 默认锁定：只有 capacity API 确认有仓位才能触发抢位
  let candidates = [];
  let cycleIndex = -1;
  let cooldownUntil = 0;
  let grabInFlight = false; // 抢位流程是否正在执行，防止 API/DOM 并发重复触发
  let grabSafetyTimer = null; // grabInFlight 超时安全阀
  let chainTotalRetries = 0; // Confirm 按钮强制点击后的累计重试次数（总超时控制）
  let chainStartUrl = ""; // 链式点击开始时的 URL，用于检测页面跳转
  let lastTransition = null;
  let lastCheckTime = null;
  let titleFlashTimer = null;
  let originalTitle = document.title;
  let fallbackTimer = null;
  let refreshTimer = null;
  let observer = null;
  let throttleTimer = null;
  const THROTTLE_MS = 150;
  let lastApplyWarehouseTime = 0;
  let pollActive = false; // API 轮询是否已激活（已捕获 capacity 请求参数）
  let pollCount = 0; // API 轮询次数
  let pollLastLogTime = Date.now(); // 上次打印轮询摘要的时间
  let actualPollInterval = 500; // 实际轮询间隔（含退避调整）
  let pollBackoffLevel = 0; // 当前退避等级
  let pollMaxBackoffSince = 0; // 持续 L4 的起始时间
  const POLL_FALLBACK_MS = 300000; // L4 持续 5 分钟 → 回退页面刷新
  const POLL_LOG_INTERVAL = 10000; // 每 10 秒打印一次轮询摘要
  const PREFERRED_WAREHOUSE_REAPPLY_MS = 4000;

  // ── Noon FBN 专用售罄关键词 ──────────────────────────────────────

  const SOLD_OUT_PATTERNS = [
    /no\s+slots?\s+available/i,
    /sold\s+out/i,
    /\bfully\s+booked\b/i,
    /no\s+capacity/i,
    /slots?\s+are\s+full/i,
    /no\s+delivery\s+slots/i,
    /no\s+shipping\s+slots/i,
    /all\s+slots?\s+(are\s+)?taken/i,
    /no\s+time\s+slots/i,
  ];

  // ── 安全/反爬关键词 ──────────────────────────────────────────────

  const SAFETY_PATTERNS = [
    /access\s+denied/i,
    /too\s+many\s+requests/i,
    /rate\s+limit/i,
    /\brobot\b/i,
    /captcha/i,
    /blocked/i,
    /unusual\s+activity/i,
  ];

  // ── Noon FBN 专用按钮关键词（优先级从高到低）─────────────────────

  const LABEL_KEYWORDS = [
    "book",
    "reserve",
    "select",
    "choose",
    "schedule",
    "confirm",
    "continue",
    "submit",
    "add",
    "create",
    "save",
    "apply",
    "proceed",
    "next",
  ];

  // ── Noon FBN 专用容器选择器 ──────────────────────────────────────

  const SLOT_CONTAINER_SELECTORS = [
    '[class*="slot"]',
    '[class*="calendar"]',
    '[class*="schedule"]',
    '[class*="availability"]',
    '[class*="booking"]',
    '[class*="delivery"]',
    '[class*="shipping"]',
    '[class*="warehouse"]',
    '[class*="fbn"]',
    '[class*="capacity"]',
    '[class*="time"]',
    '[class*="date"]',
    '[class*="inbound"]',
    '[data-testid*="slot"]',
    '[data-testid*="schedule"]',
    '[data-testid*="booking"]',
    'main',
    '[role="main"]',
    '[class*="content"]',
    '[class*="modal"]',
    '[class*="dialog"]',
  ].join(",");

  // ── 工具函数：解析首选日期字符串 ──────────────────────────────────

  function parsePreferredDates(str) {
    if (!str || typeof str === "number") {
      const n = parseInt(str, 10);
      return (n >= 1 && n <= 31) ? [n] : [];
    }
    const parts = String(str).split(",").map(s => s.trim()).filter(Boolean);
    const result = new Set();
    for (const part of parts) {
      const rangeMatch = part.match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
      if (rangeMatch) {
        const start = parseInt(rangeMatch[1], 10);
        const end = parseInt(rangeMatch[2], 10);
        if (start >= 1 && end <= 31 && start <= end) {
          for (let i = start; i <= end; i++) result.add(i);
        }
      } else {
        const n = parseInt(part, 10);
        if (n >= 1 && n <= 31) result.add(n);
      }
    }
    return Array.from(result).sort((a, b) => a - b);
  }

  // ── 从 capacity API 响应提取日期（日号）─────────────────────────
  const _dateRe = /(\d{4})-(\d{2})-(\d{2})/;

  function extractSlotDays(slots, apiUrl) {
    const days = [];
    // 1) 从 slot 对象提取
    if (Array.isArray(slots)) {
      for (const slot of slots) {
        if (!slot || typeof slot !== "object") continue;
        // 尝试所有已知字段名
        const candidates = [
          slot.start, slot.startDate, slot.date, slot.slotDate,
          slot.slotStart, slot.startTime, slot.end, slot.endDate, slot.endTime,
        ];
        let found = false;
        for (const val of candidates) {
          if (!val) continue;
          const m = String(val).match(_dateRe);
          if (m) { days.push(parseInt(m[3], 10)); found = true; break; }
        }
        // 兜底：在整个 slot JSON 中搜索日期模式
        if (!found) {
          const json = JSON.stringify(slot);
          const m = json.match(_dateRe);
          if (m) days.push(parseInt(m[3], 10));
        }
      }
      // 首次无法提取时，输出 slot 数据结构帮助调试
      if (days.length === 0 && slots.length > 0) {
        const sample = slots[0];
        const keys = Object.keys(sample).join(", ");
        const json = JSON.stringify(sample).slice(0, 300);
        log("warn", `[extractSlotDays] 无法从 slot 提取日期！字段: [${keys}] | 样本: ${json}`);
      }
    }
    // 2) slot 对象提取不到时，从 API URL 中提取日期
    if (days.length === 0 && apiUrl) {
      const m = String(apiUrl).match(_dateRe);
      if (m) days.push(parseInt(m[3], 10));
    }
    return days;
  }

  // ── 工具函数：时间文本 → 分钟数 ──────────────────────────────────

  function parseTimeToMinutes(str) {
    if (!str) return -1;
    const s = str.trim();
    const m = s.match(/^(\d{1,2})\s*(am|pm)$/i);
    if (m) {
      let h = parseInt(m[1], 10);
      const isPm = m[2].toLowerCase() === "pm";
      if (h === 12) h = isPm ? 12 : 0;
      else if (isPm) h += 12;
      return h * 60;
    }
    const m24 = s.match(/^(\d{1,2}):(\d{2})$/);
    if (m24) {
      const h = parseInt(m24[1], 10);
      const min = parseInt(m24[2], 10);
      if (h >= 0 && h <= 23 && min >= 0 && min <= 59) return h * 60 + min;
    }
    return -1;
  }

  // ── 工具函数：判断时段文本是否在范围内 ─────────────────────────────

  function isTimeInRange(slotText, rangeText) {
    if (!rangeText) return false;
    const rangeTrimmed = rangeText.trim().toLowerCase();
    // 解析范围：如 "9am-4pm"
    const rangeMatch = rangeTrimmed.match(/^(\d{1,2}\s*[ap]m|\d{1,2}:\d{2})\s*-\s*(\d{1,2}\s*[ap]m|\d{1,2}:\d{2})$/i);
    if (!rangeMatch) {
      // 不是有效范围格式 → 退回精确文本匹配
      return slotText.toLowerCase().replace(/\s+/g, " ").includes(rangeTrimmed.replace(/\s+/g, " "));
    }
    const rangeStart = parseTimeToMinutes(rangeMatch[1]);
    const rangeEnd = parseTimeToMinutes(rangeMatch[2]);
    if (rangeStart < 0 || rangeEnd < 0) {
      return slotText.toLowerCase().replace(/\s+/g, " ").includes(rangeTrimmed.replace(/\s+/g, " "));
    }

    // 从 slotText 提取所有时间点（如 "From 9am - To 11am" → [540, 660]）
    const timeTokens = slotText.match(/\d{1,2}\s*[ap]m|\d{1,2}:\d{2}/gi);
    if (!timeTokens || timeTokens.length === 0) return false;

    const slotMinutes = timeTokens.map(parseTimeToMinutes).filter(m => m >= 0);
    if (slotMinutes.length === 0) return false;

    // 判断 slot 的所有时间点是否都在范围内
    return slotMinutes.every(m => m >= rangeStart && m <= rangeEnd);
  }

  // ── 判断是否在 Schedule Shipment 页面 ───────────────────────────

  function isScheduleShipmentPage() {
    const heading = (document.body?.innerText || "").slice(0, 3000);
    return /schedule\s+shipment/i.test(heading);
  }

  // ── 检测时段卡片（"From 9am - To 12pm" 之类）────────────────────

  const TIME_PATTERN = /\d{1,2}\s*[ap]m|\d{1,2}:\d{2}/i;
  const FROM_TO_PATTERN = /from\s+(\d{1,2}\s*[ap]m|\d{1,2}:\d{2})/i;

  function detectTimeSlotCards() {
    const selectors = [
      'div[role="button"]', '[role="button"]', 'button',
      'a', 'li', 'label',
      '[class*="slot"]', '[class*="time"]', '[class*="card"]',
      '[class*="option"]', '[class*="period"]', '[class*="shift"]',
      '[data-testid]',
    ];
    const all = document.querySelectorAll(selectors.join(","));
    const scored = [];

    for (const el of all) {
      if (el.closest("#ss-toast, #ss-slot-label, #ss-safety-banner, #ss-autoclick-overlay")) continue;

      const text = (el.textContent || "").trim();
      if (text.length > 120 || text.length < 3) continue;
      if (!TIME_PATTERN.test(text)) continue;

      const rect = el.getBoundingClientRect();
      if (rect.width < 20 || rect.height < 15) continue;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;

      let score = 100;
      if (FROM_TO_PATTERN.test(text)) score += 50;
      const timeMatches = text.match(/\d{1,2}\s*[ap]m|\d{1,2}:\d{2}/gi);
      if (timeMatches && timeMatches.length >= 2) score += 40;
      if (el.matches('[role="button"], button, a')) score += 30;
      if (el.closest('[class*="slot"], [class*="time"], [class*="card"]')) score += 20;

      const preferredTime = (cfg.preferredTimeText || "").trim();
      if (preferredTime && isTimeInRange(text, preferredTime)) {
        score += 200;
      }

      scored.push({
        el,
        score,
        text: text.replace(/\s+/g, " ").slice(0, 60),
        selector: describeSelector(el),
      });
    }

    // 去重：若父元素和子元素都命中，只保留更小的那个（实际卡片）
    const filtered = scored.filter((item) => {
      return !scored.some((other) => other !== item && item.el.contains(other.el) && other.el !== item.el);
    });

    filtered.sort((a, b) => b.score - a.score);
    return filtered;
  }

  // ── Init ─────────────────────────────────────────────────────────

  function init() {
    chrome.runtime.sendMessage({ type: "GET_CONFIG" }, (response) => {
      if (chrome.runtime.lastError) return;
      cfg = response || {};
      armed = cfg.armed === true;
      highlightOn = cfg.highlightOn !== false;
      autoClickEnabled = !!cfg.autoClick;
      autoRefreshEnabled = !!cfg.autoRefresh;
      autoRefreshInterval = cfg.autoRefreshSec || 30;

      // 检查紧急抢位标记（API 轮询检测到仓位后触发的刷新）
      const urgentAge = cfg.urgentGrabTime ? Date.now() - cfg.urgentGrabTime : Infinity;
      if (cfg.urgentGrab && urgentAge < 30000) {
        chrome.storage.local.set({ urgentGrab: false });
        capacityLock = false; // API 已确认有仓位，解锁 DOM 检测
        log("info", "⚡ [极速] 紧急抢位模式 — API 已确认有仓位，capacityLock 已解锁");
      } else {
        log("info", "脚本加载完成 | armed=" + armed + " | autoClick=" + autoClickEnabled);
      }

      // #2 #3: 通过 DOM 隐蔽通道传递 nonce，避免 postMessage 暴露
      const meta = document.createElement("meta");
      meta.name = "__ss";
      meta.content = _ssNonce;
      document.head.appendChild(meta);
      sendInitWithRetry();
      applyPreferredWarehouse();
      runDetection();
      startObserver();
      startFallbackTimer();
      if (autoRefreshEnabled) startAutoRefresh();
      // 刷新后 Ship To 下拉可能晚渲染，多次尝试填回首选仓库，避免变成「没显示仓库」
      if ((cfg.preferredWarehouse || "").trim()) {
        setTimeout(applyPreferredWarehouse, 500);
        setTimeout(applyPreferredWarehouse, 1500);
        setTimeout(applyPreferredWarehouse, 3000);
      }
      // 从邮件点进链接时页面可能刚加载，slot 稍后才渲染，延迟再检测几次
      setTimeout(runDetection, 800);
      setTimeout(runDetection, 2000);
      setTimeout(() => {
        if (capacityLock && !pollActive) {
          capacityLock = false;
          log("warn", "⚠️ capacityLock 120s 超时未收到 API 轮询信号，自动解锁");
        }
      }, 120000);
    });
    // 从邮件点进后切回该标签页时立即再检测一次（"点进去"时自动抢）
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && armed) {
        applyPreferredWarehouse();
        runDetection();
      }
    });
  }

  // ── SS_INIT 重试机制（#2: 解决 injected.js 加载时序竞争）────────

  let initRetryTimer = null;

  function sendInitWithRetry() {
    let attempts = 0;
    const maxAttempts = 25; // 200ms × 25 = 5秒
    const send = () => {
      if (attempts >= maxAttempts) {
        log("warn", "SS_INIT 重试超时（5秒），injected.js 可能未加载");
        return;
      }
      attempts++;
      window.postMessage({ type: "SS_INIT" }, "*");
      initRetryTimer = setTimeout(send, 200);
    };
    send();
  }

  // ── 自主选择仓库（Ship To 下拉）──────────────────────────────────

  let warehouseApplyInProgress = false;
  let reselectInFlight = false; // 重选仓库流程互斥锁

  function applyPreferredWarehouse() {
    const wh = (cfg.preferredWarehouse || "").trim().toUpperCase();
    if (!wh) return false;
    if (warehouseApplyInProgress) return false;

    const bodyText = document.body?.innerText || "";

    // 如果页面已经显示了该仓库（已选中），不再操作
    const upper = bodyText.toUpperCase();
    if (upper.includes("NO SLOTS AVAILABLE IN THE " + wh) || upper.includes("AVAILABLE IN " + wh)) {
      return true;
    }

    // 检查当前下拉是否已显示该仓库
    const currentDisplay = findShipToCurrentValue();
    if (currentDisplay && currentDisplay.toUpperCase().includes(wh)) {
      return true;
    }

    log("info", `选仓库: 当前显示 "${currentDisplay || "未知"}"，需要切换到 ${wh}`);

    // 策略: 找到 Ship To 区块，点击下拉框，然后点击选项
    warehouseApplyInProgress = true;

    // 在 Ship To 区块内找可点击的下拉触发器
    const clickTarget = findDropdownTrigger();
    if (!clickTarget) {
      log("warn", "选仓库: 未找到 Ship To 下拉触发器");
      warehouseApplyInProgress = false;
      return false; // 返回 false → 不更新时间戳，下次立即重试
    }

    // Ant Design Select 需要 mousedown 事件才能打开下拉
    clickTarget.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    clickTarget.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    clickTarget.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    // 同时聚焦内部 input 触发搜索框
    const searchInput = clickTarget.closest(".ant-select")?.querySelector('input[type="search"], input[role="combobox"]');
    if (searchInput) searchInput.focus();
    log("info", "选仓库: 已点击下拉框，等待选项…");

    let optionAttempt = 0;
    const findAndClickOption = () => {
      optionAttempt++;

      // Ant Design 下拉选项渲染在 body 根部的 .ant-select-dropdown 内
      const candidates = document.querySelectorAll(
        '.ant-select-item-option, .ant-select-item, ' +
        '[class*="option"], [role="option"], [role="menuitem"]'
      );

      for (const opt of candidates) {
        const optText = (opt.textContent || "").trim();
        if (optText.length > 50) continue;
        if (optText.toUpperCase() === wh || optText.toUpperCase().includes(wh)) {
          const rect = opt.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          opt.click();
          log("info", `✅ 已选择仓库: ${optText}`);
          warehouseApplyInProgress = false;
          return;
        }
      }

      if (optionAttempt < 15) {
        setTimeout(findAndClickOption, 400);
      } else {
        log("warn", "选仓库: 15次尝试后仍未找到 " + wh + " 选项");
        document.body.click();
        warehouseApplyInProgress = false;
      }
    };

    setTimeout(findAndClickOption, 500);
    return true;
  }

  /**
   * 重选仓库：打开下拉 → 选别的仓库 → 再选回目标仓库
   * 目的：强制页面 React 重新调 capacity API 并渲染
   * 比 location.reload() 快 5-7 秒
   */
  function triggerWarehouseReselect() {
    if (reselectInFlight) return; // 已有重选流程在执行，跳过
    reselectInFlight = true;
    warehouseApplyInProgress = true; // 阻止 DOM 检测在重选期间误触发
    const wh = (cfg.preferredWarehouse || "").trim().toUpperCase();
    if (!wh) {
      log("warn", "重选仓库: 未设首选仓库，回退到 reload");
      reselectInFlight = false;
      warehouseApplyInProgress = false;
      finishGrab();
      chrome.storage.local.set({ urgentGrab: true, urgentGrabTime: Date.now() }, () => location.reload());
      return;
    }

    const clickTarget = findDropdownTrigger();
    if (!clickTarget) {
      log("warn", "重选仓库: 未找到下拉触发器，回退到 reload");
      reselectInFlight = false;
      warehouseApplyInProgress = false;
      finishGrab();
      chrome.storage.local.set({ urgentGrab: true, urgentGrabTime: Date.now() }, () => location.reload());
      return;
    }

    log("info", "⚡ 步骤1: 打开下拉框，准备切换仓库…");
    clickTarget.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    clickTarget.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    clickTarget.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    const searchInput = clickTarget.closest(".ant-select")?.querySelector('input[type="search"], input[role="combobox"]');
    if (searchInput) searchInput.focus();

    // 先选一个别的仓库（触发 React 状态变化），然后再选回目标仓库
    let reselectAttempt = 0;
    const doReselect = () => {
      reselectAttempt++;
      const options = document.querySelectorAll(
        '.ant-select-item-option, .ant-select-item, [role="option"]'
      );

      // 找一个不是目标仓库的选项先点一下
      let otherOption = null;
      let targetOption = null;
      for (const opt of options) {
        const txt = (opt.textContent || "").trim().toUpperCase();
        if (txt.length > 50 || !txt) continue;
        const rect = opt.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (txt.includes(wh)) {
          targetOption = opt;
        } else if (!otherOption) {
          otherOption = opt;
        }
      }

      if (!otherOption || !targetOption) {
        if (reselectAttempt < 10) {
          setTimeout(doReselect, 300);
        } else {
          log("warn", "重选仓库: 选项未找到，回退到 reload");
          document.body.click();
          reselectInFlight = false;
          warehouseApplyInProgress = false;
          finishGrab();
          chrome.storage.local.set({ urgentGrab: true, urgentGrabTime: Date.now() }, () => location.reload());
        }
        return;
      }

      // 先点别的仓库
      log("info", `⚡ 步骤2: 临时切换到 "${(otherOption.textContent || "").trim()}"…`);
      otherOption.click();

      // 等 React 更新后，再打开下拉选回目标仓库
      setTimeout(() => {
        log("info", "⚡ 步骤3: 重新打开下拉框，选回目标仓库…");
        const trigger2 = findDropdownTrigger();
        if (trigger2) {
          trigger2.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
          trigger2.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
          trigger2.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        }

        setTimeout(() => {
          const options2 = document.querySelectorAll(
            '.ant-select-item-option, .ant-select-item, [role="option"]'
          );
          for (const opt of options2) {
            const txt = (opt.textContent || "").trim().toUpperCase();
            if (txt.includes(wh)) {
              const rect = opt.getBoundingClientRect();
              if (rect.width === 0 || rect.height === 0) continue;
              opt.click();
              log("info", `⚡ 步骤4: 已选回 ${wh}，等待页面刷新数据…`);
              // 页面会自己调 capacity API → injected.js 拦截 → 如果有 slot 会再次触发
              // 同时 DOM 也会更新 → MutationObserver 检测到时段卡片 → 自动抢
              reselectInFlight = false;
              warehouseApplyInProgress = false;
              afterWarehouseReselect();
              return;
            }
          }
          log("warn", "重选仓库: 选回失败，回退到 reload");
          reselectInFlight = false;
          warehouseApplyInProgress = false;
          finishGrab();
          chrome.storage.local.set({ urgentGrab: true, urgentGrabTime: Date.now() }, () => location.reload());
        }, 500);
      }, 800);
    };

    setTimeout(doReselect, 500);
  }

  /** 重选仓库后：走完整的 日期→时段→确认 流程 */
  function afterWarehouseReselect() {
    if (!armed || !autoClickEnabled) { finishGrab(); return; }
    log("info", "✅ 仓库重选完成，开始检测日期…");
    currentState = "AVAILABLE";
    lastTransition = Date.now();
    waitForDateClick(0);
  }

  /** 找到 Ship To 区块里下拉框当前显示的文字（Ant Design Select） */
  function findShipToCurrentValue() {
    const block = findShipToBlock();
    if (!block) return "";
    // Ant Design: span.ant-select-selection-item 的 title 属性 = 当前值
    const item = block.querySelector(".ant-select-selection-item");
    if (item) return (item.getAttribute("title") || item.textContent || "").trim();
    // 备用
    const el = block.querySelector('[class*="single-value"], [class*="singleValue"], input');
    return el ? (el.value || el.textContent || "").trim() : "";
  }

  /** 找到 Ship To 区块内可点击的下拉触发器（Ant Design Select） */
  function findDropdownTrigger() {
    const block = findShipToBlock();
    if (!block) return null;
    // Ant Design: 点击 .ant-select-selector 打开下拉
    const selector = block.querySelector(".ant-select-selector");
    if (selector && selector.getBoundingClientRect().width > 0) return selector;
    // 备用: 点击整个 .ant-select
    const antSelect = block.querySelector(".ant-select");
    if (antSelect && antSelect.getBoundingClientRect().width > 0) return antSelect;
    // 最后备用
    const input = block.querySelector('input, [role="combobox"]');
    if (input && input.getBoundingClientRect().width > 0) return input;
    return null;
  }

  /** 找到页面中 "Ship To" 对应的 DOM 块 */
  function findShipToBlock() {
    const allEls = document.querySelectorAll("label, span, div, p, h1, h2, h3, h4, h5, h6, td, th, dt, dd");
    for (const el of allEls) {
      if (el.children.length > 20) continue;
      const ownText = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent.trim())
        .join(" ");
      if (/^ship\s*to$/i.test(ownText)) {
        // 从 "Ship To" 标签往上找包含 ant-select 的容器
        let block = el.parentElement;
        while (block && block !== document.body) {
          if (block.querySelector('.ant-select, input, [role="combobox"]')) {
            return block;
          }
          block = block.parentElement;
        }
      }
    }
    return null;
  }

  /** 从页面读取当前选中的 Ship To 仓库（用于判断是否是指定仓库） */
  function getCurrentWarehouseFromPage() {
    const select = document.querySelector("select");
    if (select && select.value) {
      const opt = Array.from(select.querySelectorAll("option")).find((o) => o.value === select.value);
      const t = (opt?.textContent ?? select.value ?? "").trim().toUpperCase();
      if (t) return t;
    }
    const bodyText = document.body?.innerText || "";
    if (!/ship\s+to|warehouse|仓库/i.test(bodyText)) return "";
    const inputs = document.querySelectorAll('input[type="text"], input[role="combobox"], [role="combobox"]');
    for (const inp of inputs) {
      const label = (inp.closest("label")?.textContent || inp.previousElementSibling?.textContent || "").toLowerCase();
      if (!/ship\s+to|warehouse|仓库|destination/.test(label)) continue;
      const v = (inp.value || inp.getAttribute("value") || "").trim().toUpperCase();
      if (v) return v;
    }
    return "";
  }

  // ── 向上查找实际可点击的容器元素 ─────────────────────────────────

  function findClickableAncestor(el) {
    let cur = el;
    // 向上最多遍历 5 层，找 cursor:pointer 且尺寸合理的祖先
    for (let i = 0; i < 5 && cur && cur !== document.body; i++) {
      const parent = cur.parentElement;
      if (!parent) break;
      const pStyle = getComputedStyle(parent);
      const pRect = parent.getBoundingClientRect();
      // 圆形日期按钮通常 30-100px，cursor:pointer
      if (pStyle.cursor === "pointer" && pRect.width <= 120 && pRect.height <= 120 && pRect.width > 0) {
        cur = parent;
      } else {
        break;
      }
    }
    return cur;
  }

  // ── 模拟完整点击（委托到页面上下文，兼容 React fiber）─────────────

  let _ssClickSeq = 0;
  function simulateFullClick(el) {
    // 用临时 DOM 属性标记目标元素，让页面上下文（injected.js）能精确找到它
    // 不依赖坐标/elementFromPoint，避免 overlay 遮挡导致点到错误元素
    const clickId = (++_ssClickSeq).toString(36) + "_" + Date.now().toString(36);
    el.setAttribute("data-ss-click", clickId);
    log("info", `[simulateFullClick] 标记元素 <${el.tagName.toLowerCase()}> clickId=${clickId} → 发送 SS_CLICK_AT`);
    window.postMessage({ type: "SS_CLICK_AT", clickId, _ssNonce }, "*");
    // 延迟清除标记
    setTimeout(() => {
      if (el.getAttribute("data-ss-click") === clickId) el.removeAttribute("data-ss-click");
    }, 500);
  }

  // ── 点击可用日期（Noon FBN: 有仓位时页面直接弹出日期圆形按钮）──
  // 返回值: "clicked" = 已点击 | "no-dates" = 页面无日期元素 | "filtered" = 日期存在但不匹配偏好

  function tryClickAvailableDate() {
    const preferredDays = parsePreferredDates(cfg.preferredDate);
    const dateCandidates = [];
    const _diag = { scanned: 0, nums: {}, disabled: [], prefFiltered: [], rejected: [] };

    // Noon FBN 页面特征：有仓位时直接显示一个日期数字（圆形按钮），
    // 不是传统日历网格。策略：全页面扫描所有含 1-31 数字的可见小型元素。
    const all = document.querySelectorAll("*");

    for (const el of all) {
      // 跳过子元素过多的容器（日期按钮通常是叶子节点或只有1-2层嵌套）
      if (el.children.length > 3) continue;
      // 跳过扩展自身注入的 UI
      if (el.closest("#ss-toast, #ss-slot-label, #ss-safety-banner, #ss-autoclick-overlay")) continue;

      const rect = el.getBoundingClientRect();
      // 日期按钮是圆形/小型元素，排除过大或不可见的
      if (rect.width < 8 || rect.height < 8 || rect.width > 150 || rect.height > 150) continue;

      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;

      // 提取文本：优先直接文本节点，再看 fullText
      const ownText = Array.from(el.childNodes)
        .filter(n => n.nodeType === Node.TEXT_NODE)
        .map(n => n.textContent.trim())
        .join("").trim();
      const fullText = (el.textContent || "").trim();

      // 只要纯数字 1-31（日期按钮内容就是一个数字）
      let num = 0;
      if (/^\d{1,2}$/.test(ownText)) num = parseInt(ownText, 10);
      else if (/^\d{1,2}$/.test(fullText) && fullText.length <= 2) num = parseInt(fullText, 10);
      if (num < 1 || num > 31) continue;

      _diag.scanned++;
      _diag.nums[num] = (_diag.nums[num] || 0) + 1;

      // disabled 检测
      const isDisabled = el.hasAttribute("disabled") ||
        el.getAttribute("aria-disabled") === "true" ||
        /disabled/i.test((el.className || "").toString()) ||
        style.pointerEvents === "none" ||
        parseFloat(style.opacity) < 0.4;
      if (isDisabled) { _diag.disabled.push(num); continue; }

      // 偏好日期过滤
      if (preferredDays.length > 0 && !preferredDays.includes(num)) { _diag.prefFiltered.push(num); continue; }

      // 排除明显不是日期按钮的元素（导航、分页、标题中的数字等）
      const tag = el.tagName.toLowerCase();
      const cls = ((el.className || "") + " " + (el.parentElement?.className || "")).toString().toLowerCase();
      if (/pagination|pager|page-num|breadcrumb|nav-item|header|footer|menu/i.test(cls)) {
        _diag.rejected.push(`${num}号(${tag}.${cls.slice(0,20)})`);
        continue;
      }

      // 评分：越像日期按钮分越高
      let score = 10; // 基础分（找到数字就有分）
      // 圆形特征（border-radius ≥ 40% 视为圆形按钮）
      const br = style.borderRadius || "";
      if (/50%|100%/.test(br) || parseInt(br) >= Math.min(rect.width, rect.height) * 0.4) score += 300;
      // 有背景色（蓝色圆形日期按钮的典型特征）
      const bg = style.backgroundColor || "";
      if (bg && bg !== "rgb(255, 255, 255)" && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") score += 200;
      // 接近正方形（圆形按钮特征）
      const ratio = rect.width / rect.height;
      if (ratio >= 0.7 && ratio <= 1.4) score += 100;
      // cursor: pointer
      if (style.cursor === "pointer") score += 100;
      // 可点击元素类型
      if (/^(button|a|td)$/i.test(tag)) score += 80;
      if (/button|gridcell|option/i.test(el.getAttribute("role") || "")) score += 80;
      // 在 Schedule 页面主内容区域内
      if (el.closest('[class*="schedule"], [class*="shipment"], [class*="slot"], [class*="booking"]')) score += 150;
      // class 含日期相关关键词
      if (/date|day|calendar|picker|selected|active|available/i.test(cls)) score += 100;
      // ownText 就是纯数字 → 几乎确定是日期按钮
      if (/^\d{1,2}$/.test(ownText)) score += 50;

      dateCandidates.push({ el, num, score });
    }

    // ── 诊断日志 ──
    if (!dateCandidates.length) {
      const numsStr = Object.entries(_diag.nums).map(([n, c]) => `${n}号×${c}`).join(", ") || "无";
      const parts = [
        `扫描含数字元素: ${_diag.scanned}`,
        `日期数字: [${numsStr}]`,
      ];
      if (_diag.disabled.length) parts.push(`disabled: [${[...new Set(_diag.disabled)].join(",")}]`);
      if (_diag.prefFiltered.length) parts.push(`偏好过滤: [${[...new Set(_diag.prefFiltered)].join(",")}]`);
      if (_diag.rejected.length) parts.push(`排除: [${_diag.rejected.join(",")}]`);

      // 深度 DOM 诊断：dump 页面上所有可见的含 1-2 位数字的元素
      const allNums = [];
      for (const el of document.querySelectorAll("*")) {
        const t = (el.textContent || "").trim();
        if (t.length > 5 || t.length < 1) continue;
        if (!/^\d{1,2}$/.test(t)) continue;
        const n = parseInt(t, 10);
        if (n < 1 || n > 31) continue;
        if (el.children.length > 2) continue;
        const s = getComputedStyle(el);
        if (s.display === "none" || s.visibility === "hidden") continue;
        const r = el.getBoundingClientRect();
        if (r.width < 3 || r.height < 3) continue;
        allNums.push(
          `<${el.tagName.toLowerCase()}` +
          ` class="${(el.className||"").toString().slice(0,40)}"` +
          ` ${Math.round(r.width)}×${Math.round(r.height)}` +
          ` cursor=${s.cursor}` +
          ` bg=${(s.backgroundColor||"none").slice(0,25)}` +
          ` br=${(s.borderRadius||"0").slice(0,10)}` +
          ` opacity=${s.opacity}` +
          ` pointer-events=${s.pointerEvents}` +
          `>${t}`
        );
        if (allNums.length >= 20) break;
      }
      if (allNums.length) parts.push(`全页面数字元素详情: [${allNums.join(" | ")}]`);

      // 页面是否有 iframe
      const iframes = document.querySelectorAll("iframe");
      if (iframes.length) parts.push(`⚠️ ${iframes.length}个iframe`);

      log("warn", `[日期诊断] ${parts.join(" | ")}`);
      // 区分：有日期但被偏好过滤 vs 页面完全没日期
      if (_diag.prefFiltered.length > 0) return "filtered";
      return "no-dates";
    }

    // 去重并取最高分
    const byNum = {};
    for (const c of dateCandidates) {
      if (!byNum[c.num] || c.score > byNum[c.num].score) byNum[c.num] = c;
    }
    const sorted = Object.values(byNum).sort((a, b) => b.score - a.score);
    const best = sorted[0];

    log("info", `日期候选: ${sorted.map(c => c.num + "号(" + c.score + "分)").join(", ")}`);

    const clickTarget = findClickableAncestor(best.el);
    log("info", `点击目标: <${clickTarget.tagName.toLowerCase()}> class="${(clickTarget.className || "").toString().slice(0, 80)}" cursor=${getComputedStyle(clickTarget).cursor}`);

    clickTarget.scrollIntoView({ behavior: "instant", block: "center" });
    simulateFullClick(clickTarget);
    log("info", `✅ 步骤1: 已点击日期 ${best.num} 号（得分 ${best.score}）`);
    return "clicked";
  }

  // ── Logging ──────────────────────────────────────────────────────

  function log(level, message, data) {
    const entry = { level, message, ...(data || {}) };
    try {
      chrome.runtime.sendMessage({ type: "LOG", entry });
    } catch (_) {}
  }

  // ── MutationObserver（主检测）────────────────────────────────────

  function startObserver() {
    if (observer) observer.disconnect();
    observer = new MutationObserver(() => {
      if (!armed) return;
      if (throttleTimer) return;
      throttleTimer = setTimeout(() => {
        throttleTimer = null;
        runDetection();
      }, THROTTLE_MS);
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["disabled", "class", "aria-disabled", "style", "hidden"],
    });
  }

  // ── 备用轮询（25–55秒随机间隔）──────────────────────────────────

  function startFallbackTimer() {
    clearTimeout(fallbackTimer);
    const jitter = () => Math.floor(25000 + Math.random() * 30000);
    const tick = () => {
      if (armed) runDetection();
      fallbackTimer = setTimeout(tick, jitter());
    };
    fallbackTimer = setTimeout(tick, jitter());
  }

  // ── 自动刷新 ────────────────────────────────────────────────────

  function startAutoRefresh() {
    stopAutoRefresh();
    if (!autoRefreshEnabled || !armed) return;
    const ms = (autoRefreshInterval || 30) * 1000;
    const jitter = Math.floor(Math.random() * 5000);
    refreshTimer = setTimeout(() => {
      // 抢位流程进行中，绝不刷新页面
      if (grabInFlight) {
        log("info", "跳过页面刷新（抢位流程进行中）");
        startAutoRefresh();
        return;
      }
      if (autoRefreshEnabled && armed && currentState !== "AVAILABLE") {
        // API 轮询已激活时跳过页面刷新，轮询本身就是"刷新"
        if (pollActive) {
          const stuckAtMax = pollMaxBackoffSince > 0 &&
            (Date.now() - pollMaxBackoffSince) > POLL_FALLBACK_MS;
          if (!stuckAtMax) {
            log("info", "跳过页面刷新（API 轮询已激活，无需 reload）");
            startAutoRefresh();
            return;
          }
          log("warn", "⚠️ API 轮询长期限流(L4 超5分钟)，回退到页面刷新");
        } else {
          log("info", "自动刷新页面…");
        }
        location.reload();
      } else {
        startAutoRefresh();
      }
    }, ms + jitter);
  }

  function stopAutoRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }

  // ── 安全检测 ─────────────────────────────────────────────────────

  function checkSafety() {
    const text = document.body?.innerText || "";
    for (const p of SAFETY_PATTERNS) {
      if (p.test(text)) {
        armed = false;
        chrome.storage.local.set({ armed: false });
        showSafetyBanner();
        log("warn", "安全触发器: " + p.toString());
        return false;
      }
    }
    return true;
  }

  function showSafetyBanner() {
    if (document.getElementById("ss-safety-banner")) return;
    const banner = document.createElement("div");
    banner.id = "ss-safety-banner";
    banner.textContent = "⚠️ AutoSlot 已暂停 — 检测到反爬信号，请手动重新启用";
    document.body.appendChild(banner);
    setTimeout(() => banner?.remove(), 20000);
  }

  // ── 核心检测逻辑 ────────────────────────────────────────────────

  function runDetection() {
    if (!armed) { broadcastState(); return; }
    if (Date.now() < cooldownUntil) { broadcastState(); return; }
    if (!checkSafety()) { broadcastState(); return; }

    // 只在 Schedule Shipment 页面做检测
    if (!isScheduleShipmentPage()) { broadcastState(); return; }

    const preferredWh = (cfg.preferredWarehouse || "").trim().toUpperCase();
    if (preferredWh && Date.now() - lastApplyWarehouseTime > PREFERRED_WAREHOUSE_REAPPLY_MS) {
      const applied = applyPreferredWarehouse();
      if (applied) lastApplyWarehouseTime = Date.now();
    }

    lastCheckTime = Date.now();
    const soldOut = detectSoldOut();

    // 检查仓库是否已选好：页面上要出现具体仓库名（如 RUH01S），而不是 "Noon Warehouse Name"
    const pageText = document.body?.innerText || "";
    const hasWarehouseSelected = preferredWh
      ? pageText.toUpperCase().includes(preferredWh)
      : !/noon\s+warehouse\s+name/i.test(pageText);

    if (!hasWarehouseSelected) {
      // 仓库还没选好，不做判断，但仍广播状态让弹窗更新
      if (currentState !== "UNKNOWN") {
        log("info", "状态: 等待仓库选择完成…");
        currentState = "UNKNOWN";
      }
      broadcastState();
      return;
    }

    if (soldOut) {
      // "No slots available" 还在 → 没仓位，继续等
      if (currentState !== "SOLD_OUT") {
        log("info", "状态: 没仓位（" + preferredWh + "），继续监测…");
      }
      currentState = "SOLD_OUT";
      candidates = [];
      clearHighlights();
    } else if (currentState === "SOLD_OUT") {
      // 之前确认过是 SOLD_OUT，现在 "No slots available" 消失了 → 有仓位了！
      debouncedTransition();
    } else if (currentState === "UNKNOWN") {
      // 首次确认仓库已选好：先标记为 SOLD_OUT，等下一轮确认
      const hasTimeCards = detectTimeSlotCards().length > 0;
      if (hasTimeCards) {
        debouncedTransition();
      } else {
        currentState = "SOLD_OUT";
        log("info", "状态: 仓库已选好，开始监测仓位…");
      }
    }

    broadcastState();
  }

  let debounceTimer = null;
  function debouncedTransition() {
    clearTimeout(debounceTimer);
    const ms = cfg.debounceMs || 100;
    debounceTimer = setTimeout(() => {
      // 仓库下拉操作中 DOM 会瞬间变化，禁止误触发
      if (warehouseApplyInProgress) return;
      // capacity API 确认无仓位 → 禁止 DOM 检测覆盖
      let skipDate = false;
      if (capacityLock) {
        const timeCards = detectTimeSlotCards();
        if (timeCards.length === 0) return;
        capacityLock = false;
        skipDate = true; // 时段卡片已在页面，跳过日期点击
        log("info", "⚡ 页面已有时段卡片，capacityLock 自动解锁");
      }
      // 二次确认：确保 "No slots available" 确实消失了
      if (detectSoldOut()) return;
      currentState = "AVAILABLE";
      lastTransition = Date.now();
      log("info", "⚡ 仓位出现了！'No slots available' 已消失！");
      onSlotsAvailable(false, skipDate);
    }, ms);
  }

  // ── 售罄检测 ─────────────────────────────────────────────────────

  function detectSoldOut() {
    const containers = document.querySelectorAll(SLOT_CONTAINER_SELECTORS);
    const searchIn =
      containers.length > 0
        ? Array.from(containers)
            .map((c) => c.innerText)
            .join(" ")
        : document.body?.innerText || "";
    return SOLD_OUT_PATTERNS.some((p) => p.test(searchIn));
  }

  function describeSelector(el) {
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : "";
    const cls = el.className && typeof el.className === "string"
      ? "." + el.className.split(/\s+/).filter(Boolean).slice(0, 2).join(".")
      : "";
    return tag + id + cls;
  }

  // ── 抢位流程结束恢复 ────────────────────────────────────────────

  function finishGrab() {
    if (!grabInFlight) return;
    grabInFlight = false;
    clearTimeout(grabSafetyTimer);
    sendPollConfig();
    if (autoRefreshEnabled && armed) startAutoRefresh();
  }

  function resetGrabSafetyTimer() {
    clearTimeout(grabSafetyTimer);
    grabSafetyTimer = setTimeout(() => {
      if (grabInFlight) {
        log("warn", "⚠️ grabInFlight 超时 90s 未释放，自动解锁");
        finishGrab();
      }
    }, 90000);
  }

  // ── 当 slot 可用时 ──────────────────────────────────────────────

  function onSlotsAvailable(fromApi, skipDate) {
    if (grabInFlight) {
      log("info", "抢位流程已在执行中，跳过重复触发");
      return;
    }

    chrome.runtime.sendMessage({
      type: "SLOTS_AVAILABLE",
      count: 1,
      buttons: "仓位已出现",
    });

    if (cfg.titleFlash !== false) flashTitle();
    showToast(1);
    if (cfg.soundEnabled) playBeep();

    if (autoClickEnabled) {
      grabInFlight = true;
      resetGrabSafetyTimer();
      performFullGrab(fromApi, skipDate);
    } else {
      log("info", "⚠️ 自动抢位未启用（autoClick=false），仅显示通知");
    }

    cooldownUntil = Date.now() + 15000;
    stopAutoRefresh();
    window.postMessage({
      type: "SS_SET_POLL",
      interval: cfg.pollInterval || 500,
      paused: true,
      pauseDuration: 16000,
      _ssNonce,
    }, "*");
  }

  // ── 完整自动抢位流程：选日期 → 等时段出现 → 选时段 → Confirm ──

  function performFullGrab(fromApi, skipDate) {
    // API 触发 → 零延迟立刻抢；DOM 触发 → 使用配置的延迟
    const delay = fromApi ? 0 : (cfg.autoClickDelay || 500);
    if (delay > 0) showAutoClickOverlay(delay, null);
    log("info", fromApi
      ? `⚡ [极速] API 检测到仓位，零延迟立刻抢位！`
      : `⚡ 开始自动抢位流程（${delay}ms 后执行）`);

    chainStartUrl = location.href; // 记录抢位开始时的 URL，用于检测成功跳转
    dateClickReselected = false; // 重置仓库重选标志

    const doGrab = () => {
      if (!armed || !autoClickEnabled) {
        log("info", "自动抢位已取消（手动暂停）");
        finishGrab();
        hideAutoClickOverlay();
        return;
      }

      // ── 步骤 1: 点击日历上出现的可用日期 ──
      if (skipDate) {
        log("info", "步骤1: 跳过日期点击（时段卡片已在页面）");
        setTimeout(() => waitForTimeSlots(0), 0);
      } else if (fromApi) {
        // API 触发 → 页面 DOM 尚未更新，直接重选仓库强制 React 重新请求并渲染
        log("info", "步骤1: API 触发 → 重选仓库强制前端刷新数据…");
        dateClickReselected = true;
        triggerWarehouseReselect();
        // → afterWarehouseReselect() → 等待日期渲染 → waitForDateClick(0)
      } else {
        // DOM 触发（页面刷新/用户操作）→ 日期可能已在页面，正常重试流程
        waitForDateClick(0);
      }
    };

    if (delay > 0) {
      setTimeout(doGrab, delay);
    } else {
      doGrab();
    }
  }

  // ── 步骤 1 重试：等待日历渲染后点击日期 ───────────────────────────
  const MAX_DATE_CLICK_ATTEMPTS = 10; // 10 × 500ms = 5 秒
  let dateClickReselected = false; // 是否已尝试过重选仓库

  function waitForDateClick(attempt) {
    if (!armed || !autoClickEnabled) {
      finishGrab();
      hideAutoClickOverlay();
      return;
    }
    resetGrabSafetyTimer();

    const dateResult = tryClickAvailableDate();
    if (dateResult === "clicked") {
      log("info", `✅ 步骤1: 日期点击成功（第 ${attempt + 1} 次尝试${dateClickReselected ? "，重选后" : ""}）`);
      dateClickReselected = false;
      // 点击日期后等 1s 让页面加载时段
      setTimeout(() => waitForTimeSlots(0), 1000);
      return;
    }
    if (dateResult === "filtered") {
      // 日期存在但不匹配偏好 → 放弃抢位，短冷却后继续轮询
      log("info", "步骤1: 页面日期不匹配偏好，等待此 slot 被他人抢走…（5s 后重新检查）");
      dateClickReselected = false;
      cooldownUntil = Date.now() + 10000;
      finishGrab();
      hideAutoClickOverlay();
      return;
    }

    if (attempt < MAX_DATE_CLICK_ATTEMPTS) {
      if (attempt === 0) {
        log("info", "步骤1: 等待日期元素出现…");
      } else if (attempt % 3 === 0) {
        log("info", `步骤1: 等待日期元素… (${attempt + 1}/${MAX_DATE_CLICK_ATTEMPTS})`);
      }
      setTimeout(() => waitForDateClick(attempt + 1), 500);
    } else if (!dateClickReselected) {
      // 第一轮失败 → 重选仓库强制页面重新渲染日历
      dateClickReselected = true;
      log("info", "步骤1: 5s 未找到日期，重选仓库强制渲染日历…");
      triggerWarehouseReselect();
      // 重选成功后 afterWarehouseReselect() → waitForDateClick(0) 重新开始第二轮
    } else {
      // 重选后仍失败 → 放弃日期步骤，直接找时段卡片
      dateClickReselected = false;
      log("warn", "步骤1: 重选仓库后仍未找到日期元素，跳过日期步骤");
      setTimeout(() => waitForTimeSlots(0), 0);
    }
  }

  const MAX_WAIT_TIMESLOT_ATTEMPTS = 25; // 25 × 800ms = 20秒，给页面更多渲染时间

  function waitForTimeSlots(attempt) {
    if (!armed || !autoClickEnabled) {
      finishGrab();
      hideAutoClickOverlay();
      return;
    }
    resetGrabSafetyTimer();

    const found = detectTimeSlotCards();
    if (found.length > 0) {
      if (highlightOn) applyHighlights(found);

      // 筛选要点击的时段：有偏好→只点匹配的，无偏好→只点第一个（得分最高）
      const preferredTime = (cfg.preferredTimeText || "").trim();
      let toClick;
      if (preferredTime) {
        toClick = found.filter(c => isTimeInRange(c.text, preferredTime));
        if (toClick.length === 0) {
          log("warn", `偏好时段 "${preferredTime}" 无匹配，回退到得分最高的时段`);
          toClick = [found[0]];
        }
      } else {
        toClick = [found[0]]; // 无偏好时只点最高分
      }

      for (let i = 0; i < toClick.length; i++) {
        const card = toClick[i];
        card.el.scrollIntoView({ behavior: "instant", block: "center" });
        simulateFullClick(card.el);
        log("info", `✅ 步骤2: 已点击时段 [${i + 1}/${toClick.length}] "${card.text}"`);
      }

      // 点击后验证：如果卡片没变蓝，尝试点击父元素
      setTimeout(() => {
        for (const card of toClick) {
          const style = getComputedStyle(card.el);
          const bg = style.backgroundColor || "";
          const cls = card.el.className || "";
          const isSelected = /selected|active|checked|primary/i.test(cls) ||
            (bg && bg !== "rgb(255, 255, 255)" && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent");
          if (!isSelected && card.el.parentElement) {
            log("info", `时段 "${card.text}" 未变蓝，尝试点击父元素`);
            simulateFullClick(card.el.parentElement);
          }
        }
      }, 300);

      hideAutoClickOverlay();

      // ── 步骤 3: 等 Confirm slot 按钮可点击，然后点击 ──
      if (cfg.autoClickChain) {
        log("info", "步骤3: 等待 Confirm slot 按钮…");
        chainRetryCount = 0;
        chainTotalRetries = 0;
        setTimeout(() => chainNextClick(), 1500);
      } else {
        finishGrab();
      }
    } else if (attempt < MAX_WAIT_TIMESLOT_ATTEMPTS) {
      // 每5次尝试滚动页面，刺激懒加载渲染
      if (attempt > 0 && attempt % 5 === 0) {
        window.scrollBy(0, 200);
        setTimeout(() => window.scrollBy(0, -200), 300);
        log("info", `等待时段卡片… (${attempt + 1}/${MAX_WAIT_TIMESLOT_ATTEMPTS}) — 尝试滚动刺激渲染`);
      } else {
        log("info", `等待时段卡片出现… (${attempt + 1}/${MAX_WAIT_TIMESLOT_ATTEMPTS})`);
      }
      setTimeout(() => waitForTimeSlots(attempt + 1), 800);
    } else {
      // 超时仍未出现 → 尝试刷新页面重来
      log("warn", "等待 20s 超时：时段卡片未出现，刷新页面重试");
      finishGrab();
      hideAutoClickOverlay();
      chrome.storage.local.set({ urgentGrab: true, urgentGrabTime: Date.now() }, () => location.reload());
    }
  }

  // ── 链式点击（连续确认）──────────────────────────────────────────

  let chainRetryCount = 0;
  const CHAIN_MAX_RETRIES = 8;

  function chainNextClick() {
    if (!armed || !autoClickEnabled) {
      finishGrab();
      return;
    }
    resetGrabSafetyTimer();
    document.querySelectorAll("[data-ss-clicked]").forEach(el => el.removeAttribute("data-ss-clicked"));
    // URL 变化说明预约成功或页面跳转，停止链式点击
    if (chainStartUrl && location.href !== chainStartUrl) {
      log("info", "✅ 页面 URL 已变化，预约可能已成功，停止链式点击");
      finishGrab();
      return;
    }

    const confirmPatterns = [
      /\bconfirm\b/i,
      /\bconfirm\s+slot\b/i,
      /\bsubmit\b/i,
      /\bproceed\b/i,
      /\byes\b/i,
    ];

    // 同时查找 disabled 和 enabled 的确认按钮
    const selectors = [
      'button', 'a[role="button"]', '[role="button"]', 'input[type="submit"]',
    ];
    // 优先在预约相关容器内搜索，减少误匹配
    const confirmContainers = document.querySelectorAll(
      '[class*="schedule"], [class*="booking"], [class*="modal"], [class*="dialog"], [class*="confirm"], [class*="slot"]'
    );
    let searchRoot = null;
    for (const c of confirmContainers) {
      const btns = c.querySelectorAll('button, [role="button"]');
      for (const btn of btns) {
        const btnText = (btn.textContent || "").trim().toLowerCase();
        if (confirmPatterns.some(re => re.test(btnText))) {
          searchRoot = c;
          break;
        }
      }
      if (searchRoot) break;
    }
    const all = (searchRoot || document).querySelectorAll(selectors.join(","));

    for (const el of all) {
      if (el.closest("#ss-toast, #ss-slot-label, #ss-safety-banner, #ss-autoclick-overlay")) continue;
      if (el.hasAttribute("data-ss-clicked")) continue; // 跳过已点击的按钮
      const text = (el.textContent || el.value || "").trim().toLowerCase();
      const ariaLabel = (el.getAttribute("aria-label") || "").toLowerCase();
      const combined = text + " " + ariaLabel;

      const match = confirmPatterns.some((re) => re.test(combined));
      if (!match) continue;

      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (rect.width === 0 || style.display === "none" || style.visibility === "hidden") continue;

      // 如果按钮是 disabled（灰色），等它变成 enabled 再点
      const isDisabled = el.disabled || el.getAttribute("aria-disabled") === "true" || el.classList.contains("disabled") || style.pointerEvents === "none" || parseFloat(style.opacity) < 0.5;
      if (isDisabled) {
        if (chainRetryCount < CHAIN_MAX_RETRIES) {
          chainRetryCount++;
          log("info", `Confirm 按钮暂时不可点(disabled)，等待中… (${chainRetryCount}/${CHAIN_MAX_RETRIES})`);
          setTimeout(() => chainNextClick(), 800);
        } else {
          log("warn", "Confirm 按钮持续 disabled，强制点击并继续等待");
          el.scrollIntoView({ behavior: "instant", block: "center" });
          simulateFullClick(el);
          chainRetryCount = 0;
          chainTotalRetries += CHAIN_MAX_RETRIES;
          if (chainTotalRetries >= 38) { // ~30s 总超时
            log("warn", "Confirm 按钮超时 30s 仍不可用，放弃");
            finishGrab();
            return;
          }
          setTimeout(() => chainNextClick(), 800);
        }
        return;
      }

      // 按钮可点击，直接点
      log("info", `链式点击确认按钮: "${text}"`);
      el.scrollIntoView({ behavior: "instant", block: "center" });
      el.setAttribute("data-ss-clicked", "1");
      simulateFullClick(el);
      log("info", `✅ 已自动点击 Confirm slot!`);
      chainRetryCount = 0;

      // #1: Confirm 成功后才发邮件通知
      try {
        chrome.runtime.sendMessage({
          type: "CONFIRM_CLICK_SUCCESS",
          buttonText: text,
        });
      } catch (_) {}

      // 检测页面是否跳转（成功标志），否则 1.5s 后继续扫描
      const urlBefore = location.href;
      setTimeout(() => {
        if (location.href !== urlBefore) {
          log("info", "✅ 页面已跳转，Confirm 成功，结束链式点击");
          finishGrab();
          return;
        }
        chainNextClick();
      }, 1500);
      return;
    }

    // #1: 链式点击结束兜底通知
    log("info", "链式点击结束 — 没有更多确认按钮");
    chainRetryCount = 0;
    finishGrab();
    try {
      chrome.runtime.sendMessage({ type: "AUTO_CLICK_DONE" });
    } catch (_) {}
  }

  // ── 自动点击倒计时覆盖层 ────────────────────────────────────────

  function showAutoClickOverlay(delayMs, targetEl) {
    hideAutoClickOverlay();
    const overlay = document.createElement("div");
    overlay.id = "ss-autoclick-overlay";
    overlay.innerHTML = `
      <div class="ss-ac-content">
        <div class="ss-ac-icon">⚡</div>
        <div class="ss-ac-text">自动点击中…</div>
        <div class="ss-ac-countdown"></div>
        <button class="ss-ac-cancel">取消 (Esc)</button>
      </div>
    `;
    document.body.appendChild(overlay);

    const countdown = overlay.querySelector(".ss-ac-countdown");
    const cancelBtn = overlay.querySelector(".ss-ac-cancel");
    let remaining = delayMs;
    const tick = setInterval(() => {
      remaining -= 50;
      if (remaining <= 0) {
        clearInterval(tick);
        countdown.textContent = "点击!";
      } else {
        countdown.textContent = (remaining / 1000).toFixed(1) + "s";
      }
    }, 50);
    countdown.textContent = (remaining / 1000).toFixed(1) + "s";

    const cancel = () => {
      clearInterval(tick);
      autoClickEnabled = false;
      chrome.storage.local.set({ autoClick: false });
      hideAutoClickOverlay();
      log("info", "用户取消了自动点击");
    };
    cancelBtn.addEventListener("click", cancel);

    const escHandler = (e) => {
      if (e.key === "Escape") {
        cancel();
        document.removeEventListener("keydown", escHandler);
      }
    };
    document.addEventListener("keydown", escHandler);
  }

  function hideAutoClickOverlay() {
    document.getElementById("ss-autoclick-overlay")?.remove();
  }

  // ── 高亮 ─────────────────────────────────────────────────────────

  function applyHighlights(found) {
    clearHighlights();
    for (const { el } of found) {
      el.classList.add("ss-highlight");
    }
    const best = found[0];
    if (best) {
      let label = document.getElementById("ss-slot-label");
      if (!label) {
        label = document.createElement("div");
        label.id = "ss-slot-label";
        document.body.appendChild(label);
      }
      label.textContent = "⚡ 有位了!";
      label.classList.add("ss-slot-label-visible");
      const rect = best.el.getBoundingClientRect();
      Object.assign(label.style, {
        top: rect.top + window.scrollY - 36 + "px",
        left: rect.left + window.scrollX + "px",
      });
    }
  }

  function clearHighlights() {
    document.querySelectorAll(".ss-highlight").forEach((el) => el.classList.remove("ss-highlight"));
    document.querySelectorAll("[data-ss-tabindex]").forEach((el) => {
      el.removeAttribute("tabindex");
      delete el.dataset.ssTabindex;
    });
    const label = document.getElementById("ss-slot-label");
    if (label) label.classList.remove("ss-slot-label-visible");
  }

  // ── Toast ────────────────────────────────────────────────────────

  function showToast(count) {
    if (cfg.notifMode === "none") return;
    let toast = document.getElementById("ss-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "ss-toast";
      document.body.appendChild(toast);
    }
    const mode = autoClickEnabled ? "⚡ 自动抢位中…" : "点击预约!";
    toast.textContent = `⚡ ${count} 个 slot 可用 — ${mode}`;
    toast.classList.add("ss-toast-visible");

    document.body.classList.add("ss-screen-flash");
    setTimeout(() => document.body.classList.remove("ss-screen-flash"), 400);

    clearTimeout(toast._hideTimer);
    toast._hideTimer = setTimeout(() => toast.classList.remove("ss-toast-visible"), 6000);
  }

  // ── 标题闪烁 ─────────────────────────────────────────────────────

  function flashTitle() {
    clearInterval(titleFlashTimer);
    let on = true;
    let count = 0;
    titleFlashTimer = setInterval(() => {
      document.title = on ? "⚡ SLOT 可用!" : originalTitle;
      on = !on;
      if (++count >= 8) {
        clearInterval(titleFlashTimer);
        document.title = originalTitle;
      }
    }, 400);
  }

  // ── 提示音 ───────────────────────────────────────────────────────

  function playBeep() {
    try {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 880;
      osc.type = "square";
      gain.gain.value = 0.2;
      osc.start();
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
      osc.stop(ctx.currentTime + 0.3);
    } catch (_) {}
  }

  // ── 状态广播 ─────────────────────────────────────────────────────

  function broadcastState() {
    try {
      chrome.runtime.sendMessage({
        type: "STATE_UPDATE",
        state: currentState,
        armed,
        autoClick: autoClickEnabled,
        autoRefresh: autoRefreshEnabled,
        candidateCount: candidates.length,
        lastTransition,
        lastCheckTime,
        selectors: candidates.slice(0, 5).map((c) => c.selector),
        texts: candidates.slice(0, 5).map((c) => c.text),
      });
      chrome.runtime.sendMessage({ type: "GET_SCHEDULE_STATUS" }, (resp) => {
        if (chrome.runtime.lastError || !resp) return;
        chrome.runtime.sendMessage({ type: "SCHEDULE_STATUS_UPDATE", ...resp });
      });
    } catch (_) {}
  }

  // ── 消息处理 ─────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg) => {
    switch (msg.type) {
      case "CYCLE_SLOTS":
        cycleSlots();
        break;

      case "SET_ARMED":
        armed = msg.armed;
        if (armed) {
          runDetection();
          document.getElementById("ss-safety-banner")?.remove();
          if (autoRefreshEnabled) startAutoRefresh();
          // 重新注册轮询（如果之前已捕获 capacity 参数）
          if (pollActive) chrome.runtime.sendMessage({ type: "POLL_REGISTER", interval: actualPollInterval }).catch(() => {});
        } else {
          clearHighlights();
          stopAutoRefresh();
          // 暂停时从协调注册表移除，释放配额给其他标签页
          if (pollActive) chrome.runtime.sendMessage({ type: "POLL_UNREGISTER" }).catch(() => {});
        }
        sendPollConfig();
        log("info", (armed ? "已启用" : "已暂停") + " 监控");
        break;

      case "SET_HIGHLIGHT":
        highlightOn = msg.on;
        if (!highlightOn) clearHighlights();
        else if (candidates.length) applyHighlights(candidates);
        break;

      case "SET_AUTO_CLICK":
        autoClickEnabled = msg.on;
        if (!msg.on) finishGrab();
        log("info", "自动点击: " + (msg.on ? "开启" : "关闭"));
        break;

      case "SET_AUTO_REFRESH":
        autoRefreshEnabled = msg.on;
        autoRefreshInterval = msg.interval || autoRefreshInterval;
        if (autoRefreshEnabled && armed) startAutoRefresh();
        else stopAutoRefresh();
        log("info", "自动刷新: " + (msg.on ? `开启 (${autoRefreshInterval}s)` : "关闭"));
        break;

      case "FORCE_CHECK":
        cooldownUntil = 0;
        runDetection();
        break;

      case "FORCE_REFRESH":
        log("info", "手动刷新页面");
        location.reload();
        break;

      case "CONFIG_UPDATED":
        Object.assign(cfg, msg.cfg);
        applyPreferredWarehouse();
        sendPollConfig();
        break;

      case "REQUEST_STATE":
        broadcastState();
        break;

      case "TEST_HIGHLIGHT":
        testHighlight();
        break;

      case "SCHEDULE_TICK":
        if (msg.armed && !armed) {
          armed = true;
          cooldownUntil = 0;
          runDetection();
          if (autoRefreshEnabled) startAutoRefresh();
          log("info", "⏰ 定时调度: 已自动启用监控");
        } else if (!msg.armed && armed) {
          armed = false;
          clearHighlights();
          stopAutoRefresh();
          log("info", "⏰ 定时调度: 已自动暂停监控");
        }
        broadcastState();
        break;

      case "POLL_ADJUST":
        // 跨标签页协调：service worker 根据在线标签页数量调整轮询间隔
        if (msg.interval > 0) {
          actualPollInterval = msg.interval;
          window.postMessage({ type: "SS_ADJUST_POLL", interval: msg.interval, tabCount: msg.tabCount, _ssNonce }, "*");
          log("info", `[协调] 在线标签页: ${msg.tabCount}，轮询间隔 → ${msg.interval}ms`);
        }
        break;
    }
  });

  // ── 辅助功能 ─────────────────────────────────────────────────────

  function ensureFocusable(el) {
    if (!el.hasAttribute("tabindex")) {
      el.setAttribute("tabindex", "-1");
      el.dataset.ssTabindex = "1";
    }
  }

  function cycleSlots() {
    if (!candidates.length) {
      runDetection();
      if (!candidates.length) return;
    }
    cycleIndex = (cycleIndex + 1) % candidates.length;
    const c = candidates[cycleIndex];
    c.el.scrollIntoView({ behavior: "smooth", block: "center" });
    ensureFocusable(c.el);
    c.el.focus({ preventScroll: true });
    applyHighlights([c]);
  }

  function testHighlight() {
    const btn =
      document.querySelector("button") ||
      document.querySelector('a[role="button"]') ||
      document.querySelector("a");
    if (!btn) return;
    btn.classList.add("ss-highlight");
    const label = document.getElementById("ss-slot-label") ||
      (() => {
        const l = document.createElement("div");
        l.id = "ss-slot-label";
        document.body.appendChild(l);
        return l;
      })();
    label.textContent = "⚡ 测试高亮!";
    label.classList.add("ss-slot-label-visible");
    const rect = btn.getBoundingClientRect();
    Object.assign(label.style, {
      top: rect.top + window.scrollY - 36 + "px",
      left: rect.left + window.scrollX + "px",
    });
    setTimeout(() => {
      btn.classList.remove("ss-highlight");
      label.classList.remove("ss-slot-label-visible");
    }, 3000);
  }

  // ── API 网络拦截响应（比 MutationObserver 更早感知）──────────────

  // 向 injected.js 发送轮询配置
  function sendPollConfig() {
    const interval = cfg.pollInterval || 500;
    const paused = !armed || Date.now() < cooldownUntil;
    window.postMessage({ type: "SS_SET_POLL", interval, paused, _ssNonce }, "*");
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data) return;

    // #2: 收到 injected.js 的 ACK，校验 nonce 摘要后停止重试
    if (e.data.type === "SS_INIT_ACK") {
      if (e.data._ssAck !== _ssNonce.slice(0, 8)) return; // 摘要不匹配，忽略伪造 ACK
      clearTimeout(initRetryTimer);
      document.querySelector('meta[name="__ss"]')?.remove();
      log("info", "SS_INIT_ACK 已收到，nonce 已安全传递");
      return;
    }

    if (typeof e.data.type === "string" && e.data.type.startsWith("SS_") && e.data.type !== "SS_INIT" && e.data.type !== "SS_SET_POLL") {
      if (e.data._ssNonce !== _ssNonce) return;
    }

    // Worker PAUSE_FOR 超时后自动恢复
    if (e.data.type === "SS_POLL_RESUMED") {
      cooldownUntil = 0;
      capacityLock = true;
      if (currentState === "AVAILABLE") currentState = "SOLD_OUT";
      // 抢位流程进行中不重启自动刷新，避免中途打断
      if (autoRefreshEnabled && armed && !grabInFlight) startAutoRefresh();
      log("info", "⏱ 冷却结束，轮询已自动恢复");
      return;
    }

    // capacity 请求参数已捕获，启动轮询（首次打日志，重复时只同步配置）
    if (e.data.type === "SS_POLL_READY") {
      if (!pollActive) {
        pollActive = true;
        pollBackoffLevel = 0;
        pollMaxBackoffSince = 0;
        actualPollInterval = Math.max(cfg.pollInterval || 500, 500);
        log("info", `🔄 capacity API 参数已捕获，启动轮询（${actualPollInterval}ms）— 页面不刷新，仅API轮询`);
        // 向 service worker 注册轮询，触发跨标签页协调
        chrome.runtime.sendMessage({ type: "POLL_REGISTER", interval: actualPollInterval }).catch(() => {});
      }
      sendPollConfig(); // 始终同步 pause/interval 配置给 injected.js
      return;
    }

    // 自动捕获 booking/confirm API（方案B 学习）
    if (e.data.type === "SS_BOOKING_API_CAPTURED") {
      const d = e.data;
      log("info", `🎯 [自动抓包] 捕获到预约 API: ${d.method} ${d.pathname}`);
      chrome.storage.local.set({
        bookingApi: {
          url: d.url,
          method: d.method,
          body: d.body,
          headers: d.headers,
          capturedAt: Date.now(),
        },
      });
      return;
    }

    // 轮询退避通知
    if (e.data.type === "SS_POLL_BACKOFF") {
      actualPollInterval = e.data.interval;
      pollBackoffLevel = e.data.level;
      if (e.data.level >= 4) {
        if (pollMaxBackoffSince === 0) pollMaxBackoffSince = Date.now();
      } else {
        pollMaxBackoffSince = 0;
      }
      log("warn", `[轮询] ${e.data.reason} → 间隔调整为 ${e.data.interval}ms（退避等级 ${e.data.level}）`);
      return;
    }

    // 轮询错误上报（429 不再刷屏，只在退避时通知）
    if (e.data.type === "SS_POLL_ERROR") {
      if (!e.data.error.includes("429")) {
        log("warn", `[轮询错误] 第${e.data.tick}次: ${e.data.error}`);
      }
      return;
    }

    if (e.data.type !== "SS_API_RESPONSE") return;
    const d = e.data;
    if (!armed || Date.now() < cooldownUntil) return;

    if (d.subtype === "capacity") {
      pollCount++;
      const now = Date.now();

      if (!d.isSoldOut && d.slotCount > 0) {
        // ═══ 偏好日期过滤：只对用户设定的日期触发抢位 ═══
        const prefDays = parsePreferredDates(cfg.preferredDate);
        if (prefDays.length > 0) {
          const slotDays = extractSlotDays(d.slots, d.url);
          const uniqueDays = [...new Set(slotDays)].sort((a, b) => a - b);
          if (slotDays.length > 0) {
            const hasMatch = slotDays.some(day => prefDays.includes(day));
            if (!hasMatch) {
              if (now - pollLastLogTime >= 10000) {
                log("info", `[轮询] 检测到 ${d.slotCount} 个 slot（日期: ${uniqueDays.join(",")}号），不在偏好 [${prefDays.join(",")}号] 范围内，跳过`);
                pollLastLogTime = now;
              }
              return;
            }
            log("info", `⚡ slot 日期 [${uniqueDays.join(",")}号] 匹配偏好 [${prefDays.join(",")}号]，触发抢位！`);
          } else {
            // 无法从 API 响应提取日期 → 不盲目放行，而是触发抢位让 DOM 层的偏好过滤来把关
            log("warn", `[轮询] 检测到 ${d.slotCount} 个 slot，无法从 API 提取日期 → 交由 DOM 层偏好过滤`);
          }
        }

        // ═══ 发现仓位！立即暂停轮询 + 本地冷却双保险 ═══
        log("info", `⚡⚡⚡ [第${pollCount}次轮询] 检测到 ${d.slotCount} 个可用 slot！！！`);
        cooldownUntil = now + 16000; // 本地冷却：后续 SS_API_RESPONSE 在 :1673 处被拦截
        window.postMessage({ type: "SS_SET_POLL", interval: actualPollInterval, paused: true, pauseDuration: 16000, _ssNonce }, "*");

        capacityLock = false;
        currentState = "AVAILABLE";
        lastTransition = now;

        const timeCards = detectTimeSlotCards();
        if (timeCards.length > 0) {
          log("info", `⚡ 页面已有 ${timeCards.length} 个时段卡片，直接零延迟抢位！`);
          onSlotsAvailable(true, true);  // skipDate=true，时段已在页面
        } else {
          // 页面无时段卡片 → 交给 performFullGrab 点日期→等时段→抢位
          log("info", "⚡ API 确认有仓位，进入抢位流程（点日期→选时段）");
          onSlotsAvailable(true, false); // skipDate=false，需要先点日期
        }
      } else {
        // ═══ 无仓位，定期打印摘要 ═══
        capacityLock = true;
        if (currentState !== "SOLD_OUT") {
          log("info", `[轮询] 第${pollCount}次检测 — 无仓位，持续监测中（${actualPollInterval}ms/次）`);
          pollLastLogTime = now;
        } else if (now - pollLastLogTime >= POLL_LOG_INTERVAL) {
          const elapsed = Math.round((now - pollLastLogTime) / 1000);
          log("info", `[轮询] 已检测 ${pollCount} 次 | 最近 ${elapsed}s 均无仓位 | 间隔 ${actualPollInterval}ms`);
          pollLastLogTime = now;
        }
        currentState = "SOLD_OUT";
        candidates = [];
        clearHighlights();
        broadcastState();
      }
    }
  });

  // ── SPA 导航支持 ─────────────────────────────────────────────────

  let lastUrl = location.href;
  const urlObserver = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      currentState = "UNKNOWN";
      if (pollActive) chrome.runtime.sendMessage({ type: "POLL_UNREGISTER" }).catch(() => {});
      pollActive = false;
      candidates = [];
      clearHighlights();
      cooldownUntil = 0;
      setTimeout(runDetection, 300);
      log("info", "SPA 导航检测到: " + location.href);
    }
  });
  urlObserver.observe(document, { subtree: true, childList: true });

  window.addEventListener("hashchange", () => {
    currentState = "UNKNOWN";
    if (pollActive) chrome.runtime.sendMessage({ type: "POLL_UNREGISTER" }).catch(() => {});
    pollActive = false;
    cooldownUntil = 0;
    setTimeout(runDetection, 300);
  });

  // ── 启动 ─────────────────────────────────────────────────────────

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
