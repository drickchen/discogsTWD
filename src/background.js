// Discogs → TWD : 匯率抓取與每日快取 (Manifest V3 service worker)
//
// 匯率表一律存成「相對 1 USD 的比率」(table[CUR] = 每 1 USD 等於多少 CUR)，
// 任一幣別換台幣： amountTWD = amount * table.TWD / table[CUR]

const PRIMARY_URL = "https://open.er-api.com/v6/latest/USD";
const FALLBACK_URL = "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json";

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

async function fetchPrimary() {
  const res = await fetch(PRIMARY_URL, { cache: "no-store" });
  if (!res.ok) throw new Error("primary http " + res.status);
  const data = await res.json();
  if (data.result !== "success" || !data.rates || !data.rates.TWD) {
    throw new Error("primary bad payload");
  }
  // rates 已是「每 1 USD = ? 該幣」，key 為大寫幣別碼
  return { table: data.rates, date: todayStr(), source: "open.er-api.com" };
}

async function fetchFallback() {
  const res = await fetch(FALLBACK_URL, { cache: "no-store" });
  if (!res.ok) throw new Error("fallback http " + res.status);
  const data = await res.json();
  const usd = data.usd;
  if (!usd || !usd.twd) throw new Error("fallback bad payload");
  const table = {};
  for (const k of Object.keys(usd)) table[k.toUpperCase()] = usd[k];
  return { table, date: todayStr(), source: "fawazahmed0/currency-api" };
}

async function fetchRates() {
  try {
    return await fetchPrimary();
  } catch (e) {
    return await fetchFallback();
  }
}

// 回傳快取的匯率，過期(非今日)或不存在則重新抓
async function getRates(force) {
  const cached = await chrome.storage.local.get(["dtwd_rates"]);
  const r = cached.dtwd_rates;
  if (!force && r && r.date === todayStr() && r.table && r.table.TWD) {
    return { ok: true, ...r, cached: true };
  }
  try {
    const fresh = await fetchRates();
    await chrome.storage.local.set({ dtwd_rates: fresh });
    return { ok: true, ...fresh, cached: false };
  } catch (e) {
    // 抓取失敗時，若有舊資料就先用舊的
    if (r && r.table && r.table.TWD) {
      return { ok: true, ...r, cached: true, stale: true, error: String(e) };
    }
    return { ok: false, error: String(e) };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "getRates") {
    getRates(false).then(sendResponse);
    return true; // async response
  }
  if (msg && msg.type === "refreshRates") {
    getRates(true).then(sendResponse);
    return true;
  }
});
