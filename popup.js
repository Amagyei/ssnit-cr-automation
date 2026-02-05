document.getElementById('go').addEventListener('click', async () => {
    const period = document.getElementById('period').value.trim();
    const rawInput = document.getElementById('ers').value;

    const lines = rawInput.split(/[\n,\s]+/).map(e => e.trim()).filter(e => e.length > 0);
    
    const validErs = [];
    const invalidErs = [];

    lines.forEach(item => {
        if (/^\d{9}$/.test(item)) {
            if (!validErs.includes(item)) validErs.push(item);
        } else if (item.length > 0) {
            invalidErs.push(item);
        }
    });

    if (invalidErs.length > 0) {
        const proceed = confirm(`Found ${invalidErs.length} invalid ER(s):\n[${invalidErs.slice(0, 5).join(', ')}${invalidErs.length > 5 ? '...' : ''}]\n\nProceed with ${validErs.length} valid number(s)?`);
        if (!proceed) return;
    }

    if (validErs.length === 0) {
        alert("No valid 9-digit ER numbers found.");
        return;
    }

    if (!/^\d{6}$/.test(period)) {
        alert("Enter a valid period in YYYYMM format (e.g., 202601).");
        return;
    }

    const year = parseInt(period.substring(0, 4));
    const month = parseInt(period.substring(4, 6));
    if (month < 1 || month > 12 || year < 2000 || year > 2100) {
        alert("Invalid period values.");
        return;
    }

    chrome.tabs.query({active: true, currentWindow: true}, async (tabs) => {
        const tab = tabs[0];
        if (!tab) return;

        // Store automation tab ID so only this tab runs scraping/capture/validation
        await chrome.storage.local.set({
            phase: 'SCRAPING',
            targetPeriod: period,
            erQueue: validErs,
            currentER: validErs[0],
            scrapedResults: [],
            captureQueue: [],
            currentCaptureIndex: 0,
            capturedErs: [],
            failedErs: [],
            retryCount: 0,
            startTime: Date.now(),
            totalERs: validErs.length,
            originalErCount: validErs.length, // For progress bar calculation
            automationTabId: tab.id
        });

        chrome.tabs.update(tab.id, { url: "https://app.issas.ssnit.org.gh/contributions/view_crs/report" });
    });
});
