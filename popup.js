/* ─────────────────────────────────────────────
   Slot Sentinel – Popup Script (v2.1 FBN)
   支持定时调度管理
   ───────────────────────────────────────────── */

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// ── UI references ──────────────────────────────────────────────────

const armBtn            = $("#armBtn");
const statusDot         = $("#statusDot");
const statusText        = $("#statusText");
const statusDetail      = $("#statusDetail");

const togSchedule       = $("#togSchedule");
const scheduleStatus    = $("#scheduleStatus");
const scheduleList      = $("#scheduleList");
const schStartTime      = $("#schStartTime");
const schEndTime        = $("#schEndTime");
const daysPicker        = $("#daysPicker");
const btnAddSchedule    = $("#btnAddSchedule");

const togAutoClick      = $("#togAutoClick");
const togAutoClickChain = $("#togAutoClickChain");
const autoClickDelay    = $("#autoClickDelay");
const autoClickDelayVal = $("#autoClickDelayVal");
const togAutoRefresh    = $("#togAutoRefresh");
const refreshInterval   = $("#refreshInterval");
const refreshIntervalVal = $("#refreshIntervalVal");
const togScroll         = $("#togScroll");
const togFocus          = $("#togFocus");
const togHighlight      = $("#togHighlight");
const togTitle          = $("#togTitle");
const togSound          = $("#togSound");
const notifMode         = $("#notifMode");
const pollIntervalEl    = $("#pollInterval");
const pollIntervalVal   = $("#pollIntervalVal");
const debounceSlider    = $("#debounceSlider");
const debounceVal       = $("#debounceVal");
const btnForceCheck     = $("#btnForceCheck");
const btnRefresh        = $("#btnRefresh");
const btnTestHL         = $("#btnTestHighlight");
const btnClearLogs      = $("#btnClearLogs");
const logPanel          = $("#logPanel");
const btnLogFilter      = $("#btnLogFilter");
const candidateInfo     = $("#candidateInfo");
const candidateList     = $("#candidateList");

const togEmail          = $("#togEmail");
const emailAddress      = $("#emailAddress");
const togEmailOnAvail   = $("#togEmailOnAvailable");
const togEmailOnClicked = $("#togEmailOnClicked");
const emailServiceId    = $("#emailServiceId");
const emailTemplateId   = $("#emailTemplateId");
const emailPublicKey    = $("#emailPublicKey");
const emailStatus       = $("#emailStatus");
const btnSaveEmail      = $("#btnSaveEmail");
const btnTestEmail      = $("#btnTestEmail");

const domainList        = $("#domainList");
const domainInput       = $("#domainInput");
const btnAddDomain      = $("#btnAddDomain");
const btnInjectCurrent  = $("#btnInjectCurrent");

const preferredWarehouse = $("#preferredWarehouse");
const preferredDate      = $("#preferredDate");
const preferredTimeText  = $("#preferredTimeText");

const remoteUrl          = $("#remoteUrl");
const remoteToken        = $("#remoteToken");
const remoteStatus       = $("#remoteStatus");
const btnTestRemote      = $("#btnTestRemote");

const DAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"];

let currentTabId = null;
let logFilterTab = true;

