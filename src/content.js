// Discogs → TWD : 掃描頁面價格，換算成台幣後貼在原價旁邊
(function () {
  "use strict";

  const DEFAULTS = {
    enabled: true,
    customsRate: 0,        // 關稅率 (%)，唱片類多為低/零關稅，可自行調整
    businessTaxRate: 5,    // 營業稅率 (%)
    dutyFreeThreshold: 2000, // 完稅價格 (NT$) 在此以下免徵關稅及營業稅
    showBreakdown: true,   // 滑鼠移上去顯示明細
  };

  let SETTINGS = { ...DEFAULTS };
  let RATES = null; // { table, date, source }

  // ---- 幣別/金額解析 -------------------------------------------------------

  function detectCurrency(str) {
    if (/US\s?\$/.test(str)) return "USD";
    if (/CA\s?\$/.test(str)) return "CAD";
    if (/A\s?\$/.test(str)) return "AUD";
    if (/NZ\s?\$/.test(str)) return "NZD";
    if (/HK\s?\$/.test(str)) return "HKD";
    if (/R\s?\$/.test(str)) return "BRL";
    if (/MX\s?\$/.test(str)) return "MXN";
    if (/€/.test(str)) return "EUR";
    if (/£/.test(str)) return "GBP";
    if (/¥/.test(str)) return "JPY";
    if (/₩/.test(str)) return "KRW";
    if (/zł/i.test(str)) return "PLN";
    if (/R\$|reais/i.test(str)) return "BRL";
    if (/CHF/i.test(str)) return "CHF";
    if (/\$/.test(str)) return "USD";
    const code = str.match(/\b([A-Z]{3})\b/);
    if (code) return code[1];
    return null;
  }

  // 解析金額，兼容 "1,234.56"(美式) 與 "1.234,56"(歐式)
  function parseAmount(str) {
    const s0 = String(str).replace(/[^\d.,]/g, "");
    if (!s0) return NaN;
    let s = s0;
    const lastComma = s.lastIndexOf(",");
    const lastDot = s.lastIndexOf(".");
    if (lastComma > -1 && lastDot > -1) {
      if (lastComma > lastDot) {
        s = s.replace(/\./g, "").replace(",", "."); // 逗號當小數點
      } else {
        s = s.replace(/,/g, ""); // 逗號當千分位
      }
    } else if (lastComma > -1) {
      const after = s.length - lastComma - 1;
      s = after === 1 || after === 2 ? s.replace(",", ".") : s.replace(/,/g, "");
    }
    return parseFloat(s);
  }

  // 從元素讀出 {currency, value}，優先用 Discogs 的 data 屬性
  function readPrice(el) {
    if (!el) return null;
    const cur = el.dataset && el.dataset.currency ? el.dataset.currency.toUpperCase() : null;
    let val = el.dataset && el.dataset.pricevalue != null ? parseFloat(el.dataset.pricevalue) : NaN;
    const text = el.textContent || "";
    if (!Number.isFinite(val)) val = parseAmount(text);
    const currency = cur || detectCurrency(text);
    if (!currency || !Number.isFinite(val)) return null;
    return { currency, value: val };
  }

  // ---- 換算與稅金估算 ------------------------------------------------------

  function toTWD(amount, currency) {
    if (currency === "TWD") return amount;
    const t = RATES && RATES.table;
    if (!t || !t.TWD || !t[currency]) return null;
    return amount * (t.TWD / t[currency]);
  }

  // 回傳台幣明細，找不到匯率回 null
  function computeTWD(itemPrice, shipPrice) {
    const itemTWD = toTWD(itemPrice.value, itemPrice.currency);
    if (itemTWD == null) return null;
    let shipTWD = 0;
    let shipKnown = false;
    if (shipPrice) {
      const s = toTWD(shipPrice.value, shipPrice.currency);
      if (s != null) {
        shipTWD = s;
        shipKnown = true;
      }
    }
    const cif = itemTWD + shipTWD; // 完稅價格估算（商品＋運費）
    let customs = 0;
    let vat = 0;
    if (cif > SETTINGS.dutyFreeThreshold) {
      customs = cif * (SETTINGS.customsRate / 100);
      vat = (cif + customs) * (SETTINGS.businessTaxRate / 100);
    }
    const total = cif + customs + vat;
    return { itemTWD, shipTWD, shipKnown, customs, vat, total, taxFree: cif <= SETTINGS.dutyFreeThreshold };
  }

  // ---- 注入畫面 ------------------------------------------------------------

  const ntd = (n) => "NT$" + Math.round(n).toLocaleString("en-US");

  function buildBadge(r) {
    const badge = document.createElement("span");
    badge.className = "dtwd-badge";
    badge.textContent = "≈ " + ntd(r.total);
    if (SETTINGS.showBreakdown) {
      const lines = [
        "商品 " + ntd(r.itemTWD),
        r.shipKnown ? "運費 " + ntd(r.shipTWD) : "運費 未列於頁面",
        r.taxFree
          ? "稅金 免徵（完稅價 ≤ " + ntd(SETTINGS.dutyFreeThreshold) + "）"
          : "關稅 " + ntd(r.customs) + " ＋ 營業稅 " + ntd(r.vat),
        "── 合計 " + ntd(r.total) + " （估算）",
      ];
      badge.title = lines.join("\n");
    }
    return badge;
  }

  function scopeOf(el) {
    return (
      el.closest(".item_price, tr, li, .shortcut_navigable, .mpitems, .listing_block") ||
      el.parentElement
    );
  }

  function process(root) {
    if (!SETTINGS.enabled || !RATES) return;
    const priceEls = root.querySelectorAll(".price");
    priceEls.forEach((el) => {
      if (el.dataset.dtwdDone === "1") return;
      el.dataset.dtwdDone = "1";

      const item = readPrice(el);
      if (!item || item.currency === "TWD") return;

      // 只讀頁面顯示的運費，找不到就當未列（不估算）
      const scope = scopeOf(el);
      let ship = null;
      if (scope) {
        const shipEl = scope.querySelector(".item_shipping, .shipping, [data-shipping-pricevalue]");
        if (shipEl && shipEl !== el) {
          const sp = readPrice(shipEl);
          if (sp && Number.isFinite(sp.value)) ship = sp;
        }
      }

      const r = computeTWD(item, ship);
      if (!r) return;

      const badge = buildBadge(r);
      el.insertAdjacentElement("afterend", badge);
    });
  }

  // ---- 動態頁面監看 --------------------------------------------------------

  let pending = false;
  function scheduleScan() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      process(document);
    });
  }

  function observe() {
    const obs = new MutationObserver(scheduleScan);
    obs.observe(document.documentElement, { childList: true, subtree: true });
  }

  // ---- 啟動 ----------------------------------------------------------------

  async function init() {
    const stored = await chrome.storage.sync.get(DEFAULTS);
    SETTINGS = { ...DEFAULTS, ...stored };
    if (!SETTINGS.enabled) return;

    chrome.runtime.sendMessage({ type: "getRates" }, (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.ok) return;
      RATES = { table: resp.table, date: resp.date, source: resp.source };
      process(document);
      observe();
    });

    // 設定變更後即時反映（重整頁面才會重算徽章，這裡先更新記憶體設定）
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync") return;
      for (const k of Object.keys(changes)) {
        if (k in SETTINGS) SETTINGS[k] = changes[k].newValue;
      }
    });
  }

  init();
})();
