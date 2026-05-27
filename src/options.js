const DEFAULTS = {
  enabled: true,
  customsRate: 0,
  businessTaxRate: 5,
  dutyFreeThreshold: 2000,
  showBreakdown: true,
};

const FIELDS = {
  enabled: "checkbox",
  customsRate: "number",
  businessTaxRate: "number",
  dutyFreeThreshold: "number",
  showBreakdown: "checkbox",
};

function $(id) {
  return document.getElementById(id);
}

function load() {
  chrome.storage.sync.get(DEFAULTS, (s) => {
    for (const [id, type] of Object.entries(FIELDS)) {
      const el = $(id);
      if (type === "checkbox") el.checked = !!s[id];
      else el.value = s[id];
    }
  });
}

function save() {
  const out = {};
  for (const [id, type] of Object.entries(FIELDS)) {
    const el = $(id);
    if (type === "checkbox") out[id] = el.checked;
    else out[id] = Number(el.value);
  }
  chrome.storage.sync.set(out, () => {
    flash("已儲存。重整 Discogs 頁面即可套用新設定。");
  });
}

function flash(msg) {
  const s = $("status");
  s.textContent = msg;
  setTimeout(() => {
    if (s.textContent === msg) s.textContent = "";
  }, 4000);
}

function showRates(resp) {
  const info = $("rateInfo");
  if (!resp || !resp.ok) {
    info.textContent = "匯率取得失敗，請檢查網路後再試。";
    return;
  }
  const usdTwd = resp.table.TWD;
  const eurTwd = resp.table.EUR ? resp.table.TWD / resp.table.EUR : null;
  const parts = ["匯率日期 " + resp.date, "1 USD ≈ NT$" + usdTwd.toFixed(2)];
  if (eurTwd) parts.push("1 EUR ≈ NT$" + eurTwd.toFixed(2));
  parts.push("來源 " + resp.source);
  info.textContent = parts.join("｜");
}

$("save").addEventListener("click", save);

$("refresh").addEventListener("click", () => {
  flash("更新匯率中…");
  chrome.runtime.sendMessage({ type: "refreshRates" }, (resp) => {
    showRates(resp);
    flash(resp && resp.ok ? "匯率已更新。" : "更新失敗。");
  });
});

load();
chrome.runtime.sendMessage({ type: "getRates" }, showRates);