// ── Load config ────────────────────────────────────────────────────

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  currentTabId = tabs[0]?.id || null;

  chrome.storage.local.get(null, (cfg) => {
    togAutoClick.checked      = !!cfg.autoClick;
    togAutoClickChain.checked = !!cfg.autoClickChain;
    autoClickDelay.value      = cfg.autoClickDelay || 500;
    autoClickDelayVal.textContent = (cfg.autoClickDelay || 500) + "ms";
    togAutoRefresh.checked    = !!cfg.autoRefresh;
    refreshInterval.value     = cfg.autoRefreshSec || 30;
    refreshIntervalVal.textContent = (cfg.autoRefreshSec || 30) + "s";
    togScroll.checked         = cfg.autoScroll !== false;
    togFocus.checked          = cfg.autoFocus !== false;
    togHighlight.checked      = cfg.highlightOn !== false;
    togTitle.checked          = cfg.titleFlash !== false;
    togSound.checked          = !!cfg.soundEnabled;
    notifMode.value           = cfg.notifMode || "toast";
    pollIntervalEl.value      = cfg.pollInterval || 500;
    pollIntervalVal.textContent = formatPollInterval(cfg.pollInterval || 500);
    debounceSlider.value      = cfg.debounceMs || 100;
    debounceVal.textContent   = (cfg.debounceMs || 100) + "ms";
    togSchedule.checked       = !!cfg.scheduleEnabled;
    togEmail.checked          = !!cfg.emailEnabled;
    emailAddress.value        = cfg.emailAddress || "";
    togEmailOnAvail.checked   = cfg.emailOnAvailable !== false;
    togEmailOnClicked.checked = cfg.emailOnClicked !== false;
    emailServiceId.value      = cfg.emailServiceId || "";
    emailTemplateId.value     = cfg.emailTemplateId || "";
    emailPublicKey.value      = cfg.emailPublicKey || "";

    // 偏好：优先使用当前标签页的独立设置
    const tabPrefs = currentTabId ? (cfg.tabPreferences || {})[currentTabId] : null;
    preferredWarehouse.value  = ((tabPrefs?.preferredWarehouse ?? cfg.preferredWarehouse) || "").trim();
    preferredDate.value       = (() => {
      const v = tabPrefs?.preferredDate ?? cfg.preferredDate;
      return (v != null && v !== 0 && v !== "") ? String(v) : "";
    })();
    preferredTimeText.value   = ((tabPrefs?.preferredTimeText ?? cfg.preferredTimeText) || "").trim();

    // 显示当前标签页标识
    const prefTabTag = document.getElementById("prefTabTag");
    if (prefTabTag && currentTabId) {
      prefTabTag.textContent = tabPrefs ? `[Tab #${currentTabId}]` : `[Tab #${currentTabId} · 继承全局]`;
    }

    // 新标签页首次打开时，立即创建独立偏好副本
    if (currentTabId && !tabPrefs) {
      const initPrefs = {
        preferredWarehouse: preferredWarehouse.value,
        preferredDate: preferredDate.value,
        preferredTimeText: preferredTimeText.value,
      };
      chrome.storage.local.get("tabPreferences", ({ tabPreferences = {} }) => {
        tabPreferences[currentTabId] = initPrefs;
        chrome.storage.local.set({ tabPreferences });
      });
    }

    if (remoteUrl) remoteUrl.value     = (cfg.remoteUrl || "").trim();
    if (remoteToken) remoteToken.value = (cfg.remoteToken || "").trim();

    updateArmUI(cfg.armed !== false);
    renderSchedules(cfg.schedules || []);
    renderDomains(cfg.customDomains || []);
    renderLogs(cfg.logs || []);
    updateScheduleStatusUI();
    initMultiWindowsSection();
  });

  requestState();
});

// ══════════════════════════════════════════════════════════════════
//  监控网址管理
// ══════════════════════════════════════════════════════════════════

btnAddDomain.addEventListener("click", addDomain);
domainInput.addEventListener("keydown", (e) => { if (e.key === "Enter") addDomain(); });

function addDomain() {
  let val = domainInput.value.trim();
  if (!val) return;
  val = val.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!val) return;

  const pattern = "https://" + val + "/*";
  chrome.permissions.request({ origins: [pattern] }, (granted) => {
    if (!granted) return;
    chrome.storage.local.get("customDomains", ({ customDomains = [] }) => {
      if (customDomains.includes(val)) {
        domainInput.value = "";
        return;
      }
      customDomains.push(val);
      chrome.runtime.sendMessage({ type: "UPDATE_CUSTOM_DOMAINS", domains: customDomains }, () => {
        renderDomains(customDomains);
        domainInput.value = "";
      });
    });
  });
}

function removeDomain(domain) {
  chrome.storage.local.get("customDomains", ({ customDomains = [] }) => {
    customDomains = customDomains.filter((d) => d !== domain);
    const pattern = "https://" + domain + "/*";
    chrome.permissions.remove({ origins: [pattern] }).catch(() => {});
    chrome.runtime.sendMessage({ type: "UPDATE_CUSTOM_DOMAINS", domains: customDomains }, () => {
      renderDomains(customDomains);
    });
  });
}

