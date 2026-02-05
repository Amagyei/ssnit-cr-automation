/**
 * SSNIT AUTOMATOR - CONTENT SCRIPT (Build 2.7)
 * 
 * Features:
 * - Phase 1: SCRAPING with data integrity checks + manual entry/edit
 * - Phase 2: CAPTURE with comprehensive modal handling
 * - Phase 3: VALIDATION - submit captured CRs for processing
 * - Pause/Resume/Skip functionality
 * - Login detection and auto-resume
 * - Event-driven dashboard updates (no wasteful polling when idle)
 * 
 * Modal States Handled:
 * - Print Receipt (Acknowledgement Letter) - Cancel/Close/Print buttons
 * - Error Modal (Duplicate/Validation) - OK button with .btn-error
 * - Unknown Modal - Pauses for user intervention
 */

// ==================== UTILITIES ====================

function log(msg, type = 'info') {
    const styles = {
        info: 'color: #0066cc',
        success: 'color: #10b981; font-weight: bold',
        warn: 'color: #f59e0b',
        error: 'color: #dc2626; font-weight: bold'
    };
    console.log(`%c[SSNIT] ${msg}`, styles[type] || styles.info);
}

function getSequence(yyyyMm) {
    const year = parseInt(yyyyMm.substring(0, 4));
    const month = parseInt(yyyyMm.substring(4, 6)) - 1;
    
    const format = (d) => d.toLocaleString('en-GB', { 
        month: 'short', 
        year: 'numeric' 
    }).toUpperCase();
    
    return {
        targetLabel: format(new Date(year, month)),
        p1Label: format(new Date(year, month - 1)),
        p2Label: format(new Date(year, month - 2))
    };
}

function setNativeValue(element, value) {
    if (!element) return;
    
    const valueSetter = Object.getOwnPropertyDescriptor(element, 'value')?.set;
    const prototype = Object.getPrototypeOf(element);
    const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;

    if (prototypeValueSetter && valueSetter !== prototypeValueSetter) {
        prototypeValueSetter.call(element, value);
    } else if (valueSetter) {
        valueSetter.call(element, value);
    } else {
        element.value = value;
    }
    
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    element.dispatchEvent(new InputEvent('input', {
        bubbles: true, cancelable: true, inputType: 'insertText', data: String(value)
    }));
}

async function safeGet(keys) {
    return new Promise((resolve) => {
        try {
            if (typeof chrome === "undefined" || !chrome.runtime?.id) {
                return resolve(null);
            }
            chrome.storage.local.get(keys, (res) => {
                if (chrome.runtime.lastError) {
                    resolve(null);
                } else {
                    resolve(res);
                }
            });
        } catch (e) { 
            resolve(null); 
        }
    });
}

async function safeSet(obj) {
    return new Promise((resolve) => {
        try {
            if (typeof chrome === "undefined" || !chrome.runtime?.id) {
                return resolve(false);
            }
            chrome.storage.local.set(obj, () => {
                resolve(!chrome.runtime.lastError);
            });
        } catch (e) { 
            resolve(false); 
        }
    });
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));

// Minimum contribution threshold - employees below this require wage adjustment
const MIN_CTB = 79.35;

// ==================== PHASE A: FOUNDATION UTILITIES ====================

/**
 * Generate a UUID v4 for unique employer record identification
 */
function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

/**
 * DJB2 hash for efficient data comparison
 * Used to detect if scraped data actually changed (for dashboard refresh optimization)
 */
function djb2Hash(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash) + str.charCodeAt(i);
    }
    return hash >>> 0; // Convert to unsigned 32-bit integer
}

/**
 * Compute fingerprint of scraped results for change detection
 * Includes content (not just length) to detect edits
 */
function computeScrapedFingerprint(scrapedResults) {
    if (!scrapedResults || scrapedResults.length === 0) return 0;

    const contentStr = scrapedResults.map(r => {
        const p1 = r.p1Records?.find(p => p.type === 'NORMAL') || {};
        return `${r.er}:${r.employerName}:${p1.lf || 0}:${p1.amt || 0}:${r.alreadyCaptured}:${r.continuityError}:${r.zeroCrError}:${r.isSelfCapture}`;
    }).join('|');

    return djb2Hash(contentStr);
}

/**
 * Normalize month text to handle various portal formats
 * "December 2025" -> "december 2025"
 * "DEC 2025" -> "december 2025"
 * "2025-12" -> "december 2025"
 */
function normalizeMonthText(text) {
    if (!text) return '';

    const monthNames = {
        'jan': 'january', 'january': 'january',
        'feb': 'february', 'february': 'february',
        'mar': 'march', 'march': 'march',
        'apr': 'april', 'april': 'april',
        'may': 'may',
        'jun': 'june', 'june': 'june',
        'jul': 'july', 'july': 'july',
        'aug': 'august', 'august': 'august',
        'sep': 'september', 'sept': 'september', 'september': 'september',
        'oct': 'october', 'october': 'october',
        'nov': 'november', 'november': 'november',
        'dec': 'december', 'december': 'december'
    };

    const normalized = text.toLowerCase().trim();

    // Handle ISO format: 2025-12 -> december 2025
    const isoMatch = normalized.match(/^(\d{4})-(\d{2})$/);
    if (isoMatch) {
        const monthNum = parseInt(isoMatch[2]) - 1;
        const monthName = Object.values(monthNames)[monthNum * 2] || ''; // Skip abbreviations
        return `${monthName} ${isoMatch[1]}`;
    }

    // Replace month abbreviations with full names
    for (const [abbr, full] of Object.entries(monthNames)) {
        const regex = new RegExp(`\\b${abbr}\\b`, 'gi');
        if (regex.test(normalized)) {
            return normalized.replace(regex, full);
        }
    }

    return normalized;
}

/**
 * Get previous month label in multiple formats for flexible matching
 * Target: 202501 -> Returns array of possible formats: ["December 2025", "Dec 2025", "2024-12"]
 */
function getPreviousMonthLabels(yyyymm) {
    if (!yyyymm || yyyymm.length !== 6) return [];

    const year = parseInt(yyyymm.substring(0, 4));
    const month = parseInt(yyyymm.substring(4, 6)) - 1; // 0-indexed

    // Go back one month
    const prevDate = new Date(year, month - 1, 1);
    const prevYear = prevDate.getFullYear();
    const prevMonth = prevDate.getMonth();

    // Various format options
    return [
        prevDate.toLocaleString('en-GB', { month: 'long', year: 'numeric' }),
        prevDate.toLocaleString('en-US', { month: 'long', year: 'numeric' }),
        prevDate.toLocaleString('en-GB', { month: 'short', year: 'numeric' }).toUpperCase(),
        `${prevYear}-${String(prevMonth + 1).padStart(2, '0')}`
    ];
}

// ==================== UNIFIED EMPLOYER RECORD (Phase G Foundation) ====================

/**
 * Unified Employer Record Structure
 * This is the target data model that consolidates all phase-specific arrays into a single structure.
 * Status fields allow filtering: employers.filter(e => e.captureStatus === 'pending')
 *
 * @typedef {Object} UnifiedEmployer
 * @property {string} id - UUID generated at scrape time
 * @property {string} er - 9-digit employer number
 * @property {string} name - Employer name
 * @property {string} period - Target period (YYYYMM)
 *
 * // Phase 1 - Scraping
 * @property {Array} p1Records - Previous month records [{period, type, lf, amt}]
 * @property {Array} p2Records - Month before previous
 * @property {number} scrapedAt - Timestamp when scraped
 * @property {boolean} continuityError - Missing P1/P2 data
 * @property {boolean} zeroCrError - Zero LF or amount in P1
 * @property {boolean} isSelfCapture - Globe icon detected
 *
 * // Phase 2 - Capture
 * @property {string} captureStatus - pending|captured|failed|skipped|already_captured
 * @property {number} capturedAt - Timestamp when captured
 * @property {string} captureMessage - Error or success message
 *
 * // Phase 3 - Validation
 * @property {string} validationStatus - pending|imported|submitted|validated|failed
 * @property {number} validatedAt - Timestamp when validated
 * @property {Array} ctbIssues - [{ssNumber, name, currentCtb, requiredAdjustment}]
 * @property {boolean} needsWageEdit - Requires wage adjustment
 *
 * // Phase 3B - Wage Edit
 * @property {string} wageEditStatus - pending|edited|failed
 * @property {number} originalTotal - Total before adjustment
 * @property {number} adjustedTotal - Total after applying MIN_CTB
 * @property {number} wageEditedAt - Timestamp when edited
 */

/**
 * Create a new unified employer record from scraped data
 * This function serves as a factory for the new data model
 */
function createUnifiedEmployer(er, name, period, p1Records = [], p2Records = []) {
    return {
        // Identity
        id: generateUUID(),
        er: er,
        name: name,
        period: period,

        // Phase 1 - Scraping
        p1Records: p1Records,
        p2Records: p2Records,
        scrapedAt: Date.now(),
        continuityError: false,
        zeroCrError: false,
        isSelfCapture: false,

        // Phase 2 - Capture
        captureStatus: 'pending',
        capturedAt: null,
        captureMessage: '',

        // Phase 3 - Validation
        validationStatus: 'pending',
        validatedAt: null,
        ctbIssues: [],
        needsWageEdit: false,

        // Phase 3B - Wage Edit
        wageEditStatus: 'pending',
        originalTotal: 0,
        adjustedTotal: 0,
        wageEditedAt: null
    };
}

/**
 * Convert legacy scraped result to unified format
 * Provides backwards compatibility during migration
 */
function legacyToUnifiedEmployer(legacyResult, period) {
    const p1Normal = legacyResult.p1Records?.find(r => r.type === 'NORMAL');

    const unified = createUnifiedEmployer(
        legacyResult.er,
        legacyResult.employerName,
        period,
        legacyResult.p1Records || [],
        legacyResult.p2Records || []
    );

    // Copy legacy flags
    unified.id = legacyResult.id || generateUUID();
    unified.scrapedAt = legacyResult.scrapedAt || Date.now();
    unified.continuityError = legacyResult.continuityError || false;
    unified.zeroCrError = legacyResult.zeroCrError || false;
    unified.isSelfCapture = legacyResult.isSelfCapture || false;

    // Set capture status based on legacy flags
    if (legacyResult.alreadyCaptured) {
        unified.captureStatus = 'already_captured';
    }

    return unified;
}

/**
 * Get employers by status (filter helper for unified model)
 * Example: getEmployersByStatus(employers, 'captureStatus', 'pending')
 */
function getEmployersByStatus(employers, statusField, statusValue) {
    return (employers || []).filter(e => e[statusField] === statusValue);
}

// ==================== PAGE DESCRIPTORS ====================

/**
 * Page descriptors define selectors and elements for each portal page
 * This abstracts away DOM specifics and makes the code more maintainable
 */
const PAGE_DESCRIPTORS = {
    viewCrsReport: {
        urlPattern: '/view_crs/report',
        table: '#mytable',
        erColumn: 2,
        nameColumn: 3,
        periodColumn: 8,
        typeColumn: 5,
        lfColumn: 6,
        amtColumn: 10,
        erInput: 'input[placeholder="ER Number"], input[data-v-6d729868]',
        searchButton: { text: 'SEARCH' }
    },

    receiveEmployer: {
        urlPattern: '/receive/employer',
        erInput: 'input[maxlength="9"].form-control:not(#changeER)',
        continueButton: '#addToTable'
    },

    receiveCapture: {
        urlPattern: '/receive/capture',
        periodInputs: 'input[placeholder*="YYYYMM"]',
        mediaRadio: 'input[name="sub_media"][value="1"]',
        modeRadio: 'input[name="sub_mod"][value="2"]',
        lfInput: '#no_employees',
        submitButton: '#addToTable2',
        headerTitle: 'h4.text-info'
    },

    viewCrsUnprocessed: {
        urlPattern: '/view_crs/unprocessed',
        table: 'table.table',
        erColumn: 1, // ER is typically in column index 1-2, will search dynamically
        dataEntryLink: 'a[href*="data-entry"]',
        editPrivateLink: 'a[href*="edit-private"]'
    },

    dataEntry: {
        urlPattern: '/data-entry',
        importButton: { text: 'import' },
        submitButton: { text: 'submit', contains: 'validation' },
        employeeTable: 'table.table-striped',
        ctbColumn: 7, // Contribution column (0-indexed)
        autoPostCheckbox: 'input[type="checkbox"]#checkbox2, input[type="checkbox"][name="checkboxInline"]'
    },

    editPrivate: {
        urlPattern: '/receive/edit-private',
        totalContributionLabel: 'total contribution',
        updateButton: { text: 'update' },
        headerTitle: 'h3.text-info, h4.text-info'
    }
};

// ==================== PAGEOPS ABSTRACTION LAYER ====================

/**
 * PageOps provides shared methods for interacting with portal pages
 * Uses PAGE_DESCRIPTORS for consistent, maintainable selectors
 */
const PageOps = {
    /**
     * Detect current page and return merged descriptor
     */
    detectPage() {
        const url = window.location.href;
        for (const [pageName, descriptor] of Object.entries(PAGE_DESCRIPTORS)) {
            if (url.includes(descriptor.urlPattern)) {
                return { name: pageName, ...descriptor };
            }
        }
        return null;
    },

    /**
     * Find a button by text content (case-insensitive, partial match supported)
     * @param {Object} matcher - { text: string, contains?: string }
     * @returns {HTMLElement|null}
     */
    findButton(matcher) {
        if (!matcher) return null;

        const buttons = Array.from(document.querySelectorAll('button'));
        return buttons.find(btn => {
            const text = (btn.textContent || '').toLowerCase();
            if (matcher.text && !text.includes(matcher.text.toLowerCase())) return false;
            if (matcher.contains && !text.includes(matcher.contains.toLowerCase())) return false;
            return !btn.disabled;
        }) || null;
    },

    /**
     * Find a table row by ER number using column-specific search (O(R) instead of O(R×C))
     * @param {string} er - ER number to find
     * @param {string} tableSelector - CSS selector for the table
     * @param {number} erColumnIndex - Column index for ER (0-indexed), or -1 for any column
     * @returns {HTMLElement|null}
     */
    findTableRowByER(er, tableSelector = 'table.table', erColumnIndex = -1) {
        const table = document.querySelector(tableSelector);
        if (!table) return null;

        const rows = table.querySelectorAll('tbody tr');

        for (const row of rows) {
            const cells = row.querySelectorAll('td');

            if (erColumnIndex >= 0 && erColumnIndex < cells.length) {
                // Column-specific search (faster)
                if (cells[erColumnIndex]?.textContent?.trim() === er) {
                    return row;
                }
            } else {
                // Fallback: search all columns
                for (const cell of cells) {
                    if (cell.textContent?.trim() === er) {
                        return row;
                    }
                }
            }
        }

        return null;
    },

    /**
     * Find input by associated label text
     * @param {string} labelText - Text to match in label (case-insensitive)
     * @returns {HTMLInputElement|null}
     */
    findInputByLabel(labelText) {
        const labels = document.querySelectorAll('label');
        const searchText = labelText.toLowerCase();

        for (const label of labels) {
            const text = (label.innerText || '').toLowerCase();
            if (text.includes(searchText)) {
                // Check for explicit "for" attribute
                if (label.htmlFor) {
                    const input = document.getElementById(label.htmlFor);
                    if (input) return input;
                }

                // Check parent form-group
                const formGroup = label.closest('.form-group') || label.parentElement;
                if (formGroup) {
                    const input = formGroup.querySelector('input[type="text"], input.form-control, input[type="number"]');
                    if (input) return input;
                }
            }
        }

        return null;
    },

    /**
     * Detect modal state with priority-based detection
     * Priority: Consent > Receipt > Error > Success > Unknown
     * @returns {{ type: string|null, element: HTMLElement|null, message: string }}
     */
    detectModal() {
        // Check 0: Consent/Confirmation Modal (Submit for Validation confirmation)
        // Container: .custom-alert (NOT .custom-alert-container)
        // Has warning icon and "Submit for Validation" title
        const consentAlerts = document.querySelectorAll('.custom-alert');
        for (const alert of consentAlerts) {
            if (alert.offsetParent === null) continue;

            const warningIcon = alert.querySelector('.icon.warning, .icon.warning.pulseWarning');
            const title = alert.querySelector('.custom-alert-title');
            const titleText = (title?.innerText || '').toLowerCase();

            if (warningIcon && (titleText.includes('submit') || titleText.includes('validation'))) {
                return {
                    type: 'consent',
                    element: alert,
                    message: 'Submit for Validation confirmation'
                };
            }
        }

        // Check 1: Receipt/Acknowledgement Modal (SUCCESS)
        const receiptHeader = document.querySelector('.custom-alert-container-header');
        if (receiptHeader && receiptHeader.offsetParent !== null) {
            const headerText = (receiptHeader.innerText || '').toUpperCase();
            if (headerText.includes('SSNIT PENSION SYSTEM') || headerText.includes('ACKNOWLEDGEMENT')) {
                return {
                    type: 'receipt',
                    element: receiptHeader.closest('.custom-alert-container'),
                    message: 'Acknowledgement Letter'
                };
            }
        }

        // Check 2: Error Modal - X icon
        const errorIcon = document.querySelector('.icon.error, .icon.error.animateErrorIcon');
        if (errorIcon && errorIcon.offsetParent !== null) {
            const container = errorIcon.closest('.custom-alert-container') || errorIcon.closest('.custom-alert');
            const message = container?.querySelector('.custom-alert-message')?.innerText || '';
            return { type: 'error', element: container, message };
        }

        // Check 3: Success Modal - green checkmark
        const successIcon = document.querySelector('.icon.success, .icon.success.animate');
        if (successIcon && successIcon.offsetParent !== null) {
            const container = successIcon.closest('.custom-alert-container') || successIcon.closest('.custom-alert');
            return { type: 'success', element: container, message: 'Success' };
        }

        // Check 4: Button-based fallback
        const btnError = document.querySelector('.custom-alert .btn-error, .custom-alert-container .btn-error');
        if (btnError && btnError.offsetParent !== null) {
            const container = btnError.closest('.custom-alert-container') || btnError.closest('.custom-alert');
            const message = container?.querySelector('.custom-alert-message')?.innerText || '';
            return { type: 'error', element: container, message };
        }

        const btnSuccess = document.querySelector('.custom-alert .btn-success, .custom-alert-container .btn-success');
        if (btnSuccess && btnSuccess.offsetParent !== null) {
            const container = btnSuccess.closest('.custom-alert-container') || btnSuccess.closest('.custom-alert');
            return { type: 'success', element: container, message: 'Data Successfully Saved' };
        }

        // Check 5: Text-based fallback
        const alertContainers = document.querySelectorAll('.custom-alert-container, .custom-alert');
        for (const container of alertContainers) {
            if (container.offsetParent === null) continue;

            const text = (container.innerText || '').toLowerCase();
            if (text.includes('data successfully saved') || text.includes('contribution report received')) {
                return { type: 'success', element: container, message: 'Data Successfully Saved' };
            }
            if (text.includes('errors occured') || text.includes('already exists')) {
                return {
                    type: 'error',
                    element: container,
                    message: container.querySelector('.custom-alert-message')?.innerText || ''
                };
            }
        }

        // Check 6: Unknown modal
        for (const container of alertContainers) {
            if (container.offsetParent === null) continue;
            const message = container.querySelector('.custom-alert-message')?.innerText ||
                           container.querySelector('.custom-alert-title')?.innerText ||
                           'Unknown modal';
            return { type: 'unknown', element: container, message };
        }

        return { type: null, element: null, message: '' };
    },

    /**
     * Set Vue input value with proper event dispatch
     * Uses blur → wait → focus → inject → blur → wait protocol
     * @param {HTMLInputElement} element - Input element
     * @param {string|number} value - Value to set
     */
    async setVueInput(element, value) {
        if (!element) return false;

        element.blur();
        await wait(100);
        element.focus();
        await wait(50);
        setNativeValue(element, value);
        element.blur();
        await wait(200);

        return true;
    },

    /**
     * Get table element by selector with header validation
     * @param {string} selector - CSS selector
     * @param {string} headerText - Required header text (optional)
     * @returns {HTMLTableElement|null}
     */
    getTable(selector, headerText = null) {
        const tables = document.querySelectorAll(selector);

        if (!headerText) {
            return tables[0] || null;
        }

        for (const table of tables) {
            const headers = table.querySelectorAll('thead th');
            for (const th of headers) {
                if (th.textContent?.toLowerCase().includes(headerText.toLowerCase())) {
                    return table;
                }
            }
        }

        return null;
    },

    /**
     * Click a Vue custom radio button properly
     * Vue custom radios need the wrapper clicked, not the input
     * @param {HTMLInputElement} radio - Radio input element
     */
    async clickVueRadio(radio) {
        if (!radio) return false;

        // First try clicking the parent wrapper
        const wrapper = radio.closest('.radio-custom') ||
                       radio.closest('.radio-inline') ||
                       radio.parentElement;

        if (wrapper && wrapper !== radio) {
            wrapper.click();
            await wait(100);
        }

        // Also set checked state and dispatch events
        radio.checked = true;
        radio.dispatchEvent(new Event('change', { bubbles: true }));
        radio.dispatchEvent(new Event('input', { bubbles: true }));
        radio.dispatchEvent(new Event('click', { bubbles: true }));

        await wait(100);
        return radio.checked;
    }
};

