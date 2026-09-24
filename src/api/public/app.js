const LABELS = ["legit", "spam", "phish", "malware", "gray", "unsolicited-admin"];
const LABEL_NAMES = {
  legit: "正常",
  phish: "钓鱼",
  malware: "恶意威胁",
  spam: "垃圾",
  "unsolicited-admin": "推广",
  gray: "未知/可疑",
};

let currentTab = "ai";
let currentView = "inbox";
let currentSettingCategory = "prompts";
let selectedMailId = null;
let selectedJobId = null;
let currentMailHtml = "";
let allowExternalImages = false;
let cursor = null;
let currentJobs = [];
let currentMessages = [];

// DOM 元素引用
const appEl = document.querySelector("#app");
const loginEl = document.querySelector("#login");
const loginForm = document.querySelector("#login-form");
const loginError = document.querySelector("#login-error");
const logoutBtn = document.querySelector("#logout");
const themeBtn = document.querySelector("#btn-theme");
const themeIcon = document.querySelector("#theme-icon");

// 导航按钮 (收件箱, 死信队列, 系统设置)
const navInboxBtn = document.querySelector("#nav-inbox");
const navDlqBtn = document.querySelector("#nav-dlq");
const navSettingsBtn = document.querySelector("#nav-settings");
const badgeDlq = document.querySelector("#badge-dlq");

// 第二列流头部
const streamInboxHeader = document.querySelector("#stream-inbox-header");
const streamDlqHeader = document.querySelector("#stream-dlq-header");
const streamSettingsHeader = document.querySelector("#stream-settings-header");
const listEl = document.querySelector("#list");
const moreBtn = document.querySelector("#more");
const noticeEl = document.querySelector("#notice");
const queryInput = document.querySelector("#q");
const labelInput = document.querySelector("#label");
const filterSelect = document.querySelector("#filter-select");
const refreshBtn = document.querySelector("#btn-refresh");
const dlqRefreshBtn = document.querySelector("#btn-dlq-refresh");
const retryAllBtn = document.querySelector("#btn-retry-all");

// 第三列工作台各视图
const viewMail = document.querySelector("#view-mail");
const viewDlq = document.querySelector("#view-dlq");
const viewPrompts = document.querySelector("#view-prompts");
const viewMailboxes = document.querySelector("#view-mailboxes");
const viewStats = document.querySelector("#view-stats");
const viewSystem = document.querySelector("#view-system");

// 邮件阅读器元素
const mailEmptyEl = document.querySelector("#mail-empty");
const mailDetailEl = document.querySelector("#mail-detail");
const detailSubject = document.querySelector("#detail-subject");
const detailFrom = document.querySelector("#detail-from");
const detailTo = document.querySelector("#detail-to");
const detailTime = document.querySelector("#detail-time");
const detailVerdictSelect = document.querySelector("#detail-verdict-select");
const detailModelVerdict = document.querySelector("#detail-model-verdict");
const detailSummary = document.querySelector("#detail-summary");
const verdictBar = document.querySelector("#verdict-bar");
const verdictPercent = document.querySelector("#verdict-percent");
const sectionSignals = document.querySelector("#section-signals");
const signalsCountEl = document.querySelector("#signals-count");
const signalsList = document.querySelector("#signals-list");
const sectionUrls = document.querySelector("#section-urls");
const urlCountEl = document.querySelector("#url-count");
const urlsList = document.querySelector("#urls-list");
const attachmentsList = document.querySelector("#attachments-list");
const attachmentCountEl = document.querySelector("#attachment-count");
const mailSandbox = document.querySelector("#mail-sandbox");
const plainTextBody = document.querySelector("#plain-text-body");
const rawHeaders = document.querySelector("#raw-headers");
const authChips = document.querySelector("#auth-chips");
const btnReclassify = document.querySelector("#btn-reclassify");
const btnDownloadEml = document.querySelector("#btn-download-eml");
const btnLoadImages = document.querySelector("#btn-load-images");

// 事件绑定
loginForm.addEventListener("submit", (e) => {
  e.preventDefault();
  void signIn();
});

logoutBtn.addEventListener("click", () => void signOut());
themeBtn.addEventListener("click", () => toggleTheme());

navInboxBtn?.addEventListener("click", () => switchNav("inbox"));
navDlqBtn?.addEventListener("click", () => switchNav("dlq"));
navSettingsBtn?.addEventListener("click", () => switchNav("settings"));