function renderDomains(domains) {
  if (!domains.length) {
    domainList.innerHTML = "";
    return;
  }
  domainList.innerHTML = "";
  for (const d of domains) {
    const item = document.createElement("div");
    item.className = "domain-item";
    item.innerHTML = `
      <span class="domain-url">${escHtml(d)}</span>
      <button class="domain-del" title="删除">×</button>
    `;
    item.querySelector(".domain-del").addEventListener("click", () => removeDomain(d));
    domainList.appendChild(item);
  }
}

btnInjectCurrent.addEventListener("click", () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]?.id) return;
    chrome.runtime.sendMessage({ type: "INJECT_CURRENT_TAB", tabId: tabs[0].id });
    btnInjectCurrent.textContent = "已注入 ✓";
    setTimeout(() => { btnInjectCurrent.textContent = "注入当前页面（当前标签页不在列表中时用）"; }, 2000);
  });
});

// ══════════════════════════════════════════════════════════════════
//  定时调度管理
// ══════════════════════════════════════════════════════════════════

// ── 启用/禁用调度 ──────────────────────────────────────────────────

togSchedule.addEventListener("change", () => {
  const val = togSchedule.checked;
  chrome.storage.local.set({ scheduleEnabled: val });
  updateScheduleStatusUI();
});

// ── 星期选择器 ────────────────────────────────────────────────────

daysPicker.addEventListener("click", (e) => {
  const btn = e.target.closest(".day-btn");
  if (!btn) return;
  btn.classList.toggle("selected");
});

// ── 添加时间段 ────────────────────────────────────────────────────

btnAddSchedule.addEventListener("click", () => {
  const startTime = schStartTime.value;
  const endTime = schEndTime.value;
  if (!startTime || !endTime) return;

  const days = [];
  daysPicker.querySelectorAll(".day-btn.selected").forEach((btn) => {
    days.push(parseInt(btn.dataset.day, 10));
  });

  const newSchedule = {
    id: "sch_" + Date.now(),
    startTime,
    endTime,
    days,
    enabled: true,
  };

  chrome.storage.local.get("schedules", ({ schedules = [] }) => {
    schedules.push(newSchedule);
    chrome.storage.local.set({ schedules });
    renderSchedules(schedules);
    updateScheduleStatusUI();
  });
});

// ── 渲染时间段列表 ────────────────────────────────────────────────

function renderSchedules(schedules) {
  if (!schedules.length) {
    scheduleList.innerHTML = '<div class="schedule-empty">暂无时间段，请添加</div>';
    return;
  }

  scheduleList.innerHTML = "";
  for (const s of schedules) {
    const item = document.createElement("div");
    item.className = "schedule-item";

    const daysText = s.days && s.days.length > 0 && s.days.length < 7
      ? s.days.sort((a, b) => a - b).map((d) => DAY_LABELS[d]).join(" ")
      : "每天";

    item.innerHTML = `
      <span class="sch-time">${s.startTime} – ${s.endTime}</span>
      <span class="sch-days">${daysText}</span>
      <label class="switch schedule sch-toggle" style="width:30px;height:16px">
        <input type="checkbox" data-id="${s.id}" ${s.enabled ? "checked" : ""}>
        <span class="slider" style="border-radius:16px"></span>
      </label>
      <button class="sch-del" data-id="${s.id}" title="删除">×</button>
    `;

    const slider = item.querySelector(".slider");
    if (slider) {
      slider.style.setProperty("--before-size", "12px");
      const beforeStyle = document.createElement("style");
      beforeStyle.textContent = `
        .schedule-item .switch { width: 30px !important; height: 16px !important; }
        .schedule-item .switch .slider::before { width: 12px !important; height: 12px !important; }
        .schedule-item .switch input:checked + .slider::before { transform: translateX(14px) !important; }
      `;
      if (!document.getElementById("sch-switch-style")) {
        beforeStyle.id = "sch-switch-style";
        document.head.appendChild(beforeStyle);
      }
    }

    item.querySelector("input[type=checkbox]").addEventListener("change", (e) => {
      toggleSchedule(e.target.dataset.id, e.target.checked);
    });

    item.querySelector(".sch-del").addEventListener("click", (e) => {
      deleteSchedule(e.currentTarget.dataset.id);
    });

    scheduleList.appendChild(item);
  }
}