/**
 * Handle consent/confirmation modal (e.g., "Submit for Validation" confirmation)
 * Clicks the "Yes" or confirmation button
 * @param {HTMLElement} modalElement - The modal element
 * @returns {boolean} - Whether the modal was handled
 */
async function handleConsentModal(modalElement) {
    if (!modalElement) return false;

    // Look for "Yes" or confirmation button (.btn-success in the modal)
    const yesBtn = modalElement.querySelector('.btn-success') ||
                   Array.from(modalElement.querySelectorAll('button')).find(btn =>
                       btn.textContent.toLowerCase().includes('yes')
                   );

    if (yesBtn) {
        log('Clicking consent confirmation...', 'info');
        yesBtn.click();
        await wait(300);
        return true;
    }

    return false;
}

/**
 * Ask background if this tab is the automation tab (where scraping/capture/validation run).
 * Only the tab where the user started automation runs actions.
 * Falls back to storage check if background script is unavailable.
 */
function isAutomationTab() {
    return new Promise((resolve) => {
        if (typeof chrome === 'undefined' || !chrome.runtime?.id) {
            resolve(false);
            return;
        }
        
        // Try to ask background script first (most reliable)
        try {
            chrome.runtime.sendMessage({ type: 'isAutomationTab' }, (response) => {
                if (chrome.runtime.lastError) {
                    // Background script not available - this tab is NOT the automation tab
                    // (Background script should always be available in the automation tab)
                    log('Background script unavailable - not automation tab', 'warn');
                    resolve(false);
                    return;
                }
                resolve(response?.isAutomationTab === true);
            });
        } catch (e) {
            log('Error checking automation tab: ' + e.message, 'error');
            resolve(false);
        }
    });
}

/**
 * Register this tab as the automation tab (e.g. when user clicks Start Capture in this tab).
 */
function registerThisTabAsAutomationTab() {
    return new Promise((resolve) => {
        if (typeof chrome === 'undefined' || !chrome.runtime?.id) {
            resolve(false);
            return;
        }
        chrome.runtime.sendMessage({ type: 'registerAutomationTab' }, (response) => {
            resolve(response?.ok === true);
        });
    });
}

async function selectVueOption(labelHint, targetText) {
    try {
        const containers = Array.from(document.querySelectorAll('.form-group, .m-b-5, .m-b-10'));
        const targetContainer = containers.find(c => (c.innerText || '').includes(labelHint));
        
        if (!targetContainer) return false;

        const toggle = targetContainer.querySelector('.dropdown-toggle, .v-select');
        if (toggle) {
            toggle.click();
            await wait(600);
        }

        const options = Array.from(document.querySelectorAll('.vs__dropdown-menu li, .vs__dropdown-option, .dropdown-menu li'));
        const choice = options.find(opt => (opt.innerText || '').trim().toUpperCase() === targetText.toUpperCase());
        
        if (choice) {
            choice.click();
            await wait(300);
            return true;
        }
        
        const searchInput = targetContainer.querySelector('input[type="search"], input.form-control');
        if (searchInput && searchInput.offsetParent !== null) {
            setNativeValue(searchInput, targetText);
            await wait(400);
            searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
            await wait(300);
            return true;
        }
        
        return false;
    } catch (e) {
        return false;
    }
}


// ==================== LOGIN DETECTION ====================

function isLoginPage() {
    // Check for login page indicators
    const loginDiv = document.querySelector('div.login');
    const emailInput = document.querySelector('#email[type="email"]');
    const passwordInput = document.querySelector('#password[type="password"]');
    const loginBtn = Array.from(document.querySelectorAll('button')).find(b => 
        b.innerText.trim().toUpperCase() === 'LOG IN'
    );
    
    return !!(loginDiv || (emailInput && passwordInput && loginBtn));
}


// ==================== GLOBAL STATE ====================

let isPaused = false;
let scrapingStarted = false;
let extractionInProgress = false;
let captureInProgress = false;
let captureInterval = null;
let stuckCounter = 0;
const MAX_STUCK_COUNT = 5; // After 5 cycles with no progress, take action

// Track which ER is currently being edited (to prevent UI refresh from overwriting)
let currentlyEditingER = null;

// Track if user is interacting with dashboard (hovering, selecting text, etc.)
let userInteractingWithDashboard = false;

// Store hash of last rendered data to avoid unnecessary re-renders
let lastDataHash = null;


// ==================== PHASE 1: SCRAPING (NO RELOAD VERSION) ====================

// Scraping interval reference for the continuous loop
let scrapingInterval = null;

/**
 * Start the scraping phase - runs as a continuous async loop WITHOUT page reloads
 * This fixes issues #1 (progress bar), #2 (pause/login), and #11 (multi-tab sync)
 */
async function runScrapingPhase(currentER) {
    if (scrapingStarted) return;
    scrapingStarted = true;

    log(`Starting scraping loop for ER: ${currentER}`);

    // Run the scraping loop
    runScrapingLoop();
}

/**
 * Main scraping loop - polls at interval and handles pause/login/extraction
 */
function runScrapingLoop() {
    if (scrapingInterval) clearInterval(scrapingInterval);

    scrapingInterval = setInterval(async () => {
        if (extractionInProgress) return;

        // Check pause state
        const pauseData = await safeGet(['isPaused']);
        if (pauseData?.isPaused) {
            isPaused = true;
            return;
        }
        isPaused = false;

        // Check for login page
        if (isLoginPage()) {
            log('Login page detected - pausing scraping', 'warn');
            await safeSet({ loginPending: true });
            return;
        }

        await doScrapingStep();
    }, 2000);
}

/**
 * Single step of the scraping process
 * Handles: searching for ER, waiting for table, extracting data, advancing to next ER
 */
async function doScrapingStep() {
    const state = await safeGet(['erQueue', 'currentER', 'targetPeriod', 'scrapedResults', 'originalErCount']);
    if (!state) return;

    const erQueue = state.erQueue || [];
    const currentER = state.currentER;
    const scraped = state.scrapedResults || [];
    const originalCount = state.originalErCount || erQueue.length + scraped.length;

    // Update progress bar dynamically
    const progressFill = document.getElementById('progress-fill');
    if (progressFill && originalCount > 0) {
        const pct = (scraped.length / originalCount) * 100;
        progressFill.style.width = `${pct}%`;
        progressFill.style.background = '#10b981';
    }

    // Check if scraping is complete
    if (!currentER || erQueue.length === 0) {
        log('Scraping Complete!', 'success');
        if (scrapingInterval) {
            clearInterval(scrapingInterval);
            scrapingInterval = null;
        }
        await safeSet({ phase: 'IDLE' }); // Ready for capture
        updateDashboardUI();
        return;
    }

    // Check if ER already scraped
    if (scraped.some(r => r.er === currentER)) {
        log(`ER ${currentER} already scraped, moving to next...`, 'warn');
        await proceedToNextScrape();
        return;
    }

    // Find the ER input field
    const erField = document.querySelector('input[placeholder="ER Number"]') ||
                    document.querySelector('input[data-v-6d729868]');

    if (!erField || erField.offsetParent === null) {
        // Form not ready yet
        return;
    }

    // Check if we need to enter the ER or wait for results
    const table = document.querySelector('#mytable');
    const hasTableData = table?.querySelectorAll('tbody tr').length > 0;
    const currentTableER = hasTableData ? table.querySelector('tbody tr')?.cells[2]?.innerText?.trim() : null;

    // If table shows wrong ER or is empty, we need to search
    if (currentTableER !== currentER) {
        // Clear and enter the current ER
        await clearAndSearchER(erField, currentER);
        return;
    }

    // Table shows correct ER - extract data
    await extractDataFromTable();
}

/**
 * Clear the search form and search for a new ER
 */
async function clearAndSearchER(erField, er) {
    extractionInProgress = true;

    try {
        // Clear the input first
        erField.blur();
        await wait(100);

        // Clear any existing value
        setNativeValue(erField, '');
        await wait(200);

        // Enter the new ER
        erField.focus();
        await wait(50);
        setNativeValue(erField, er);
        erField.blur();
        await wait(400);

        // Click search button
        const searchBtn = PageOps.findButton({ text: 'SEARCH' });
        if (searchBtn) {
            log(`Searching for ER: ${er}`);
            searchBtn.click();
            await wait(2500); // Wait for results to load
        } else {
            log('Search button not found', 'error');
        }
    } finally {
        extractionInProgress = false;
    }
}

/**
 * Skip to next ER without page reload
 */
async function skipToNextER(reason) {
    const state = await safeGet(['erQueue', 'currentER']);
    if (!state) return;

    log(`Skipping ER ${state.currentER}: ${reason}`, 'warn');
    await proceedToNextScrape();
}

/**
 * Advance to the next ER in the queue without page reload
 */
async function proceedToNextScrape() {
    const state = await safeGet(['erQueue', 'currentER']);
    if (!state) return;

    const nextQueue = (state.erQueue || []).slice(1);
    const nextER = nextQueue[0] || null;

    await safeSet({ erQueue: nextQueue, currentER: nextER });

    // Clear the table to prepare for next search
    const table = document.querySelector('#mytable tbody');
    if (table) {
        table.innerHTML = ''; // Clear table rows
    }

    // Clear the ER input
    const erField = document.querySelector('input[placeholder="ER Number"]') ||
                    document.querySelector('input[data-v-6d729868]');
    if (erField) {
        setNativeValue(erField, '');
    }

    await wait(300);

    // Dashboard will update automatically via storage listener
    log(`Moving to next ER: ${nextER || 'DONE'}`, 'info');
}

/**
 * Extract data from the table and save to storage
 */
async function extractDataFromTable() {
    if (extractionInProgress) return;
    extractionInProgress = true;

    try {
        const state = await safeGet(['targetPeriod', 'currentER', 'scrapedResults', 'erQueue']);
        if (!state || !state.currentER) return;

        const currentER = state.currentER;
        const existingResults = state.scrapedResults || [];

        if (existingResults.some(r => r.er === currentER)) {
            log(`ER ${currentER} already scraped, skipping...`, 'warn');
            await proceedToNextScrape();
            return;
        }

        const seq = getSequence(state.targetPeriod);
        const table = document.querySelector('#mytable');

        let data = {
            id: generateUUID(),
            er: currentER,
            employerName: "Unknown",
            p1Records: [],
            p2Records: [],
            alreadyCaptured: false,
            continuityError: false,
            isSelfCapture: false,
            zeroCrError: false,
            scrapedAt: Date.now()
        };

        if (table) {
            const rows = Array.from(table.querySelectorAll('tbody tr'));

            if (rows.length > 0) {
                const tableER = rows[0].cells[2]?.innerText?.trim();
                if (tableER && tableER !== currentER) {
                    log(`Table ER mismatch (expected ${currentER}, got ${tableER}), retrying...`, 'warn');
                    // Don't abort - just wait for next tick to retry
                    return;
                }

                data.employerName = rows[0].cells[3]?.innerText?.trim() || "Unknown";

                rows.forEach(row => {
                    if (row.cells.length >= 11) {
                        const iconCell = row.cells[0];
                        if (iconCell.querySelector('i.fa-globe')) {
                            data.isSelfCapture = true;
                        }

                        const period = row.cells[8]?.innerText?.trim().toUpperCase() || "";
                        const type = row.cells[5]?.innerText?.trim().toUpperCase() || "";

                        const record = {
                            period, type,
                            lf: parseInt(row.cells[6]?.innerText?.trim()) || 0,
                            amt: parseFloat(row.cells[10]?.innerText?.trim().replace(/[^\d.]/g, '')) || 0
                        };

                        if (period === seq.targetLabel) data.alreadyCaptured = true;
                        if (period === seq.p1Label) data.p1Records.push(record);
                        if (period === seq.p2Label) data.p2Records.push(record);
                    }
                });
            }
        }

        if (data.p1Records.length === 0) data.continuityError = true;

        const normalP1 = data.p1Records.find(r => r.type === 'NORMAL');
        if (normalP1 && (normalP1.lf === 0 || normalP1.amt === 0)) data.zeroCrError = true;

        const newResults = [...existingResults, data];

        log(`Extracted ${data.er}: ${data.employerName}`, 'success');

        // Save results and advance to next ER
        await safeSet({ scrapedResults: newResults });
        await proceedToNextScrape();

    } finally {
        extractionInProgress = false;
    }
}


// ==================== PHASE 2: CAPTURE ====================

// Track submission state for retry logic
let lastSubmitTime = 0;
let awaitingResponse = false;
const RESPONSE_TIMEOUT_MS = 12000; // 12 seconds to wait for modal response

async function handleCapturePhase() {
    if (captureInProgress || isPaused) return;
    captureInProgress = true;
    
    try {
        // Check for login page first
        if (isLoginPage()) {
            log('Login page detected during capture', 'warn');
            await safeSet({ loginPending: true });
            captureInProgress = false;
            return;
        }
        
        await doCaptureStep();
    } catch (e) {
        log(`Capture error: ${e.message}`, 'error');
    } finally {
        captureInProgress = false;
    }
}

/**
 * Detects visible response modals by checking for icon elements, button classes, and text
 * Priority order: Receipt > Icon-based > Button-based > Text-based > Unknown modal
 * 
 * Returns: { type: 'success'|'error'|'receipt'|'unknown'|null, element: HTMLElement|null, message: string }
 */