refreshBtn?.addEventListener("click", () => void reloadMessages());
dlqRefreshBtn?.addEventListener("click", () => void loadDlqJobs());
retryAllBtn?.addEventListener("click", () => void retryAllDead());

document.querySelector("#filters")?.addEventListener("submit", (e) => {
  e.preventDefault();
  void reloadMessages();
});

queryInput?.addEventListener("input", debounce(() => void reloadMessages(), 350));

filterSelect?.addEventListener("change", () => {
  labelInput.value = filterSelect.value;
  void reloadMessages();
});

detailVerdictSelect?.addEventListener("change", async () => {
  if (!selectedMailId) return;
  const newLabel = detailVerdictSelect.value;
  detailVerdictSelect.disabled = true;
  try {
    const res = await request("/v1/messages/" + encodeURIComponent(selectedMailId) + "/label", {
      method: "PATCH",
      body: { label: newLabel },
    });
    detailVerdictSelect.dataset.label = newLabel;
    if (detailModelVerdict) {
      const origName = LABEL_NAMES[res.originalLabel] || res.originalLabel || "未分类";
      const origConf = typeof res.originalConfidence === "number" ? " " + Math.round(res.originalConfidence * 100) + "%" : "";
      detailModelVerdict.textContent = `(模型初判: ${origName}${origConf} · 人工修正)`;
    }
    const listItem = listEl.querySelector(`.mail-item[data-id="${selectedMailId}"]`);
    if (listItem) {
      const tag = listItem.querySelector(".verdict-tag");
      if (tag) {
        tag.dataset.label = newLabel;
        tag.textContent = (LABEL_NAMES[newLabel] || newLabel) + " (人工修正)";
      }
    }
    noticeEl.textContent = "研判已手动修正为: " + (LABEL_NAMES[newLabel] || newLabel);
    setTimeout(() => {
      if (noticeEl.textContent.startsWith("研判已手动修正")) noticeEl.textContent = "";
    }, 3000);
  } catch (err) {
    noticeEl.textContent = "修改研判失败: " + explain(err);
  } finally {
    detailVerdictSelect.disabled = false;
  }
});

moreBtn.addEventListener("click", () => void loadMessagesPage(false));

// DLQ 状态胶囊点击
document.querySelector("#dlq-pills")?.addEventListener("click", (e) => {
  const target = e.target;
  if (!target || !target.matches("button[data-dlq-status]")) return;
  for (const btn of document.querySelectorAll("#dlq-pills button")) btn.classList.remove("active");
  target.classList.add("active");
  const st = target.getAttribute("data-dlq-status") || "";
  void loadDlqJobs(st);
});

// 详情 Tab 切换
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const tab = btn.getAttribute("data-tab");
    if (!tab) return;
    switchTab(tab);
  });
});

btnLoadImages.addEventListener("click", () => {
  allowExternalImages = true;
  renderSandboxHtml(currentMailHtml);
  btnLoadImages.textContent = "已允许加载外链图片";
  btnLoadImages.disabled = true;
});

btnReclassify.addEventListener("click", () => {
  if (selectedMailId) void reclassify(selectedMailId, btnReclassify);
});

// 键盘快捷键 (j: 下一封, k: 上一封, r: 刷新)
window.addEventListener("keydown", (e) => {
  if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
  if (currentView === "inbox") {
    if (e.key === "j") navigateMail(1);
    else if (e.key === "k") navigateMail(-1);
    else if (e.key === "r") void reloadMessages();
  }
});

// 启动初始化
void init();

async function init() {
  initTheme();
  try {
    await request("/v1/me");
    showApp();
    await switchNav("inbox");
    void updateDlqBadge();
  } catch {
    showLogin();
  }
}

function initTheme() {
  const saved = localStorage.getItem("flytrap_theme") || "dark";
  document.documentElement.setAttribute("data-theme", saved);
  themeIcon.textContent = saved === "dark" ? "☀️" : "🌙";
}

function toggleTheme() {
  const cur = document.documentElement.getAttribute("data-theme") || "dark";
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("flytrap_theme", next);
  themeIcon.textContent = next === "dark" ? "☀️" : "🌙";
}

async function signIn() {
  loginError.textContent = "";
  const btn = document.querySelector("#btn-login");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "正在进入...";
  }
  try {
    await request("/v1/login", {
      method: "POST",
      body: {
        username: document.querySelector("#username").value,
        password: document.querySelector("#password").value,
      },
    });
    document.querySelector("#password").value = "";
    showApp();
    await switchNav("inbox");
    void updateDlqBadge();
  } catch (err) {
    loginError.textContent = explain(err);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "进入控制台";
    }
  }
}

