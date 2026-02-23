/* ─────────────────────────────────────────────
   Slot Sentinel – Service Worker (MV3)
   v2.3: 支持自定义网址、定时调度、自动点击、自动刷新
   ───────────────────────────────────────────── */

const BUILT_IN_DOMAINS = [
  "https://fbn.noon.partners/*",
  "https://*.noon.com/*",
];

const DEFAULTS = {
  armed: false,
  soundEnabled: false,
  desktopNotif: false,
  titleFlash: true,
  autoScroll: true,
  autoFocus: true,
  highlightOn: true,
  debounceMs: 100,
  notifMode: "toast",
  autoClick: false,
  autoClickDelay: 500,
  autoClickChain: false,
  autoRefresh: false,
  autoRefreshSec: 30,
  scheduleEnabled: false,
  schedules: [],
  emailEnabled: false,
  emailAddress: "",
  emailServiceId: "",
  emailTemplateId: "",
  emailPublicKey: "",
  emailOnAvailable: true,
  emailOnClicked: true,
  customDomains: [],
  preferredWarehouse: "",
  preferredDate: "",
  preferredTimeText: "",
  remoteUrl: "",
  remoteToken: "",
  pollInterval: 2000,
  tabPreferences: {},
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(null, (existing) => {
    const merged = { ...DEFAULTS, ...existing };
    chrome.storage.local.set(merged);
    registerCustomDomains(merged.customDomains || []);
  });
  chrome.alarms.create("schedule-check", { periodInMinutes: 0.25 });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("schedule-check", { periodInMinutes: 0.25 });
  chrome.storage.local.get("customDomains", ({ customDomains = [] }) => {
    registerCustomDomains(customDomains);
  });
});

// ── 清理已关闭标签页的独立偏好 ───────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.get("tabPreferences", ({ tabPreferences = {} }) => {
    if (tabPreferences[tabId]) {
      delete tabPreferences[tabId];
      chrome.storage.local.set({ tabPreferences });
    }
  });
  sendRemote("/api/client/remove", { clientId: String(tabId) });
});

// ── 动态注册自定义域名的内容脚本 ─────────────────────────────────

async function registerCustomDomains(domains) {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: ["ss-custom-domains", "ss-custom-domains-main"] }).catch(() => {});
  } catch (_) {}

  const patterns = domains.map(domainToPattern).filter(Boolean);
  if (!patterns.length) return;

  try {
    await chrome.scripting.registerContentScripts([
      {
        id: "ss-custom-domains-main",
        matches: patterns,
        js: ["injected.js"],
        runAt: "document_start",
        world: "MAIN",
      },
      {
        id: "ss-custom-domains",
        matches: patterns,
        js: ["content_script.js"],
        css: ["styles.css"],
        runAt: "document_idle",
      },
    ]);
  } catch (e) {
    addLog("warn", "自定义域名注册失败: " + e.message);
  }
}

function domainToPattern(input) {
  let d = input.trim().toLowerCase();
  if (!d) return null;
  d = d.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return "https://" + d + "/*";
}

// 手动注入到已打开的标签页（新增域名后不用刷新）
async function injectIntoMatchingTabs(domains) {
  const patterns = domains.map(domainToPattern).filter(Boolean);
  for (const pattern of patterns) {
    try {
      const tabs = await chrome.tabs.query({ url: pattern });
      for (const tab of tabs) {
        chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["injected.js"], world: "MAIN" }).catch(() => {});
        chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content_script.js"] }).catch(() => {});
        chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["styles.css"] }).catch(() => {});
      }
    } catch (_) {}
  }
}

// ── 获取所有监控域名（内置 + 自定义）的 URL 匹配模式 ─────────────

function getAllUrlPatterns(customDomains) {
  const patterns = [...BUILT_IN_DOMAINS];
  for (const d of (customDomains || [])) {
    const p = domainToPattern(d);
    if (p) patterns.push(p);
  }
  return patterns;
}

function isScheduleTabUrl(url) {
  if (!url) return false;
  return /\/schedule(\/|$)/i.test(url) || /inbound-scheduler/i.test(url);
}