function detectModalState() {
    // Check 1: Receipt/Acknowledgement Modal (SUCCESS)
    // Has unique header with "SSNIT Pension System" or "ACKNOWLEDGEMENT"
    const receiptHeader = document.querySelector('.custom-alert-container-header');
    if (receiptHeader && receiptHeader.offsetParent !== null) {
        const headerText = (receiptHeader.innerText || '').toUpperCase();
        if (headerText.includes('SSNIT PENSION SYSTEM') || headerText.includes('ACKNOWLEDGEMENT')) {
            log('Modal detected: RECEIPT (Acknowledgement Letter)', 'success');
            return { type: 'receipt', element: receiptHeader.closest('.custom-alert-container'), message: 'Acknowledgement Letter' };
        }
    }
    
    // Check 2: Error Modal - Look for the X icon (most reliable)
    // Structure: <div class="icon error animateErrorIcon"><span class="x-mark">
    const errorIcon = document.querySelector('.icon.error, .icon.error.animateErrorIcon');
    if (errorIcon && errorIcon.offsetParent !== null) {
        const container = errorIcon.closest('.custom-alert-container') || errorIcon.closest('.custom-alert');
        const message = container?.querySelector('.custom-alert-message')?.innerText || '';
        log('Modal detected: ERROR (X icon)', 'warn');
        return { type: 'error', element: container, message };
    }
    
    // Check 3: Success Modal - Look for the green checkmark icon
    // Structure: <div class="icon success animate">
    const successIcon = document.querySelector('.icon.success, .icon.success.animate');
    if (successIcon && successIcon.offsetParent !== null) {
        const container = successIcon.closest('.custom-alert-container') || successIcon.closest('.custom-alert');
        log('Modal detected: SUCCESS (checkmark icon)', 'success');
        return { type: 'success', element: container, message: 'Data Successfully Saved' };
    }
    
    // Check 4: Button-based fallback (if icons didn't render but buttons exist)
    // Look for visible .btn-error or .btn-success in a modal context
    const btnError = document.querySelector('.custom-alert .btn-error, .custom-alert-container .btn-error');
    if (btnError && btnError.offsetParent !== null) {
        const container = btnError.closest('.custom-alert-container') || btnError.closest('.custom-alert');
        const message = container?.querySelector('.custom-alert-message')?.innerText || '';
        log('Modal detected: ERROR (.btn-error fallback)', 'warn');
        return { type: 'error', element: container, message };
    }
    
    const btnSuccess = document.querySelector('.custom-alert .btn-success, .custom-alert-container .btn-success');
    if (btnSuccess && btnSuccess.offsetParent !== null) {
        const container = btnSuccess.closest('.custom-alert-container') || btnSuccess.closest('.custom-alert');
        log('Modal detected: SUCCESS (.btn-success fallback)', 'success');
        return { type: 'success', element: container, message: 'Data Successfully Saved' };
    }
    
    // Check 5: Text-based fallback for edge cases
    const alertContainers = document.querySelectorAll('.custom-alert-container, .custom-alert');
    for (const container of alertContainers) {
        if (container.offsetParent === null) continue; // Skip hidden elements
        
        const text = (container.innerText || '').toLowerCase();
        if (text.includes('data successfully saved') || text.includes('contribution report received')) {
            log('Modal detected: SUCCESS (text fallback)', 'success');
            return { type: 'success', element: container, message: 'Data Successfully Saved' };
        }
        if (text.includes('errors occured') || text.includes('already exists')) {
            log('Modal detected: ERROR (text fallback)', 'warn');
            return { type: 'error', element: container, message: container.querySelector('.custom-alert-message')?.innerText || '' };
        }
    }
    
    // Check 6: Unknown modal - a visible modal that doesn't match any pattern
    // This triggers a pause for user intervention
    for (const container of alertContainers) {
        if (container.offsetParent === null) continue;
        // If we reach here, there's a visible modal we don't recognize
        const message = container.querySelector('.custom-alert-message')?.innerText || 
                       container.querySelector('.custom-alert-title')?.innerText || 
                       'Unknown modal';
        log('Modal detected: UNKNOWN - requires intervention', 'error');
        return { type: 'unknown', element: container, message };
    }
    
    return { type: null, element: null, message: '' };
}

/**
 * Handle modal by clicking the appropriate button
 * Returns true if modal was handled, false otherwise
 */
async function handleModal(modalType, modalElement) {
    if (!modalElement) return false;
    
    if (modalType === 'receipt') {
        // Receipt modal: Click Cancel or Close button
        const closeBtn = modalElement.querySelector('button.close') || 
                        modalElement.querySelector('.btn-grey') ||
                        modalElement.querySelector('.custom-alert-footer button');
        if (closeBtn) {
            log('Closing receipt modal...', 'info');
            closeBtn.click();
            await wait(300);
            return true;
        }
    }
    
    if (modalType === 'success') {
        // Success modal: Click Close (.btn-success) or any button
        const closeBtn = modalElement.querySelector('.btn-success') || 
                        modalElement.querySelector('.custom-alert-footer button');
        if (closeBtn) {
            log('Closing success modal...', 'info');
            closeBtn.click();
            await wait(300);
            return true;
        }
    }
    
    if (modalType === 'error') {
        // Error modal: Click OK button (.btn-error or any footer button)
        const okBtn = modalElement.querySelector('.btn-error') || 
                     modalElement.querySelector('.custom-alert-footer button');
        if (okBtn) {
            log('Closing error modal...', 'info');
            okBtn.click();
            await wait(300);
            return true;
        }
    }
    
    return false;
}

/**
 * Advance to next ER in queue and navigate to employer page
 * Results:
 *   - 'success': Captured by automation (receipt or success modal)
 *   - 'already_captured': Was already captured before (duplicate error)
 *   - 'error': Validation/submission error (not duplicate)
 *   - 'failed': No response detected after retry
 *   - 'skipped': Manually skipped by user
 */
async function advanceToNextER(currentER, result, capturedList, failedList, index, errorMessage = '') {
    // Update the capture results with the outcome
    const captureResults = await safeGet(['captureResults', 'captureQueue']) || {};
    const results = captureResults.captureResults || {};
    const queue = captureResults.captureQueue || [];
    results[currentER] = { result, timestamp: Date.now(), message: errorMessage };

    // 'success' and 'already_captured' go to capturedList (job done for this ER)
    // 'error', 'failed', 'skipped' go to failedList (needs attention)
    if (result === 'success' || result === 'already_captured') {
        capturedList.push(currentER);
    } else {
        failedList.push(currentER);
    }

    const newIndex = index + 1;
    const isComplete = newIndex >= queue.length;

    // Build state update
    const stateUpdate = {
        capturedErs: capturedList,
        failedErs: failedList,
        currentCaptureIndex: newIndex,
        retryCount: 0,
        captureResults: results,
        awaitingResponse: false,
        interventionRequired: false
    };

    // If this was the last item, mark phase as COMPLETE
    if (isComplete && queue.length > 0) {
        stateUpdate.phase = 'COMPLETE';
        log('Capture complete!', 'success');
        if (captureInterval) {
            clearInterval(captureInterval);
            captureInterval = null;
        }
    }

    await safeSet(stateUpdate);

    const logType = (result === 'success' || result === 'already_captured') ? 'success' : 'error';
    log(`ER ${currentER} marked as: ${result.toUpperCase()}${errorMessage ? ` (${errorMessage.substring(0, 50)})` : ''}`, logType);

    // Reset counters
    stuckCounter = 0;
    awaitingResponse = false;
    lastSubmitTime = 0;

    // Navigate: if complete, just reload to show dashboard; otherwise go to employer page
    await wait(400);
    if (isComplete) {
        window.location.reload();
    } else {
        window.location.href = "https://app.issas.ssnit.org.gh/contributions/receive/employer";
    }
}

/**
 * Skip current ER and move to next (user-initiated)
 */
async function skipCurrentER() {
    const data = await safeGet(['captureQueue', 'currentCaptureIndex', 'capturedErs', 'failedErs']);
    if (!data) return;
    
    const queue = data.captureQueue || [];
    const index = data.currentCaptureIndex || 0;
    const capturedList = data.capturedErs || [];
    const failedList = data.failedErs || [];
    
    if (index >= queue.length) return;
    
    const currentER = queue[index].er;
    log(`User skipping ER ${currentER}`, 'warn');
    
    await advanceToNextER(currentER, 'skipped', capturedList, failedList, index, 'Manually skipped by user');
}

/**
 * Add an ER manually (user-initiated during scraping phase)
 * Allows users to enter data for ERs that couldn't be scraped
 */
async function addManualER() {
    const erInput = document.getElementById('manual-er');
    const nameInput = document.getElementById('manual-name');
    const lfInput = document.getElementById('manual-lf');
    const amtInput = document.getElementById('manual-amt');
    
    const er = erInput.value.trim();
    const name = nameInput.value.trim() || 'Manual Entry';
    const lf = parseInt(lfInput.value) || 0;
    const amt = parseFloat(amtInput.value) || 0;
    
    // Validate inputs
    if (!/^\d{9}$/.test(er)) {
        alert('Please enter a valid 9-digit ER number');
        erInput.focus();
        return;
    }
    
    if (lf <= 0) {
        alert('Please enter a valid number of employees (LF)');
        lfInput.focus();
        return;
    }
    
    if (amt <= 0) {
        alert('Please enter a valid contribution amount');
        amtInput.focus();
        return;
    }
    
    const data = await safeGet(['scrapedResults', 'targetPeriod']);
    const existingResults = data?.scrapedResults || [];
    
    // Check if ER already exists
    if (existingResults.some(r => r.er === er)) {
        alert(`ER ${er} already exists in the queue`);
        return;
    }
    
    // Create a manual entry record (simulating scraped data structure)
    // Uses 'MANUAL' as period marker to identify manual entries if needed
    const manualRecord = {
        id: generateUUID(), // Unique identifier for this employer record
        er: er,
        employerName: name,
        p1Records: [{ period: 'MANUAL', type: 'NORMAL', lf: lf, amt: amt }],
        p2Records: [],
        alreadyCaptured: false,
        continuityError: false,
        isSelfCapture: false,
        zeroCrError: false,
        scrapedAt: Date.now()
    };
    
    const newResults = [...existingResults, manualRecord];
    await safeSet({ scrapedResults: newResults });
    
    // Clear inputs
    erInput.value = '';
    nameInput.value = '';
    lfInput.value = '';
    amtInput.value = '';
    
    log(`Manual entry added: ${er} - ${name} (LF: ${lf}, Amt: ${amt})`, 'success');
    
    // Refresh UI
    updateDashboardUI();
}

/**
 * Edit a scraped record (user-initiated)
 * Converts row to editable inputs
 */
async function editScrapedRecord(er) {
    const data = await safeGet(['scrapedResults']);
    const results = data?.scrapedResults || [];
    const recordIndex = results.findIndex(r => r.er === er);
    
    if (recordIndex === -1) return;
    
    const record = results[recordIndex];
    const p1Normal = record.p1Records.find(r => r.type === 'NORMAL') || { lf: 0, amt: 0 };
    
    // Set editing flag to prevent UI refresh from overwriting
    currentlyEditingER = er;
    
    // Find the row and convert to edit mode
    const row = document.querySelector(`tr[data-er="${er}"]`);
    if (!row) return;
    
    row.classList.add('row-editing');
    row.innerHTML = `
        <td><input type="text" class="edit-input edit-er" value="${record.er}" disabled></td>
        <td><input type="text" class="edit-input edit-name" value="${record.employerName}"></td>
        <td><input type="number" class="edit-input edit-lf" value="${p1Normal.lf}" min="0"></td>
        <td><input type="number" class="edit-input edit-amt" value="${p1Normal.amt.toFixed(2)}" step="0.01" min="0"></td>
        <td><span class="status-text">✏️</span></td>
        <td class="action-cell">
            <button class="edit-save-btn" data-er="${er}" title="Save changes">💾</button>
            <button class="edit-cancel-btn" data-er="${er}" title="Cancel editing">✕</button>
        </td>
    `;
    
    // Add save listener
    row.querySelector('.edit-save-btn').addEventListener('click', () => saveScrapedRecord(er));
    
    // Add cancel listener
    row.querySelector('.edit-cancel-btn').addEventListener('click', () => cancelEditRecord(er));
    
    // Focus the name field
    row.querySelector('.edit-name').focus();
}

/**
 * Cancel editing a record
 */
function cancelEditRecord(er) {
    currentlyEditingER = null;
    updateDashboardUI();
}

/**
 * Save edited scraped record
 */
async function saveScrapedRecord(er) {
    const row = document.querySelector(`tr[data-er="${er}"]`);
    if (!row) return;
    
    const nameInput = row.querySelector('.edit-name');
    const lfInput = row.querySelector('.edit-lf');
    const amtInput = row.querySelector('.edit-amt');
    
    const newName = nameInput.value.trim();
    const newLf = parseInt(lfInput.value) || 0;
    const newAmt = parseFloat(amtInput.value) || 0;
    
    if (newLf <= 0 || newAmt <= 0) {
        alert('LF and Amount must be greater than 0');
        return;
    }
    
    const data = await safeGet(['scrapedResults']);
    const results = data?.scrapedResults || [];
    const recordIndex = results.findIndex(r => r.er === er);
    
    if (recordIndex === -1) return;
    
    // Update the record
    results[recordIndex].employerName = newName;
    
    // Update or create the NORMAL p1 record
    const p1NormalIndex = results[recordIndex].p1Records.findIndex(r => r.type === 'NORMAL');
    if (p1NormalIndex >= 0) {
        results[recordIndex].p1Records[p1NormalIndex].lf = newLf;
        results[recordIndex].p1Records[p1NormalIndex].amt = newAmt;
    } else {
        results[recordIndex].p1Records.push({ period: 'EDITED', type: 'NORMAL', lf: newLf, amt: newAmt });
    }
    
    // Clear error flags if user fixed the data
    if (newLf > 0 && newAmt > 0) {
        results[recordIndex].zeroCrError = false;
        results[recordIndex].continuityError = false;
    }
    
    // Mark as edited by setting period to 'EDITED' if it was previously something else
    const p1Idx = results[recordIndex].p1Records.findIndex(r => r.type === 'NORMAL');
    if (p1Idx >= 0 && results[recordIndex].p1Records[p1Idx].period !== 'MANUAL') {
        results[recordIndex].p1Records[p1Idx].period = 'EDITED';
    }
    
    await safeSet({ scrapedResults: results });
    
    log(`Record updated: ${er} - ${newName} (LF: ${newLf}, Amt: ${newAmt})`, 'success');
    
    // Clear editing flag and refresh UI
    currentlyEditingER = null;
    updateDashboardUI();
}

/**
 * Delete a scraped record (user-initiated)
 */
async function deleteScrapedRecord(er) {
    if (!confirm(`Delete ER ${er} from the queue?`)) return;
    
    const data = await safeGet(['scrapedResults']);
    const results = data?.scrapedResults || [];
    const newResults = results.filter(r => r.er !== er);
    
    await safeSet({ scrapedResults: newResults });
    
    log(`Record deleted: ${er}`, 'warn');
    updateDashboardUI();
}

// ==================== PHASE 3: REPORT GENERATION ====================

/**
 * Generate a capture report (not wired to UI yet)
 * Call this after capture phase completes
 */
async function generateCaptureReport() {
    const data = await safeGet([
        'targetPeriod', 'scrapedResults', 'captureQueue', 
        'capturedErs', 'failedErs', 'captureResults'
    ]);
    
    if (!data) return null;
    
    const report = {
        metadata: {
            generatedAt: new Date().toISOString(),
            targetPeriod: data.targetPeriod,
            periodFormatted: formatPeriod(data.targetPeriod)
        },
        summary: {
            totalScraped: (data.scrapedResults || []).length,
            totalQueued: (data.captureQueue || []).length,
            captured: (data.capturedErs || []).length,
            failed: (data.failedErs || []).length,
            skippedDuringScrape: 0,
            successRate: 0
        },
        scrapeResults: {
            valid: [],
            alreadyCaptured: [],
            continuityErrors: [],
            zeroValues: [],
            selfCapture: [],
            manualEntries: []
        },
        captureResults: {
            success: [],
            already_captured: [],
            error: [],
            failed: [],
            skipped: []
        }
    };
    
    // Process scraped results
    (data.scrapedResults || []).forEach(res => {
        const p1Normal = res.p1Records.find(r => r.type === 'NORMAL');
        const entry = {
            er: res.er,
            employerName: res.employerName,
            lf: p1Normal?.lf || 0,
            amt: p1Normal?.amt || 0,
            isManual: res.isManualEntry || false,
            isEdited: res.isEdited || false
        };
        
        if (res.isManualEntry) report.scrapeResults.manualEntries.push(entry);
        else if (res.alreadyCaptured) report.scrapeResults.alreadyCaptured.push(entry);
        else if (res.continuityError) report.scrapeResults.continuityErrors.push(entry);
        else if (res.zeroCrError) report.scrapeResults.zeroValues.push(entry);
        else if (res.isSelfCapture) report.scrapeResults.selfCapture.push(entry);
        else report.scrapeResults.valid.push(entry);
    });
    
    report.summary.skippedDuringScrape = 
        report.scrapeResults.alreadyCaptured.length +
        report.scrapeResults.continuityErrors.length +
        report.scrapeResults.zeroValues.length +
        report.scrapeResults.selfCapture.length;
    
    // Process capture results
    const captureResults = data.captureResults || {};
    (data.captureQueue || []).forEach(item => {
        const result = captureResults[item.er];
        const entry = {
            er: item.er,
            employerName: item.name,
            lf: item.lf,
            amt: item.amt,
            result: result?.result || 'unknown',
            message: result?.message || '',
            timestamp: result?.timestamp ? new Date(result.timestamp).toISOString() : null
        };
        
        if (result?.result === 'success') report.captureResults.success.push(entry);
        else if (result?.result === 'already_captured') report.captureResults.already_captured.push(entry);
        else if (result?.result === 'error') report.captureResults.error.push(entry);
        else if (result?.result === 'failed') report.captureResults.failed.push(entry);
        else if (result?.result === 'skipped') report.captureResults.skipped.push(entry);
    });
    
    // Calculate success rate
    const totalProcessed = report.summary.captured + report.summary.failed;
    report.summary.successRate = totalProcessed > 0 
        ? ((report.summary.captured / totalProcessed) * 100).toFixed(1) 
        : 0;
    
    log(`Report generated: ${report.summary.captured}/${report.summary.totalQueued} captured (${report.summary.successRate}% success)`, 'success');
    
    return report;
}