async function signOut() {
  try {
    await request("/v1/logout", { method: "POST", body: {} });
  } catch {
    // Session destroyed
  }
  showLogin();
}

function showLogin() {
  loginEl.hidden = false;
  loginEl.style.display = "flex";
  appEl.hidden = true;
  appEl.style.display = "none";
}

function showApp() {
  loginEl.hidden = true;
  loginEl.style.display = "none";
  appEl.hidden = false;
  appEl.style.display = "grid";
}

const SETTING_CATEGORIES = [
  { id: "prompts", icon: "🤖", title: "AI 提示词策略与模型", desc: "System Prompt 策略与模型 Key 池" },
  { id: "mailboxes", icon: "🛡️", title: "收件画像与蜜罐防线", desc: "受保护域名与诱饵邮箱属性" },
  { id: "stats", icon: "📊", title: "统计大盘与威胁态势", desc: "邮件捕获总量与威胁分类统计" },
  { id: "system", icon: "🖥️", title: "系统服务与运行健康", desc: "服务角色、端口监听与系统状态" },
];

// 视图切换
async function switchNav(view) {
  currentView = view;
  const navBtns = [navInboxBtn, navDlqBtn, navSettingsBtn];
  navBtns.forEach((b) => b?.classList.remove("active"));
  const viewPanels = [viewMail, viewDlq, viewPrompts, viewMailboxes, viewStats, viewSystem];
  viewPanels.forEach((p) => { if (p) p.hidden = true; });

  streamInboxHeader.hidden = true;
  streamDlqHeader.hidden = true;
  if (streamSettingsHeader) streamSettingsHeader.hidden = true;
  noticeEl.textContent = "";
  listEl.replaceChildren();
  moreBtn.hidden = true;

  if (view === "inbox") {
    navInboxBtn?.classList.add("active");
    streamInboxHeader.hidden = false;
    viewMail.hidden = false;
    await reloadMessages();
  } else if (view === "dlq") {
    navDlqBtn?.classList.add("active");
    streamDlqHeader.hidden = false;
    viewDlq.hidden = false;
    await loadDlqJobs();
  } else if (view === "settings") {
    navSettingsBtn?.classList.add("active");
    if (streamSettingsHeader) streamSettingsHeader.hidden = false;
    renderSettingsStream();
    await switchSettingCategory(currentSettingCategory);
  }
}

function renderSettingsStream() {
  listEl.replaceChildren();
  for (const cat of SETTING_CATEGORIES) {
    const item = document.createElement("div");
    item.className = "settings-nav-item";
    if (cat.id === currentSettingCategory) item.classList.add("active");

    const icon = document.createElement("span");
    icon.className = "settings-nav-icon";
    icon.textContent = cat.icon;

    const textWrap = document.createElement("div");
    textWrap.className = "settings-nav-text";

    const title = document.createElement("p");
    title.className = "settings-nav-title";
    title.textContent = cat.title;

    const desc = document.createElement("p");
    desc.className = "settings-nav-desc";
    desc.textContent = cat.desc;

    textWrap.append(title, desc);
    item.append(icon, textWrap);
    item.addEventListener("click", () => void switchSettingCategory(cat.id));
    listEl.append(item);
  }
}

async function switchSettingCategory(catId) {
  currentSettingCategory = catId;
  const items = listEl.querySelectorAll(".settings-nav-item");
  items.forEach((it, idx) => {
    it.classList.toggle("active", SETTING_CATEGORIES[idx]?.id === catId);
  });

  const settingPanels = [viewPrompts, viewMailboxes, viewStats, viewSystem];
  settingPanels.forEach((p) => { if (p) p.hidden = true; });

  if (catId === "prompts") {
    viewPrompts.hidden = false;
    await loadPromptsView();
  } else if (catId === "mailboxes") {
    viewMailboxes.hidden = false;
    await loadMailboxesView();
  } else if (catId === "stats") {
    viewStats.hidden = false;
    await loadStatsView();
  } else if (catId === "system") {
    viewSystem.hidden = false;
    await loadSystemView();
  }
}

