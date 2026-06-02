// offscreen.js
// Loads Llama 3.2 3B via WebLLM and processes paragraph rewrite requests.
// Processes sentence by sentence to minimize GPU memory usage per inference.
// Handles GPU device loss by reloading the engine and retrying.

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

// Force reload the engine — used after a GPU device loss
async function reloadModel() {
  enginePromise = null;
  return loadModel();
}

function isDeviceLostError(err) {
  const msg = err?.message || String(err);
  return (
    msg.includes("Device was lost") ||
    msg.includes("DEVICE_HUNG") ||
    msg.includes("already been disposed") ||
    msg.includes("unmapped before mapping")
  );
}

// Start loading immediately
loadModel().then(() => {
  chrome.runtime.sendMessage({ type: "MODEL_READY" }).catch(() => {});
}).catch((err) => {
  console.error("[offscreen] model failed to load:", err);
});

// ── Sentence splitter ─────────────────────────────────────────────────────

function splitSentences(text) {
  const parts = text.split(/(?<=[.?!])\s+(?=[A-Z])/);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

// ── Prompt ────────────────────────────────────────────────────────────────

function buildPrompt(sentence, gradeLevel) {
  return (
    `Rewrite the following sentence for a ${gradeLevel} reader using simpler words and shorter phrasing. ` +
    `Return the rewritten sentence only, with no introduction, explanation, or label before it. ` +
    `Do not add new facts. Do not change any quoted text.\n\n` +
    `Sentence: ${sentence}`
  );
}

// ── Job queue ─────────────────────────────────────────────────────────────
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

// ── Message handler ───────────────────────────────────────────────────────

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

async function runRewrite({ paragraphs, gradeLevel, tabId, jobId }) {
  let engine = await loadModel();

  for (let i = 0; i < paragraphs.length; i++) {

    // Check cancellation before each paragraph
    if (await checkCancelled(tabId, jobId)) {
      console.log(`[offscreen] job ${jobId} for tab ${tabId} was cancelled at paragraph ${i}`);
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
            console.warn("[offscreen] GPU device lost, reloading engine...");
            chrome.runtime.sendMessage({
              type: "MODEL_LOAD_PROGRESS",
              text: "GPU recovered, resuming...",
              progress: 0.5,
            }).catch(() => {});
            try {
              engine = await reloadModel();
              chrome.runtime.sendMessage({ type: "MODEL_READY" }).catch(() => {});
            } catch (reloadErr) {
              console.error("[offscreen] engine reload failed:", reloadErr);
              break;
            }
            attempts++;
          } else {
            console.error(`[offscreen] error p${i} s${s}:`, err);
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
        index: i,
        rewritten: null,
        skipped: true,
        total: paragraphs.length,
        tabId,
      }).catch(() => {});
      continue;
    }

    chrome.runtime.sendMessage({
      type: "PARAGRAPH_DONE",
      index: i,
      rewritten: kept.join(" "),
      total: paragraphs.length,
      tabId,
    }).catch(() => {});
  }

  chrome.runtime.sendMessage({
    type: "REWRITE_COMPLETE",
    gradeLevel,
    tabId,
  }).catch(() => {});
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== "REWRITE_ALL_PARAGRAPHS_OFFSCREEN") return;
  enqueueJob({
    paragraphs: message.paragraphs,
    gradeLevel: message.gradeLevel,
    tabId: message.tabId,
    jobId: message.jobId,
  });
});
