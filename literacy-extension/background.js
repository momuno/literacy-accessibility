// background.js
// Coordinator. Tracks rewrite state per tab and routes messages between
// content.js, offscreen.js, and the popup.

const OFFSCREEN_URL = chrome.runtime.getURL("offscreen.html");

// ── Model ready state ─────────────────────────────────────────────────────
let modelReady = false;

const BADGE_LABELS = {
  "Kindergarten": "K",
  "1st grade":    "1st",
  "2nd grade":    "2nd",
  "3rd grade":    "3rd",
  "4th grade":    "4th",
  "5th grade":    "5th",
  "6th grade":    "6th",
  "7th grade":    "7th",
  "8th grade":    "8th",
  "High school":  "HS",
};

function setBadge(tabId, gradeLevel) {
  const text = gradeLevel ? (BADGE_LABELS[gradeLevel] || "ON") : "";
  chrome.action.setBadgeText({ tabId, text });
  chrome.action.setBadgeBackgroundColor({
    tabId,
    color: gradeLevel ? "#4361ee" : "#888888",
  });
}

// ── Display state ─────────────────────────────────────────────────────────
// { [tabId]: gradeLevel | null }
// Tracks what is currently rendered on each tab — null means original.

const displayState = {};

function setDisplayState(tabId, gradeLevel) { displayState[tabId] = gradeLevel; }
function clearDisplayState(tabId) { delete displayState[tabId]; }
function getDisplayState(tabId) { return displayState[tabId] || null; }

// ── Rewrite state ─────────────────────────────────────────────────────────
// { [tabId]: { gradeLevel, jobId, cancelled } }
// jobId increments each time a new job is submitted for a tab,
// so offscreen can detect when its job has been superseded.

const rewriteState = {};
let nextJobId = 1;

function setRewriteState(tabId, gradeLevel) {
  const jobId = nextJobId++;
  rewriteState[tabId] = { gradeLevel, jobId };
  return jobId;
}

function clearRewriteState(tabId) { delete rewriteState[tabId]; }

function getRewriteState(tabId) { return rewriteState[tabId] || null; }

function isCancelled(tabId, jobId) {
  const state = rewriteState[tabId];
  return !state || state.cancelled || state.jobId !== jobId;
}

// All tabs currently with an active rewrite state
function getWaitingTabIds() {
  return Object.keys(rewriteState).map(Number);
}

// ── Offscreen document ────────────────────────────────────────────────────

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [OFFSCREEN_URL],
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    // Offscreen doc already exists. If SW restarted, modelReady is stale (false).
    // Ask the offscreen doc to re-announce its status so we don't deadlock.
    if (!modelReady) {
      chrome.runtime.sendMessage({ type: "QUERY_MODEL_STATUS" }).catch(() => {});
    }
    return;
  }
  modelReady = false;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["WORKERS"],
    justification: "Run Llama 3.2 3B via WebLLM to rewrite Wikipedia paragraphs locally.",
  });
}

// Start loading the model as soon as the extension loads
ensureOffscreenDocument();

// ── GPU recovery via offscreen document recycling ─────────────────────────────
// After a DXGI TDR (Timeout Detection and Recovery) on Windows, Chrome's WebGPU
// context within a page is permanently poisoned — requestDevice() will always fail.
// The only fix is to destroy the offscreen document and create a fresh one, which
// gives us a completely new WebGPU context. Model weights are served from the
// Cache API so the reload is fast (no re-download).

let pendingGpuRecoveryWork = null;
let gpuRecycleCount = 0;
const MAX_GPU_RECYCLES = 2;