function toggleSchedule(id, enabled) {
  chrome.storage.local.get("schedules", ({ schedules = [] }) => {
    const s = schedules.find((x) => x.id === id);
    if (s) s.enabled = enabled;
    chrome.storage.local.set({ schedules });
    updateScheduleStatusUI();
  });
}

function deleteSchedule(id) {
  chrome.storage.local.get("schedules", ({ schedules = [] }) => {
    schedules = schedules.filter((x) => x.id !== id);
    chrome.storage.local.set({ schedules });
    renderSchedules(schedules);
    updateScheduleStatusUI();
  });
}

// ── 调度状态显示 ──────────────────────────────────────────────────

function updateScheduleStatusUI() {
  chrome.storage.local.get(["scheduleEnabled", "schedules", "manualOverride", "armed"], (cfg) => {
    if (!cfg.scheduleEnabled) {
      scheduleStatus.className = "schedule-status inactive";
      scheduleStatus.style.display = "block";
      scheduleStatus.textContent = "定时调度未启用";
      return;
    }

    const schedules = cfg.schedules || [];
    if (!schedules.length || !schedules.some((s) => s.enabled)) {
      scheduleStatus.className = "schedule-status inactive";
      scheduleStatus.style.display = "block";
      scheduleStatus.textContent = "无已启用的时间段";
      return;
    }

    // 手动覆盖模式
    if (cfg.manualOverride) {
      scheduleStatus.className = "schedule-status active";
      scheduleStatus.style.display = "block";
      scheduleStatus.textContent = cfg.armed
        ? "手动启用中 — 调度已临时覆盖，进入下个时段后恢复调度"
        : "手动暂停中 — 调度已临时覆盖，进入下个时段后恢复调度";
      return;
    }

    const now = new Date();
    const day = now.getDay();
    const minutes = now.getHours() * 60 + now.getMinutes();
    let inRange = false;
    let nextLabel = "";

    for (const s of schedules) {
      if (!s.enabled) continue;
      if (s.days && s.days.length > 0 && !s.days.includes(day)) continue;

      const [sh, sm] = s.startTime.split(":").map(Number);
      const [eh, em] = s.endTime.split(":").map(Number);
      const start = sh * 60 + sm;
      const end = eh * 60 + em;

      if (start <= end) {
        if (minutes >= start && minutes < end) { inRange = true; break; }
      } else {
        if (minutes >= start || minutes < end) { inRange = true; break; }
      }
    }

    if (inRange) {
      scheduleStatus.className = "schedule-status active";
      scheduleStatus.style.display = "block";
      scheduleStatus.textContent = "当前处于抢位时段 — 监控已自动启用";
    } else {
      let closestStart = Infinity;
      for (const s of schedules) {
        if (!s.enabled) continue;
        if (s.days && s.days.length > 0 && !s.days.includes(day)) continue;
        const [sh, sm] = s.startTime.split(":").map(Number);
        const start = sh * 60 + sm;
        if (start > minutes && (start - minutes) < closestStart) {
          closestStart = start - minutes;
        }
      }

      if (closestStart < Infinity) {
        const h = Math.floor(closestStart / 60);
        const m = closestStart % 60;
        nextLabel = "，" + (h > 0 ? h + "小时" : "") + m + "分钟后开始";
      }

      scheduleStatus.className = "schedule-status waiting";
      scheduleStatus.style.display = "block";
      scheduleStatus.textContent = "等待下一个抢位时段" + nextLabel;
    }
  });
}

// ══════════════════════════════════════════════════════════════════
//  原有功能
// ══════════════════════════════════════════════════════════════════

// ── State updates ──────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === "STATE_UPDATE") {
    if (sender?.tab?.id && sender.tab.id !== currentTabId) return;
    updateStateUI(msg);
  }
  if (msg.type === "SCHEDULE_STATUS_UPDATE") {
    updateScheduleStatusUI();
  }
});

function requestState() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]?.id) chrome.tabs.sendMessage(tabs[0].id, { type: "REQUEST_STATE" });
  });
}