async function loadSystemView() {
  try {
    const health = await request("/healthz");
    const me = await request("/v1/me");
    const sysUser = document.querySelector("#sys-user");
    const sysRoles = document.querySelector("#sys-roles");
    const sysDb = document.querySelector("#sys-db");
    if (sysUser) sysUser.textContent = me.user || "admin";
    if (sysRoles) sysRoles.textContent = (health.roles || []).join(", ") || "smtp, worker, api";
    if (sysDb) sysDb.textContent = health.db === "ok" ? "SQLite (WAL 模式正常)" : "异常";
  } catch (err) {
    noticeEl.textContent = explain(err);
  }
}

// ==================== 收件箱模块 ====================

async function reloadMessages() {
  cursor = null;
  listEl.replaceChildren();
  noticeEl.textContent = "";
  await loadMessagesPage(true);
}

async function loadMessagesPage(replace) {
  const params = new URLSearchParams();
  if (labelInput.value) params.set("label", labelInput.value);
  const q = queryInput.value.trim();
  if (q) params.set("q", q);
  params.set("limit", "40");
  if (!replace && cursor) params.set("cursor", cursor);

  try {
    const page = await request("/v1/messages?" + params.toString());
    const items = Array.isArray(page.items) ? page.items : [];
    if (replace) currentMessages = items;
    else currentMessages = currentMessages.concat(items);

    if (replace && items.length === 0) {
      noticeEl.textContent = "没有匹配的邮件";
    }

    for (const item of items) {
      listEl.append(createMailListItem(item));
    }
    cursor = page.nextCursor || null;
    moreBtn.hidden = !cursor;

    // 如果还没有选中邮件且有数据，默认自动选择第一封
    if (replace && items.length > 0 && !selectedMailId) {
      void selectMail(items[0].id);
    }
  } catch (err) {
    if (err && err.status === 401) {
      showLogin();
      return;
    }
    noticeEl.textContent = explain(err);
  }
}

function createMailListItem(item) {
  const card = document.createElement("div");
  card.className = "mail-item";
  card.dataset.id = item.id;
  if (item.id === selectedMailId) card.classList.add("selected");

  const line1 = document.createElement("div");
  line1.className = "item-line1";

  const from = document.createElement("span");
  from.className = "item-from";
  from.textContent = item.from || item.envelopeFrom || "未知发件人";

  const time = document.createElement("span");
  time.className = "item-time";
  time.textContent = formatShortTime(item.receivedAt);

  line1.append(from, time);

  const subject = document.createElement("p");
  subject.className = "item-subject";
  subject.textContent = item.subject || "(无主题)";

  const line3 = document.createElement("div");
  line3.className = "item-line3";

  const snippet = document.createElement("span");
  snippet.className = "item-snippet";
  snippet.textContent = item.summary || "";

  const tag = document.createElement("span");
  tag.className = "verdict-tag";
  tag.dataset.label = item.label || "none";
  const confText = item.manualOverride
    ? " (人工修正)"
    : (typeof item.confidence === "number" ? ` ${Math.round(item.confidence * 100)}%` : "");
  tag.textContent = (LABEL_NAMES[item.label] || item.label || "未分类") + confText;

  line3.append(snippet, tag);

  card.append(line1, subject, line3);
  card.addEventListener("click", () => void selectMail(item.id));
  return card;
}