async function recycleOffscreenDocument() {
  console.log("[background] recycling offscreen document for GPU recovery...");
  modelReady = false;

  // 1. Destroy the poisoned offscreen document
  try {
    await chrome.offscreen.closeDocument();
  } catch (e) {
    console.warn("[background] closeDocument failed (may already be closed):", e);
  }

  // 2. Wait for the GPU adapter to fully reset after TDR
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // 3. Create a fresh offscreen document — new WebGPU context, new engine
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["WORKERS"],
    justification: "Run Llama 3.2 3B via WebLLM to rewrite Wikipedia paragraphs locally.",
  });
  // The new document auto-loads the model and sends MODEL_READY when done.
  // The pending work will be re-sent in the MODEL_READY handler below.
}

function handleGpuRecoveryNeeded(message) {
  gpuRecycleCount++;

  if (gpuRecycleCount > MAX_GPU_RECYCLES) {
    // Give up — send remaining paragraphs as skipped so content.js finishes
    console.error(`[background] GPU recovery exhausted after ${gpuRecycleCount} recycles, giving up`);
    for (let j = 0; j < message.remainingParagraphs.length; j++) {
      broadcastToTab(message.tabId, {
        type: "PARAGRAPH_DONE",
        index: message.startIndex + j,
        rewritten: null,
        skipped: true,
        total: message.totalParagraphs,
      });
    }
    broadcastToTab(message.tabId, {
      type: "REWRITE_COMPLETE",
      gradeLevel: message.gradeLevel,
    });
    clearRewriteState(message.tabId);
    pendingGpuRecoveryWork = null;
    gpuRecycleCount = 0;

    broadcastToTab(message.tabId, {
      type: "MODEL_LOAD_PROGRESS",
      text: "GPU unavailable — some paragraphs kept as original text.",
      progress: 0,
    });
    return;
  }

  // Store remaining work for re-sending after recycled document is ready
  pendingGpuRecoveryWork = {
    paragraphs: message.remainingParagraphs,
    gradeLevel: message.gradeLevel,
    tabId: message.tabId,
    jobId: message.jobId,
    startIndex: message.startIndex,
    totalParagraphs: message.totalParagraphs,
  };

  // Notify user
  broadcastToTab(message.tabId, {
    type: "MODEL_LOAD_PROGRESS",
    text: `GPU recovering, restarting engine (attempt ${gpuRecycleCount}/${MAX_GPU_RECYCLES})…`,
    progress: 0.1,
  });

  // Recycle the offscreen document (async, fire-and-forget from the listener)
  recycleOffscreenDocument().catch((err) => {
    console.error("[background] recycleOffscreenDocument failed:", err);
    pendingGpuRecoveryWork = null;
  });
}

// ── Tab lifecycle ─────────────────────────────────────────────────────────
// Clear state when a tab navigates or refreshes — page is back to original

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    clearRewriteState(tabId);
    clearDisplayState(tabId);
    setBadge(tabId, null);
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────

function broadcastToTab(tabId, message) {
  chrome.tabs.sendMessage(tabId, message).catch(() => {});
}