function updateStateUI(msg) {
  const { state, armed, autoClick, candidateCount, lastCheckTime, selectors, texts } = msg;
  updateArmUI(armed);

  statusDot.className = "status-dot";
  if (!armed) {
    statusDot.classList.add("paused");
    statusText.textContent = "已暂停";
  } else if (state === "AVAILABLE") {
    statusDot.classList.add("available");
    const mode = autoClick ? " [自动抢]" : "";
    statusText.textContent = `可用! (${candidateCount})${mode}`;
  } else if (state === "SOLD_OUT") {
    statusDot.classList.add("soldout");
    statusText.textContent = "已满 / 无位";
  } else {
    statusDot.classList.add(armed ? "armed" : "unknown");
    statusText.textContent = "监控中…";
  }

  if (lastCheckTime) {
    const d = new Date(lastCheckTime);
    statusDetail.textContent = "检测: " + d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  if (selectors && selectors.length > 0) {
    candidateInfo.style.display = "";
    candidateList.innerHTML = "";
    for (let i = 0; i < selectors.length; i++) {
      const div = document.createElement("div");
      div.className = "candidate-item";
      div.innerHTML =
        `<span class="rank">#${i + 1}</span>` +
        `<span class="sel">${escHtml(selectors[i])}</span>` +
        (texts && texts[i] ? `<span class="txt">"${escHtml(texts[i])}"</span>` : "");
      candidateList.appendChild(div);
    }
  } else {
    candidateInfo.style.display = "none";
  }
}

function updateArmUI(armed) {
  if (armed) {
    armBtn.textContent = "已启用 — 监控中";
    armBtn.className = "arm-btn armed";
  } else {
    armBtn.textContent = "已暂停 — 点击启用";
    armBtn.className = "arm-btn paused";
  }
}

// ── Arm toggle ─────────────────────────────────────────────────────

armBtn.addEventListener("click", () => {
  chrome.storage.local.get(["armed", "scheduleEnabled"], ({ armed, scheduleEnabled }) => {
    const next = !(armed !== false);
    const updates = { armed: next };
    // 手动切换时，如果调度开着，设置覆盖标记防止调度反复切换
    if (scheduleEnabled) updates.manualOverride = true;
    chrome.storage.local.set(updates);
    updateArmUI(next);
    sendToContent({ type: "SET_ARMED", armed: next });
  });
});

// ── Auto-click controls ────────────────────────────────────────────

togAutoClick.addEventListener("change", () => {
  const val = togAutoClick.checked;
  chrome.storage.local.set({ autoClick: val });
  sendToContent({ type: "SET_AUTO_CLICK", on: val });
});

togAutoClickChain.addEventListener("change", () => {
  const val = togAutoClickChain.checked;
  chrome.storage.local.set({ autoClickChain: val });
  sendToContent({ type: "CONFIG_UPDATED", cfg: { autoClickChain: val } });
});

autoClickDelay.addEventListener("input", () => {
  const val = parseInt(autoClickDelay.value, 10);
  autoClickDelayVal.textContent = val + "ms";
  chrome.storage.local.set({ autoClickDelay: val });
  sendToContent({ type: "CONFIG_UPDATED", cfg: { autoClickDelay: val } });
});

// ── 抢位偏好：保存并同步到 content ─────────────────────────────────

function savePreferenceAndNotify() {
  const warehouse = preferredWarehouse.value.trim();
  const dateStr = preferredDate.value.trim();
  const timeText = preferredTimeText.value.trim();
  const prefs = {
    preferredWarehouse: warehouse,
    preferredDate: dateStr,
    preferredTimeText: timeText,
  };

  // 按标签页独立存储偏好
  if (currentTabId) {
    chrome.storage.local.get("tabPreferences", ({ tabPreferences = {} }) => {
      tabPreferences[currentTabId] = prefs;
      chrome.storage.local.set({ tabPreferences, ...prefs });
    });
    // 更新标识
    const prefTabTag = document.getElementById("prefTabTag");
    if (prefTabTag) prefTabTag.textContent = `[Tab #${currentTabId}]`;
  } else {
    chrome.storage.local.set(prefs);
  }

  sendToContent({ type: "CONFIG_UPDATED", cfg: prefs });
}

preferredWarehouse.addEventListener("input", savePreferenceAndNotify);
preferredWarehouse.addEventListener("change", savePreferenceAndNotify);
preferredDate.addEventListener("input", savePreferenceAndNotify);
preferredDate.addEventListener("change", savePreferenceAndNotify);
preferredTimeText.addEventListener("input", savePreferenceAndNotify);
preferredTimeText.addEventListener("change", savePreferenceAndNotify);

// ── Auto-refresh controls ──────────────────────────────────────────

togAutoRefresh.addEventListener("change", () => {
  const val = togAutoRefresh.checked;
  const interval = parseInt(refreshInterval.value, 10) || 30;
  chrome.storage.local.set({ autoRefresh: val, autoRefreshSec: interval });
  sendToContent({ type: "SET_AUTO_REFRESH", on: val, interval });
});

refreshInterval.addEventListener("input", () => {
  const val = parseInt(refreshInterval.value, 10);
  refreshIntervalVal.textContent = val + "s";
  chrome.storage.local.set({ autoRefreshSec: val });
  if (togAutoRefresh.checked) {
    sendToContent({ type: "SET_AUTO_REFRESH", on: true, interval: val });
  }
});

// ── Feature toggles ────────────────────────────────────────────────

function bindToggle(el, key) {
  el.addEventListener("change", () => {
    chrome.storage.local.set({ [key]: el.checked });
    sendToContent({ type: "CONFIG_UPDATED", cfg: { [key]: el.checked } });
  });
}

bindToggle(togScroll, "autoScroll");
bindToggle(togFocus, "autoFocus");
bindToggle(togHighlight, "highlightOn");
bindToggle(togTitle, "titleFlash");
bindToggle(togSound, "soundEnabled");

togHighlight.addEventListener("change", () => {
  sendToContent({ type: "SET_HIGHLIGHT", on: togHighlight.checked });
});

notifMode.addEventListener("change", () => {
  const val = notifMode.value;
  chrome.storage.local.set({ notifMode: val, desktopNotif: val === "desktop" });
  sendToContent({ type: "CONFIG_UPDATED", cfg: { notifMode: val } });
});

pollIntervalEl.addEventListener("input", () => {
  const val = parseInt(pollIntervalEl.value, 10);
  pollIntervalVal.textContent = formatPollInterval(val);
  chrome.storage.local.set({ pollInterval: val });
  sendToContent({ type: "CONFIG_UPDATED", cfg: { pollInterval: val } });
});

function formatPollInterval(ms) {
  return ms < 1000 ? ms + "ms" : (ms / 1000).toFixed(1) + "s";
}

debounceSlider.addEventListener("input", () => {
  const val = parseInt(debounceSlider.value, 10);
  debounceVal.textContent = val + "ms";
  chrome.storage.local.set({ debounceMs: val });
  sendToContent({ type: "CONFIG_UPDATED", cfg: { debounceMs: val } });
});

// ── Action buttons ─────────────────────────────────────────────────

btnForceCheck.addEventListener("click", () => sendToContent({ type: "FORCE_CHECK" }));
btnRefresh.addEventListener("click", () => sendToContent({ type: "FORCE_REFRESH" }));
btnTestHL.addEventListener("click", () => sendToContent({ type: "TEST_HIGHLIGHT" }));
btnClearLogs.addEventListener("click", () => {
  if (logFilterTab && currentTabId) {
    chrome.storage.local.get("logs", ({ logs = [] }) => {
      logs = logs.filter((e) => e.tabId !== currentTabId);
      chrome.storage.local.set({ logs });
      logPanel.innerHTML = '<div class="empty-log">日志已清除</div>';
    });
  } else {
    chrome.storage.local.set({ logs: [] });
    logPanel.innerHTML = '<div class="empty-log">日志已清除</div>';
  }
});

// ── 日志过滤切换 ─────────────────────────────────────────────────────

btnLogFilter.addEventListener("click", () => {
  logFilterTab = !logFilterTab;
  btnLogFilter.textContent = logFilterTab ? "仅当前" : "全部";
  btnLogFilter.style.color = logFilterTab ? "#4db6ac" : "#888";
  chrome.storage.local.get("logs", ({ logs = [] }) => renderLogs(logs));
});

// ── Logs ───────────────────────────────────────────────────────────

function renderLogs(logs) {
  const filtered = logFilterTab && currentTabId
    ? logs.filter((e) => e.tabId === currentTabId || !e.tabId)
    : logs;
  if (!filtered.length) {
    logPanel.innerHTML = '<div class="empty-log">暂无活动记录</div>';
    return;
  }
  logPanel.innerHTML = "";
  const recent = filtered.slice(-60);
  for (const entry of recent) {
    const div = document.createElement("div");
    div.className = "log-entry " + (entry.level || "info");
    const ts = new Date(entry.ts).toLocaleTimeString("zh-CN", {
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    div.innerHTML = `<span class="ts">[${ts}]</span> ${escHtml(entry.message)}`;
    logPanel.appendChild(div);
  }
  logPanel.scrollTop = logPanel.scrollHeight;
}

function escHtml(s) {
  const d = document.createElement("span");
  d.textContent = s || "";
  return d.innerHTML;
}

setInterval(() => {
  chrome.storage.local.get("logs", ({ logs = [] }) => renderLogs(logs));
  requestState();
  updateScheduleStatusUI();
}, 1500);

// ══════════════════════════════════════════════════════════════════
//  邮件通知
// ══════════════════════════════════════════════════════════════════

// 所有邮件字段实时自动保存 — 输入即保存，关掉弹窗也不丢

togEmail.addEventListener("change", () => {
  chrome.storage.local.set({ emailEnabled: togEmail.checked });
});
togEmailOnAvail.addEventListener("change", () => {
  chrome.storage.local.set({ emailOnAvailable: togEmailOnAvail.checked });
});
togEmailOnClicked.addEventListener("change", () => {
  chrome.storage.local.set({ emailOnClicked: togEmailOnClicked.checked });
});

function autoSaveInput(el, key) {
  el.addEventListener("input", () => {
    chrome.storage.local.set({ [key]: el.value.trim() });
  });
  el.addEventListener("change", () => {
    chrome.storage.local.set({ [key]: el.value.trim() });
  });
}

autoSaveInput(emailAddress, "emailAddress");
autoSaveInput(emailServiceId, "emailServiceId");
autoSaveInput(emailTemplateId, "emailTemplateId");
autoSaveInput(emailPublicKey, "emailPublicKey");

btnSaveEmail.addEventListener("click", () => {
  const data = {
    emailEnabled: togEmail.checked,
    emailAddress: emailAddress.value.trim(),
    emailOnAvailable: togEmailOnAvail.checked,
    emailOnClicked: togEmailOnClicked.checked,
    emailServiceId: emailServiceId.value.trim(),
    emailTemplateId: emailTemplateId.value.trim(),
    emailPublicKey: emailPublicKey.value.trim(),
  };
  chrome.storage.local.set(data, () => {
    showEmailStatus("ok", "配置已保存 ✓");
  });
});

btnTestEmail.addEventListener("click", () => {
  const addr = emailAddress.value.trim();
  const sid = emailServiceId.value.trim();
  const tid = emailTemplateId.value.trim();
  const pk = emailPublicKey.value.trim();

  if (!addr || !sid || !tid || !pk) {
    showEmailStatus("err", "请先填写完整配置");
    return;
  }

  showEmailStatus("ok", "发送测试邮件中…");
  chrome.runtime.sendMessage({ type: "SEND_TEST_EMAIL" }, () => {
    if (chrome.runtime.lastError) {
      showEmailStatus("err", "发送失败: " + chrome.runtime.lastError.message);
      return;
    }
    setTimeout(() => {
      chrome.storage.local.get("logs", ({ logs = [] }) => {
        const last = logs[logs.length - 1];
        if (last && last.message && last.message.includes("邮件")) {
          showEmailStatus(last.message.includes("已发送") ? "ok" : "err", last.message);
        }
      });
    }, 2000);
  });
});

function showEmailStatus(type, text) {
  emailStatus.style.display = "block";
  emailStatus.className = "email-status " + type;
  emailStatus.textContent = text;
  if (type === "ok") {
    setTimeout(() => { emailStatus.style.display = "none"; }, 5000);
  }
}

// ══════════════════════════════════════════════════════════════════
//  远程监控
// ══════════════════════════════════════════════════════════════════

if (remoteUrl) autoSaveInput(remoteUrl, "remoteUrl");
if (remoteToken) autoSaveInput(remoteToken, "remoteToken");

if (btnTestRemote) {
  btnTestRemote.addEventListener("click", () => {
    const url = (remoteUrl.value || "").trim();
    const tk = (remoteToken.value || "").trim();
    if (!url) { showRemoteStatus("err", "请填写服务器地址"); return; }
    showRemoteStatus("ok", "测试连接中…");
    fetch(url.replace(/\/+$/, "") + "/api/log", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + tk },
      body: JSON.stringify({ ts: Date.now(), level: "info", message: "连接测试 — 来自 Slot Sentinel 插件" }),
    })
      .then((r) => showRemoteStatus(r.ok ? "ok" : "err", r.ok ? "连接成功" : "失败: " + r.status))
      .catch((e) => showRemoteStatus("err", "连接失败: " + e.message));
  });
}

function showRemoteStatus(type, text) {
  if (!remoteStatus) return;
  remoteStatus.style.display = "block";
  remoteStatus.className = "email-status " + type;
  remoteStatus.textContent = text;
  if (type === "ok") setTimeout(() => { remoteStatus.style.display = "none"; }, 5000);
}

// ── Helpers ────────────────────────────────────────────────────────

function sendToContent(msg) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]?.id) chrome.tabs.sendMessage(tabs[0].id, msg);
  });
}

