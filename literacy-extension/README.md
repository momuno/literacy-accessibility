# Accessing Literacy — Browser Extension

A browser extension that rewrites English Wikipedia articles to your chosen reading level using an AI model running entirely in your browser. No server, no API keys, no data leaves your device.

---

## Try it out

### Requirements

- **Chrome 113+** or **Edge 113+** with WebGPU support
- A modern GPU (most dedicated and recent integrated GPUs work)
- ~2.5 GB of free disk space for the AI model (downloads once, then cached)

### Step 1 — Download

[Download accessing-literacy-extension.zip](https://github.com/momuno/literacy-accessibility/releases/latest/download/accessing-literacy-extension.zip) and **unzip** it to a folder on your computer.

### Step 2 — Install in Developer Mode

**Chrome:**
1. Go to `chrome://extensions`
2. Turn on **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the unzipped folder

**Edge:**
1. Go to `edge://extensions`
2. Turn on **Developer mode** (toggle in the bottom-left sidebar)
3. Click **Load unpacked**
4. Select the unzipped folder

### Step 3 — Use it

1. Navigate to any English Wikipedia article (e.g. [Photosynthesis](https://en.wikipedia.org/wiki/Photosynthesis))
2. Click the **books icon** in your browser toolbar
3. Select a reading level (3rd grade through 12th grade)
4. Click **Apply**
5. Click **Off** to toggle back to the original text

**First-run note:** The first time you click Apply, the AI model (~2.5 GB) downloads and caches in your browser. This is a one-time wait of a few minutes depending on your connection. After that, everything runs locally with no network calls.

**Cache indicators:** A checkmark next to a grade level in the popup means a cached rewrite exists for that article — it loads instantly.

---

## How it works

Click the extension icon on any English Wikipedia page to open a popup. Select a reading level and hit Apply. The extension rewrites the article paragraph by paragraph, sentence by sentence, directly in your browser using a locally running language model (Llama 3.2 3B via [WebLLM](https://webllm.mlc.ai/)).

### Architecture

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

## Developer setup

If you want to modify the extension and build from source:

```bash
cd literacy-extension
npm install
npm run build
```

This produces `offscreen.bundle.js` (the only file that requires a build step — it bundles the WebLLM dependency). All other files are vanilla JS. You only need to rebuild if you change `offscreen.js` or update the WebLLM version.

Then load the extension folder via Developer Mode as described above.

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

- English Wikipedia only (expanding to other sites is planned)
- Only rewrites `<p>` tags — headings and list items are not yet rewritten
- Requires WebGPU — Chrome/Edge 113+, modern GPU
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