/**
 * Format period YYYYMM to readable format
 */
function formatPeriod(yyyymm) {
    if (!yyyymm || yyyymm.length !== 6) return yyyymm;
    const year = yyyymm.substring(0, 4);
    const month = parseInt(yyyymm.substring(4, 6)) - 1;
    const date = new Date(year, month);
    return date.toLocaleString('en-GB', { month: 'long', year: 'numeric' });
}

/**
 * Export report as JSON (can be called from console for now)
 */
async function exportReportAsJSON() {
    const report = await generateCaptureReport();
    if (!report) return;
    
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ssnit-report-${report.metadata.targetPeriod}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
}

/**
 * Export report as CSV (can be called from console for now)
 */
async function exportReportAsCSV() {
    const report = await generateCaptureReport();
    if (!report) return;
    
    // Build CSV content
    let csv = 'ER Number,Employer Name,LF,Amount,Result,Message,Timestamp\n';
    
    const allResults = [
        ...report.captureResults.success,
        ...report.captureResults.already_captured,
        ...report.captureResults.error,
        ...report.captureResults.failed,
        ...report.captureResults.skipped
    ];
    
    allResults.forEach(item => {
        csv += `"${item.er}","${item.employerName}",${item.lf},${item.amt},"${item.result}","${item.message}","${item.timestamp || ''}"\n`;
    });
    
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ssnit-report-${report.metadata.targetPeriod}-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
}

// ==================== PHASE 3: VALIDATION ====================

let validationInterval = null;
let validationInProgress = false;

/**
 * Start the validation phase
 * Submits captured CRs for SSNIT validation/processing
 */
async function startValidationPhase() {
    // Ensure this tab is the automation tab (capture/validation run only here)
    await registerThisTabAsAutomationTab();

    const data = await safeGet(['capturedErs', 'targetPeriod', 'scrapedResults']);
    const captured = data?.capturedErs || [];

    if (captured.length === 0) {
        alert("No captured ERs to validate. Complete capture phase first.");
        return;
    }

    // Build validation queue from captured ERs
    const scrapedMap = new Map((data.scrapedResults || []).map(r => [r.er, r]));
    const validationQueue = captured.map(er => {
        const scraped = scrapedMap.get(er);
        return {
            er: er,
            name: scraped?.employerName || 'Unknown',
            period: data.targetPeriod,
            notFoundCount: 0 // Track how many times this CR wasn't found in table
        };
    });

    log(`Starting validation phase with ${validationQueue.length} CRs`, 'success');

    await safeSet({
        phase: 'VALIDATION',
        validationQueue: validationQueue,
        currentValidationIndex: 0,
        validatedErs: [],
        validationFailedErs: [],
        validationResults: {},
        needsWageEdit: [], // CRs that need wage adjustment before validation
        validationState: null, // Track sub-state: null, 'imported', 'ctb_checked'
        isPaused: false,
        interventionRequired: false
    });

    // Navigate to unprocessed CRs page
    window.location.href = '/contributions/view_crs/unprocessed';
}

/**
 * Start Force Validation phase - validates ALL CRs in unprocessed table
 * Unlike startValidationPhase, this scans the unprocessed table to build the queue
 * rather than using only captured ERs
 */
async function startForceValidationPhase() {
    await registerThisTabAsAutomationTab();

    const data = await safeGet(['targetPeriod']);
    const period = data?.targetPeriod;

    if (!period) {
        alert("No target period set. Please complete scraping phase first.");
        return;
    }

    log('Starting Force Validation - will scan unprocessed table for all CRs', 'success');

    await safeSet({
        phase: 'VALIDATION',
        forceValidationMode: true, // Flag to indicate force scan mode
        validationQueue: [], // Will be populated by scanning the unprocessed table
        currentValidationIndex: 0,
        validatedErs: [],
        validationFailedErs: [],
        validationResults: {},
        needsWageEdit: [],
        validationState: 'force_scan', // Special state to trigger table scan
        isPaused: false,
        interventionRequired: false
    });

    // Navigate to unprocessed CRs page - the validation loop will scan the table
    window.location.href = '/contributions/view_crs/unprocessed';
}

/**
 * Run the validation automation loop
 */
function runValidationLoop() {
    if (validationInterval) clearInterval(validationInterval);
    
    validationInterval = setInterval(async () => {
        if (isPaused || validationInProgress) return;
        
        validationInProgress = true;
        try {
            await doValidationStep();
        } catch (e) {
            log(`Validation error: ${e.message}`, 'error');
        }
        validationInProgress = false;
    }, 2000);
}

/**
 * Get the previous month label from target period (YYYYMM)
 * Target: 202501 -> Previous: "December 2025"
 */
function getPreviousMonthLabel(yyyymm) {
    if (!yyyymm || yyyymm.length !== 6) return null;
    const year = parseInt(yyyymm.substring(0, 4));
    const month = parseInt(yyyymm.substring(4, 6)) - 1; // 0-indexed
    
    // Go back one month
    const prevDate = new Date(year, month - 1, 1);
    return prevDate.toLocaleString('en-GB', { month: 'long', year: 'numeric' });
}

/**
 * Check employee table for CTB amounts below minimum threshold (MIN_CTB)
 * Called after import on data-entry page
 * Returns array of employees with CTB issues, or empty array if all OK
 * 
 * Table structure (from SSNIT data-entry page):
 * Col 0: No. | Col 1: SS Number | Col 2: NIA Number | Col 3: Surname | Col 4: First Name
 * Col 5: Other Name(s) | Col 6: Option Code | Col 7: Contribution(GHS) | Col 8: Hazardous | Col 9: Staff ID
 */
function checkMinimumCtb() {
    const employeesWithIssues = [];
    
    // Find the employee table on data-entry page
    const tables = document.querySelectorAll('table.table-striped');
    let employeeTable = null;
    
    for (const table of tables) {
        // Look for the table with Contribution column header
        const headers = table.querySelectorAll('thead th');
        for (const th of headers) {
            if (th.textContent.includes('Contribution')) {
                employeeTable = table;
                break;
            }
        }
        if (employeeTable) break;
    }
    
    if (!employeeTable) {
        log('Employee table not found for CTB check', 'warn');
        return [];
    }
    
    const rows = employeeTable.querySelectorAll('tbody tr');
    
    rows.forEach((row, idx) => {
        const cells = row.querySelectorAll('td');
        if (cells.length >= 8) {
            const surname = cells[3]?.textContent?.trim() || '';
            const firstName = cells[4]?.textContent?.trim() || '';
            const otherNames = cells[5]?.textContent?.trim() || '';
            const ssNumber = cells[1]?.textContent?.trim() || '';
            
            // CTB is in column 7 (0-indexed), may have commas for thousands
            const ctbText = cells[7]?.textContent?.trim() || '0';
            const ctb = parseFloat(ctbText.replace(/,/g, '')) || 0;
            
            // Check if CTB is below minimum (but greater than 0 to exclude empty rows)
            if (ctb > 0 && ctb < MIN_CTB) {
                const fullName = [surname, firstName, otherNames].filter(n => n).join(' ');
                employeesWithIssues.push({
                    ssNumber: ssNumber,
                    name: fullName,
                    currentCtb: ctb,
                    requiredAdjustment: parseFloat((MIN_CTB - ctb).toFixed(2))
                });
            }
        }
    });
    
    if (employeesWithIssues.length > 0) {
        log(`Found ${employeesWithIssues.length} employee(s) with CTB below ${MIN_CTB}`, 'warn');
    }

    return employeesWithIssues;
}

/**
 * Calculate current total and adjusted total from employee table
 * Scans all employees and applies MIN_CTB where needed
 * Returns { currentTotal, adjustedTotal }
 */
function calculateAdjustedTotal() {
    let currentTotal = 0;
    let adjustedTotal = 0;

    // Find the employee table on data-entry page
    const tables = document.querySelectorAll('table.table-striped');
    let employeeTable = null;

    for (const table of tables) {
        const headers = table.querySelectorAll('thead th');
        for (const th of headers) {
            if (th.textContent.includes('Contribution')) {
                employeeTable = table;
                break;
            }
        }
        if (employeeTable) break;
    }

    if (!employeeTable) {
        log('Employee table not found for total calculation', 'warn');
        return { currentTotal: 0, adjustedTotal: 0 };
    }

    const rows = employeeTable.querySelectorAll('tbody tr');

    rows.forEach((row) => {
        const cells = row.querySelectorAll('td');
        if (cells.length >= 8) {
            // CTB is in column 7 (0-indexed), may have commas for thousands
            const ctbText = cells[7]?.textContent?.trim() || '0';
            const ctb = parseFloat(ctbText.replace(/,/g, '')) || 0;

            if (ctb > 0) {
                currentTotal += ctb;
                // Apply minimum if below threshold
                adjustedTotal += Math.max(ctb, MIN_CTB);
            }
        }
    });

    return {
        currentTotal: parseFloat(currentTotal.toFixed(2)),
        adjustedTotal: parseFloat(adjustedTotal.toFixed(2))
    };
}

/**
 * Log wage/CTB issue for later review and manual editing
 * Stores in wageIssueLog array in chrome.storage
 */
async function logCtbIssue(er, period, employerName, employees) {
    const data = await safeGet(['ctbIssueLog']);
    const log = data?.ctbIssueLog || [];
    
    log.push({
        er: er,
        period: period,
        employerName: employerName,
        employees: employees,
        timestamp: Date.now()
    });
    
    await safeSet({ ctbIssueLog: log });
    
    // Log to console for visibility
    console.log('%c[SSNIT] CTB Issue Logged:', 'color: #f59e0b; font-weight: bold', {
        er, period, employerName,
        affectedEmployees: employees.length,
        details: employees
    });
}

/**
 * Main validation step - multi-page flow:
 * 1. Unprocessed list → find ER → click to open
 * 2. Data entry page → click Import button
 * 3. Import modal → select previous month → click Import
 * 4. Data entry page → click Submit for Validation
 * 5. Handle consent modal (Submit for Validation confirmation)
 * 6. Handle success/error modal
 * 7. Navigate back to unprocessed list
 */
