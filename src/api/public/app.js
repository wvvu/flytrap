const LABELS = ["legit", "spam", "phish", "malware", "gray", "unsolicited-admin"];
const STATUSES = ["received", "authed", "parsed", "classified", "notified", "error"];

const loginView = document.querySelector("#login");
const mailView = document.querySelector("#mail");
const logoutButton = document.querySelector("#logout");
const listEl = document.querySelector("#list");
const moreButton = document.querySelector("#more");
const noticeEl = document.querySelector("#notice");
const loginError = document.querySelector("#login-error");
const labelSelect = document.querySelector("#label");
const statusSelect = document.querySelector("#status");
const queryInput = document.querySelector("#q");

let cursor = null;

fillSelect(labelSelect, "全部标签", LABELS);
fillSelect(statusSelect, "全部状态", STATUSES);

document.querySelector("#login-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void signIn();
});
document.querySelector("#filters").addEventListener("submit", (event) => {
  event.preventDefault();
  void reload();
});
moreButton.addEventListener("click", () => {
  void loadPage(false);
});
logoutButton.addEventListener("click", () => {
  void signOut();
});

void boot();

async function boot() {
  try {
    await request("/v1/me");
    showMail();
    await reload();
  } catch {
    showLogin();
  }
}

async function signIn() {
  loginError.textContent = "";
  try {
    await request("/v1/login", {
      method: "POST",
      body: {
        username: document.querySelector("#username").value,
        password: document.querySelector("#password").value,
      },
    });
    document.querySelector("#password").value = "";
    showMail();
    await reload();
  } catch (err) {
    loginError.textContent = explain(err);
  }
}

async function signOut() {
  try {
    await request("/v1/logout", { method: "POST", body: {} });
  } catch {
    // The session is already gone. Show the login form either way.
  }
  showLogin();
}

async function reload() {
  cursor = null;
  listEl.replaceChildren();
  noticeEl.textContent = "";
  await loadPage(true);
}

async function loadPage(replace) {
  const params = new URLSearchParams();
  if (labelSelect.value) params.set("label", labelSelect.value);
  if (statusSelect.value) params.set("status", statusSelect.value);
  const q = queryInput.value.trim();
  if (q) params.set("q", q);
  params.set("limit", "50");
  if (!replace && cursor) params.set("cursor", cursor);
  try {
    const page = await request("/v1/messages?" + params.toString());
    const items = Array.isArray(page.items) ? page.items : [];
    if (replace && items.length === 0) noticeEl.textContent = "没有邮件";
    for (const item of items) listEl.append(renderItem(item));
    cursor = page.nextCursor || null;
    moreButton.hidden = !cursor;
  } catch (err) {
    if (err.status === 401) {
      showLogin();
      return;
    }
    noticeEl.textContent = explain(err);
  }
}

async function reclassify(id, button) {
  button.disabled = true;
  try {
    await request("/v1/messages/" + encodeURIComponent(id) + "/reclassify", { method: "POST", body: {} });
    button.textContent = "已入队";
  } catch (err) {
    button.disabled = false;
    noticeEl.textContent = explain(err);
  }
}

function renderItem(item) {
  const article = document.createElement("article");
  article.className = "item";

  const top = document.createElement("div");
  top.className = "item-top";
  const time = document.createElement("time");
  time.dateTime = typeof item.receivedAt === "string" ? item.receivedAt : "";
  time.textContent = typeof item.receivedAt === "string" ? new Date(item.receivedAt).toLocaleString() : "";
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.dataset.label = typeof item.label === "string" ? item.label : "none";
  const confidence = typeof item.confidence === "number" ? " " + Math.round(item.confidence * 100) + "%" : "";
  badge.textContent = typeof item.label === "string" ? item.label + confidence : "未分类";
  const status = document.createElement("span");
  status.className = "status";
  status.textContent = typeof item.status === "string" ? item.status : "";
  top.append(time, badge, status);

  const from = document.createElement("p");
  from.className = "from";
  from.textContent = text(item.from) || text(item.envelopeFrom) || "未知发件人";

  const subject = document.createElement("h2");
  subject.textContent = text(item.subject) || "(无主题)";

  const tags = document.createElement("div");
  tags.className = "tags";
  const tagList = Array.isArray(item.tags) ? item.tags.filter((tag) => typeof tag === "string") : [];
  if (tagList.length === 0) {
    const empty = document.createElement("span");
    empty.textContent = "无标签";
    tags.append(empty);
  } else {
    for (const tag of tagList) {
      const chip = document.createElement("span");
      chip.textContent = tag;
      tags.append(chip);
    }
  }

  const summary = document.createElement("p");
  summary.className = "summary";
  summary.textContent = text(item.summary);

  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "重分类";
  button.addEventListener("click", () => {
    void reclassify(item.id, button);
  });

  article.append(top, from, subject, tags, summary, button);
  return article;
}

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

function fillSelect(select, allLabel, values) {
  const all = document.createElement("option");
  all.value = "";
  all.textContent = allLabel;
  select.append(all);
  for (const value of values) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.append(option);
  }
}

function showLogin() {
  loginView.hidden = false;
  mailView.hidden = true;
  logoutButton.hidden = true;
  listEl.replaceChildren();
}

function showMail() {
  loginView.hidden = true;
  mailView.hidden = false;
  logoutButton.hidden = false;
  loginError.textContent = "";
}

function explain(err) {
  if (err && err.status === 401) return "用户名或口令不正确";
  if (err && err.status === 429) return "尝试过多，请稍后再试";
  if (err && err.status === 403) return "缺少 CSRF 令牌";
  return "请求失败";
}

function text(value) {
  return typeof value === "string" ? value : "";
}