// ── 定时调度检查（每15秒）────────────────────────────────────────

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "schedule-check") return;

  chrome.storage.local.get(["scheduleEnabled", "schedules", "armed", "schedulePrevState", "manualOverride"], (cfg) => {
    if (!cfg.scheduleEnabled) return;

    const schedules = cfg.schedules || [];
    if (!schedules.length) return;

    const shouldBeArmed = isWithinAnySchedule(schedules);
    const prevState = cfg.schedulePrevState;

    // 用户手动覆盖了调度 → 不干预，等到进入下一个时段时自动清除覆盖
    if (cfg.manualOverride) {
      if (shouldBeArmed) {
        // 进入了调度时段，清除手动覆盖标记，恢复调度控制
        chrome.storage.local.set({ manualOverride: false, schedulePrevState: shouldBeArmed });
        addLog("info", "⏰ 进入调度时段，手动覆盖已清除");
      }
      return;
    }

    if (shouldBeArmed !== prevState) {
      chrome.storage.local.set({ armed: shouldBeArmed, schedulePrevState: shouldBeArmed });

      chrome.storage.local.get("customDomains", ({ customDomains = [] }) => {
        const urlPatterns = getAllUrlPatterns(customDomains);
        chrome.tabs.query({ url: urlPatterns }, (tabs) => {
          for (const tab of tabs) {
            chrome.tabs.sendMessage(tab.id, { type: "SET_ARMED", armed: shouldBeArmed });
            chrome.tabs.sendMessage(tab.id, {
              type: "SCHEDULE_TICK",
              armed: shouldBeArmed,
              nextEvent: getNextScheduleEvent(schedules),
            });
          }
        });
      });

      const now = new Date();
      const timeStr = now.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      addLog("info", shouldBeArmed
        ? `⏰ [${timeStr}] 定时启动 — 进入抢位时段`
        : `⏰ [${timeStr}] 定时停止 — 离开抢位时段`);
    }
  });
});

function isWithinAnySchedule(schedules) {
  const now = new Date();
  const day = now.getDay();
  const minutes = now.getHours() * 60 + now.getMinutes();

  for (const s of schedules) {
    if (!s.enabled) continue;
    if (s.days && s.days.length > 0 && !s.days.includes(day)) continue;

    const [sh, sm] = s.startTime.split(":").map(Number);
    const [eh, em] = s.endTime.split(":").map(Number);
    const start = sh * 60 + sm;
    const end = eh * 60 + em;

    if (start <= end) {
      if (minutes >= start && minutes < end) return true;
    } else {
      if (minutes >= start || minutes < end) return true;
    }
  }
  return false;
}

function getNextScheduleEvent(schedules) {
  const now = new Date();
  const day = now.getDay();
  const minutes = now.getHours() * 60 + now.getMinutes();
  let closest = Infinity;
  let eventType = "";

  for (const s of schedules) {
    if (!s.enabled) continue;

    const [sh, sm] = s.startTime.split(":").map(Number);
    const [eh, em] = s.endTime.split(":").map(Number);
    const start = sh * 60 + sm;
    const end = eh * 60 + em;

    const hasDayMatch = !s.days || s.days.length === 0 || s.days.includes(day);
    if (!hasDayMatch) continue;

    if (minutes < start && (start - minutes) < closest) {
      closest = start - minutes;
      eventType = "start";
    }
    if (minutes < end && (end - minutes) < closest) {
      closest = end - minutes;
      eventType = "end";
    }
  }

  if (closest < Infinity) {
    const h = Math.floor(closest / 60);
    const m = closest % 60;
    return { minutes: closest, label: (h > 0 ? h + "时" : "") + m + "分后" + (eventType === "start" ? "开始" : "结束") };
  }
  return null;
}

// ── Command handling ───────────────────────────────────────────────

chrome.commands.onCommand.addListener((command, tab) => {
  if (!tab?.id) return;

  switch (command) {
    case "cycle-slots":
      chrome.tabs.sendMessage(tab.id, { type: "CYCLE_SLOTS" });
      break;
    case "toggle-monitor":
      chrome.storage.local.get(["armed", "scheduleEnabled"], ({ armed, scheduleEnabled }) => {
        const next = !armed;
        const updates = { armed: next };
        if (scheduleEnabled) updates.manualOverride = true;
        chrome.storage.local.set(updates);
        chrome.tabs.sendMessage(tab.id, { type: "SET_ARMED", armed: next });
      });
      break;
    case "toggle-highlight":
      chrome.storage.local.get("highlightOn", ({ highlightOn }) => {
        const next = !highlightOn;
        chrome.storage.local.set({ highlightOn: next });
        chrome.tabs.sendMessage(tab.id, { type: "SET_HIGHLIGHT", on: next });
      });
      break;
  }
});

