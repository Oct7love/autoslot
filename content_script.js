/* ─────────────────────────────────────────────
   Slot Sentinel – Content Script
   Noon FBN 仓库 slot 专用自动抢位
   支持：自动检测、自动点击、自动刷新
   ───────────────────────────────────────────── */

(() => {
  "use strict";

  // ── State ────────────────────────────────────────────────────────

  let cfg = {};
  let armed = true;
  let highlightOn = true;
  let autoClickEnabled = false;
  let autoRefreshEnabled = false;
  let autoRefreshInterval = 30;
  let currentState = "UNKNOWN";
  let capacityLock = true; // 默认锁定：只有 capacity API 确认有仓位才能触发抢位
  let candidates = [];
  let cycleIndex = -1;
  let cooldownUntil = 0;
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
  const PREFERRED_WAREHOUSE_REAPPLY_MS = 4000;

  // ── Noon FBN 专用售罄关键词 ──────────────────────────────────────

  const SOLD_OUT_PATTERNS = [
    /no\s+slots?\s+available/i,
    /sold\s+out/i,
    /\bfully\s+booked\b/i,
    /\bfull\b/i,
    /no\s+available/i,
    /unavailable/i,
    /no\s+capacity/i,
    /slots?\s+are\s+full/i,
    /no\s+delivery\s+slots/i,
    /no\s+shipping\s+slots/i,
    /all\s+slots?\s+(are\s+)?taken/i,
    /currently\s+unavailable/i,
    /not\s+available/i,
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

  // ── 判断是否在 Schedule Shipment 页面 ───────────────────────────

  function isScheduleShipmentPage() {
    const heading = (document.body?.innerText || "").slice(0, 3000);
    return /schedule\s+shipment/i.test(heading);
  }

  // ── 检测时段卡片（"From 9am - To 12pm" 之类）────────────────────

  const TIME_PATTERN = /\d{1,2}\s*[ap]m/i;
  const FROM_TO_PATTERN = /from\s+\d{1,2}\s*[ap]m/i;

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
      const timeMatches = text.match(/\d{1,2}\s*[ap]m/gi);
      if (timeMatches && timeMatches.length >= 2) score += 40;
      if (el.matches('[role="button"], button, a')) score += 30;
      if (el.closest('[class*="slot"], [class*="time"], [class*="card"]')) score += 20;

      const preferredTime = (cfg.preferredTimeText || "").trim().toLowerCase();
      if (preferredTime && text.toLowerCase().replace(/\s+/g, " ").includes(preferredTime.replace(/\s+/g, " "))) {
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
      armed = cfg.armed !== false;
      highlightOn = cfg.highlightOn !== false;
      autoClickEnabled = !!cfg.autoClick;
      autoRefreshEnabled = !!cfg.autoRefresh;
      autoRefreshInterval = cfg.autoRefreshSec || 30;
      log("info", "脚本加载完成 | armed=" + armed + " | autoClick=" + autoClickEnabled);
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
    });
    // 从邮件点进后切回该标签页时立即再检测一次（“点进去”时自动抢）
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && armed) {
        applyPreferredWarehouse();
        runDetection();
      }
    });
  }

  // ── 自主选择仓库（Ship To 下拉）──────────────────────────────────

  let warehouseApplyInProgress = false;

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
    // 优先: 精确查找包含 "Ship To" 文本的标签
    const allEls = document.querySelectorAll("*");
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

  // ── 点击指定日期（日历上的某一天）────────────────────────────────

  function tryClickPreferredDate() {
    const day = parseInt(cfg.preferredDate, 10);
    if (!day || day < 1 || day > 31) return;

    const all = document.querySelectorAll("[role='button'], button, a, div[class*='day'], div[class*='date'], [class*='calendar'] *");
    for (const el of all) {
      const t = (el.textContent || "").trim();
      if (t === String(day) && el.getBoundingClientRect().width > 0) {
        el.click();
        log("info", "已选择日期: " + day + " 号");
        return true;
      }
    }
    return false;
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
      if (autoRefreshEnabled && armed && currentState !== "AVAILABLE") {
        log("info", "自动刷新页面…");
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
    banner.innerHTML = "⚠️ Slot Sentinel 已暂停 — 检测到反爬信号，请手动重新启用";
    Object.assign(banner.style, {
      position: "fixed",
      top: "0",
      left: "0",
      right: "0",
      zIndex: "2147483647",
      background: "#d32f2f",
      color: "#fff",
      padding: "12px 16px",
      fontSize: "14px",
      fontWeight: "600",
      textAlign: "center",
      fontFamily: "system-ui, sans-serif",
    });
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
      // capacity API 确认无仓位 → 禁止 DOM 检测覆盖
      if (capacityLock) return;
      // 二次确认：确保 "No slots available" 确实消失了
      if (detectSoldOut()) return;
      currentState = "AVAILABLE";
      lastTransition = Date.now();
      log("info", "⚡ 仓位出现了！'No slots available' 已消失！");
      onSlotsAvailable();
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

  // ── 可用按钮检测（多策略扫描）────────────────────────────────────

  function detectAvailableButtons() {
    const selectors = [
      'button:not([disabled]):not([aria-disabled="true"])',
      'a[role="button"]:not([aria-disabled="true"])',
      '[role="button"]:not([aria-disabled="true"])',
      'input[type="submit"]:not([disabled])',
      'div[role="button"]:not([aria-disabled="true"])',
      'span[role="button"]:not([aria-disabled="true"])',
      '[class*="btn"]:not([disabled])',
      '[class*="button"]:not([disabled])',
      '[data-testid*="book"]:not([disabled])',
      '[data-testid*="select"]:not([disabled])',
      '[data-testid*="slot"]:not([disabled])',
      '[data-testid*="confirm"]:not([disabled])',
    ];
    const all = document.querySelectorAll(selectors.join(","));
    const scored = [];

    for (const el of all) {
      if (el.closest("#ss-toast, #ss-slot-label, #ss-safety-banner, #ss-autoclick-overlay")) continue;

      const text = (el.textContent || el.value || "").trim().toLowerCase();
      const ariaLabel = (el.getAttribute("aria-label") || "").toLowerCase();
      const title = (el.getAttribute("title") || "").toLowerCase();
      const dataTestId = (el.getAttribute("data-testid") || "").toLowerCase();
      const combined = [text, ariaLabel, title, dataTestId].join(" ");

      const kwMatch = LABEL_KEYWORDS.findIndex((kw) => combined.includes(kw));
      if (kwMatch === -1) continue;

      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const visible =
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        style.opacity !== "0";
      if (!visible) continue;

      const inViewport =
        rect.top >= 0 &&
        rect.left >= 0 &&
        rect.bottom <= window.innerHeight &&
        rect.right <= window.innerWidth;

      const nearSlotContainer = !!el.closest(SLOT_CONTAINER_SELECTORS);

      const area = rect.width * rect.height;

      const isDirectAction = /^(book|select|reserve|schedule|confirm)\b/i.test(text.trim());

      let timeMatchBonus = 0;
      const preferredTime = (cfg.preferredTimeText || "").trim().toLowerCase();
      if (preferredTime && combined.includes(preferredTime.replace(/\s+/g, " "))) {
        timeMatchBonus = 200;
      }

      scored.push({
        el,
        score:
          (inViewport ? 100 : 0) +
          (10 - kwMatch) * 10 +
          (nearSlotContainer ? 50 : 0) +
          Math.min(area / 100, 30) +
          (isDirectAction ? 80 : 0) +
          timeMatchBonus,
        text: text.slice(0, 60),
        selector: describeSelector(el),
      });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored;
  }

  function describeSelector(el) {
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : "";
    const cls = el.className && typeof el.className === "string"
      ? "." + el.className.split(/\s+/).filter(Boolean).slice(0, 2).join(".")
      : "";
    return tag + id + cls;
  }

  // ── 当 slot 可用时 ──────────────────────────────────────────────

  function onSlotsAvailable() {
    chrome.runtime.sendMessage({
      type: "SLOTS_AVAILABLE",
      count: 1,
      buttons: "仓位已出现",
    });

    if (cfg.titleFlash !== false) flashTitle();
    showToast(1);
    if (cfg.soundEnabled) playBeep();

    if (autoClickEnabled) {
      performFullGrab();
    }

    cooldownUntil = Date.now() + 15000;
    stopAutoRefresh();
  }

  // ── 完整自动抢位流程：选日期 → 等时段出现 → 选时段 → Confirm ──

  function performFullGrab() {
    const delay = cfg.autoClickDelay || 500;
    showAutoClickOverlay(delay, null);
    log("info", `⚡ 开始自动抢位流程（${delay}ms 后执行）`);

    setTimeout(() => {
      if (!armed || !autoClickEnabled) {
        log("info", "自动抢位已取消（手动暂停）");
        hideAutoClickOverlay();
        return;
      }

      // ── 步骤 1: 选日期 ──
      if (cfg.preferredDate) {
        const clicked = tryClickPreferredDate();
        log("info", clicked ? `✅ 步骤1: 已点击日期 ${cfg.preferredDate} 号` : `⚠️ 步骤1: 未找到日期 ${cfg.preferredDate}，使用页面默认日期`);
      } else {
        log("info", "步骤1: 未设首选日期，使用页面默认日期");
      }

      // ── 步骤 2: 等页面响应，然后找时段卡片并点击 ──
      waitForTimeSlots(0);

    }, delay);
  }

  const MAX_WAIT_TIMESLOT_ATTEMPTS = 12;

  function waitForTimeSlots(attempt) {
    if (!armed || !autoClickEnabled) {
      hideAutoClickOverlay();
      return;
    }

    const found = detectTimeSlotCards();
    if (found.length > 0) {
      // 找到时段卡片了，选最优的
      let best = found[0];
      const preferredTime = (cfg.preferredTimeText || "").trim().toLowerCase();
      if (preferredTime) {
        const normalized = preferredTime.replace(/\s+/g, " ");
        const match = found.find((f) => (f.text || "").toLowerCase().replace(/\s+/g, " ").includes(normalized));
        if (match) {
          best = match;
          log("info", `匹配到首选时段: "${best.text}"`);
        }
      }

      if (highlightOn) applyHighlights(found);
      best.el.scrollIntoView({ behavior: "instant", block: "center" });
      best.el.click();
      log("info", `✅ 步骤2: 已点击时段 "${best.text}"`);

      try {
        chrome.runtime.sendMessage({
          type: "AUTO_CLICK_SUCCESS",
          buttonText: best.text,
        });
      } catch (_) {}

      hideAutoClickOverlay();

      // ── 步骤 3: 等 Confirm slot 按钮可点击，然后点击 ──
      if (cfg.autoClickChain) {
        log("info", "步骤3: 等待 Confirm slot 按钮…");
        chainRetryCount = 0;
        setTimeout(() => chainNextClick(), 1000);
      }
    } else if (attempt < MAX_WAIT_TIMESLOT_ATTEMPTS) {
      log("info", `等待时段卡片出现… (${attempt + 1}/${MAX_WAIT_TIMESLOT_ATTEMPTS})`);
      setTimeout(() => waitForTimeSlots(attempt + 1), 800);
    } else {
      log("warn", "等待超时：时段卡片未出现，请手动操作");
      hideAutoClickOverlay();
    }
  }

  // ── 链式点击（连续确认）──────────────────────────────────────────

  let chainRetryCount = 0;
  const CHAIN_MAX_RETRIES = 8;

  function chainNextClick() {
    if (!armed || !autoClickEnabled) return;

    const confirmKeywords = ["confirm", "confirm slot", "yes", "submit", "proceed", "continue", "ok", "done", "save", "apply"];

    // 同时查找 disabled 和 enabled 的确认按钮
    const selectors = [
      'button', 'a[role="button"]', '[role="button"]', 'input[type="submit"]',
    ];
    const all = document.querySelectorAll(selectors.join(","));

    for (const el of all) {
      if (el.closest("#ss-toast, #ss-slot-label, #ss-safety-banner, #ss-autoclick-overlay")) continue;
      const text = (el.textContent || el.value || "").trim().toLowerCase();
      const ariaLabel = (el.getAttribute("aria-label") || "").toLowerCase();
      const combined = text + " " + ariaLabel;

      const match = confirmKeywords.some((kw) => combined.includes(kw));
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
          log("warn", "Confirm 按钮持续 disabled，尝试强制点击");
          el.scrollIntoView({ behavior: "instant", block: "center" });
          el.click();
          chainRetryCount = 0;
        }
        return;
      }

      // 按钮可点击，直接点
      log("info", `链式点击确认按钮: "${text}"`);
      el.scrollIntoView({ behavior: "instant", block: "center" });
      el.click();
      log("info", `✅ 已自动点击 Confirm slot!`);
      chainRetryCount = 0;

      setTimeout(() => chainNextClick(), 1500);
      return;
    }

    log("info", "链式点击结束 — 没有更多确认按钮");
    chainRetryCount = 0;
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
        } else {
          clearHighlights();
          stopAutoRefresh();
        }
        log("info", (armed ? "已启用" : "已暂停") + " 监控");
        break;

      case "SET_HIGHLIGHT":
        highlightOn = msg.on;
        if (!highlightOn) clearHighlights();
        else if (candidates.length) applyHighlights(candidates);
        break;

      case "SET_AUTO_CLICK":
        autoClickEnabled = msg.on;
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

  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.type !== "SS_API_RESPONSE") return;
    if (!armed || Date.now() < cooldownUntil) return;

    if (d.subtype === "capacity") {
      // 精确 capacity 端点响应 — 唯一可信的 slot 数据源
      if (!d.isSoldOut && d.slotCount > 0) {
        capacityLock = false;
        log("info", `⚡ [CAPACITY] 检测到 ${d.slotCount} 个可用 slot → 立即抢位！`);
        currentState = "AVAILABLE";
        lastTransition = Date.now();
        onSlotsAvailable();
      } else {
        capacityLock = true; // 锁定：禁止 DOM 检测误判为有仓位
        if (currentState !== "SOLD_OUT") {
          log("info", "[CAPACITY] 响应空数组 → 无仓位，持续监测…");
        }
        currentState = "SOLD_OUT";
        candidates = [];
        clearHighlights();
        broadcastState();
      }
    }
    // 通用 API 响应仅用于辅助检测，不直接触发抢位
  });

  // ── SPA 导航支持 ─────────────────────────────────────────────────

  let lastUrl = location.href;
  const urlObserver = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      currentState = "UNKNOWN";
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
