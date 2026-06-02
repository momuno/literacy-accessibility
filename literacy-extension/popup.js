// popup.js
// Renders the grade level selector, checks cache status, and sends
// commands to background.js when the user submits or turns off.

const GRADE_LEVELS = [
  "Kindergarten",
  "1st grade",
  "2nd grade",
  "3rd grade",
  "4th grade",
  "5th grade",
  "6th grade",
  "7th grade",
  "8th grade",
  "High school",
];

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

let activeTabId = null;
let activeUrl = null;
let inProgressGradeLevel = null;
let displayedGradeLevel = null;
let selectedGradeLevel = null;

// ── Init ──────────────────────────────────────────────────────────────────

async function init() {
  // Ask background for current tab + rewrite state
  const tabInfo = await chrome.runtime.sendMessage({ type: "GET_ACTIVE_TAB" });

  if (!tabInfo || !tabInfo.url?.startsWith("https://en.wikipedia.org/wiki/")) {
    document.getElementById("main-ui").style.display = "none";
    document.getElementById("not-wikipedia").style.display = "block";
    return;
  }

  activeTabId = tabInfo.tabId;
  activeUrl = tabInfo.url;
  inProgressGradeLevel = tabInfo.inProgressGradeLevel;
  displayedGradeLevel = tabInfo.displayedGradeLevel;

  // Select whatever is currently active — in-progress takes priority over displayed
  // null means original is showing, nothing selected
  selectedGradeLevel = inProgressGradeLevel || displayedGradeLevel || null;

  // Check which grade levels are cached for this page
  const cachedLevels = await getCachedLevels(activeUrl);

  renderGradeList(cachedLevels);

  // Disable apply if nothing selected (original is showing)
  document.getElementById("submit-btn").disabled = selectedGradeLevel === null;
}

// ── Cache check ───────────────────────────────────────────────────────────

async function getCachedLevels(url) {
  const cached = new Set();
  const all = await chrome.storage.local.get(null);
  for (const key of Object.keys(all)) {
    const [keyUrl, keyLevel] = key.split("|");
    if (keyUrl === url && keyLevel) {
      cached.add(keyLevel);
    }
  }
  return cached;
}

// ── Render ────────────────────────────────────────────────────────────────

function renderGradeList(cachedLevels) {
  const list = document.getElementById("grade-list");
  list.innerHTML = "";

  for (const level of GRADE_LEVELS) {
    const li = document.createElement("li");
    if (level === selectedGradeLevel) li.classList.add("selected");

    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "grade";
    radio.value = level;
    radio.checked = level === selectedGradeLevel && selectedGradeLevel !== null;

    const name = document.createElement("span");
    name.className = "grade-name";
    name.textContent = level;

    // Status: spinner if processing, ✅ if cached, empty otherwise
    const status = document.createElement("span");
    status.className = "grade-status";
    if (level === inProgressGradeLevel) {
      const spinner = document.createElement("span");
      spinner.className = "spinner";
      status.appendChild(spinner);
    } else if (cachedLevels.has(level)) {
      status.textContent = "✅";
      status.title = "Cached — loads instantly";
    }

    li.appendChild(radio);
    li.appendChild(name);
    li.appendChild(status);

    li.addEventListener("click", () => {
      selectedGradeLevel = level;
      document.querySelectorAll(".grade-list li").forEach((el) => el.classList.remove("selected"));
      li.classList.add("selected");
      radio.checked = true;
      document.getElementById("submit-btn").disabled = false;
    });

    list.appendChild(li);
  }
}

// ── Buttons ───────────────────────────────────────────────────────────────

document.getElementById("submit-btn").addEventListener("click", async () => {
  if (!selectedGradeLevel || !activeTabId) return;

  // Save preference
  await chrome.storage.sync.set({ gradeLevel: selectedGradeLevel });

  // Tell background to start rewrite
  chrome.runtime.sendMessage({
    type: "SUBMIT_GRADE_LEVEL",
    tabId: activeTabId,
    gradeLevel: selectedGradeLevel,
  });

  window.close();
});

document.getElementById("off-btn").addEventListener("click", () => {
  if (!activeTabId) return;
  chrome.runtime.sendMessage({ type: "TURN_OFF", tabId: activeTabId });
  window.close();
});

// ── Start ─────────────────────────────────────────────────────────────────
init();