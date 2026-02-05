/**
 * SSNIT Automator - Background Service Worker
 * Stores the "automation tab" ID so only the tab where automation was started runs actions.
 */

// When content script or popup sets automation tab, we store it here and in storage
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'registerAutomationTab') {
        const tabId = sender.tab?.id;
        if (tabId) {
            chrome.storage.local.set({ automationTabId: tabId }, () => {
                sendResponse({ ok: true, tabId });
            });
        } else {
            sendResponse({ ok: false });
        }
        return true; // async response
    }

    if (message.type === 'getMyTabId') {
        const tabId = sender.tab?.id ?? null;
        sendResponse({ tabId });
        return false; // sync
    }

    if (message.type === 'isAutomationTab') {
        chrome.storage.local.get(['automationTabId'], (data) => {
            const stored = data.automationTabId;
            const myId = sender.tab?.id;
            sendResponse({ isAutomationTab: stored != null && myId === stored });
        });
        return true; // async
    }

    return false;
});