async function selectMail(id) {
  selectedMailId = id;
  allowExternalImages = false;
  btnLoadImages.textContent = "允许加载外链图片";
  btnLoadImages.disabled = false;

  // 默认折叠威胁指纹与外链
  if (sectionSignals) sectionSignals.open = false;
  if (sectionUrls) sectionUrls.open = false;

  // 更新左侧列表的高亮状态
  document.querySelectorAll(".mail-item").forEach((el) => {
    if (el.dataset.id === id) el.classList.add("selected");
    else el.classList.remove("selected");
  });

  mailEmptyEl.hidden = true;
  mailDetailEl.hidden = false;

  try {
    const detail = await request("/v1/messages/" + encodeURIComponent(id));
    if (detailSubject) detailSubject.textContent = detail.subject || "(无主题)";
    if (detailFrom) detailFrom.textContent = detail.from || detail.envelopeFrom || "未知发件人";
    if (detailTo) detailTo.textContent = Array.isArray(detail.envelopeTo) ? detail.envelopeTo.join(", ") : detail.envelopeTo || "";
    if (detailTime) detailTime.textContent = formatFullTime(detail.receivedAt);

    const label = detail.aiResult?.label || detail.label || "gray";
    if (detailVerdictSelect) {
      detailVerdictSelect.value = label;
      detailVerdictSelect.dataset.label = label;
    }
    const confidence = typeof detail.aiResult?.confidence === "number" ? detail.aiResult.confidence : 0;
    if (detailModelVerdict) {
      if (detail.aiResult?.manualOverride) {
        const origName = LABEL_NAMES[detail.aiResult.originalLabel] || detail.aiResult.originalLabel || "未分类";
        const origConf = typeof detail.aiResult.originalConfidence === "number" ? ` ${Math.round(detail.aiResult.originalConfidence * 100)}%` : "";
        detailModelVerdict.textContent = `(模型初判: ${origName}${origConf} · 人工修正)`;
      } else {
        detailModelVerdict.textContent = `(模型判定 ${Math.round(confidence * 100)}%)`;
      }
    }

    verdictBar.style.width = Math.round(confidence * 100) + "%";
    verdictPercent.textContent = Math.round(confidence * 100) + "%";
    detailSummary.textContent = detail.aiResult?.summary || "尚未生成 AI 研判摘要";

    // 威胁信号指纹
    signalsList.replaceChildren();
    const signals = detail.aiResult?.signals || [];
    if (signalsCountEl) signalsCountEl.textContent = String(signals.length);
    if (signals.length === 0) {
      const emptySig = document.createElement("span");
      emptySig.className = "text-dim";
      emptySig.textContent = "无高危命中指纹";
      signalsList.append(emptySig);
    } else {
      for (const sig of signals) {
        const chip = document.createElement("div");
        chip.className = "signal-chip";
        const sName = document.createElement("span");
        sName.className = "signal-name";
        sName.textContent = sig.name;
        const sVal = document.createElement("span");
        sVal.className = "signal-val";
        sVal.textContent = sig.value;
        chip.append(sName, sVal);
        signalsList.append(chip);
      }
    }

    // 正文提取外链
    urlsList.replaceChildren();
    const urls = detail.parsed?.urls || [];
    urlCountEl.textContent = String(urls.length);
    if (urls.length === 0) {
      const emptyUrl = document.createElement("span");
      emptyUrl.className = "text-dim";
      emptyUrl.textContent = "未提取到外部超链接";
      urlsList.append(emptyUrl);
    } else {
      for (const u of urls) {
        const uItem = document.createElement("div");
        uItem.className = "url-item";
        const uLink = document.createElement("a");
        uLink.href = u;
        uLink.target = "_blank";
        uLink.rel = "noopener noreferrer";
        uLink.textContent = u;
        uItem.append(uLink);
        urlsList.append(uItem);
      }
    }

    // 附件清单
    attachmentsList.replaceChildren();
    const attachments = detail.attachments || [];
    attachmentCountEl.textContent = String(attachments.length);
    if (attachments.length === 0) {
      const emptyAtt = document.createElement("span");
      emptyAtt.className = "text-dim";
      emptyAtt.textContent = "无随信附件";
      attachmentsList.append(emptyAtt);
    } else {
      for (const att of attachments) {
        const attItem = document.createElement("div");
        attItem.className = "attachment-item";
        const attName = document.createElement("span");
        attName.textContent = att.filename || att.sha256;
        const attDl = document.createElement("a");
        attDl.className = "btn-sm";
        attDl.href = "/v1/attachments/" + encodeURIComponent(att.sha256);
        attDl.target = "_blank";
        attDl.download = att.filename || att.sha256;
        attDl.textContent = "下载 (" + formatBytes(att.sizeBytes) + ")";
        attItem.append(attName, attDl);
        attachmentsList.append(attItem);
      }
    }

    // 下载 EML 链接
    btnDownloadEml.href = "/v1/messages/" + encodeURIComponent(id) + "/raw";
    btnDownloadEml.setAttribute("download", `${detail.sha256 || id}.eml`);

    // 邮件来源鉴权标签
    authChips.replaceChildren();
    if (detail.authResult) {
      const auth = detail.authResult;
      authChips.append(createAuthChip("SPF", auth.spf));
      authChips.append(createAuthChip("DKIM", auth.dkim));
      authChips.append(createAuthChip("DMARC", auth.dmarc));
    }

    // 纯文本正文与原始头
    plainTextBody.textContent = detail.parsed?.text || "(正文为空)";
    rawHeaders.textContent = formatRawHeaders(detail);

    // 加载 HTML
    void loadMailHtml(id);
  } catch (err) {
    console.error("selectMail error:", err);
    if (detailSubject) detailSubject.textContent = "无法加载邮件详情";
    if (detailSummary) detailSummary.textContent = explain(err);
  }
}

