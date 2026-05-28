// Discogs → TWD : 掃描頁面價格換算成台幣，並移除無法寄送台灣的商品
(function () {
  "use strict";

  const DEFAULTS = {
    enabled: true,
    customsRate: 0,           // 關稅率 (%)，唱片類多為低/零關稅，可自行調整
    businessTaxRate: 5,       // 營業稅率 (%)
    dutyFreeThreshold: 2000,  // 完稅價格 (NT$) 在此以下免徵關稅及營業稅
    showBreakdown: true,      // 滑鼠移上去顯示明細
    hideUnavailable: true,    // 移除/隱藏「Unavailable in Taiwan」的商品
    sortByTWD: true,          // 依台幣總價由低到高排序當頁列表
  };

  let SETTINGS = { ...DEFAULTS };
  let RATES = null; // { table, date, source }

  const IS_CHECKOUT = /\/sell\/(cart|order|checkout|payment|buyer)/i.test(location.pathname);

  // 同時抓「符號在前」(US$15.00 / €12) 與三碼幣別碼。NT$ 先排除避免把台幣再換一次
  const CUR_RE =
    /(NT\$|US\$|CA\$|A\$|NZ\$|HK\$|MX\$|R\$|CHF|[$€£¥₩])\s?(\d[\d.,]*\d|\d)/;

  // ---- 幣別/金額解析 -------------------------------------------------------

  function detectCurrency(str) {
    if (/NT\s?\$/.test(str)) return "TWD";
    if (/US\s?\$/.test(str)) return "USD";
    if (/CA\s?\$/.test(str)) return "CAD";
    if (/A\s?\$/.test(str)) return "AUD";
    if (/NZ\s?\$/.test(str)) return "NZD";
    if (/HK\s?\$/.test(str)) return "HKD";
    if (/MX\s?\$/.test(str)) return "MXN";
    if (/R\$|reais/i.test(str)) return "BRL";
    if (/€/.test(str)) return "EUR";
    if (/£/.test(str)) return "GBP";
    if (/¥/.test(str)) return "JPY";
    if (/₩/.test(str)) return "KRW";
    if (/zł/i.test(str)) return "PLN";
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
      if (lastComma > lastDot) s = s.replace(/\./g, "").replace(",", ".");
      else s = s.replace(/,/g, "");
    } else if (lastComma > -1) {
      const after = s.length - lastComma - 1;
      s = after === 1 || after === 2 ? s.replace(",", ".") : s.replace(/,/g, "");
    }
    return parseFloat(s);
  }

  // 從元素的 data 屬性或文字讀出 {currency, value}
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

  // 商品＋運費 → 含台灣進口稅估算的到手台幣，找不到匯率回 null
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
    return {
      itemTWD,
      shipTWD,
      shipKnown,
      customs,
      vat,
      total: cif + customs + vat,
      taxFree: cif <= SETTINGS.dutyFreeThreshold,
    };
  }

  // ---- 徽章 ----------------------------------------------------------------

  const ntd = (n) => "NT$" + Math.round(n).toLocaleString("en-US");

  function makeBadge(textContent, title) {
    const b = document.createElement("span");
    b.className = "dtwd-badge";
    b.textContent = textContent;
    if (title && SETTINGS.showBreakdown) b.title = title;
    return b;
  }

  function landedBadge(r) {
    const title = [
      "商品 " + ntd(r.itemTWD),
      r.shipKnown ? "運費 " + ntd(r.shipTWD) : "運費 未列於頁面",
      r.taxFree
        ? "稅金 免徵（完稅價 ≤ " + ntd(SETTINGS.dutyFreeThreshold) + "）"
        : "關稅 " + ntd(r.customs) + " ＋ 營業稅 " + ntd(r.vat),
      "── 合計 " + ntd(r.total) + " （估算）",
    ].join("\n");
    const b = makeBadge("≈ " + ntd(r.total), title);
    b.dataset.dtwdTotal = String(r.total);
    return b;
  }

  // ---- 列表/商品頁：以 .price 為主 -----------------------------------------

  function scopeOf(el) {
    return (
      el.closest(".item_price, tr, li, .shortcut_navigable, .mpitems, .listing_block") ||
      el.parentElement
    );
  }

  function scanListings(root) {
    root.querySelectorAll(".price").forEach((el) => {
      if (el.dataset.dtwdDone === "1") return;
      el.dataset.dtwdDone = "1";

      const item = readPrice(el);
      if (!item || item.currency === "TWD") return;

      // 只讀頁面顯示的運費，找不到當未列（不估算）
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
      if (r) el.insertAdjacentElement("afterend", landedBadge(r));
    });
  }

  // ---- 依台幣總價排序當頁列表 ---------------------------------------------

  function sortByTWD(root) {
    if (!SETTINGS.sortByTWD) return;
    // 把已算出台幣的列依 parent 分組
    const groups = new Map();
    root.querySelectorAll(".dtwd-badge[data-dtwd-total]").forEach((b) => {
      const row = b.closest("tr, li");
      if (!row || !row.parentElement) return;
      const total = parseFloat(b.dataset.dtwdTotal);
      if (!Number.isFinite(total)) return;
      const arr = groups.get(row.parentElement) || [];
      arr.push({ row, total });
      groups.set(row.parentElement, arr);
    });

    groups.forEach((items, parent) => {
      if (items.length < 2) return;
      const sorted = items.slice().sort((a, b) => a.total - b.total);
      // 取得目前這些列在 parent 內的實際順序
      const sortedSet = new Set(sorted.map((s) => s.row));
      const currentOrder = Array.from(parent.children).filter((c) => sortedSet.has(c));
      const targetOrder = sorted.map((s) => s.row);
      let same = true;
      for (let i = 0; i < targetOrder.length; i++) {
        if (currentOrder[i] !== targetOrder[i]) {
          same = false;
          break;
        }
      }
      if (same) return; // 順序已正確，避免觸發 observer
      // 重排：把已算出台幣的列照順序 append 到 parent 尾端，
      // 沒算出台幣的列保留在原本相對位置
      targetOrder.forEach((r) => parent.appendChild(r));
    });
  }

  // ---- 結帳/購物車頁：全頁掃描貨幣金額 -------------------------------------

  function looksLikeTotal(el) {
    const c = el.closest("tr, li, .row, .order-total, [class*='total' i]") || el.parentElement;
    const t = (c && c.textContent ? c.textContent : "").toLowerCase();
    return /total|總計|合計|grand/.test(t) && !/sub-?total|小計|item total/.test(t);
  }

  function collectTextNodes(root) {
    const nodes = [];
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentNode;
        if (!p) return NodeFilter.FILTER_REJECT;
        const tag = p.nodeName;
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEXTAREA" || tag === "OPTION")
          return NodeFilter.FILTER_REJECT;
        if (p.classList && p.classList.contains("dtwd-badge")) return NodeFilter.FILTER_REJECT;
        if (p.dataset && p.dataset.dtwdDone === "1") return NodeFilter.FILTER_REJECT;
        if (!n.nodeValue || !CUR_RE.test(n.nodeValue)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let cur;
    while ((cur = tw.nextNode())) nodes.push(cur);
    return nodes;
  }

  function scanCheckout(root) {
    collectTextNodes(root).forEach((node) => {
      const m = node.nodeValue.match(CUR_RE);
      if (!m) return;
      const currency = detectCurrency(m[1]);
      const value = parseAmount(m[2]);
      const parent = node.parentNode;
      if (!parent) return;
      parent.dataset && (parent.dataset.dtwdDone = "1");
      if (!currency || currency === "TWD" || !Number.isFinite(value)) return;

      let badge;
      if (parent.nodeType === 1 && looksLikeTotal(parent)) {
        const r = computeTWD({ currency, value }, null);
        if (!r) return;
        badge = landedBadge(r);
      } else {
        const twd = toTWD(value, currency);
        if (twd == null) return;
        badge = makeBadge("≈ " + ntd(twd), "匯率換算（未計進口稅）");
      }
      parent.insertBefore(badge, node.nextSibling);
    });
  }

  // ---- 移除無法寄送台灣的商品 ----------------------------------------------

  const UNAVAIL_RE =
    /(unavailable in (your country|taiwan))|(not available in (your country|taiwan))|((does not|doesn't|will not|won't|cannot|can't|unable to)\s+ship[^]*?\b(taiwan|your country))/i;

  function killListing(el) {
    const container =
      el.closest(
        "tr.shortcut_navigable, li.shortcut_navigable, .marketplace-item, .listing_block, .mp_listing, .card"
      ) || el.closest("tr, li");
    if (container && container.parentElement) {
      container.remove();
      return;
    }
    const block = el.closest("div, section, article") || el;
    block.style.display = "none";
  }

  function removeUnavailable(root) {
    if (!SETTINGS.hideUnavailable) return;
    const candidates = collectUnavailNodes(root);
    candidates.forEach((el) => killListing(el));
  }

  function collectUnavailNodes(root) {
    const out = [];
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const v = n.nodeValue;
        if (!v || !UNAVAIL_RE.test(v)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let cur;
    while ((cur = tw.nextNode())) if (cur.parentElement) out.push(cur.parentElement);
    return out;
  }

  // ---- 排程與監看 ----------------------------------------------------------

  function processAll() {
    if (!SETTINGS.enabled) return;
    removeUnavailable(document);
    if (!RATES) return;
    if (IS_CHECKOUT) {
      scanCheckout(document);
    } else {
      scanListings(document);
      sortByTWD(document);
    }
  }

  let pending = false;
  function scheduleScan() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      processAll();
    });
  }

  function observe() {
    new MutationObserver(scheduleScan).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  // ---- 啟動 ----------------------------------------------------------------

  async function init() {
    const stored = await chrome.storage.sync.get(DEFAULTS);
    SETTINGS = { ...DEFAULTS, ...stored };
    if (!SETTINGS.enabled) return;

    // 移除無法寄台灣的商品不需要等匯率，先跑
    removeUnavailable(document);
    observe();

    chrome.runtime.sendMessage({ type: "getRates" }, (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.ok) return;
      RATES = { table: resp.table, date: resp.date, source: resp.source };
      processAll();
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync") return;
      for (const k of Object.keys(changes)) if (k in SETTINGS) SETTINGS[k] = changes[k].newValue;
    });
  }

  init();
})();
