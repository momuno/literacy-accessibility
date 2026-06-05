// offscreen.js
// Loads Llama 3.2 3B via WebLLM and processes paragraph rewrite requests.
// Processes sentence by sentence to minimize GPU memory usage per inference.
// Handles GPU device loss by signaling background.js to recycle this document.

import * as webllm from "@mlc-ai/web-llm";

const MODEL_ID = "Llama-3.2-3B-Instruct-q4f32_1-MLC";

let enginePromise = null;

function loadModel() {
  if (enginePromise) return enginePromise;

  enginePromise = webllm.CreateMLCEngine(MODEL_ID, {
    initProgressCallback: (progress) => {
      chrome.runtime.sendMessage({
        type: "MODEL_LOAD_PROGRESS",
        text: progress.text,
        progress: progress.progress,
      }).catch(() => {});
    },
  });

  return enginePromise;
}

function isDeviceLostError(err) {
  const msg = err?.message || String(err);
  return (
    msg.includes("Device was lost") ||
    msg.includes("DEVICE_HUNG") ||
    msg.includes("DEVICE_REMOVED") ||
    msg.includes("already been disposed") ||
    msg.includes("unmapped before mapping") ||
    msg.includes("Model not loaded")
  );
}

// Start loading immediately
loadModel().then(() => {
  chrome.runtime.sendMessage({ type: "MODEL_READY" }).catch(() => {});
}).catch((err) => {
  console.error("[offscreen] model failed to load:", err);
});

// ── Sentence splitter ─────────────────────────────────────────────────────────

function splitSentences(text) {
  const parts = text.split(/(?<=[.?!])\s+(?=[A-Z])/);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

// ── Prompt ────────────────────────────────────────────────────────────────────

function buildPrompt(sentence, gradeLevel) {
  return (
    `Rewrite the following sentence for a ${gradeLevel} reader using simpler words and shorter phrasing. ` +
    `Return the rewritten sentence only, with no introduction, explanation, or label before it. ` +
    `Do not add new facts. Do not change any quoted text.\n\n` +
    `Sentence: ${sentence}`
  );
}

// ── Job queue ─────────────────────────────────────────────────────────────────
// Ensures only one tab's paragraphs are processed at a time.
// Multiple tabs queue up and are processed sequentially.

const jobQueue = [];
let processing = false;

async function enqueueJob(job) {
  jobQueue.push(job);
  if (!processing) processNextJob();
}

async function processNextJob() {
  if (jobQueue.length === 0) { processing = false; return; }
  processing = true;
  const job = jobQueue.shift();
  await runRewrite(job);
  processNextJob();
}

// ── Message handler ───────────────────────────────────────────────────────────

async function checkCancelled(tabId, jobId) {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "CHECK_CANCELLED",
      tabId,
      jobId,
    });
    return response?.cancelled || false;
  } catch {
    return false;
  }
}

// ── Main inference loop ───────────────────────────────────────────────────────
// startIndex / totalParagraphs allow resuming after a GPU recovery recycle.
// When background.js recreates this document and re-sends remaining paragraphs,
// startIndex offsets the PARAGRAPH_DONE index so content.js updates the right DOM element.

async function runRewrite({ paragraphs, gradeLevel, tabId, jobId, startIndex = 0, totalParagraphs }) {
  totalParagraphs = totalParagraphs || paragraphs.length;

  let engine;

  try {
    engine = await loadModel();
  } catch (err) {
    console.error("[offscreen] initial model load failed:", err);
    chrome.runtime.sendMessage({
      type: "MODEL_LOAD_PROGRESS",
      text: "Model failed to load. Please try again.",
      progress: 0,
    }).catch(() => {});
    return;
  }

  for (let i = 0; i < paragraphs.length; i++) {
    const globalIndex = startIndex + i;

    // Check cancellation before each paragraph
    if (await checkCancelled(tabId, jobId)) {
      console.log(`[offscreen] job ${jobId} for tab ${tabId} was cancelled at paragraph ${globalIndex}`);
      return;
    }
    const sentences = splitSentences(paragraphs[i]);
    const rewrittenSentences = [];

    for (let s = 0; s < sentences.length; s++) {
      const sentence = sentences[s];
      let rewritten = sentence;
      let attempts = 0;

      while (attempts < 2) {
        try {
          const reply = await engine.chat.completions.create({
            messages: [{ role: "user", content: buildPrompt(sentence, gradeLevel) }],
            temperature: 0.3,
            max_tokens: 150,
          });
          rewritten = reply.choices[0].message.content.trim();
          rewritten = rewritten.replace(/^(here is the rewritten sentence:|rewritten:|output:)\s*/i, "").trim();
          // If model refused to rewrite, skip this sentence
          if (/^(i can'?t|i cannot|i'?m unable|i'?m sorry|i will not|i won'?t)/i.test(rewritten)) {
            rewritten = null;
          }
          break;
        } catch (err) {
          if (isDeviceLostError(err) && attempts === 0) {
            // ─── GPU DEVICE LOST ────────────────────────────────────────────
            // The WebGPU context in this offscreen document is permanently
            // poisoned after a DXGI TDR. We cannot recover here — signal
            // background.js to destroy this document and create a fresh one,
            // then resume from the current paragraph.
            console.warn("[offscreen] GPU device lost — requesting document recycle from background");
            chrome.runtime.sendMessage({
              type: "GPU_RECOVERY_NEEDED",
              remainingParagraphs: paragraphs.slice(i),
              startIndex: globalIndex,
              totalParagraphs,
              gradeLevel,
              tabId,
              jobId,
            }).catch(() => {});
            return; // Stop — background will recycle this document
            // ────────────────────────────────────────────────────────────────
          } else {
            console.error(`[offscreen] error p${globalIndex} s${s}:`, err);
            break;
          }
        }
      }

      rewrittenSentences.push(rewritten);
    }

    // Filter out refused sentences
    const kept = rewrittenSentences.filter((s) => s !== null);

    // If all sentences were refused, skip this paragraph — leave it as original
    if (kept.length === 0) {
      chrome.runtime.sendMessage({
        type: "PARAGRAPH_DONE",
        index: globalIndex,
        rewritten: null,
        skipped: true,
        total: totalParagraphs,
        tabId,
      }).catch(() => {});
      continue;
    }

    chrome.runtime.sendMessage({
      type: "PARAGRAPH_DONE",
      index: globalIndex,
      rewritten: kept.join(" "),
      total: totalParagraphs,
      tabId,
    }).catch(() => {});
  }

  chrome.runtime.sendMessage({
    type: "REWRITE_COMPLETE",
    gradeLevel,
    tabId,
  }).catch(() => {});
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "QUERY_MODEL_STATUS") {
    if (enginePromise) {
      enginePromise.then(() => {
        chrome.runtime.sendMessage({ type: "MODEL_READY" }).catch(() => {});
        sendResponse({ ready: true });
      }).catch(() => {
        sendResponse({ ready: false });
      });
    } else {
      sendResponse({ ready: false });
    }
    return true; // async sendResponse
  }

  if (message.type !== "REWRITE_ALL_PARAGRAPHS_OFFSCREEN") return;
  enqueueJob({
    paragraphs: message.paragraphs,
    gradeLevel: message.gradeLevel,
    tabId: message.tabId,
    jobId: message.jobId,
    startIndex: message.startIndex || 0,
    totalParagraphs: message.totalParagraphs || message.paragraphs.length,
  });
});
