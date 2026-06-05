// content.js
// Runs on Wikipedia pages. Handles DOM updates, spinners, caching, and toggle.

if (!window.__alContentLoaded) {
window.__alContentLoaded = true;

(async () => {

  // ── State ──────────────────────────────────────────────────────────────────

  const PAGE_KEY = window.location.href.split('#')[0];

  const paragraphs = Array.from(
    document.querySelectorAll("#mw-content-text p")
  ).filter((p) => p.innerText.trim().length > 40);

  const originals = paragraphs.map((p) => p.innerHTML);
  let isRewritten = false;
  let pendingCache = {};
  let pendingGradeLevel = null;
  let currentJobId = null;

  // ── Link map extraction ────────────────────────────────────────────────────
  // For each paragraph, build a map of lowercase link text → href.
  // Sorted longest-first so we match "carbon dioxide" before "carbon".

  function extractLinkMap(paragraphEl) {
    const map = []; // array of { text, lower, href } sorted longest first
    paragraphEl.querySelectorAll("a[href]").forEach((a) => {
      const text = a.innerText.trim();
      const href = a.getAttribute("href");
      if (text.length > 0 && href) {
        map.push({ text, lower: text.toLowerCase(), href });
      }
    });
    // Sort longest first so multi-word phrases match before single words
    map.sort((a, b) => b.lower.length - a.lower.length);
    return map;
  }

  // Build link maps once from original DOM before any rewriting
  const linkMaps = paragraphs.map((p) => extractLinkMap(p));

  // ── Link re-insertion ──────────────────────────────────────────────────────
  // Given rewritten plain text and a link map, return HTML with links restored.
  // Matches substrings case-insensitively, wraps with original href.
  // Each link phrase is only applied once (first occurrence).

  function relinkText(text, linkMap) {
    if (!linkMap || linkMap.length === 0) return escapeHtml(text);

    // Track which character positions are already linked
    // so we don't double-wrap overlapping matches
    const taken = new Array(text.length).fill(false);
    const matches = []; // { start, end, href, originalText }

    const lowerText = text.toLowerCase();

    for (const { lower, href, text: originalText } of linkMap) {
      let pos = lowerText.indexOf(lower);
      while (pos !== -1) {
        const end = pos + lower.length;
        // Check word boundaries — don't match inside a larger word
        const beforeOk = pos === 0 || /\W/.test(text[pos - 1]);
        const afterOk = end === text.length || /\W/.test(text[end]);
        // Check no overlap with already matched ranges
        const noOverlap = !taken.slice(pos, end).some(Boolean);

        if (beforeOk && afterOk && noOverlap) {
          matches.push({ start: pos, end, href, originalText });
          // Mark positions as taken
          for (let i = pos; i < end; i++) taken[i] = true;
          break; // only first occurrence per link phrase
        }
        pos = lowerText.indexOf(lower, pos + 1);
      }
    }

    if (matches.length === 0) return escapeHtml(text);

    // Sort matches by position so we can build HTML left to right
    matches.sort((a, b) => a.start - b.start);

    let html = "";
    let cursor = 0;
    for (const { start, end, href } of matches) {
      // Plain text before this match
      html += escapeHtml(text.slice(cursor, start));
      // The matched text wrapped in an <a> tag
      // Use the rewritten text's casing but the original href
      const matchedWord = text.slice(start, end);
      html += `<a href="${escapeAttr(href)}">${escapeHtml(matchedWord)}</a>`;
      cursor = end;
    }
    // Remaining plain text after last match
    html += escapeHtml(text.slice(cursor));

    return html;
  }

  function escapeHtml(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function escapeAttr(str) {
    return str.replace(/"/g, "&quot;");
  }

  // ── Storage helpers ────────────────────────────────────────────────────────

  function cacheKey(gradeLevel) {
    return `${PAGE_KEY}|${gradeLevel}`;
  }

  async function getCachedVersion(gradeLevel) {
    const key = cacheKey(gradeLevel);
    const result = await chrome.storage.local.get(key);
    return result[key] || null;
  }

  async function saveToCachePartial(gradeLevel, index, html) {
    const key = cacheKey(gradeLevel);
    const result = await chrome.storage.local.get(key);
    const existing = result[key] || {};
    existing[index] = html;
    await chrome.storage.local.set({ [key]: existing });
  }

  // ── Spinner helpers ────────────────────────────────────────────────────────

  function injectSpinnerCSS() {
    if (document.getElementById("al-spinner-style")) return;
    const style = document.createElement("style");
    style.id = "al-spinner-style";
    style.textContent = `
      @keyframes al-spin { to { transform: rotate(360deg); } }
    `;
    document.head.appendChild(style);
  }

  function addSpinner(p) {
    p.style.opacity = "0.45";
    const spinner = document.createElement("span");
    spinner.className = "al-spinner";
    spinner.style.cssText = `
      display: inline-block; width: 10px; height: 10px;
      border: 2px solid #93c5fd; border-top-color: #2563eb;
      border-radius: 50%; animation: al-spin 0.7s linear infinite;
      margin-left: 8px; vertical-align: middle;
    `;
    p.after(spinner);
  }

  function removeSpinner(p) {
    p.style.opacity = "1";
    const next = p.nextSibling;
    if (next?.classList?.contains("al-spinner")) next.remove();
  }

  // ── Banner ─────────────────────────────────────────────────────────────────

  function getOrCreateBanner() {
    let banner = document.getElementById("al-banner");
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "al-banner";
      banner.style.cssText = `
        position: fixed; bottom: 20px; right: 20px;
        background: #1e3a5f; color: #e0f0ff;
        font-family: sans-serif; font-size: 13px;
        padding: 10px 16px; border-radius: 8px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.3);
        z-index: 99999; max-width: 300px; line-height: 1.5;
        transition: opacity 0.4s;
      `;
      document.body.appendChild(banner);
    }
    return banner;
  }

  let bannerHideTimer = null;

  function setBanner(text, autohide = false) {
    if (bannerHideTimer) { clearTimeout(bannerHideTimer); bannerHideTimer = null; }
    const banner = getOrCreateBanner();
    banner.style.opacity = "1";
    banner.textContent = text;
    if (autohide) bannerHideTimer = setTimeout(() => { banner.style.opacity = "0"; }, 3000);
  }

  function removeBanner() {
    document.getElementById("al-banner")?.remove();
  }

  // ── Apply cached version ───────────────────────────────────────────────────

  async function applyCache(gradeLevel, cached) {
    for (const [i, html] of Object.entries(cached)) {
      if (paragraphs[i]) paragraphs[i].innerHTML = html;
    }
    isRewritten = true;
    // Tell background this is now displayed and rewrite state is done
    chrome.runtime.sendMessage({ type: "SET_DISPLAY_STATE", gradeLevel });
    chrome.runtime.sendMessage({ type: "REWRITE_COMPLETE_ACK" });
    setBanner(`✅ Loaded cached ${gradeLevel} version`, true);
  }

  // ── Restore original ───────────────────────────────────────────────────────

  function restoreOriginal() {
    paragraphs.forEach((p, i) => { p.innerHTML = originals[i]; });
    isRewritten = false;
    chrome.runtime.sendMessage({ type: "SET_DISPLAY_STATE", gradeLevel: null });
    removeBanner();
  }

  // ── Start a fresh rewrite ──────────────────────────────────────────────────

  function startRewrite(gradeLevel, jobId) {
    currentJobId = jobId;
    injectSpinnerCSS();
    paragraphs.forEach((p) => addSpinner(p));
    setBanner(`⏳ Rewriting… (0 / ${paragraphs.length})`);

    const texts = paragraphs.map((p) => p.innerText.trim());
    chrome.runtime.sendMessage({
      type: "REWRITE_ALL_PARAGRAPHS",
      paragraphs: texts,
      gradeLevel,
      jobId,
    });
  }

  // ── Message listener ───────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener(async (message) => {

    if (message.type === "START_REWRITE") {
      const { gradeLevel, modelReady, jobId } = message;
      pendingGradeLevel = gradeLevel;
      currentJobId = jobId;

      const cached = await getCachedVersion(gradeLevel);
      if (cached && Object.keys(cached).length > 0) {
        await applyCache(gradeLevel, cached);
        pendingGradeLevel = null;
      } else if (modelReady) {
        startRewrite(gradeLevel, jobId);
        pendingGradeLevel = null;
      } else {
        setBanner(`⏳ Loading model…`);
      }
    }

    if (message.type === "MODEL_READY") {
      if (pendingGradeLevel) {
        startRewrite(pendingGradeLevel, currentJobId);
        pendingGradeLevel = null;
      }
    }

    if (message.type === "RESTORE_ORIGINAL") {
      restoreOriginal();
    }

    if (message.type === "MODEL_LOAD_PROGRESS") {
      if (message.progress < 1) {
        setBanner(`⏳ Loading model… ${Math.round(message.progress * 100)}%`);
      } else {
        // Model fully loaded — clear the loading banner
        setBanner(`✅ Model ready`, true);
      }
    }

    // One paragraph finished — re-link and update DOM
    if (message.type === "PARAGRAPH_DONE") {
      const { index, rewritten, skipped, total } = message;
      if (paragraphs[index]) {
        if (skipped) {
          // Model refused all sentences — restore original and remove spinner
          paragraphs[index].innerHTML = originals[index];
        } else {
          const html = relinkText(rewritten, linkMaps[index]);
          paragraphs[index].innerHTML = html;
          pendingCache[index] = html;
        }
        removeSpinner(paragraphs[index]);
      }
      setBanner(`📖 Rewriting… (${index + 1} / ${total})`);
    }

    if (message.type === "REWRITE_COMPLETE") {
      paragraphs.forEach((p) => removeSpinner(p));
      isRewritten = true;
      setBanner(`✅ Rewritten to ${message.gradeLevel} level`, true);

      // Save completed version to cache
      const key = cacheKey(message.gradeLevel);
      await chrome.storage.local.set({ [key]: pendingCache });
      pendingCache = {};

      // Tell background what's now displayed and that rewrite is done
      chrome.runtime.sendMessage({ type: "SET_DISPLAY_STATE", gradeLevel: message.gradeLevel });
      chrome.runtime.sendMessage({ type: "REWRITE_COMPLETE_ACK" });
    }

  });

  // ── Visibility change ────────────────────────────────────────────────────
  // When user switches back to this tab, check with background whether
  // a rewrite is still pending (handles case where model loaded while tab was hidden)

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    chrome.runtime.sendMessage({ type: "CHECK_PENDING_REWRITE" }, (response) => {
      if (!response?.gradeLevel) return; // nothing pending
      if (pendingGradeLevel) return;     // already waiting, don't double-start

      if (response.modelReady) {
        startRewrite(response.gradeLevel, currentJobId);
      } else {
        setBanner(`⏳ Loading model…`);
        pendingGradeLevel = response.gradeLevel;
      }
    });
  });

})();

} // end double-injection guard