async function loadMailHtml(id) {
  try {
    const res = await request("/v1/messages/" + encodeURIComponent(id) + "/html");
    currentMailHtml = res.html || "";
    renderSandboxHtml(currentMailHtml);
  } catch {
    currentMailHtml = "<p style='color:#888;padding:20px'>该邮件无 HTML 格式内容或解析失败</p>";
    renderSandboxHtml(currentMailHtml);
  }
}

function renderSandboxHtml(html) {
  const csp = allowExternalImages
    ? "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src * data: cid:; font-src data:;\">"
    : "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data: cid:; font-src data:;\">";
  const doc = `<!DOCTYPE html><html><head><meta charset="utf-8">${csp}<style>body{font-family:sans-serif;font-size:14px;line-height:1.6;color:#111;padding:16px;word-break:break-word;}img{max-width:100%;height:auto;}</style></head><body>${html}</body></html>`;
  mailSandbox.setAttribute("srcdoc", doc);
}

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll(".tab-btn").forEach((b) => {
    if (b.getAttribute("data-tab") === tab) b.classList.add("active");
    else b.classList.remove("active");
  });
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
  const activePanel = document.querySelector("#panel-" + tab);
  if (activePanel) activePanel.classList.add("active");
}

async function reclassify(id, button) {
  button.disabled = true;
  try {
    await request("/v1/messages/" + encodeURIComponent(id) + "/reclassify", { method: "POST", body: {} });
    button.textContent = "已入队";
    setTimeout(() => {
      button.textContent = "重分类";
      button.disabled = false;
    }, 2000);
  } catch (err) {
    button.disabled = false;
    alert("触发重分类失败: " + explain(err));
  }
}

function navigateMail(delta) {
  if (currentMessages.length === 0) return;
  const idx = currentMessages.findIndex((m) => m.id === selectedMailId);
  const nextIdx = Math.max(0, Math.min(currentMessages.length - 1, idx + delta));
  if (nextIdx !== idx) {
    void selectMail(currentMessages[nextIdx].id);
  }
}

// ==================== 死信队列 (DLQ) 模块 ====================

async function loadDlqJobs(statusFilter = "") {
  listEl.replaceChildren();
  noticeEl.textContent = "加载死信与失败任务中...";
  try {
    const url = statusFilter ? "/v1/jobs?status=" + encodeURIComponent(statusFilter) : "/v1/jobs";
    const res = await request(url);
    currentJobs = Array.isArray(res.items) ? res.items : [];
    noticeEl.textContent = currentJobs.length === 0 ? "队列当前无异常任务" : "";

    for (const job of currentJobs) {
      listEl.append(createDlqJobItem(job));
    }

    if (currentJobs.length > 0 && !selectedJobId) {
      selectDlqJob(currentJobs[0].id);
    }
  } catch (err) {
    noticeEl.textContent = explain(err);
  }
}

function createDlqJobItem(job) {
  const item = document.createElement("div");
  item.className = "dlq-job-item";
  item.dataset.id = job.id;
  if (job.id === selectedJobId) item.classList.add("selected");

  const l1 = document.createElement("div");
  l1.className = "item-line1";
  const typeTag = document.createElement("span");
  typeTag.className = "verdict-tag";
  typeTag.dataset.label = job.status === "dead" ? "phish" : "spam";
  typeTag.textContent = `${job.type} (${job.status})`;

  const attempts = document.createElement("span");
  attempts.className = "item-time";
  attempts.textContent = `重试 ${job.attempts}/${job.maxAttempts}`;
  l1.append(typeTag, attempts);

  const title = document.createElement("p");
  title.className = "item-subject";
  title.textContent = job.messageSubject || `Message ID: ${job.messageId || "none"}`;

  const errSnippet = document.createElement("span");
  errSnippet.className = "dlq-error-snippet";
  errSnippet.textContent = job.lastError || "无报错文本";

  item.append(l1, title, errSnippet);
  item.addEventListener("click", () => selectDlqJob(job.id));
  return item;
}