// ══════════════════════════════════════════════════════════════════
//  抢占窗口：一次打开多个监控标签页
// ══════════════════════════════════════════════════════════════════

const DEFAULT_MONITOR_URL = "https://fbn.noon.partners/";

function initMultiWindowsSection() {
  if (document.getElementById("multiWindowsSection")) return;

  const section = document.createElement("div");
  section.id = "multiWindowsSection";
  section.className = "section";
  section.innerHTML = `
    <div class="section-title">抢占窗口</div>
    <div style="display:flex;align-items:center;gap:6px;padding:6px 0;flex-wrap:wrap">
      <label style="font-size:12px;color:#ccc">打开</label>
      <input type="number" id="multiWindowCount" min="2" max="10" value="5" style="width:48px;background:#1a1a25;border:1px solid #333;border-radius:4px;color:#ccc;padding:4px 6px;font-size:12px;text-align:center">
      <span style="font-size:12px;color:#ccc">个监控窗口</span>
      <button type="button" id="btnOpenMultiWindows" style="margin-left:4px;padding:6px 12px;border-radius:6px;background:linear-gradient(135deg,#1b5e20,#2e7d32);color:#fff;border:none;font-size:12px;font-weight:600;cursor:pointer">打开</button>
    </div>
    <div style="font-size:10px;color:#555;margin-top:4px;line-height:1.4">每个标签页独立监测，可同时抢多个 slot（建议 4～5 个）</div>
  `;

  const actions = document.querySelector(".actions");
  if (actions && actions.parentNode) {
    actions.parentNode.insertBefore(section, actions);
  } else {
    document.body.appendChild(section);
  }

  const input = document.getElementById("multiWindowCount");
  const btn = document.getElementById("btnOpenMultiWindows");
  if (!input || !btn) return;

  chrome.storage.local.get("multiWindowCount", (cfg) => {
    const n = Math.min(10, Math.max(2, parseInt(cfg.multiWindowCount, 10) || 5));
    input.value = n;
    btn.textContent = "打开 " + n + " 个";
  });

  input.addEventListener("input", () => {
    const n = Math.min(10, Math.max(2, parseInt(input.value, 10) || 2));
    input.value = n;
    btn.textContent = "打开 " + n + " 个";
    chrome.storage.local.set({ multiWindowCount: n });
  });

  btn.addEventListener("click", openMultipleMonitorWindows);
}

function openMultipleMonitorWindows() {
  const input = document.getElementById("multiWindowCount");
  const n = Math.min(10, Math.max(2, parseInt(input?.value, 10) || 5));

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    let url = (tabs[0] && tabs[0].url) || "";
    if (!url || !/noon\.partners|noon\.com/i.test(url)) {
      url = DEFAULT_MONITOR_URL;
    }

    for (let i = 0; i < n; i++) {
      setTimeout(() => {
        chrome.tabs.create({ url });
      }, i * 120);
    }
  });
}