async function doValidationStep() {
    const data = await safeGet([
        'validationQueue', 'currentValidationIndex', 'targetPeriod',
        'phase', 'validatedErs', 'validationFailedErs', 'validationResults',
        'validationState', 'validationSubmitTime', 'forceValidationMode'
    ]);

    if (!data || data.phase !== 'VALIDATION') return;

    // ==================== FORCE VALIDATION SCAN MODE ====================
    // If in force_scan mode, scan the unprocessed table and build queue from all visible CRs
    if (data.validationState === 'force_scan' && window.location.href.includes('/view_crs/unprocessed')) {
        log('[FORCE VALIDATION] Scanning unprocessed table for all CRs...', 'info');

        const tableRows = document.querySelectorAll('table.table tbody tr');
        const queue = [];

        for (const row of tableRows) {
            const cells = row.querySelectorAll('td');
            // ER is typically in one of the first few columns
            for (const cell of cells) {
                const text = cell.textContent?.trim();
                if (/^\d{9}$/.test(text)) { // 9-digit ER number
                    queue.push({
                        er: text,
                        name: 'Unknown', // Will be determined during processing
                        period: data.targetPeriod,
                        notFoundCount: 0
                    });
                    break;
                }
            }
        }

        if (queue.length === 0) {
            log('[FORCE VALIDATION] No CRs found in unprocessed table', 'warn');
            await safeSet({ phase: 'COMPLETE', forceValidationMode: false, validationState: null });
            return;
        }

        log(`[FORCE VALIDATION] Found ${queue.length} CRs to validate`, 'success');
        await safeSet({
            validationQueue: queue,
            currentValidationIndex: 0,
            validationState: null,
            forceValidationMode: true
        });
        return;
    }

    // ==================== MODAL DETECTION FIRST ====================
    // Check for modals BEFORE any other logic - modals must be handled immediately
    const modalState = PageOps.detectModal();

    // Handle consent modal (Submit for Validation confirmation)
    if (modalState.type === 'consent') {
        log('[VALIDATION] Consent modal detected - clicking Yes...', 'info');
        const handled = await handleConsentModal(modalState.element);
        if (handled) {
            await wait(300);
        }
        return;
    }

    // Handle success modal after validation submit
    if (modalState.type === 'success' && data.validationState === 'submitted_awaiting') {
        log('[VALIDATION] Success modal detected - validation succeeded!', 'success');
        const handled = await handleModal('success', modalState.element);
        if (handled) {
            // Mark as validated and advance
            const queue = data.validationQueue || [];
            const index = data.currentValidationIndex || 0;
            const currentER = queue[index]?.er;

            if (currentER) {
                await advanceValidation(
                    currentER, 'submitted',
                    data.validatedErs || [],
                    data.validationFailedErs || [],
                    index, 'Validation successful'
                );
            }

            // Navigate back to unprocessed list
            await wait(500);
            window.location.href = '/contributions/view_crs/unprocessed';
        }
        return;
    }

    // Handle error modal after validation submit
    if (modalState.type === 'error' && data.validationState === 'submitted_awaiting') {
        log(`[VALIDATION] Error modal detected: ${modalState.message}`, 'error');
        const handled = await handleModal('error', modalState.element);
        if (handled) {
            const queue = data.validationQueue || [];
            const index = data.currentValidationIndex || 0;
            const currentER = queue[index]?.er;

            if (currentER) {
                await advanceValidation(
                    currentER, 'error',
                    data.validatedErs || [],
                    data.validationFailedErs || [],
                    index, modalState.message
                );
            }

            await wait(500);
            window.location.href = '/contributions/view_crs/unprocessed';
        }
        return;
    }

    // Handle unknown modal - pause for intervention
    if (modalState.type === 'unknown') {
        log(`[VALIDATION] Unknown modal detected: ${modalState.message}`, 'error');
        isPaused = true;
        await safeSet({
            isPaused: true,
            interventionRequired: true,
            interventionMessage: `Unknown modal: ${modalState.message}. Please handle manually and click Resume.`
        });
        return;
    }

    // Check for submit timeout
    if (data.validationState === 'submitted_awaiting' && data.validationSubmitTime) {
        const elapsed = Date.now() - data.validationSubmitTime;
        if (elapsed > RESPONSE_TIMEOUT_MS) {
            log('[VALIDATION] Submit timeout - marking as failed', 'error');
            const queue = data.validationQueue || [];
            const index = data.currentValidationIndex || 0;
            const currentER = queue[index]?.er;

            if (currentER) {
                await advanceValidation(
                    currentER, 'failed',
                    data.validatedErs || [],
                    data.validationFailedErs || [],
                    index, 'Timeout waiting for validation response'
                );
            }

            window.location.href = '/contributions/view_crs/unprocessed';
            return;
        }

        // Still waiting for modal response
        log(`[VALIDATION] Waiting for modal response... (${Math.round(elapsed/1000)}s)`, 'info');
        return;
    }
    
    const queue = data.validationQueue || [];
    const index = data.currentValidationIndex || 0;
    let validatedList = data.validatedErs || [];
    let failedList = data.validationFailedErs || [];
    const period = data.targetPeriod;
    const prevMonthLabel = getPreviousMonthLabel(period);
    
    // Check if validation complete
    if (queue.length === 0 || index >= queue.length) {
        if (index >= queue.length && queue.length > 0) {
            log('Validation complete!', 'success');
            if (validationInterval) {
                clearInterval(validationInterval);
                validationInterval = null;
            }
            await safeSet({ phase: 'COMPLETE' });
            updateDashboardUI();
        }
        return;
    }
    
    const currentItem = queue[index];
    const currentER = currentItem.er;
    
    // Skip if already processed
    if (validatedList.includes(currentER) || failedList.includes(currentER)) {
        await safeSet({ currentValidationIndex: index + 1, validationState: null });
        stuckCounter = 0;
        return;
    }
    
    const currentUrl = window.location.href;
    const isUnprocessedPage = currentUrl.includes('/view_crs/unprocessed');
    const isDataEntryPage = currentUrl.includes('/data-entry');
    
    // ==================== CHECK FOR IMPORT MODAL ====================
    // Modal has header "Import Contribution Transactions"
    const importModal = document.querySelector('.custom-alert-container');
    const importModalHeader = importModal?.querySelector('.custom-alert-title h3');
    const isImportModalOpen = importModal &&
        importModalHeader?.textContent?.includes('Import Contribution Transactions') &&
        importModal.offsetParent !== null;

    if (isImportModalOpen) {
        // Get all possible previous month formats for flexible matching
        const prevMonthLabels = getPreviousMonthLabels(period);
        log(`[VALIDATION] Import modal open, looking for previous month (formats: ${prevMonthLabels.slice(0, 2).join(', ')}...)...`);

        // Scan the table in the modal for the previous month using normalized matching
        const modalTable = importModal.querySelector('table tbody');
        const modalRows = modalTable?.querySelectorAll('tr') || [];
        let targetRow = null;

        for (const row of modalRows) {
            const periodCell = row.querySelector('td:nth-child(2)'); // Period is second column
            if (periodCell) {
                const cellText = periodCell.textContent?.trim() || '';
                const normalizedCellText = normalizeMonthText(cellText);

                // Check against all possible previous month formats
                for (const label of prevMonthLabels) {
                    const normalizedLabel = normalizeMonthText(label);
                    if (normalizedCellText === normalizedLabel) {
                        targetRow = row;
                        log(`Matched period: "${cellText}" (normalized: "${normalizedCellText}")`, 'info');
                        break;
                    }
                }
                if (targetRow) break;
            }
        }

        if (targetRow) {
            // Check if radio is already selected
            const radio = targetRow.querySelector('input[type="radio"][name="import_cr"]');
            if (radio && !radio.checked) {
                log(`Selecting period using Vue radio click...`, 'success');

                // Use PageOps.clickVueRadio for proper Vue radio handling
                const clicked = await PageOps.clickVueRadio(radio);
                if (!clicked) {
                    log('Vue radio click failed, trying fallback...', 'warn');
                    // Fallback: try clicking the row itself
                    targetRow.click();
                }
                await wait(400);
            }

            // Click Import button (should now be enabled)
            const importBtn = importModal.querySelector('button.btn-custom:not(:disabled)');
            if (importBtn && importBtn.textContent.toLowerCase().includes('import')) {
                log(`Clicking Import button...`, 'success');
                importBtn.click();
                await safeSet({ validationState: 'imported' });
                await wait(500);
                return;
            }

            // Import button still disabled - try more aggressive radio selection
            const disabledImportBtn = importModal.querySelector('button.btn-custom:disabled');
            if (disabledImportBtn && radio) {
                log('Import button disabled, trying aggressive radio selection...', 'warn');

                // Try clicking the radio wrapper div (Vue custom radios)
                const radioWrapper = radio.closest('.radio-custom') ||
                                     radio.closest('.radio-inline') ||
                                     radio.closest('div.radio');
                if (radioWrapper) {
                    radioWrapper.click();
                    await wait(200);
                }

                // Also try setting value directly with all events
                radio.checked = true;
                radio.dispatchEvent(new Event('change', { bubbles: true }));
                radio.dispatchEvent(new Event('input', { bubbles: true }));
                radio.dispatchEvent(new Event('click', { bubbles: true }));
                radio.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            }
            return;
        } else {
            // Previous month not found in table - pause for intervention
            log(`Previous month not found in import table (tried: ${prevMonthLabels.join(', ')})`, 'error');
            isPaused = true;
            await safeSet({
                isPaused: true,
                interventionRequired: true,
                interventionMessage: `Previous month not found for ER ${currentER}. Tried formats: ${prevMonthLabels.slice(0, 2).join(', ')}. Please import manually or Skip.`
            });
            return;
        }
    }
    
    // ==================== STATE 1: UNPROCESSED LIST PAGE ====================
    if (isUnprocessedPage) {
        log(`[VALIDATION] Looking for ER ${currentER} in unprocessed list...`);

        // Reset validation state when on list page (but not force_scan mode)
        if (data.validationState && data.validationState !== 'force_scan' && data.validationState !== 'searching') {
            await safeSet({ validationState: null });
        }

        // Use optimized column-specific search (O(R) instead of O(R×C))
        const foundRow = PageOps.findTableRowByER(currentER, 'table.table');

        if (foundRow) {
            log(`Found ER ${currentER} in table, clicking to open...`, 'success');

            // Find clickable element - the cogs icon link for data-entry
            const processLink = foundRow.querySelector('a[href*="data-entry"]');
            const clickableElement = processLink || foundRow.querySelector('a.text-success') || foundRow;

            if (clickableElement && clickableElement.click) {
                clickableElement.click();
                stuckCounter = 0;
                // Reset search state and notFoundCount since we found it
                if (currentItem.notFoundCount > 0 || currentItem.searchAttempted) {
                    const updatedQueue = [...queue];
                    updatedQueue[index].notFoundCount = 0;
                    updatedQueue[index].searchAttempted = false;
                    await safeSet({ validationQueue: updatedQueue, validationState: null });
                }
            }
            return;
        }

        // ER not found in visible table - try using portal search before giving up
        // Look for search input on the unprocessed page
        const searchInput = document.querySelector('input[placeholder*="ER"], input[placeholder*="Search"], input.form-control[type="text"]');
        const searchBtn = PageOps.findButton({ text: 'search' }) ||
                          PageOps.findButton({ text: 'filter' }) ||
                          document.querySelector('button[type="submit"]');

        // Check if we already searched for this ER
        const alreadySearched = currentItem.searchAttempted === true;
        const currentSearchValue = searchInput?.value?.trim() || '';
        const isSearchedForThisER = currentSearchValue === currentER;

        if (searchInput && !alreadySearched) {
            log(`[VALIDATION] ER ${currentER} not in visible table, using search...`, 'info');

            // Clear any existing search first if searching for different ER
            if (currentSearchValue && !isSearchedForThisER) {
                setNativeValue(searchInput, '');
                await wait(300);
            }

            // Enter the ER in search field
            searchInput.focus();
            await wait(100);
            setNativeValue(searchInput, currentER);
            searchInput.blur();
            await wait(300);

            // Click search button or trigger search
            if (searchBtn) {
                searchBtn.click();
            } else {
                // Try submitting via Enter key
                searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
                searchInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
            }

            // Mark that we've attempted search for this ER
            const updatedQueue = [...queue];
            updatedQueue[index].searchAttempted = true;
            await safeSet({ validationQueue: updatedQueue, validationState: 'searching' });

            log(`[VALIDATION] Search initiated for ${currentER}, waiting for results...`, 'info');
            await wait(1500); // Wait for search results to load
            return;
        }

        // If we already searched and still not found, or no search available
        if (alreadySearched || !searchInput) {
            if (alreadySearched) {
                log(`ER ${currentER} not found even after search, moving to back of queue...`, 'warn');
            } else {
                log(`ER ${currentER} not in visible table (no search available), moving to back of queue...`, 'warn');
            }

            // Increment notFoundCount for this item
            currentItem.notFoundCount = (currentItem.notFoundCount || 0) + 1;
            currentItem.searchAttempted = false; // Reset for next attempt

            // Remove from current position and add to back of queue
            const updatedQueue = [...queue];
            updatedQueue.splice(index, 1); // Remove from current position
            updatedQueue.push(currentItem); // Add to back

            // Check if all remaining items have been not found multiple times (infinite loop prevention)
            const allStuck = updatedQueue.every(item => item.notFoundCount >= 3);
            if (allStuck) {
                log('All remaining CRs not found in table even after search. Pausing for intervention...', 'error');
                isPaused = true;
                await safeSet({
                    validationQueue: updatedQueue,
                    validationState: null,
                    isPaused: true,
                    interventionRequired: true,
                    interventionMessage: `None of the remaining ${updatedQueue.length} CRs found in unprocessed table (search attempted). Please check manually or Skip.`
                });
                return;
            }

            // Clear search field for next ER
            if (searchInput && searchInput.value) {
                setNativeValue(searchInput, '');
                await wait(200);
                if (searchBtn) searchBtn.click();
            }

            await safeSet({ validationQueue: updatedQueue, validationState: null });
            // Index stays the same since we removed current item, next item slides into this position
            stuckCounter = 0;
            return;
        }

        return;
    }
    
    // ==================== STATE 2: DATA ENTRY PAGE ====================
    if (isDataEntryPage) {
        const validationState = data.validationState;
        
        // After import, check for minimum CTB issues before allowing submit
        if (validationState === 'imported') {
            const ctbIssues = checkMinimumCtb();

            if (ctbIssues.length > 0) {
                // Calculate total employee contributions and new adjusted total
                const { currentTotal, adjustedTotal } = calculateAdjustedTotal();

                // Log the CTB issues for later review
                await logCtbIssue(currentER, period, currentItem.name, ctbIssues);

                // Add to needsWageEdit queue for later processing
                const wageEditData = await safeGet(['needsWageEdit']);
                const needsWageEdit = wageEditData?.needsWageEdit || [];
                needsWageEdit.push({
                    er: currentER,
                    name: currentItem.name,
                    period: period,
                    currentTotal: currentTotal,
                    adjustedTotal: adjustedTotal,
                    affectedEmployees: ctbIssues.length,
                    ctbIssues: ctbIssues
                });
                await safeSet({ needsWageEdit: needsWageEdit });

                log(`CTB below minimum for ${currentER} - ${ctbIssues.length} employee(s) affected. Added to wage edit queue.`, 'warn');
                log(`Current total: ${currentTotal.toFixed(2)}, Adjusted total needed: ${adjustedTotal.toFixed(2)}`, 'info');

                // Remove from validation queue and move to next
                const updatedQueue = [...queue];
                updatedQueue.splice(index, 1);
                await safeSet({
                    validationQueue: updatedQueue,
                    validationState: null
                });

                // Navigate back to unprocessed list for next CR
                window.location.href = '/contributions/view_crs/unprocessed';
                return;
            }

            // CTB check passed, update state to indicate ready for submit
            await safeSet({ validationState: 'ctb_checked' });
        }
        
        // Check if we've already imported - look for Submit button
        const submitBtn = Array.from(document.querySelectorAll('button')).find(btn => {
            const text = btn.textContent.toLowerCase();
            return text.includes('submit') && text.includes('validation') && !btn.disabled;
        });
        
        if (submitBtn) {
            log(`Submitting CR ${currentER} for validation...`, 'success');

            // Get user's post-after-validation preference from storage
            const settings = await safeGet(['autoPostAfterValidation']);
            const shouldAutoPost = settings?.autoPostAfterValidation === true;

            // Handle the "Post after validation" checkbox based on user setting
            const autoPostCheckbox = document.querySelector('input[type="checkbox"]#checkbox2, input[type="checkbox"][name="checkboxInline"]');
            if (autoPostCheckbox) {
                if (shouldAutoPost && !autoPostCheckbox.checked) {
                    autoPostCheckbox.click();
                    await wait(200);
                } else if (!shouldAutoPost && autoPostCheckbox.checked) {
                    // Uncheck if user doesn't want auto-post
                    autoPostCheckbox.click();
                    await wait(200);
                }
            }

            // Set state to awaiting modal response BEFORE clicking submit
            await safeSet({
                validationState: 'submitted_awaiting',
                validationSubmitTime: Date.now()
            });

            submitBtn.click();

            // Don't advance immediately - wait for modal detection on next tick
            // The modal handler at the start of doValidationStep will handle the response
            log('[VALIDATION] Submit clicked, waiting for modal response...', 'info');
            return;
        }
        
        // No submit button enabled - need to import first
        // Look for Import button to open the modal
        const importOpenBtn = Array.from(document.querySelectorAll('button')).find(btn => {
            const text = btn.textContent.toLowerCase();
            return text.includes('import') && !btn.disabled;
        });
        
        if (importOpenBtn && !isImportModalOpen) {
            log(`Opening import modal for ${currentER}...`);
            importOpenBtn.click();
            await wait(500);
            return;
        }
        
        // Check for disabled submit button (data issue after import)
        const disabledSubmit = Array.from(document.querySelectorAll('button:disabled')).find(btn => {
            const text = btn.textContent.toLowerCase();
            return text.includes('submit') && text.includes('validation');
        });
        
        if (disabledSubmit && validationState === 'imported') {
            log(`Submit button disabled after import for ${currentER}`, 'error');
            isPaused = true;
            await safeSet({
                isPaused: true,
                interventionRequired: true,
                interventionMessage: `Submit disabled for ER ${currentER} after import. Please review data or Skip.`
            });
            return;
        }
        
        // Stuck on data entry page
        stuckCounter++;
        if (stuckCounter >= MAX_STUCK_COUNT) {
            log(`Stuck on data entry for ${currentER}, skipping...`, 'error');
            await advanceValidation(currentER, 'stuck', validatedList, failedList, index, 'Could not complete data entry');
            stuckCounter = 0;
            window.location.href = '/contributions/view_crs/unprocessed';
        }
        return;
    }
    
    // ==================== UNKNOWN PAGE - NAVIGATE BACK ====================
    stuckCounter++;
    if (stuckCounter >= 3) {
        log('On unknown page, navigating back to unprocessed list...', 'warn');
        window.location.href = '/contributions/view_crs/unprocessed';
        stuckCounter = 0;
    }
}

/**
 * Advance to next ER in validation queue
 */
async function advanceValidation(er, result, validatedList, failedList, index, message = '') {
    // Store result
    const data = await safeGet(['validationResults']);
    const results = data?.validationResults || {};
    results[er] = {
        result: result,
        message: message,
        timestamp: Date.now()
    };
    
    if (result === 'submitted') {
        validatedList.push(er);
        await safeSet({
            validatedErs: validatedList,
            currentValidationIndex: index + 1,
            validationResults: results,
            interventionRequired: false
        });
        log(`✓ ${er} submitted for validation`, 'success');
    } else {
        failedList.push(er);
        await safeSet({
            validationFailedErs: failedList,
            currentValidationIndex: index + 1,
            validationResults: results,
            interventionRequired: false
        });
        log(`✗ ${er} validation failed: ${message}`, 'error');
    }
    
    stuckCounter = 0;
}

/**
 * Skip current ER in validation phase
 */
async function skipCurrentValidation() {
    const data = await safeGet(['validationQueue', 'currentValidationIndex', 'validatedErs', 'validationFailedErs']);
    const queue = data?.validationQueue || [];
    const index = data?.currentValidationIndex || 0;
    
    if (index >= queue.length) return;
    
    const currentER = queue[index].er;
    log(`Skipping validation for ${currentER}`, 'warn');
    
    await advanceValidation(
        currentER, 
        'skipped', 
        data.validatedErs || [], 
        data.validationFailedErs || [], 
        index, 
        'Manually skipped by user'
    );
    
    // Navigate back to unprocessed page for next ER
    if (!window.location.href.includes('/view_crs/unprocessed')) {
        window.location.href = '/contributions/view_crs/unprocessed';
    }
}

// ==================== PHASE 3B: WAGE EDIT ====================

let wageEditInterval = null;
let wageEditInProgress = false;

/**
 * Start the wage edit phase
 * Processes CRs that need wage adjustment before validation
 */
async function startWageEditPhase() {
    await registerThisTabAsAutomationTab();

    const data = await safeGet(['needsWageEdit']);
    const needsWageEdit = data?.needsWageEdit || [];

    if (needsWageEdit.length === 0) {
        alert("No CRs need wage editing.");
        return;
    }

    log(`Starting wage edit phase with ${needsWageEdit.length} CRs`, 'success');

    await safeSet({
        phase: 'WAGE_EDIT',
        wageEditQueue: needsWageEdit,
        currentWageEditIndex: 0,
        wageEditState: null, // Track sub-state: null, 'editing', 'updated'
        isPaused: false,
        interventionRequired: false
    });

    // Navigate to unprocessed CRs page
    window.location.href = '/contributions/view_crs/unprocessed';
}

/**
 * Run the wage edit automation loop
 */
function runWageEditLoop() {
    if (wageEditInterval) clearInterval(wageEditInterval);

    wageEditInterval = setInterval(async () => {
        if (isPaused || wageEditInProgress) return;

        wageEditInProgress = true;
        try {
            await doWageEditStep();
        } catch (e) {
            log(`Wage edit error: ${e.message}`, 'error');
        }
        wageEditInProgress = false;
    }, 2000);
}

/**
 * Main wage edit step - multi-page flow:
 * 1. Unprocessed list → find ER → click Edit button
 * 2. Edit page (/receive/edit-private) → update Total Contribution → click Update
 * 3. Return to unprocessed list for next item (or reprocess in validation)
 */