// ── Messages from content script ───────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "SLOTS_AVAILABLE") {
    chrome.storage.local.get(["desktopNotif", "notifMode", "autoClick"], (cfg) => {
      if (cfg.notifMode === "desktop" || cfg.desktopNotif) {
        const mode = cfg.autoClick ? "自动抢位中…" : "快去预约!";
        chrome.notifications.create("slot-alert-" + Date.now(), {
          type: "basic",
          iconUrl: "icons/icon128.png",
          title: "⚡ 仓库 Slot 可用!",
          message: `发现 ${msg.count} 个可预约的 slot — ${mode}`,
          priority: 2,
        });
      }
    });
    sendEmail("available", {
      count: msg.count,
      buttons: msg.buttons || "",
      url: sender?.tab?.url || "",
    });
  }

  // #1: 监听 Confirm 点击成功后才发 "clicked" 邮件
  if (msg.type === "CONFIRM_CLICK_SUCCESS") {
    sendEmail("clicked", {
      buttonText: msg.buttonText || "",
      url: sender?.tab?.url || "",
    });
  }

  // #1: 链式点击结束 — 仅记录日志，不发邮件（无确认按钮≠预约成功）
  if (msg.type === "AUTO_CLICK_DONE") {
    addLog("info", "链式点击流程结束（无更多确认按钮）");
  }

  if (msg.type === "SEND_TEST_EMAIL") {
    sendEmail("test", {}).then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === "GET_CONFIG") {
    chrome.storage.local.get(null, (cfg) => {
      // 合并当前标签页的独立偏好
      const tabId = sender?.tab?.id;
      if (tabId && cfg.tabPreferences && cfg.tabPreferences[tabId]) {
        const tp = cfg.tabPreferences[tabId];
        if (tp.preferredWarehouse != null) cfg.preferredWarehouse = tp.preferredWarehouse;
        if (tp.preferredDate != null) cfg.preferredDate = tp.preferredDate;
        if (tp.preferredTimeText != null) cfg.preferredTimeText = tp.preferredTimeText;
      }
      sendResponse(cfg);
    });
    return true;
  }

  if (msg.type === "LOG") {
    const tabId = sender?.tab?.id ?? null;
    const tabUrl = sender?.tab?.url || "";
    // 仅记录调度页面日志，避免其它 Noon 页面日志污染远程监控
    if (tabId != null && !isScheduleTabUrl(tabUrl)) return;
    addLog(msg.entry.level, msg.entry.message, { ...msg.entry, tabId, tabUrl });
  }

  if (msg.type === "GET_SCHEDULE_STATUS") {
    chrome.storage.local.get(["scheduleEnabled", "schedules"], (cfg) => {
      const active = cfg.scheduleEnabled && isWithinAnySchedule(cfg.schedules || []);
      const next = cfg.scheduleEnabled ? getNextScheduleEvent(cfg.schedules || []) : null;
      sendResponse({ active, next });
    });
    return true;
  }

  if (msg.type === "UPDATE_CUSTOM_DOMAINS") {
    const domains = msg.domains || [];
    chrome.storage.local.set({ customDomains: domains }, () => {
      registerCustomDomains(domains);
      injectIntoMatchingTabs(domains);
      addLog("info", `🌐 自定义域名已更新: ${domains.length} 个`);
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === "INJECT_CURRENT_TAB") {
    if (msg.tabId) {
      chrome.tabs.get(msg.tabId, (tab) => {
        if (chrome.runtime.lastError || !tab?.url || !isScheduleTabUrl(tab.url)) return;
        chrome.scripting.executeScript({ target: { tabId: msg.tabId }, files: ["injected.js"], world: "MAIN" }).catch(() => {});
        chrome.scripting.executeScript({ target: { tabId: msg.tabId }, files: ["content_script.js"] }).catch(() => {});
        chrome.scripting.insertCSS({ target: { tabId: msg.tabId }, files: ["styles.css"] }).catch(() => {});
      });
    }
  }

  if (msg.type === "STATE_UPDATE") {
    const tabId = sender?.tab?.id;
    const tabUrl = sender?.tab?.url || "";
    if (tabId == null || !isScheduleTabUrl(tabUrl)) return;
    sendRemote("/api/state", {
      ...msg,
      clientId: String(tabId),
      tabUrl,
    });
  }
});