function selectDlqJob(id) {
  selectedJobId = id;
  document.querySelectorAll(".dlq-job-item").forEach((el) => {
    if (el.dataset.id === id) el.classList.add("selected");
    else el.classList.remove("selected");
  });

  const job = currentJobs.find((j) => j.id === id);
  const detailBox = document.querySelector("#dlq-detail-content");
  detailBox.replaceChildren();

  if (!job) return;

  const retryBtn = document.querySelector("#btn-dlq-single-retry");
  retryBtn.hidden = false;
  retryBtn.onclick = () => void retrySingleJob(job.id);

  const grid = document.createElement("div");
  grid.className = "meta-grid";
  grid.append(createMetaItem("任务 ID", job.id));
  grid.append(createMetaItem("任务类型", job.type));
  grid.append(createMetaItem("关联邮件", job.messageSubject || job.messageId || "无"));
  grid.append(createMetaItem("状态", `${job.status} (失败 ${job.attempts}/${job.maxAttempts} 次)`));
  grid.append(createMetaItem("入队时间", job.createdAt || ""));
  grid.append(createMetaItem("下次执行", job.runAfter || ""));

  const errTitle = document.createElement("h4");
  errTitle.textContent = "最后抛出的异常报错";
  errTitle.style.marginTop = "16px";

  const pre = document.createElement("pre");
  pre.className = "code-block";
  pre.textContent = job.lastError || "无详细异常堆栈";

  detailBox.append(grid, errTitle, pre);
}

async function retrySingleJob(id) {
  try {
    await request("/v1/jobs/" + encodeURIComponent(id) + "/retry", { method: "POST", body: {} });
    alert("该任务已成功重入队，Worker 正在调度执行！");
    await loadDlqJobs();
    void updateDlqBadge();
  } catch (err) {
    alert("任务重试失败: " + explain(err));
  }
}

async function retryAllDead() {
  if (!confirm("确定要将所有死信/失败任务全部重入队重试吗？")) return;
  try {
    const res = await request("/v1/jobs/retry-all", { method: "POST", body: {} });
    alert(`成功救回 ${res.count || 0} 个死信任务！`);
    await loadDlqJobs();
    void updateDlqBadge();
  } catch (err) {
    alert("批量重试失败: " + explain(err));
  }
}

async function updateDlqBadge() {
  try {
    const res = await request("/v1/jobs?status=dead");
    const count = Array.isArray(res.items) ? res.items.length : 0;
    if (count > 0) {
      badgeDlq.hidden = false;
      badgeDlq.textContent = String(count);
    } else {
      badgeDlq.hidden = true;
    }
  } catch {
    // ignore
  }
}

// ==================== AI 策略与提示词管理 ====================

async function loadPromptsView() {
  listEl.replaceChildren();
  try {
    const statusRes = await request("/v1/ai/status");
    document.querySelector("#ai-model-name").textContent = statusRes.model || "-";
    document.querySelector("#ai-provider-name").textContent = statusRes.classifier || "-";
    document.querySelector("#ai-key-count").textContent = String(statusRes.keyCount ?? 0);

    const promptsRes = await request("/v1/prompts");
    const items = promptsRes.items || [];
    for (const p of items) {
      const card = document.createElement("div");
      card.className = "mail-item selected";
      const title = document.createElement("p");
      title.className = "item-from";
      title.textContent = p.name;
      card.append(title);
      listEl.append(card);
    }

    const promptId = promptsRes.defaultPromptId || "classify-v1";
    const detail = await request("/v1/prompts/" + encodeURIComponent(promptId));
    document.querySelector("#prompt-editor").value = detail.content || "";

    document.querySelector("#btn-save-prompt").onclick = async () => {
      const newContent = document.querySelector("#prompt-editor").value;
      try {
        await request("/v1/prompts/" + encodeURIComponent(promptId), {
          method: "PUT",
          body: { content: newContent },
        });
        alert("提示词策略已成功更新并热重载生效！");
      } catch (err) {
        alert("保存提示词失败: " + explain(err));
      }
    };
  } catch (err) {
    noticeEl.textContent = explain(err);
  }
}

// ==================== 收件画像模块 ====================