// ── Message routing ───────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // Popup asks for current tab info + rewrite state
  if (message.type === "GET_ACTIVE_TAB") {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab) { sendResponse(null); return; }
      const state = getRewriteState(tab.id);
      sendResponse({
        url: tab.url,
        tabId: tab.id,
        inProgressGradeLevel: state?.gradeLevel || null,
        displayedGradeLevel: getDisplayState(tab.id),
      });
    });
    return true;
  }

  // content.js asks on visibility change — am I still supposed to be running?
  if (message.type === "CHECK_PENDING_REWRITE") {
    const state = getRewriteState(sender.tab.id);
    sendResponse({
      gradeLevel: state?.gradeLevel || null,
      modelReady,
    });
    return true;
  }

  // offscreen polls between paragraphs to check if job was cancelled
  if (message.type === "CHECK_CANCELLED") {
    sendResponse({ cancelled: isCancelled(message.tabId, message.jobId) });
    return true;
  }
  if (message.type === "MODEL_READY") {
    modelReady = true;

    // If we have pending GPU recovery work, re-send it to the fresh offscreen doc
    if (pendingGpuRecoveryWork) {
      const work = pendingGpuRecoveryWork;
      pendingGpuRecoveryWork = null;
      console.log(`[background] GPU recovery complete, resuming job at paragraph ${work.startIndex}`);
      chrome.runtime.sendMessage({
        type: "REWRITE_ALL_PARAGRAPHS_OFFSCREEN",
        paragraphs: work.paragraphs,
        gradeLevel: work.gradeLevel,
        tabId: work.tabId,
        jobId: work.jobId,
        startIndex: work.startIndex,
        totalParagraphs: work.totalParagraphs,
      });
      return; // Don't broadcast MODEL_READY to tabs — we're in recovery mode
    }

    // Normal MODEL_READY broadcast
    for (const tabId of getWaitingTabIds()) {
      broadcastToTab(tabId, { type: "MODEL_READY" });
    }
  }

  // offscreen.js signals that the GPU is dead and this document needs recycling
  if (message.type === "GPU_RECOVERY_NEEDED") {
    handleGpuRecoveryNeeded(message);
  }

  // Popup submits a grade level selection
  if (message.type === "SUBMIT_GRADE_LEVEL") {
    const { tabId, gradeLevel } = message;
    gpuRecycleCount = 0; // Reset GPU recovery counter for new jobs
    pendingGpuRecoveryWork = null;
    const jobId = setRewriteState(tabId, gradeLevel); // marks any existing job cancelled
    setBadge(tabId, gradeLevel);

    chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    }).catch(() => {}).then(() => {
      ensureOffscreenDocument().then(() => {
        broadcastToTab(tabId, {
          type: "START_REWRITE",
          gradeLevel,
          modelReady,
          jobId,
        });
      });
    });
  }

  // content.js reports what is currently displayed on the page
  if (message.type === "SET_DISPLAY_STATE") {
    setDisplayState(sender.tab.id, message.gradeLevel);
    setBadge(sender.tab.id, message.gradeLevel);
  }

  // Popup selects OFF
  if (message.type === "TURN_OFF") {
    const { tabId } = message;
    clearRewriteState(tabId);
    clearDisplayState(tabId);
    setBadge(tabId, null);
    broadcastToTab(tabId, { type: "RESTORE_ORIGINAL" });
  }

  // content.js reports rewrite complete
  if (message.type === "REWRITE_COMPLETE_ACK") {
    clearRewriteState(sender.tab.id);
    setBadge(sender.tab.id, null);
  }

  // content.js → offscreen: send full paragraph list for processing
  if (message.type === "REWRITE_ALL_PARAGRAPHS") {
    ensureOffscreenDocument().then(() => {
      chrome.runtime.sendMessage({
        type: "REWRITE_ALL_PARAGRAPHS_OFFSCREEN",
        paragraphs: message.paragraphs,
        gradeLevel: message.gradeLevel,
        jobId: message.jobId,
        tabId: sender.tab.id,
      });
    });
  }

  // offscreen → content: one paragraph done
  if (message.type === "PARAGRAPH_DONE") {
    broadcastToTab(message.tabId, {
      type: "PARAGRAPH_DONE",
      index: message.index,
      rewritten: message.rewritten,
      skipped: message.skipped,
      total: message.total,
    });
  }

  // offscreen → content: all paragraphs done
  if (message.type === "REWRITE_COMPLETE") {
    gpuRecycleCount = 0; // Reset GPU recovery counter on successful completion
    clearRewriteState(message.tabId);
    broadcastToTab(message.tabId, {
      type: "REWRITE_COMPLETE",
      gradeLevel: message.gradeLevel,
    });
  }

  // offscreen → content: model loading progress
  // Send to all tabs with pending rewrites
  if (message.type === "MODEL_LOAD_PROGRESS") {
    for (const tabId of getWaitingTabIds()) {
      broadcastToTab(tabId, message);
    }
    // Also send to active tab in case it opened before submitting
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (tab && !rewriteState[tab.id]) {
        broadcastToTab(tab.id, message);
      }
    });
  }

});