async function doWageEditStep() {
    const data = await safeGet([
        'wageEditQueue', 'currentWageEditIndex', 'phase',
        'wageEditState', 'needsWageEdit'
    ]);

    if (!data || data.phase !== 'WAGE_EDIT') return;

    const queue = data.wageEditQueue || [];
    const index = data.currentWageEditIndex || 0;

    // Check if wage edit complete
    if (queue.length === 0 || index >= queue.length) {
        log('Wage edit phase complete!', 'success');
        if (wageEditInterval) clearInterval(wageEditInterval);

        // Clear needsWageEdit and move edited items back to validation queue
        const editedItems = queue.map(item => ({
            er: item.er,
            name: item.name,
            period: item.period,
            notFoundCount: 0
        }));

        // Get existing validation queue and add edited items
        const valData = await safeGet(['validationQueue', 'capturedErs']);
        const existingValQueue = valData?.validationQueue || [];

        await safeSet({
            phase: 'VALIDATION',
            needsWageEdit: [],
            wageEditQueue: [],
            validationQueue: [...existingValQueue, ...editedItems],
            currentValidationIndex: 0,
            validationState: null
        });

        // Navigate to unprocessed to continue validation
        window.location.href = '/contributions/view_crs/unprocessed';
        return;
    }

    const currentItem = queue[index];
    const currentER = currentItem.er;
    const adjustedTotal = currentItem.adjustedTotal;

    const currentUrl = window.location.href;
    const isUnprocessedPage = currentUrl.includes('/view_crs/unprocessed');
    const isEditPrivatePage = currentUrl.includes('/receive/edit-private');

    // ==================== STATE 1: UNPROCESSED LIST PAGE ====================
    if (isUnprocessedPage) {
        log(`[WAGE EDIT] Looking for ER ${currentER} to edit...`);

        // Use optimized column-specific search (O(R) instead of O(R×C))
        const foundRow = PageOps.findTableRowByER(currentER, 'table.table');

        if (foundRow) {
            log(`Found ER ${currentER}, clicking Edit button...`, 'success');

            // Find the edit button (pencil icon linking to edit-private)
            const editLink = foundRow.querySelector('a[href*="edit-private"]');

            if (editLink) {
                editLink.click();
                // Reset search state
                if (currentItem.searchAttempted) {
                    const updatedQueue = [...queue];
                    updatedQueue[index].searchAttempted = false;
                    await safeSet({ wageEditQueue: updatedQueue });
                }
                await safeSet({ wageEditState: 'navigating_to_edit' });
                stuckCounter = 0;
                return;
            } else {
                log(`Edit button not found for ${currentER}`, 'error');
            }
        }

        // ER not found in visible table - try using portal search
        const searchInput = document.querySelector('input[placeholder*="ER"], input[placeholder*="Search"], input.form-control[type="text"]');
        const searchBtn = PageOps.findButton({ text: 'search' }) ||
                          PageOps.findButton({ text: 'filter' }) ||
                          document.querySelector('button[type="submit"]');

        const alreadySearched = currentItem.searchAttempted === true;

        if (searchInput && !alreadySearched) {
            log(`[WAGE EDIT] ER ${currentER} not in visible table, using search...`, 'info');

            // Clear and search for this ER
            searchInput.focus();
            await wait(100);
            setNativeValue(searchInput, currentER);
            searchInput.blur();
            await wait(300);

            if (searchBtn) {
                searchBtn.click();
            } else {
                searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            }

            // Mark search attempted
            const updatedQueue = [...queue];
            updatedQueue[index].searchAttempted = true;
            await safeSet({ wageEditQueue: updatedQueue, wageEditState: 'searching' });

            await wait(1500);
            return;
        }

        // Search attempted but still not found, or no search available
        stuckCounter++;
        if (stuckCounter >= MAX_STUCK_COUNT) {
            const reason = alreadySearched ? 'not found even after search' : 'not found (no search available)';
            log(`ER ${currentER} ${reason}, skipping...`, 'error');

            // Clear search if needed
            if (searchInput && searchInput.value) {
                setNativeValue(searchInput, '');
                await wait(200);
                if (searchBtn) searchBtn.click();
            }

            await advanceWageEdit(index, 'not_found', `CR not found in unprocessed list`);
            stuckCounter = 0;
        }
        return;
    }

    // ==================== STATE 2: EDIT PRIVATE PAGE ====================
    if (isEditPrivatePage) {
        log(`[WAGE EDIT] On edit page, updating Total Contribution to ${adjustedTotal.toFixed(2)}...`);

        // Verify we're editing the correct ER by checking the header
        const headerTitle = document.querySelector('h3.text-info, h4.text-info');
        const headerText = headerTitle ? headerTitle.innerText : '';

        if (headerText && !headerText.includes(currentER)) {
            log(`Wrong ER on edit page. Expected ${currentER}, navigating back...`, 'warn');
            window.location.href = '/contributions/view_crs/unprocessed';
            return;
        }

        // Find the Total Contribution input field using PageOps
        const amtInput = PageOps.findInputByLabel('total contribution');

        if (amtInput) {
            // Update the value using Vue-compatible method via PageOps
            await PageOps.setVueInput(amtInput, adjustedTotal.toFixed(2));

            log(`Set Total Contribution to ${adjustedTotal.toFixed(2)}`, 'success');

            // Find and click the Update button
            const updateBtn = Array.from(document.querySelectorAll('button')).find(btn => {
                const text = btn.textContent.toLowerCase();
                return text.includes('update') && !btn.disabled;
            });

            if (updateBtn) {
                log(`Clicking Update button...`, 'success');
                updateBtn.click();
                await wait(500);

                // Mark as updated and advance to next
                await advanceWageEdit(index, 'updated', `Total adjusted to ${adjustedTotal.toFixed(2)}`);

                // Navigate back to unprocessed list
                window.location.href = '/contributions/view_crs/unprocessed';
                return;
            } else {
                log('Update button not found or disabled', 'error');
                stuckCounter++;
            }
        } else {
            log('Total Contribution input not found', 'error');
            stuckCounter++;
        }

        if (stuckCounter >= MAX_STUCK_COUNT) {
            log(`Stuck on edit page for ${currentER}, skipping...`, 'error');
            await advanceWageEdit(index, 'stuck', 'Could not complete edit');
            stuckCounter = 0;
            window.location.href = '/contributions/view_crs/unprocessed';
        }
        return;
    }

    // ==================== UNKNOWN PAGE - NAVIGATE BACK ====================
    stuckCounter++;
    if (stuckCounter >= 3) {
        log('On unknown page, navigating back to unprocessed list...', 'warn');
        window.location.href = '/contributions/view_crs/unprocessed';
        stuckCounter = 0;
    }
}

/**
 * Advance to next item in wage edit queue
 */
async function advanceWageEdit(index, result, message = '') {
    const data = await safeGet(['wageEditQueue']);
    const queue = data?.wageEditQueue || [];

    if (index < queue.length) {
        queue[index].editResult = result;
        queue[index].editMessage = message;
        queue[index].editTimestamp = Date.now();
    }

    await safeSet({
        wageEditQueue: queue,
        currentWageEditIndex: index + 1,
        wageEditState: null
    });

    log(`Wage edit ${result} for item ${index + 1}: ${message}`, result === 'updated' ? 'success' : 'warn');
    stuckCounter = 0;
}

/**
 * Skip current item in wage edit phase
 */
async function skipCurrentWageEdit() {
    const data = await safeGet(['wageEditQueue', 'currentWageEditIndex']);
    const index = data?.currentWageEditIndex || 0;

    log(`Skipping wage edit for item ${index + 1}`, 'warn');
    await advanceWageEdit(index, 'skipped', 'Manually skipped by user');

    if (!window.location.href.includes('/view_crs/unprocessed')) {
        window.location.href = '/contributions/view_crs/unprocessed';
    }
}

async function doCaptureStep() {
    const data = await safeGet([
        'captureQueue', 'currentCaptureIndex', 'targetPeriod', 
        'phase', 'capturedErs', 'failedErs', 'retryCount', 'scrapedResults',
        'awaitingResponse', 'lastSubmitTime'
    ]);
    
    if (!data || data.phase !== 'CAPTURE') return;

    let queue = data.captureQueue || [];
    const index = data.currentCaptureIndex || 0;
    let capturedList = data.capturedErs || [];
    let failedList = data.failedErs || [];
    let retries = data.retryCount || 0;
    
    // Restore awaiting state from storage
    awaitingResponse = data.awaitingResponse || false;
    lastSubmitTime = data.lastSubmitTime || 0;

    // Queue population
    if (queue.length === 0 && data.scrapedResults && data.scrapedResults.length > 0) {
        log('Populating capture queue...');
        
        const newQueue = data.scrapedResults
            .filter(res => !res.alreadyCaptured && !res.continuityError && !res.zeroCrError && !res.isSelfCapture)
            .map(res => {
                const p1Normal = res.p1Records.find(r => r.type === 'NORMAL');
                return { er: res.er, name: res.employerName, lf: p1Normal?.lf || 0, amt: p1Normal?.amt || 0 };
            })
            .filter(item => item.lf > 0 && item.amt > 0);
        
        if (newQueue.length > 0) {
            await safeSet({ 
                captureQueue: newQueue, 
                currentCaptureIndex: 0, 
                capturedErs: [], 
                failedErs: [],
                captureResults: {} 
            });
            await wait(300);
            window.location.reload();
            return;
        }
        return;
    }

    // If queue is empty or we've processed all items, nothing to do
    // (Completion is handled in advanceToNextER)
    if (queue.length === 0 || index >= queue.length) {
        return;
    }

    const currentRecord = queue[index];
    
    // Skip if already processed
    if (capturedList.includes(currentRecord.er) || failedList.includes(currentRecord.er)) {
        await safeSet({ currentCaptureIndex: index + 1, retryCount: 0, awaitingResponse: false });
        stuckCounter = 0;
        return;
    }

    // ==================== MODAL DETECTION (Improved) ====================
    // Checks for response modals: receipt, success, error, unknown
    // Priority: Receipt > Icon > Button > Text > Unknown
    // Does NOT check button spinner state (unreliable - can spin forever)
    
    const modalState = detectModalState();
    
    // Handle receipt modal (SUCCESS - acknowledgement letter)
    if (modalState.type === 'receipt') {
        const handled = await handleModal('receipt', modalState.element);
        if (handled) {
            await advanceToNextER(currentRecord.er, 'success', capturedList, failedList, index, 'Acknowledgement received');
            return;
        }
    }
    
    // Handle success modal (green checkmark or "Data Successfully Saved")
    if (modalState.type === 'success') {
        const handled = await handleModal('success', modalState.element);
        if (handled) {
            await advanceToNextER(currentRecord.er, 'success', capturedList, failedList, index, 'Data saved successfully');
            return;
        }
    }
    
    // Handle error modal (X icon or "Errors Occured")
    if (modalState.type === 'error') {
        const handled = await handleModal('error', modalState.element);
        if (handled) {
            // Check if it's a duplicate error ("already exists" = was captured before, not by us)
            const errorText = (modalState.message || '').toLowerCase();
            const isDuplicate = errorText.includes('already exists') || errorText.includes('duplicate');
            
            if (isDuplicate) {
                // Already captured = job done for this ER, goes to capturedList
                await advanceToNextER(currentRecord.er, 'already_captured', capturedList, failedList, index, modalState.message);
            } else {
                // Other validation error = goes to failedList
                await advanceToNextER(currentRecord.er, 'error', capturedList, failedList, index, modalState.message);
            }
            return;
        }
    }
    
    // Handle unknown modal - PAUSE and prompt user for intervention
    if (modalState.type === 'unknown') {
        log(`Unknown modal detected: ${modalState.message}`, 'error');
        isPaused = true;
        await safeSet({ 
            isPaused: true, 
            interventionRequired: true,
            interventionMessage: `Unknown modal: ${modalState.message}. Please review and click Skip or Resume.`
        });
        return;
    }
    
    // ==================== RESPONSE TIMEOUT HANDLING ====================
    
    // If we submitted and are waiting for response, check for timeout
    if (awaitingResponse && lastSubmitTime > 0) {
        const elapsed = Date.now() - lastSubmitTime;
        
        if (elapsed > RESPONSE_TIMEOUT_MS) {
            log(`Response timeout after ${Math.round(elapsed/1000)}s`, 'warn');
            
            if (retries < 1) {
                // First timeout: retry submit once
                log('Retrying submit...', 'warn');
                await safeSet({ retryCount: retries + 1, awaitingResponse: false, lastSubmitTime: 0 });
                stuckCounter = 0;
                // Will fall through to form filling/submit logic below
            } else {
                // Second timeout: mark as failed and move on
                log('Response unreadable after retry, marking as FAILED', 'error');
                await advanceToNextER(currentRecord.er, 'failed', capturedList, failedList, index);
                return;
            }
        } else {
            // Still waiting for response, don't do anything else
            log(`Waiting for response... (${Math.round(elapsed/1000)}s / ${RESPONSE_TIMEOUT_MS/1000}s)`, 'info');
            return;
        }
    }

    // ==================== PAGE DETECTION & FORM FILLING ====================
    
    // Helper to check if we should continue (checks pause state from storage)
    async function checkPauseState() {
        const pauseData = await safeGet(['isPaused']);
        if (pauseData?.isPaused) {
            isPaused = true;
            log('Pause detected mid-operation, stopping...', 'warn');
            return false;
        }
        return true;
    }
    
    const currentUrl = window.location.href;
    const isEmployerPage = currentUrl.includes('/receive/employer') && !currentUrl.includes('/capture');
    const isCapturePage = currentUrl.includes('/receive/capture');

    // STATE 1: Employer page - enter ER and continue
    if (isEmployerPage) {
        const initialErInput = document.querySelector('input[maxlength="9"].form-control:not(#changeER)');
        const initialContinueBtn = document.getElementById('addToTable');
        
        if (initialErInput && initialContinueBtn && initialErInput.offsetParent !== null) {
            log(`[STATE 1] Employer page: entering ER ${currentRecord.er}`);
            
            // Check pause before each action
            if (!await checkPauseState()) return;
            
            initialErInput.blur();
            await wait(100);
            initialErInput.focus();
            await wait(50);
            setNativeValue(initialErInput, currentRecord.er);
            initialErInput.blur();
            await wait(400);
            
            // Check pause before clicking continue
            if (!await checkPauseState()) return;
            
            initialContinueBtn.disabled = false;
            initialContinueBtn.classList.remove('disabled', 'btn-grey');
            
            if (initialErInput.value === currentRecord.er) {
                initialContinueBtn.click();
                stuckCounter = 0;
            }
            return;
        }
    }

    // STATE 2: Capture form page - fill and submit
    if (isCapturePage) {
        // Check if showing wrong employer - redirect to employer page instead of using changeER
        const headerTitle = document.querySelector('h4.text-info');
        const headerText = headerTitle ? headerTitle.innerText : '';
        
        if (headerText && !headerText.includes(currentRecord.er)) {
            log(`Wrong employer displayed, navigating to employer page...`, 'warn');
            window.location.href = "https://app.issas.ssnit.org.gh/contributions/receive/employer";
            return;
        }

        // Fill the form - check pause between each field
        log(`[STATE 2] Filling form for ${currentRecord.er}...`);

        // Check pause before starting form fill
        if (!await checkPauseState()) return;

        // Period inputs
        const periodInputs = document.querySelectorAll('input[placeholder*="YYYYMM"]');
        periodInputs.forEach(inp => {
            if (inp.value !== data.targetPeriod) setNativeValue(inp, data.targetPeriod);
        });
        await wait(200);
        
        if (!await checkPauseState()) return;

        // Submission Medium: Preprinted
        const mediaRadio = document.querySelector('input[name="sub_media"][value="1"]');
        if (mediaRadio && !mediaRadio.checked) {
            mediaRadio.click();
            await wait(200);
        }
        
        if (!await checkPauseState()) return;
        
        // Submission Mode: Contribution
        const modeRadio = document.querySelector('input[name="sub_mod"][value="2"]');
        if (modeRadio && !modeRadio.checked) {
            modeRadio.click();
            await wait(400);
        }
        
        if (!await checkPauseState()) return;

        // Dropdowns
        await selectVueOption('Contribution Type', 'NORMAL');
        await wait(300);
        
        if (!await checkPauseState()) return;
        
        await selectVueOption('Staff Category', 'ALL');
        await wait(300);
        
        if (!await checkPauseState()) return;

        // Number of Employees
        let lfInput = document.getElementById('no_employees');
        if (lfInput) {
            lfInput.focus();
            await wait(50);
            setNativeValue(lfInput, currentRecord.lf.toString());
            lfInput.blur();
            await wait(200);
        }
        
        if (!await checkPauseState()) return;
        
        // Total Contribution Amount - use PageOps for finding and setting
        const amtInput = PageOps.findInputByLabel('total contribution');
        if (amtInput) {
            await PageOps.setVueInput(amtInput, currentRecord.amt.toFixed(2));
        }

        await wait(600);
        
        // Final pause check before submit
        if (!await checkPauseState()) return;

        // Submit
        const submitBtn = document.getElementById('addToTable2');
        if (submitBtn && !submitBtn.disabled) {
            log(`[STATE 3] Submitting ${currentRecord.er}...`, 'success');
            
            // Track submission time for timeout handling
            lastSubmitTime = Date.now();
            awaitingResponse = true;
            await safeSet({ lastSubmitTime, awaitingResponse: true });
            
            submitBtn.click();
            stuckCounter = 0;
            return;
        } else {
            // Button disabled - increment stuck counter
            stuckCounter++;
            log(`Submit button disabled (stuck: ${stuckCounter}/${MAX_STUCK_COUNT})`, 'warn');
            
            if (stuckCounter >= MAX_STUCK_COUNT) {
                log('Max stuck count reached, marking as FAILED', 'error');
                await advanceToNextER(currentRecord.er, 'failed', capturedList, failedList, index);
                return;
            }
            
            // Try to trigger validation
            if (lfInput) {
                lfInput.focus();
                lfInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
            }
        }
    }
    
    // STATE 5: Unknown page - navigate to employer page
    if (!isEmployerPage && !isCapturePage) {
        stuckCounter++;
        log(`Unknown page state (stuck: ${stuckCounter}/${MAX_STUCK_COUNT})`, 'warn');
        
        if (stuckCounter >= MAX_STUCK_COUNT) {
            log('Navigating to employer page...', 'warn');
            stuckCounter = 0;
            window.location.href = "https://app.issas.ssnit.org.gh/contributions/receive/employer";
        }
    }
}


// ==================== DASHBOARD ====================

