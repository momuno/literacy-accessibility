# Accessing Literacy — Chrome Extension

A Chrome extension that rewrites English Wikipedia articles to your chosen reading level using a local AI model. No server, no API keys, no data leaves your device.

---

## How it works

Click the extension icon on any English Wikipedia page to open a popup. Select a reading level (Kindergarten through High School) and hit Apply. The extension rewrites the article paragraph by paragraph, sentence by sentence, directly in your browser using a locally running language model.

- ✅ next to a grade level means a cached version exists — loads instantly
- A spinner means that level is currently being processed
- The selected radio button reflects what is currently displayed

Clicking **Off / Restore original** brings back the original Wikipedia text. Cached versions persist locally so switching between grade levels is instant after the first run.

---

## Architecture

```
Chrome Extension only — no backend, no server, no API keys

background.js       Coordinator — tracks rewrite state per tab, routes
                    messages between content.js, offscreen.js, and popup
offscreen.js        Loads and runs the LLM via WebLLM in a hidden persistent
                    page — processes paragraphs sentence by sentence
content.js          Runs on Wikipedia pages — DOM manipulation, spinners,
                    hyperlink re-insertion, caching, original/rewrite toggle
popup.html/js       Extension popup — grade level selector with cache status
manifest.json       Extension config, permissions, and CSP for WebAssembly
```

Messages flow through `background.js` — `content.js` and `offscreen.js` never talk directly.

---

## Setup

**Step 1 — Install dependencies and build the WebLLM bundle (one time only)**

```bash
cd literacy-extension
npm install
npm run build
```

This produces `offscreen.bundle.js`. Commit it to your repo so collaborators don't need to repeat this step. Only re-run if you update the WebLLM version.

**Step 2 — Load the extension in Chrome**

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** → select this folder
4. Navigate to any `https://en.wikipedia.org/wiki/` article
5. Click the extension icon

**Requirements:** Chrome 113+ with WebGPU support. A modern GPU with at least 4GB VRAM is recommended.

**First run:** The model (~2.5GB) downloads and caches automatically. This takes a few minutes depending on your connection. Subsequent loads are fast.

---

## Customization

### Change the model

In `offscreen.js`, update the model ID:

```javascript
const MODEL_ID = "Llama-3.2-3B-Instruct-q4f32_1-MLC";
```

Any model from [mlc.ai/models](https://mlc.ai/models) tagged `MLC` works with WebLLM. Some options:

| Model | Size | Notes |
|---|---|---|
| `Llama-3.2-1B-Instruct-q4f16_1-MLC` | ~1GB | Fastest, lower quality |
| `Llama-3.2-3B-Instruct-q4f32_1-MLC` | ~2.5GB | Default — good balance |
| `Phi-3.5-mini-instruct-q4f16_1-MLC` | ~2.3GB | Strong instruction following |
| `Llama-3.1-8B-Instruct-q4f32_1-MLC` | ~5GB | Best quality, needs more VRAM |

After changing the model, run `npm run build` again.

### Change the prompt

In `offscreen.js`, update `buildPrompt()`:

```javascript
function buildPrompt(sentence, gradeLevel) {
  return (
    `Rewrite the following sentence for a ${gradeLevel} reader...`
  );
}
```

The `gradeLevel` variable is passed in from the user's popup selection.

### Adapt for a different website

In `manifest.json`, update the `matches` and `host_permissions` entries:

```json
"content_scripts": [
  { "matches": ["https://yoursite.com/*"], "js": ["content.js"] }
],
"host_permissions": ["https://yoursite.com/*"]
```

In `content.js`, update the paragraph selector:

```javascript
const paragraphs = Array.from(
  document.querySelectorAll("#your-content-container p")
).filter((p) => p.innerText.trim().length > 40);
```

---

## Known limitations

- English Wikipedia only (expanding to other sites is a planned improvement)
- Only rewrites `<p>` tags — headings and list items are not yet rewritten
- Requires WebGPU — Chrome 113+, modern GPU
- First model download takes several minutes
- Long articles may trigger GPU memory pressure on lower-end hardware — the extension handles this by retrying after a GPU reset
- Page refresh clears the displayed version (cached versions are preserved)

---

## Roadmap

- [ ] Expand to other English-language websites
- [ ] Rewrite headings and list items
- [ ] Side-by-side original / rewritten view
- [ ] Resume interrupted rewrites across sessions
- [ ] Clear cache option in popup
- [ ] Non-English Wikipedia support
- [ ] Published to Chrome Web Store

---

## License

MIT