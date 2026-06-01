async function processHTML() {
    // HACK
    // Calling local service that has existing python code for OpenAI connection.
    const url = "http://127.0.0.1:8000/process_html";
    const requestOptions = {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body : JSON.stringify({ "html" : document.body.innerHTML })
    }

    try {
        const response = await fetch(url, requestOptions);
        if (!response.ok) {
            throw new Error(`Response status: ${response.status}`);
        }

        const response_json = await response.json();
        document.body.innerHTML = response_json["processed"]
    } catch (error) {
        console.error(error.message);
    }
}

chrome.runtime.onInstalled.addListener(() => {
    chrome.action.setBadgeText({
      text: "OFF",
    });
  });

chrome.action.onClicked.addListener(async (tab) => {
    if (tab.url.startsWith("https://en.wikipedia.org/wiki/")) {
        // Retrieve the action badge to check if the extension is 'ON' or 'OFF'
        const prevState = await chrome.action.getBadgeText({ tabId: tab.id });
        // Next state will always be the opposite
        const nextState = prevState === 'ON' ? 'OFF' : 'ON';

        // Set the action badge to the next state
        await chrome.action.setBadgeText({
          tabId: tab.id,
          text: nextState,
        });

        if (nextState === "ON") {
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: processHTML,
            }).then(() => console.log("injected script file process_html.js"));
        } else if (nextState === "OFF") {
            chrome.tabs.reload();
        }
    }
});