function createDashboard() {
    const existing = document.getElementById('ssnit-automation-container');
    if (existing) existing.remove();

    const container = document.createElement('div');
    container.id = 'ssnit-automation-container';
    
    container.innerHTML = `
        <div class="click-outside-overlay"></div>
        <div class="dash-bubble">
            <div class="bubble-content">
                <span class="bubble-count" id="bubble-count">0</span>
                <span class="bubble-label">SSNIT</span>
            </div>
        </div>
        <div class="dash-window">
            <div class="dash-header">
                <div>
                    <span class="app-title">🏛️ SSNIT Automator</span>
                    <span class="period-tag" id="dash-period">--</span>
                    <span class="period-tag" id="dash-phase">IDLE</span>
                </div>
                <div>
                    <button class="ctrl-btn" id="dash-skip" title="Skip current ER">⏭</button>
                    <button class="ctrl-btn" id="dash-pause" title="Pause/Resume">⏸</button>
                    <button class="ctrl-btn" id="dash-minimize" title="Minimize">_</button>
                    <button class="ctrl-btn btn-danger" id="dash-stop" title="Stop">■</button>
                </div>
            </div>
            <div class="progress-bar-container">
                <div class="progress-fill" id="progress-fill" style="width: 0%"></div>
            </div>
            <div id="login-warning" style="display: none; background: #fef3c7; color: #92400e; padding: 10px; text-align: center; font-weight: bold;">
                ⚠️ Session expired - Please log in to continue
            </div>
            <div id="intervention-warning" style="display: none; background: #fee2e2; color: #991b1b; padding: 10px; text-align: center; font-weight: bold;">
                ⚠️ <span id="intervention-message">Manual intervention required</span>
            </div>
            <div class="dash-content" id="dash-content">
                <div class="dash-col">
                    <div class="col-header">📋 Queue <span id="queue-count">(0)</span> <button class="add-manual-btn" id="toggle-manual-input" title="Add ER manually">➕</button></div>
                    <div class="scroll-wrapper">
                        <table class="dash-table">
                            <thead>
                                <tr><th>ER No</th><th>Employer</th><th>LF</th><th>Amt</th><th>Status</th><th>Act</th></tr>
                            </thead>
                            <tbody id="dash-table-body"></tbody>
                        </table>
                    </div>
                </div>
                <div class="dash-col">
                    <div class="col-header">⚠️ Needs Review <span id="review-count">(0)</span></div>
                    <div class="scroll-wrapper" id="review-list"></div>
                </div>
            </div>
            <div id="manual-input-section" class="manual-input-panel">
                <div class="manual-input-header">
                    <span>➕ Add ER Manually</span>
                    <button id="close-manual-input" class="close-manual-btn">✕</button>
                </div>
                <div class="manual-input-row">
                    <input type="text" id="manual-er" placeholder="ER Number" maxlength="9" class="manual-field manual-er-field">
                    <input type="text" id="manual-name" placeholder="Employer Name" class="manual-field manual-name-field">
                    <input type="number" id="manual-lf" placeholder="LF" min="1" class="manual-field manual-lf-field">
                    <input type="number" id="manual-amt" placeholder="Amount" step="0.01" min="0" class="manual-field manual-amt-field">
                    <button id="add-manual-er-btn" class="manual-add-btn">Add</button>
                </div>
            </div>
            <button class="main-proceed-btn" id="start-capture-btn">🚀 Start Capture Phase</button>
            <div id="validation-options" style="display: none; padding: 8px 15px; background: #f0f9ff; border-top: 1px solid #bae6fd;">
                <label style="display: flex; align-items: center; gap: 8px; font-size: 12px; color: #0369a1; cursor: pointer;">
                    <input type="checkbox" id="auto-post-checkbox" style="width: 16px; height: 16px; cursor: pointer;">
                    <span>Post transactions after successful validation</span>
                </label>
            </div>
            <button class="main-proceed-btn validation-btn" id="start-validation-btn" style="display: none;">✅ Start Validation Phase</button>
            <button class="force-validate-btn" id="force-validate-btn" style="display: none;">🔄 Force Validate All Unprocessed</button>
            <button class="main-proceed-btn wage-edit-btn" id="start-wage-edit-btn" style="display: none; background: #f59e0b;">💰 Process Wage Edits (<span id="wage-edit-count">0</span>)</button>
            <div class="capture-footer" id="capture-footer" style="display: none;">
                <span id="capture-status">Initializing...</span>
            </div>
        </div>
    `;
    
    document.body.appendChild(container);
    
    // Event listeners
    document.getElementById('dash-minimize').addEventListener('click', () => {
        container.classList.add('minimized');
    });
    
    container.querySelector('.dash-bubble').addEventListener('click', () => {
        container.classList.remove('minimized');
    });
    
    container.querySelector('.click-outside-overlay').addEventListener('click', () => {
        container.classList.add('minimized');
    });
    
    document.getElementById('dash-pause').addEventListener('click', togglePause);
    
    // Skip button - skip current ER and move to next (works in CAPTURE, VALIDATION, and WAGE_EDIT phases)
    document.getElementById('dash-skip').addEventListener('click', async () => {
        const data = await safeGet(['phase']);
        const phase = data?.phase;

        if (phase === 'CAPTURE') {
            if (confirm("Skip current ER and move to next?")) {
                await skipCurrentER();
            }
        } else if (phase === 'VALIDATION') {
            if (confirm("Skip current CR validation and move to next?")) {
                await skipCurrentValidation();
            }
        } else if (phase === 'WAGE_EDIT') {
            if (confirm("Skip current wage edit and move to next?")) {
                await skipCurrentWageEdit();
            }
        } else {
            alert('Skip is only available during capture, validation, or wage edit phases');
        }
    });
    
    document.getElementById('dash-stop').addEventListener('click', async () => {
        if (confirm("Stop automation?")) {
            if (captureInterval) clearInterval(captureInterval);
            if (validationInterval) clearInterval(validationInterval);
            if (wageEditInterval) clearInterval(wageEditInterval);
            isPaused = false;
            await safeSet({
                phase: 'IDLE',
                erQueue: [],
                captureQueue: [],
                validationQueue: [],
                wageEditQueue: [],
                needsWageEdit: [],
                interventionRequired: false,
                automationTabId: null
            });
            window.location.reload();
        }
    });
    
    document.getElementById('start-capture-btn').addEventListener('click', startCapturePhase);
    
    // Start Validation - save checkbox state before starting
    document.getElementById('start-validation-btn').addEventListener('click', async () => {
        const autoPostCheckbox = document.getElementById('auto-post-checkbox');
        const shouldAutoPost = autoPostCheckbox?.checked || false;
        await safeSet({ autoPostAfterValidation: shouldAutoPost });
        startValidationPhase();
    });

    // Start Wage Edit phase
    document.getElementById('start-wage-edit-btn').addEventListener('click', startWageEditPhase);

    // Force Validate All - validates all CRs in unprocessed table (not just captured ones)
    document.getElementById('force-validate-btn').addEventListener('click', async () => {
        if (confirm('This will validate ALL CRs currently in the unprocessed table, not just those captured by this automation. Continue?')) {
            const autoPostCheckbox = document.getElementById('auto-post-checkbox');
            const shouldAutoPost = autoPostCheckbox?.checked || false;
            await safeSet({ autoPostAfterValidation: shouldAutoPost });
            await startForceValidationPhase();
        }
    });

    // Toggle manual input section
    document.getElementById('toggle-manual-input').addEventListener('click', () => {
        const section = document.getElementById('manual-input-section');
        section.classList.toggle('visible');
    });
    
    // Close manual input section
    document.getElementById('close-manual-input').addEventListener('click', () => {
        document.getElementById('manual-input-section').classList.remove('visible');
    });
    
    // Add manual ER button
    document.getElementById('add-manual-er-btn').addEventListener('click', addManualER);
    
    // Track user interaction with dashboard to prevent refresh during interaction
    // This allows copying ER numbers, selecting text, etc.
    const dashWindow = container.querySelector('.dash-window');
    if (dashWindow) {
        // Set flag when user is interacting (mouseenter, focus, selection)
        dashWindow.addEventListener('mouseenter', () => {
            userInteractingWithDashboard = true;
        });
        dashWindow.addEventListener('mouseleave', () => {
            // Small delay before allowing refresh again (for click actions)
            setTimeout(() => {
                userInteractingWithDashboard = false;
            }, 500);
        });
        
        // Also detect text selection
        dashWindow.addEventListener('selectstart', () => {
            userInteractingWithDashboard = true;
        });
        document.addEventListener('selectionchange', () => {
            const selection = window.getSelection();
            if (selection && selection.toString().length > 0) {
                userInteractingWithDashboard = true;
            }
        });
    }
    
    // Event-driven dashboard updates instead of constant polling
    // Only poll during active phases, otherwise rely on storage.onChanged
    setupDashboardUpdates();
    updateDashboardUI();
}

// Dashboard update interval reference
let dashboardInterval = null;

/**
 * Setup smart dashboard updates:
 * - Uses chrome.storage.onChanged for reactive updates
 * - Only polls during active automation phases
 */
function setupDashboardUpdates() {
    // Listen for storage changes and update UI reactively
    if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== 'local') return;
            
            // Keys that should trigger UI update
            const uiKeys = [
                'phase', 'scrapedResults', 'captureQueue', 'validationQueue',
                'currentCaptureIndex', 'currentValidationIndex',
                'isPaused', 'capturedErs', 'failedErs', 'validatedErs',
                'interventionRequired', 'interventionMessage', 'loginPending',
                'captureResults', 'targetPeriod',
                'needsWageEdit', 'wageEditQueue', 'currentWageEditIndex'
            ];
            
            // Update if any relevant key changed
            if (uiKeys.some(key => key in changes)) {
                // Don't update if user is editing
                if (!currentlyEditingER) {
                    updateDashboardUI();
                }
            }
            
            // Start/stop polling based on phase
            const phaseChange = changes.phase;
            if (phaseChange) {
                const newPhase = phaseChange.newValue;
                if (newPhase === 'CAPTURE' || newPhase === 'VALIDATION' || newPhase === 'SCRAPING' || newPhase === 'WAGE_EDIT') {
                    startDashboardPolling();
                } else {
                    stopDashboardPolling();
                }
            }
        });
    }
    
    // Initial check - start polling if already in active phase
    safeGet(['phase']).then(data => {
        const phase = data?.phase;
        if (phase === 'CAPTURE' || phase === 'VALIDATION' || phase === 'SCRAPING' || phase === 'WAGE_EDIT') {
            startDashboardPolling();
        }
    });
}

/**
 * Start polling dashboard (only during active automation)
 */
function startDashboardPolling() {
    if (!dashboardInterval) {
        dashboardInterval = setInterval(() => {
            // Don't refresh if:
            // - User is editing a row
            // - User is paused (let them interact freely)
            // - User is hovering/interacting with dashboard
            if (!currentlyEditingER && !isPaused && !userInteractingWithDashboard) {
                updateDashboardUI();
            }
        }, 2000); // Increased to 2 seconds for less aggressive refresh
        log('Dashboard polling started', 'info');
    }
}

/**
 * Stop polling dashboard (when idle or complete)
 */
function stopDashboardPolling() {
    if (dashboardInterval) {
        clearInterval(dashboardInterval);
        dashboardInterval = null;
        log('Dashboard polling stopped', 'info');
    }
}

async function togglePause() {
    isPaused = !isPaused;
    const pauseBtn = document.getElementById('dash-pause');
    
    if (isPaused) {
        pauseBtn.textContent = '▶';
        pauseBtn.title = 'Resume';
        log('Automation PAUSED', 'warn');
        await safeSet({ isPaused });
    } else {
        pauseBtn.textContent = '⏸';
        pauseBtn.title = 'Pause';
        log('Automation RESUMED', 'success');
        // Clear intervention state when resuming
        await safeSet({ isPaused, interventionRequired: false, interventionMessage: '' });
    }
    
    updateDashboardUI();
}

async function startCapturePhase() {
    // Ensure this tab is the automation tab (capture runs only in this tab)
    await registerThisTabAsAutomationTab();

    const data = await safeGet(['scrapedResults', 'targetPeriod']);
    const scraped = data?.scrapedResults || [];
    
    const valid = scraped.filter(s => 
        !s.alreadyCaptured && !s.continuityError && !s.zeroCrError && !s.isSelfCapture
    );
    
    if (valid.length === 0) {
        alert("No valid employers to capture.");
        return;
    }

    const queue = valid.map(s => {
        const p1 = s.p1Records.find(r => r.type === 'NORMAL');
        return { er: s.er, name: s.employerName, lf: p1?.lf || 0, amt: p1?.amt || 0 };
    }).filter(item => item.lf > 0 && item.amt > 0);

    if (queue.length === 0) {
        alert("No valid data to capture.");
        return;
    }

    log(`Starting capture with ${queue.length} employers`, 'success');
    
    await safeSet({
        phase: 'CAPTURE',
        captureQueue: queue,
        currentCaptureIndex: 0,
        capturedErs: [],
        failedErs: [],
        retryCount: 0,
        isPaused: false
    });
    
    isPaused = false;
    await wait(200);
    window.location.href = "https://app.issas.ssnit.org.gh/contributions/receive/employer";
}