async function loadMailboxesView() {
  listEl.replaceChildren();
  try {
    const res = await request("/v1/mailbox-history");
    const items = res.items || [];
    const tbody = document.querySelector("#mailboxes-tbody");
    tbody.replaceChildren();

    for (const item of items) {
      const tr = document.createElement("tr");
      const tdAddr = document.createElement("td");
      tdAddr.textContent = `${item.localpart}@${item.domain}`;
      const tdFirst = document.createElement("td");
      tdFirst.textContent = formatShortTime(item.firstSeen);
      const tdLast = document.createElement("td");
      tdLast.textContent = formatShortTime(item.lastSeen);
      const tdNotes = document.createElement("td");
      tdNotes.textContent = item.notes || "通用";
      tr.append(tdAddr, tdFirst, tdLast, tdNotes);
      tbody.append(tr);
    }

    document.querySelector("#mailbox-form").onsubmit = async (e) => {
      e.preventDefault();
      try {
        await request("/v1/mailbox-history", {
          method: "POST",
          body: {
            domain: document.querySelector("#mb-domain").value,
            localpart: document.querySelector("#mb-localpart").value,
            notes: document.querySelector("#mb-notes").value,
          },
        });
        alert("收件画像已保存！");
        await loadMailboxesView();
      } catch (err) {
        alert("保存画像失败: " + explain(err));
      }
    };
  } catch (err) {
    noticeEl.textContent = explain(err);
  }
}

// ==================== 统计报表模块 ====================

async function loadStatsView() {
  listEl.replaceChildren();
  try {
    const res = await request("/v1/stats");
    const total = res.total || {};
    document.querySelector("#stat-total-count").textContent = String(
      (total.legit || 0) + (total.spam || 0) + (total.phish || 0) + (total.malware || 0) + (total.gray || 0) + (total.unlabeled || 0)
    );
    document.querySelector("#stat-phish-count").textContent = String(total.phish || 0);
    document.querySelector("#stat-malware-count").textContent = String(total.malware || 0);
    document.querySelector("#stat-spam-count").textContent = String(total.spam || 0);
    document.querySelector("#stat-legit-count").textContent = String(total.legit || 0);
  } catch (err) {
    noticeEl.textContent = explain(err);
  }
}

// ==================== 通用网络与工具函数 ====================

async function request(url, options = {}) {
  const headers = new Headers();
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
    headers.set("x-csrf-token", await fetchCsrf());
  }
  const response = await fetch(url, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    credentials: "same-origin",
  });
  const raw = await response.text();
  let data = null;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
  }
  if (!response.ok) {
    const error = new Error("request_failed");
    error.status = response.status;
    throw error;
  }
  return data || {};
}

async function fetchCsrf() {
  const response = await fetch("/v1/csrf", { credentials: "same-origin" });
  if (!response.ok) {
    const error = new Error("csrf");
    error.status = response.status;
    throw error;
  }
  const data = await response.json();
  return data.token;
}

function explain(err) {
  if (err && err.status === 401) return "用户名或口令不正确";
  if (err && err.status === 429) return "请求过于频繁，请稍后再试";
  if (err && err.status === 403) return "缺少有效 CSRF 令牌";
  return "操作失败，请重试";
}

function formatShortTime(val) {
  if (!val) return "";
  const d = new Date(val);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function formatFullTime(val) {
  if (!val) return "";
  return new Date(val).toLocaleString();
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function createAuthChip(label, status) {
  const chip = document.createElement("span");
  chip.className = "auth-chip " + (status === "pass" ? "pass" : "fail");
  chip.textContent = `${label}: ${status || "none"}`;
  return chip;
}

function createMetaItem(label, val) {
  const item = document.createElement("div");
  item.className = "meta-item";
  const l = document.createElement("span");
  l.className = "meta-label";
  l.textContent = label + "：";
  const v = document.createElement("span");
  v.className = "meta-val";
  v.textContent = val;
  item.append(l, v);
  return item;
}

function formatRawHeaders(detail) {
  const lines = [];
  if (detail.messageId) lines.push(`Message-ID: ${detail.messageId}`);
  if (detail.from) lines.push(`From: ${detail.from}`);
  if (detail.envelopeFrom) lines.push(`Return-Path: <${detail.envelopeFrom}>`);
  if (detail.envelopeTo) lines.push(`Delivered-To: ${Array.isArray(detail.envelopeTo) ? detail.envelopeTo.join(", ") : detail.envelopeTo}`);
  if (detail.subject) lines.push(`Subject: ${detail.subject}`);
  if (detail.receivedAt) lines.push(`Date: ${new Date(detail.receivedAt).toUTCString()}`);
  if (detail.smtpMeta) lines.push(`X-Flytrap-Smtp: ${JSON.stringify(detail.smtpMeta)}`);
  return lines.join("\n");
}

function debounce(fn, ms) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}