// ── 邮件通知 ───────────────────────────────────────────────────────

// #5: 节流改用 chrome.storage.local，SW 重启后状态不丢失
const EMAIL_THROTTLE_MS = 300000; // 5 分钟

async function sendEmail(event, details) {
  const cfg = await new Promise((r) => chrome.storage.local.get(null, r));

  if (event !== "test") {
    const throttleTs = cfg.emailThrottleTs || {};
    const last = throttleTs[event] || 0;
    if (Date.now() - last < EMAIL_THROTTLE_MS) {
      addLog("info", `📧 邮件已节流，跳过 ${event}（距上次发送不足 5 分钟）`);
      return;
    }
  }
  if (!cfg.emailEnabled || !cfg.emailAddress) return;
  if (!cfg.emailServiceId || !cfg.emailTemplateId || !cfg.emailPublicKey) {
    addLog("warn", "邮件配置不完整，跳过发送");
    return;
  }

  if (event === "available" && !cfg.emailOnAvailable) return;
  if (event === "clicked" && !cfg.emailOnClicked) return;

  const now = new Date();
  const timeStr = now.toLocaleString("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });

  const subjects = {
    available: "⚡ Noon FBN 仓库有位了!",
    clicked: "✅ Noon FBN 仓库已自动抢位!",
    test: "🔔 Slot Sentinel 邮件测试",
  };

  const bodies = {
    available: `检测到 ${details.count || "?"} 个可用 slot!\n\n时间: ${timeStr}\n按钮: ${details.buttons || "N/A"}\n页面: ${details.url || "N/A"}\n\n${cfg.autoClick ? "自动点击已启用，正在抢位…" : "请尽快手动预约!"}`,
    clicked: `已成功自动点击预约按钮!\n\n时间: ${timeStr}\n点击按钮: ${details.buttonText || "N/A"}\n页面: ${details.url || "N/A"}\n\n请确认预约是否成功完成。`,
    test: `这是一封测试邮件，确认 Slot Sentinel 邮件通知功能正常。\n\n时间: ${timeStr}\n配置状态: 正常`,
  };

  const payload = {
    service_id: cfg.emailServiceId,
    template_id: cfg.emailTemplateId,
    user_id: cfg.emailPublicKey,
    template_params: {
      to_email: cfg.emailAddress,
      subject: subjects[event] || "Slot Sentinel 通知",
      message: bodies[event] || details.message || "",
      time: timeStr,
      event_type: event,
    },
  };

  try {
    const resp = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (resp.ok) {
      // #5: 节流时间戳持久化到 storage
      const ts = cfg.emailThrottleTs || {};
      ts[event] = Date.now();
      chrome.storage.local.set({ emailThrottleTs: ts });
      addLog("info", `📧 邮件已发送 → ${cfg.emailAddress} (${event})`);
    } else {
      const text = await resp.text();
      addLog("warn", `📧 邮件发送失败: ${resp.status} ${text}`);
    }
  } catch (err) {
    addLog("warn", `📧 邮件发送异常: ${err.message}`);
  }
}

// ── 远程日志推送 ────────────────────────────────────────────────────

function sendRemote(endpoint, data) {
  chrome.storage.local.get(["remoteUrl", "remoteToken"], (cfg) => {
    if (!cfg.remoteUrl) return;
    const url = cfg.remoteUrl.replace(/\/+$/, "") + endpoint;
    fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + (cfg.remoteToken || ""),
      },
      body: JSON.stringify(data),
    }).catch(() => {});
  });
}

function addLog(level, message, extra) {
  const entry = { ts: Date.now(), level, message, ...(extra || {}) };
  chrome.storage.local.get("logs", ({ logs = [] }) => {
    logs.push(entry);
    if (logs.length > 500) logs = logs.slice(-500);
    chrome.storage.local.set({ logs });
  });
  sendRemote("/api/log", entry);
}