async function updateDashboardUI() {
    // Skip update if user is actively interacting with dashboard
    if (userInteractingWithDashboard || currentlyEditingER) {
        return;
    }

    const data = await safeGet([
        'erQueue', 'originalErCount', // For scraping progress
        'phase', 'targetPeriod', 'scrapedResults',
        'captureQueue', 'currentCaptureIndex',
        'capturedErs', 'failedErs', 'isPaused', 'loginPending',
        'captureResults', 'interventionRequired', 'interventionMessage',
        'validationQueue', 'currentValidationIndex', 'validatedErs', 'validationFailedErs', 'validationResults',
        'needsWageEdit', 'wageEditQueue', 'currentWageEditIndex'
    ]);

    if (!data) return;

    const phase = data.phase || 'IDLE';
    const period = data.targetPeriod || '--';
    const scraped = data.scrapedResults || [];
    const captureQueue = data.captureQueue || [];
    const captureIdx = data.currentCaptureIndex || 0;
    const captured = data.capturedErs || [];
    const failed = data.failedErs || [];
    const needsWageEdit = data.needsWageEdit || [];
    const wageEditQueue = data.wageEditQueue || [];

    // Content-aware hash to detect if data actually changed - skip re-render if same
    // Uses fingerprint for scraped data to detect edits (not just length changes)
    const scrapedFP = computeScrapedFingerprint(scraped);
    const dataHash = JSON.stringify({
        phase, period,
        scrapedFP, // Fingerprint includes content, detects edits
        scrapedLen: scraped.length,
        captureLen: captureQueue.length,
        captureIdx,
        capturedLen: captured.length,
        failedLen: failed.length,
        paused: data.isPaused,
        intervention: data.interventionRequired,
        validationIdx: data.currentValidationIndex,
        validatedLen: (data.validatedErs || []).length,
        needsWageEditLen: needsWageEdit.length,
        wageEditIdx: data.currentWageEditIndex
    });

    if (dataHash === lastDataHash) {
        return; // No changes, skip expensive DOM rebuild
    }
    lastDataHash = dataHash;
    
    // Update pause state from storage
    if (data.isPaused !== undefined) isPaused = data.isPaused;

    document.getElementById('dash-period').textContent = period;
    
    // Phase display - show INTERVENTION if needed
    const phaseDisplay = data.interventionRequired ? 'INTERVENTION' : (isPaused ? 'PAUSED' : phase);
    document.getElementById('dash-phase').textContent = phaseDisplay;
    
    // Login warning
    const loginWarning = document.getElementById('login-warning');
    if (loginWarning) {
        loginWarning.style.display = data.loginPending ? 'block' : 'none';
    }
    
    // Intervention warning
    const interventionWarning = document.getElementById('intervention-warning');
    const interventionMessage = document.getElementById('intervention-message');
    if (interventionWarning) {
        interventionWarning.style.display = data.interventionRequired ? 'block' : 'none';
        if (interventionMessage && data.interventionMessage) {
            interventionMessage.textContent = data.interventionMessage;
        }
    }
    
    // Update pause button
    const pauseBtn = document.getElementById('dash-pause');
    if (pauseBtn) {
        pauseBtn.textContent = isPaused ? '▶' : '⏸';
    }
    
    const tableBody = document.getElementById('dash-table-body');
    const reviewList = document.getElementById('review-list');
    const startBtn = document.getElementById('start-capture-btn');
    const captureFooter = document.getElementById('capture-footer');
    const progressFill = document.getElementById('progress-fill');
    
    if (!tableBody) return;
    
    tableBody.innerHTML = '';
    if (reviewList) reviewList.innerHTML = '';

    // Scraping phase display
    if (phase === 'SCRAPING' || (phase !== 'CAPTURE' && phase !== 'COMPLETE' && scraped.length > 0 && captureQueue.length === 0)) {
        if (startBtn) startBtn.style.display = 'block';
        if (captureFooter) captureFooter.style.display = 'none';
        
        let validCount = 0;
        let reviewItems = [];
        
        scraped.forEach(res => {
            const p1Normal = res.p1Records.find(r => r.type === 'NORMAL');
            let status = '⏳';
            let statusClass = '';
            let statusTitle = 'Ready for capture';
            
            if (res.alreadyCaptured) { 
                status = '✅ Done'; 
                statusClass = 'row-done'; 
                statusTitle = 'Already captured in target period';
            }
            else if (res.continuityError) { 
                status = '⚠️ Gap'; 
                statusClass = 'row-warning';
                statusTitle = 'Missing previous month data';
                reviewItems.push({ ...res, reason: 'Missing previous month' }); 
            }
            else if (res.zeroCrError) { 
                status = '❌ Zero'; 
                statusClass = 'row-error';
                statusTitle = 'Zero LF or Amount in previous month';
                reviewItems.push({ ...res, reason: 'Zero contribution' }); 
            }
            else if (res.isSelfCapture) { 
                status = '🌐 Web'; 
                statusClass = 'row-web';
                statusTitle = 'Self-captured via web portal';
                reviewItems.push({ ...res, reason: 'Self-captured' }); 
            }
            else { 
                validCount++; 
                // Check if manually entered or edited based on p1 period marker
                if (p1Normal?.period === 'MANUAL') {
                    status = '📝 Manual';
                    statusTitle = 'Manually entered';
                } else if (p1Normal?.period === 'EDITED') {
                    status = '✏️ Edited';
                    statusTitle = 'Data was edited';
                }
            }
            
            const tr = document.createElement('tr');
            tr.className = statusClass;
            tr.setAttribute('data-id', res.id || res.er); // Use UUID as primary identity
            tr.setAttribute('data-er', res.er); // Keep ER for backwards compatibility
            tr.innerHTML = `
                <td class="er-cell">${res.er}</td>
                <td class="name-cell" title="${res.employerName}">${res.employerName}</td>
                <td class="num-cell">${p1Normal?.lf || '-'}</td>
                <td class="num-cell">${p1Normal?.amt?.toFixed(2) || '-'}</td>
                <td><span class="status-text" title="${statusTitle}">${status}</span></td>
                <td class="action-cell">
                    <button class="row-edit-btn" data-er="${res.er}" title="Edit this record">✏️</button>
                    <button class="row-delete-btn" data-er="${res.er}" title="Delete this record">🗑️</button>
                </td>
            `;
            tableBody.appendChild(tr);

            // Add event listeners for edit and delete buttons
            tr.querySelector('.row-edit-btn').addEventListener('click', () => editScrapedRecord(res.er));
            tr.querySelector('.row-delete-btn').addEventListener('click', () => deleteScrapedRecord(res.er));
        });
        
        document.getElementById('queue-count').textContent = `(${validCount} valid)`;
        document.getElementById('review-count').textContent = `(${reviewItems.length})`;
        document.getElementById('bubble-count').textContent = scraped.length;
        
        reviewItems.forEach(item => {
            const card = document.createElement('div');
            card.className = 'review-card';
            card.innerHTML = `
                <span class="badge ${item.isSelfCapture ? 'badge-globe' : 'badge-review'}">
                    ${item.isSelfCapture ? '🌐 WEB' : '⚠️ REVIEW'}
                </span>
                <div class="emp-name">${item.er} - ${item.employerName}</div>
                <div style="font-size: 10px; color: #666;">${item.reason}</div>
            `;
            reviewList.appendChild(card);
        });
        
        if (startBtn) {
            startBtn.textContent = `🚀 Start Capture (${validCount} employers)`;
            startBtn.disabled = validCount === 0;
        }

        // Dynamic progress bar for scraping phase
        if (progressFill) {
            const erQueue = data.erQueue || [];
            const originalCount = data.originalErCount || (scraped.length + erQueue.length);
            if (phase === 'SCRAPING' && originalCount > 0) {
                // Show actual progress during active scraping
                const pct = (scraped.length / originalCount) * 100;
                progressFill.style.width = `${pct}%`;
                progressFill.style.background = '#3b82f6'; // Blue while scraping
            } else {
                // Scraping complete - show 100%
                progressFill.style.width = '100%';
                progressFill.style.background = '#10b981';
            }
        }
    }
    
    // Capture phase display
    else if (phase === 'CAPTURE' || (phase === 'COMPLETE' && !data.validationQueue?.length)) {
        if (startBtn) startBtn.style.display = 'none';
        if (captureFooter) captureFooter.style.display = 'block';
        
        const total = captureQueue.length;
        const done = captured.length + failed.length;
        const pct = total > 0 ? (done / total) * 100 : 0;

        // Show validation button and options when capture is complete
        const validationBtn = document.getElementById('start-validation-btn');
        const validationOptions = document.getElementById('validation-options');
        const wageEditBtn = document.getElementById('start-wage-edit-btn');
        const forceValidateBtn = document.getElementById('force-validate-btn');
        const showValidation = phase === 'COMPLETE' && captured.length > 0;
        if (validationBtn) {
            validationBtn.style.display = showValidation ? 'block' : 'none';
            validationBtn.textContent = `✅ Start Validation (${captured.length} CRs)`;
        }
        if (validationOptions) {
            validationOptions.style.display = showValidation ? 'block' : 'none';
        }
        // Show Force Validate All button alongside regular validation button
        if (forceValidateBtn) {
            forceValidateBtn.style.display = showValidation ? 'block' : 'none';
        }
        // Show wage edit button if there are items needing wage adjustment
        if (wageEditBtn) {
            wageEditBtn.style.display = needsWageEdit.length > 0 ? 'block' : 'none';
            document.getElementById('wage-edit-count').textContent = needsWageEdit.length;
        }
        
        // Get capture results for detailed status
        const captureResults = data.captureResults || {};
        
        if (progressFill) {
            progressFill.style.width = `${pct}%`;
            progressFill.style.background = failed.length > 0 ? '#f59e0b' : '#10b981';
        }
        
        const statusEl = document.getElementById('capture-status');
        if (statusEl) {
            const pauseText = isPaused ? ' [PAUSED]' : '';
            statusEl.textContent = phase === 'COMPLETE'
                ? `✅ Capture Done! ${captured.length} captured, ${failed.length} failed`
                : `Processing ${captureIdx + 1}/${total}...${pauseText} (${captured.length} done, ${failed.length} failed)`;
        }
        
        document.getElementById('queue-count').textContent = `(${total})`;
        document.getElementById('bubble-count').textContent = `${done}/${total}`;
        
        captureQueue.forEach((item, idx) => {
            const tr = document.createElement('tr');
            const result = captureResults[item.er];
            
            // Determine row class and status based on result
            // Result types: success, already_captured, error, failed, skipped
            let status = '⏳';
            let statusTitle = 'Pending';
            
            if (captured.includes(item.er)) {
                tr.className = 'row-done';
                if (result?.result === 'already_captured') {
                    status = '🔁'; // Already captured before (duplicate)
                    statusTitle = `Already captured: ${result.message || 'duplicate'}`;
                } else {
                    status = '✅';
                    statusTitle = result?.message || 'Successfully captured';
                }
            } else if (failed.includes(item.er)) {
                tr.className = 'row-failed';
                if (result?.result === 'error') {
                    status = '⚠️';
                    statusTitle = `Error: ${result.message || 'Submission error'}`;
                } else if (result?.result === 'failed') {
                    status = '❌';
                    statusTitle = 'Failed - no response after retry';
                } else if (result?.result === 'skipped') {
                    status = '⏭️';
                    statusTitle = 'Skipped by user';
                    tr.className = 'row-skipped';
                } else {
                    status = '❌';
                    statusTitle = 'Failed';
                }
            } else if (idx === captureIdx) {
                tr.className = 'row-active';
                if (data.interventionRequired) {
                    status = '🛑';
                    statusTitle = 'Needs intervention';
                } else {
                    status = isPaused ? '⏸' : '🔄';
                    statusTitle = isPaused ? 'Paused' : 'Processing...';
                }
            }
            
            tr.innerHTML = `
                <td class="er-cell">${item.er}</td>
                <td class="name-cell" title="${item.name}">${item.name}</td>
                <td class="num-cell">${item.lf}</td>
                <td class="num-cell">${item.amt.toFixed(2)}</td>
                <td><span class="status-text" title="${statusTitle}">${status}</span></td>
                <td class="action-cell"></td>
            `;
            tableBody.appendChild(tr);
        });
    }
    
    // Validation phase display
    else if (phase === 'VALIDATION' || (phase === 'COMPLETE' && data.validationQueue?.length > 0)) {
        if (startBtn) startBtn.style.display = 'none';
        const validationBtn = document.getElementById('start-validation-btn');
        const validationOptions = document.getElementById('validation-options');
        const wageEditBtn = document.getElementById('start-wage-edit-btn');
        if (validationBtn) validationBtn.style.display = 'none';
        if (validationOptions) validationOptions.style.display = 'none';
        if (captureFooter) captureFooter.style.display = 'block';

        // Show wage edit button if there are items needing wage adjustment
        if (wageEditBtn) {
            wageEditBtn.style.display = needsWageEdit.length > 0 ? 'block' : 'none';
            document.getElementById('wage-edit-count').textContent = needsWageEdit.length;
        }
        
        const validationQueue = data.validationQueue || [];
        const validationIdx = data.currentValidationIndex || 0;
        const validated = data.validatedErs || [];
        const validationFailed = data.validationFailedErs || [];
        const validationResults = data.validationResults || {};
        
        const total = validationQueue.length;
        const done = validated.length + validationFailed.length;
        const pct = total > 0 ? (done / total) * 100 : 0;
        
        if (progressFill) {
            progressFill.style.width = `${pct}%`;
            progressFill.style.background = validationFailed.length > 0 ? '#f59e0b' : '#3b82f6';
        }
        
        const statusEl = document.getElementById('capture-status');
        if (statusEl) {
            const pauseText = isPaused ? ' [PAUSED]' : '';
            const isActuallyComplete = phase === 'COMPLETE' || (total > 0 && validationIdx >= total);
            const displayIdx = Math.min(validationIdx + 1, total);
            statusEl.textContent = isActuallyComplete
                ? `✅ All Done! ${validated.length} validated, ${validationFailed.length} failed`
                : `Validating ${displayIdx}/${total}...${pauseText} (${validated.length} done)`;
        }

        document.getElementById('queue-count').textContent = `(${total})`;
        document.getElementById('bubble-count').textContent = `${done}/${total}`;
        
        // Table header for validation
        const thead = tableBody.closest('table').querySelector('thead tr');
        if (thead) {
            thead.innerHTML = '<th>ER No</th><th>Employer</th><th colspan="2">Period</th><th>Status</th><th>Act</th>';
        }
        
        validationQueue.forEach((item, idx) => {
            const tr = document.createElement('tr');
            const result = validationResults[item.er];
            
            let status = '⏳';
            let statusTitle = 'Pending validation';
            
            if (validated.includes(item.er)) {
                tr.className = 'row-done';
                status = '✅';
                statusTitle = result?.message || 'Submitted for validation';
            } else if (validationFailed.includes(item.er)) {
                tr.className = 'row-failed';
                if (result?.result === 'skipped') {
                    status = '⏭️';
                    statusTitle = 'Skipped by user';
                    tr.className = 'row-skipped';
                } else if (result?.result === 'not_found') {
                    status = '🔍';
                    statusTitle = 'CR not found in unprocessed list';
                } else if (result?.result === 'ctb_adjustment') {
                    status = '💰';
                    statusTitle = `CTB below minimum: ${result?.message || 'Needs wage adjustment'}`;
                    tr.className = 'row-warning';
                } else {
                    status = '❌';
                    statusTitle = result?.message || 'Validation failed';
                }
            } else if (idx === validationIdx) {
                tr.className = 'row-active';
                status = isPaused ? '⏸' : '🔄';
                statusTitle = isPaused ? 'Paused' : 'Processing...';
            }
            
            tr.innerHTML = `
                <td class="er-cell">${item.er}</td>
                <td class="name-cell" title="${item.name}">${item.name}</td>
                <td colspan="2" class="num-cell">${formatPeriod(item.period)}</td>
                <td><span class="status-text" title="${statusTitle}">${status}</span></td>
                <td class="action-cell"></td>
            `;
            tableBody.appendChild(tr);
        });
    }

    // Wage Edit phase display
    else if (phase === 'WAGE_EDIT') {
        if (startBtn) startBtn.style.display = 'none';
        const validationBtn = document.getElementById('start-validation-btn');
        const validationOptions = document.getElementById('validation-options');
        const wageEditBtn = document.getElementById('start-wage-edit-btn');
        if (validationBtn) validationBtn.style.display = 'none';
        if (validationOptions) validationOptions.style.display = 'none';
        if (wageEditBtn) wageEditBtn.style.display = 'none'; // Hide during processing
        if (captureFooter) captureFooter.style.display = 'block';

        const total = wageEditQueue.length;
        const wageEditIdx = data.currentWageEditIndex || 0;
        const done = wageEditIdx;
        const pct = total > 0 ? (done / total) * 100 : 0;

        if (progressFill) {
            progressFill.style.width = `${pct}%`;
            progressFill.style.background = '#f59e0b';
        }

        const statusEl = document.getElementById('capture-status');
        if (statusEl) {
            const pauseText = isPaused ? ' [PAUSED]' : '';
            statusEl.textContent = `💰 Editing wage ${wageEditIdx + 1}/${total}...${pauseText}`;
        }

        document.getElementById('queue-count').textContent = `(${total})`;
        document.getElementById('bubble-count').textContent = `${done}/${total}`;

        // Table header for wage edit
        const thead = tableBody.closest('table').querySelector('thead tr');
        if (thead) {
            thead.innerHTML = '<th>ER No</th><th>Employer</th><th>Current</th><th>Adjusted</th><th>Status</th><th>Act</th>';
        }

        wageEditQueue.forEach((item, idx) => {
            const tr = document.createElement('tr');

            let status = '⏳';
            let statusTitle = 'Pending edit';

            if (item.editResult === 'updated') {
                tr.className = 'row-done';
                status = '✅';
                statusTitle = item.editMessage || 'Total updated';
            } else if (item.editResult === 'skipped') {
                tr.className = 'row-skipped';
                status = '⏭️';
                statusTitle = 'Skipped by user';
            } else if (item.editResult === 'not_found' || item.editResult === 'stuck') {
                tr.className = 'row-failed';
                status = '❌';
                statusTitle = item.editMessage || 'Edit failed';
            } else if (idx === wageEditIdx) {
                tr.className = 'row-active';
                status = isPaused ? '⏸' : '🔄';
                statusTitle = isPaused ? 'Paused' : 'Processing...';
            }

            tr.innerHTML = `
                <td class="er-cell">${item.er}</td>
                <td class="name-cell" title="${item.name}">${item.name}</td>
                <td class="num-cell">${item.currentTotal?.toFixed(2) || '--'}</td>
                <td class="num-cell">${item.adjustedTotal?.toFixed(2) || '--'}</td>
                <td><span class="status-text" title="${statusTitle}">${status}</span></td>
                <td class="action-cell"></td>
            `;
            tableBody.appendChild(tr);
        });
    }
}


// ==================== MAIN ENTRY POINT ====================

async function runAutomation() {
    const state = await safeGet(['phase', 'currentER', 'captureQueue', 'currentCaptureIndex', 'validationQueue', 'wageEditQueue', 'isPaused', 'loginPending']);
    if (!state) return;

    const phase = state.phase || 'IDLE';
    isPaused = state.isPaused || false;

    // Only run automation in the tab where it was started (scraping/capture/validation)
    if (phase && phase !== 'IDLE') {
        const amAutomationTab = await isAutomationTab();
        if (!amAutomationTab) {
            log(`Automation runs in another tab (phase: ${phase}). This tab will not run actions.`, 'info');
            return;
        }
    }
    
    log(`Initializing - Phase: ${phase}, Paused: ${isPaused}`);

    // Check for login page
    if (isLoginPage()) {
        log('On login page');
        if (state.loginPending || (phase && phase !== 'IDLE')) {
            // Show minimal UI indicator that automation is waiting
            const indicator = document.createElement('div');
            indicator.style.cssText = 'position:fixed;bottom:20px;right:20px;background:#fef3c7;padding:10px 15px;border-radius:8px;z-index:999999;font-family:sans-serif;box-shadow:0 2px 10px rgba(0,0,0,0.2);';
            indicator.innerHTML = '⏸️ <b>SSNIT Automator</b>: Waiting for login...';
            document.body.appendChild(indicator);
        }
        return;
    }
    
    // Clear login pending flag if we're past login
    if (state.loginPending) {
        await safeSet({ loginPending: false });
        log('Login complete, resuming...', 'success');
        
        // Navigate to the appropriate page to resume the phase
        if (phase === 'SCRAPING' && state.currentER) {
            log('Navigating to scraping page to resume...', 'info');
            window.location.href = 'https://app.issas.ssnit.org.gh/contributions/view_crs/report';
            return;
        } else if (phase === 'CAPTURE') {
            log('Navigating to capture page to resume...', 'info');
            window.location.href = 'https://app.issas.ssnit.org.gh/contributions/receive/employer';
            return;
        } else if (phase === 'VALIDATION') {
            log('Navigating to validation page to resume...', 'info');
            window.location.href = '/contributions/view_crs/unprocessed';
            return;
        } else if (phase === 'WAGE_EDIT') {
            log('Navigating to unprocessed page to resume wage edit...', 'info');
            window.location.href = '/contributions/view_crs/unprocessed';
            return;
        }
    }

    // Create dashboard for active phases
    if (phase && phase !== 'IDLE') {
        createDashboard();
    }

    // Run appropriate phase
    if (phase === 'SCRAPING' && state.currentER && !isPaused) {
        await runScrapingPhase(state.currentER);
    }
    else if (phase === 'CAPTURE' && !isPaused) {
        captureInterval = setInterval(handleCapturePhase, 2500);
        await wait(500);
        await handleCapturePhase();
    }
    else if (phase === 'VALIDATION' && !isPaused) {
        runValidationLoop();
    }
    else if (phase === 'WAGE_EDIT' && !isPaused) {
        runWageEditLoop();
    }
}

// Start
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', runAutomation);
} else {
    setTimeout(runAutomation, 500);
}
