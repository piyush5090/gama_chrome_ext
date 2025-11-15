// =================================================================
// SERVICE WORKER (background.js)
// =================================================================

let automationState = {
  isRunning: false,
  shouldStop: false,
  currentStep: "",
  currentDetails: "",
  progress: 0,
  
  // Batch processing state
  fileQueue: [],
  totalFiles: 0,
  currentFileIndex: 0,
  currentConfig: {},
  results: {},
  
  currentFileBaseName: null // For download listener
};

// Load persisted state on startup
chrome.storage.local.get(["automationState"], (result) => {
  if (result.automationState) {
    automationState = { ...automationState, ...result.automationState };
    console.log("🔄 Restored automation state:", automationState);

    // If it was running when closed, reset it
    if (automationState.isRunning) {
        console.log("⚠️ Resetting running state on startup.");
        automationState.isRunning = false;
        automationState.shouldStop = false;
        automationState.fileQueue = [];
    }
  }
});

// Save state to storage
function saveAutomationState() {
  chrome.storage.local.set({ automationState: automationState });
}

// =================================================================
// === DOWNLOAD LISTENER ===
// =================================================================
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  // Only rename if automation is running and we have a name
  if (automationState.isRunning && automationState.currentFileBaseName) {
    if (item.referrer && item.referrer.startsWith("https://gamma.app/docs/")) {
      const originalFilename = item.filename;
      const extension = originalFilename.substring(originalFilename.lastIndexOf('.'));
      const newFilename = `${automationState.currentFileBaseName}${extension}`; 

      suggest({ filename: newFilename, conflictAction: 'overwrite' });

      // Clear the name *after suggesting*, so it's ready for the next one
      automationState.currentFileBaseName = null;
      saveAutomationState();
      
      return; // Important: use 'return'
    }
  }
  suggest(); // Allow other downloads to proceed normally
});


// =================================================================
// === MESSAGE LISTENER ===
// =================================================================
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

  if (request.action === "startBatchAutomation") {
    if (automationState.isRunning) {
      sendResponse({ success: false, error: "Automation is already running." });
      return false;
    }

    console.log("🚀 Starting batch automation...");
    automationState = {
      ...automationState,
      isRunning: true,
      shouldStop: false,
      fileQueue: request.files,
      totalFiles: request.files.length,
      currentFileIndex: 0,
      currentConfig: request.config,
      results: {},
      startTime: Date.now()
    };
    saveAutomationState();
    
    processNextFileInQueue(); // Kick off the loop
    
    sendResponse({ success: true });
    return false; 
  }

  if (request.action === "getAutomationStatus") {
    sendResponse({
      isRunning: automationState.isRunning,
      currentStep: automationState.currentStep,
      currentDetails: automationState.currentDetails,
      progress: automationState.progress,
      shouldStop: automationState.shouldStop,
      results: automationState.results // Always send results
    });
    return false;
  }

  if (request.action === "stopAutomation") {
    if (automationState.isRunning) {
        console.log("⏹️ Stop signal received.");
        automationState.shouldStop = true;
        // Don't set isRunning=false here, let the loop handle it
        saveAutomationState();
        sendStatusUpdate("⏹️ Stopping...", "Will stop after the current file.", automationState.progress);
    }
    sendResponse({ success: true });
    return false;
  }

  if (request.action === "automationLog") {
    chrome.runtime.sendMessage({
      action: "debugLog",
      message: request.message,
      data: request.data,
      timestamp: request.timestamp,
    }).catch(() => {
      // Ignore errors if popup is closed
    });
    return false;
  }
});

// =================================================================
// === BATCH PROCESSING LOOP ===
// =================================================================

function extractFirstSlide(content) {
  const match = content.match(/Slide\s*1[\s\S]*?(?=\nSlide\s*\d+|$)/i);
  if (match) {
    return match[0].trim();
  } else {
    console.warn("⚠️ No 'Slide 1' section found, using full content.");
    return content; // fallback
  }
}

async function processNextFileInQueue() {
  const state = automationState; // Get a reference

  // 1. Check stop signal
  if (state.shouldStop) {
    console.log("⏹️ Automation loop stopped.");
    state.isRunning = false;
    state.shouldStop = false;
    state.fileQueue = []; // Clear queue
    sendStatusUpdate("⏹️ Automation stopped", "User cancelled.", state.progress);
    saveAutomationState();
    return;
  }

  // 2. Check completion
  if (state.currentFileIndex >= state.totalFiles) {
    console.log("✅ Batch complete!");
    state.isRunning = false;
    state.fileQueue = []; // Clear queue
    const successCount = Object.values(state.results).filter(r => r.startsWith("http")).length;
    const failureCount = state.totalFiles - successCount;
    sendStatusUpdate("✅ Batch complete!", `Success: ${successCount}, Failed: ${failureCount}`, 100);
    saveAutomationState();
    return;
  }

  // 3. Get next file
  const file = state.fileQueue[state.currentFileIndex];
  const config = state.currentConfig;
  const fileName = file.webkitRelativePath ? file.webkitRelativePath.replace("input/", "") : file.name;
  const progressPercent = (state.currentFileIndex / state.totalFiles) * 100;

  // 4. Update UI (via popup)
  sendStatusUpdate(
    `📄 Processing file ${state.currentFileIndex + 1}/${state.totalFiles}`,
    fileName,
    progressPercent
  );

  // 5. Process the single file
  try {
    const fullContent = file.content; // Already loaded by popup
    const slideContent = extractFirstSlide(fullContent);
    
    // This function now runs *one* automation task and returns a URL
    const url = await automateGammaPresentation(fileName, slideContent, fullContent, config);
    state.results[fileName] = url;
    console.log(`✅ SUCCESS for ${fileName}: ${url}`);

  } catch (error) {
    console.error(`❌ FAILED: Error processing ${fileName}:`, error);
    state.results[fileName] = `Error: ${error.message}`;
  }

  // 6. Move to next file
  state.currentFileIndex++;
  saveAutomationState();
  
  // Wait 5 seconds before starting the next file (to be safe)
  setTimeout(processNextFileInQueue, 5000);
}


// Function to send status updates to popup
function sendStatusUpdate(step, details, progress) {
  automationState.currentStep = step;
  automationState.currentDetails = details;
  automationState.progress = progress;
  saveAutomationState(); // Save state with new status

  chrome.runtime.sendMessage({
    action: "statusUpdate",
    step: step,
    details: details,
    progress: progress,
  }).catch(() => {
    // Ignore errors if popup is closed (it will get status on reopen)
  });
}


// =================================================================
// === SINGLE-FILE AUTOMATION (The "Worker") ===
// =================================================================

async function automateGammaPresentation(
  fileName,
  slide1Content,
  fullContent,
  config
) {
  let tabId = null; 
  try {
    const baseName = fileName.split('/').pop(); 
    const newFileName = baseName.split('-')[0]; 
    
    // Set the name for the download listener
    automationState.currentFileBaseName = newFileName; 
    saveAutomationState(); 

    sendStatusUpdate("🌐 Opening Gamma.app...", "Creating new browser tab", automationState.progress);

    const tab = await chrome.tabs.create({
      url: "https://gamma.app/",
      active: false,
    });
    tabId = tab.id; 

    sendStatusUpdate("⏳ Loading page...", "Waiting for Gamma.app to load", automationState.progress);
    await waitForTabLoad(tabId);

    sendStatusUpdate("🤖 Starting automation...", "Executing automation steps", automationState.progress);

    const result = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: executeGammaAutomation, 
      args: [
        slide1Content,
        fullContent,
        fileName,
        config,
      ],
    });

    // Check for user-initiated stop from *within* the content script
    if (result && result[0] && result[0].result === "STOPPED_BY_USER") {
        throw new Error("Automation stopped by user");
    }

    const url = result[0].result;

    sendStatusUpdate("✅ File complete!", "Closing tab...", automationState.progress);

    // Close the tab on success
    console.log(`✅ Automation finished for file. Closing tab ${tabId}`);
    await chrome.tabs.remove(tabId);

    return url;
  } catch (error) {
    sendStatusUpdate("❌ File failed", error.message, automationState.progress);
    
    // Clear the download name on failure
    automationState.currentFileBaseName = null;
    saveAutomationState();

    // Still close the tab, even on failure
    if (tabId) {
      try {
        await chrome.tabs.remove(tabId);
        console.log(`Closed failed tab ${tabId}`);
      } catch (closeError) {
        console.error("Failed to close error tab:", closeError);
      }
    }
    // Re-throw the error so the loop can catch it
    throw new Error(`Automation failed for ${fileName}: ${error.message}`);
  }
}

function waitForTabLoad(tabId) {
  return new Promise((resolve, reject) => {
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId) {
        if (changeInfo.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          setTimeout(resolve, 2000); // Wait for page to settle
        } else if (changeInfo.status === "crashed") {
          chrome.tabs.onUpdated.removeListener(listener);
          reject(new Error("Tab crashed while loading"));
        }
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}


// =================================================================
// CONTENT SCRIPT (Injected into Gamma.app)
// =================================================================

async function executeGammaAutomation(
  slide1Content,
  fullContent,
  fileName,
  config
) {
  // ---[ START HELPER FUNCTIONS ]---
  function logToConsoles(message, data = null) {
    const timestamp = new Date().toISOString();
    const logMessage = `🤖 [${timestamp}] GAMMA AUTOMATION: ${message}`;
    let cleanData = data;
    if (data instanceof Element) {
        cleanData = {
            tagName: data.tagName,
            className: data.className,
            id: data.id,
            textContent: data.textContent ? data.textContent.substring(0, 100) + '...' : ''
        };
    } else if (data && typeof data === 'object' && data !== null) {
        try { cleanData = JSON.parse(JSON.stringify(data)); } catch (e) { cleanData = "[Unclonable Object]"; }
    }
    console.log(logMessage, data || "");
    try {
     chrome.runtime.sendMessage({ action: "automationLog", message: message, data: cleanData, timestamp: timestamp });
    } catch (error) { console.log("Failed to send log message to background:", error); }
  }

  async function checkStopSignal(context = "") {
    try {
      const response = await chrome.runtime.sendMessage({ action: "getAutomationStatus" });
       if (response && response.shouldStop) {
         logToConsoles(`🛑 Stop signal received via check (${context})`);
         throw new Error("Automation stopped by user");
       }
    } catch (e) {
       logToConsoles(`⚠️ Could not check stop signal (${context}), assuming stop.`, e);
       throw new Error("Automation stopped (communication lost)");
    }
  }

  function waitForElement(selector, timeout = 15000) {
    return new Promise((resolve, reject) => {
       const element = document.querySelector(selector);
       if (element) { resolve(element); return; }
       const observer = new MutationObserver(() => {
         const element = document.querySelector(selector);
         if (element) { observer.disconnect(); resolve(element); }
       });
       observer.observe(document.body, { childList: true, subtree: true });
       setTimeout(() => { observer.disconnect(); reject(new Error(`Element ${selector} not found within ${timeout}ms`)); }, timeout);
     });
  }

  async function waitAndClick(selector, timeout = 15000) {
    logToConsoles("🎯 Looking for element:", selector);
    const element = await waitForElement(selector, timeout);
    logToConsoles("✅ Element found, clicking:", { tagName: element.tagName, className: element.className, id: element.id });
    element.click();
    await new Promise((resolve) => setTimeout(resolve, 1500)); 
  }

  function waitForElementWithText(text, timeout = 15000) {
    return new Promise((resolve, reject) => {
       const checkForElement = () => {
         const elements = Array.from(document.querySelectorAll("p, span, button"));
         const element = elements.find((el) => el.textContent && el.textContent.trim().includes(text));
         if (element) { resolve(element); return; }
       };
       checkForElement();
       const observer = new MutationObserver(checkForElement);
       observer.observe(document.body, { childList: true, subtree: true });
       setTimeout(() => { observer.disconnect(); reject(new Error(`Element with text "${text}" not found within ${timeout}ms`)); }, timeout);
     });
  }

  async function insertTextIntoEditor(editor, text) {
    logToConsoles("🔤 Starting text insertion process...");
    editor.focus();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    logToConsoles("🗑️ Clearing existing content...");
    document.execCommand("selectAll");
    document.execCommand("delete");
    await new Promise((resolve) => setTimeout(resolve, 500));
    logToConsoles("✏️ Inserting text...");
    try { document.execCommand("insertText", false, text); } catch (error) { logToConsoles("⚠️ execCommand failed:", error); }
    editor.textContent = text;
    const paragraph = document.createElement("p");
    paragraph.textContent = text;
    editor.innerHTML = "";
    editor.appendChild(paragraph);
    const events = [ new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }), new Event("keyup", { bubbles: true }), new Event("keydown", { bubbles: true }), new Event("change", { bubbles: true })];
    events.forEach((event) => editor.dispatchEvent(event));
    await new Promise((resolve) => setTimeout(resolve, 2000));
    if (!editor.textContent || editor.textContent.trim().length < 10) {
       logToConsoles("🚨 Text appears to be missing! Trying aggressive insertion...");
       editor.focus(); editor.click(); await new Promise((resolve) => setTimeout(resolve, 500));
       for (let i = 0; i < text.length; i += 100) {
         document.execCommand("insertText", false, text.substring(i, i + 100));
         await new Promise((resolve) => setTimeout(resolve, 50));
       }
    }
    logToConsoles("✅ Text insertion process completed");
  }

  async function insertTextIntoTextarea(textarea, text) {
    logToConsoles("🔤 Starting textarea insertion...");
    textarea.focus(); await new Promise((resolve) => setTimeout(resolve, 500));
    textarea.value = ""; textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 500));
    logToConsoles("✏️ Inserting text...");
    textarea.value = text;
    const events = [ new Event("input", { bubbles: true }), new Event("change", { bubbles: true }), new KeyboardEvent("keyup", { bubbles: true }), new KeyboardEvent("keydown", { bubbles: true })];
    events.forEach((event) => textarea.dispatchEvent(event));
    await new Promise((resolve) => setTimeout(resolve, 1000));
    logToConsoles("✅ Textarea insertion complete.");
  }

  function extractRemainingSlides(content) {
    logToConsoles("🔍 Extracting remaining slides (Slide 2 onwards)...");
    const match = content.match(/Slide\s*2[\s\S]*/i);
    if (match && match[0]) {
     const slides = match[0].split(/\n(?=Slide\s*\d+)/i).map(s => s.trim()).filter(s => s.length > 0);
     logToConsoles(`✅ Found ${slides.length} remaining slides.`);
     return slides;
    } else {
     logToConsoles("⚠️ No 'Slide 2' found.");
     return [];
    }
  }

  async function waitForGeneration(waitContext = "Initial") {
    return new Promise((resolve, reject) => {
     let checkCount = 0;
     const generationWaitTime = (config && config.generationWaitTime) ? config.generationWaitTime : 120;
     const maxChecks = Math.floor(generationWaitTime / 2); 
     logToConsoles(`⏳ GENERATION WAIT [${waitContext}]: Monitoring... Max wait: ${generationWaitTime}s`);
     
     const checkGeneration = async () => {
       try { await checkStopSignal(`waitForGeneration [${waitContext}]`); } catch (e) { return reject(e); }
       checkCount++;
       const spinnerEl = document.querySelector('[data-testid*="spinner"], [class*="spinner"], [class*="loading"]');
       const generatingTextEl = Array.from(document.querySelectorAll("*")).find((el) => el.textContent && (el.textContent.includes("generating") || el.textContent.includes("AI generating") || el.textContent.includes("Creating") || el.textContent.includes("Loading")));
       const isElementVisible = (el) => {
         if (!el) return false;
         const style = window.getComputedStyle(el);
         return style.display !== 'none' && style.visibility !== 'hidden' && (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0);
       };
       const isSpinnerVisible = isElementVisible(spinnerEl);
       const isGeneratingTextVisible = isElementVisible(generatingTextEl);
       
       if (!isSpinnerVisible && !isGeneratingTextVisible) {
         logToConsoles(`✅ GENERATION COMPLETE [${waitContext}]`);
         setTimeout(resolve, 3000); // Stability wait
         return;
       }
       if (checkCount >= maxChecks) {
         logToConsoles(`⏰ GENERATION TIMEOUT [${waitContext}]. Proceeding anyway.`);
         resolve();
         return;
       }
       setTimeout(checkGeneration, 2000);
     };
     setTimeout(checkGeneration, 5000);
   });
  }

  // =================================================================
  // === ⬇️ RENAMING FUNCTION UPDATED AS REQUESTED ⬇️ ===
  // =================================================================
  async function renamePresentation(newName) {
    logToConsoles(`🔄 Starting rename process to: ${newName} (using breadcrumb method)`);
    try {
      // 1. Find and click the breadcrumb element to make it editable
      const titleElement = await waitForElement('nav[aria-label="breadcrumb"] > div:last-child', 5000);
      logToConsoles("✅ Found breadcrumb title, clicking to edit...", titleElement);
      titleElement.click();
      
      // 2. Wait for the input field to appear
      // Using a more generic selector as requested in your snippet
      const inputElement = await waitForElement('nav[aria-label="breadcrumb"] input[type="text"]', 5000);
      logToConsoles("✅ Found text input, setting value...", inputElement);

      // 3. Set the new value (using the newName variable)
      inputElement.value = newName;
      
      // 4. Dispatch events to make React recognize the change
      inputElement.dispatchEvent(new Event('input', { bubbles: true }));
      inputElement.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 500)); // Short delay

      // 5. Press 'Enter' to confirm the new name
      logToConsoles("⌨️ Pressing 'Enter' to confirm name...");
      const enterEvent = new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true
      });
      inputElement.dispatchEvent(enterEvent);
      
      await new Promise((resolve) => setTimeout(resolve, 1500)); // Wait for save
      logToConsoles("✅ Rename process complete.");
      
    } catch (renameError) {
      logToConsoles("⚠️ Could not rename presentation using breadcrumb method. Proceeding.", renameError);
    }
  }
  // =================================================================
  // === ⬆️ END OF UPDATED FUNCTION ⬆️ ===
  // =================================================================
  
  // ---[ END HELPER FUNCTIONS ]---

  // ---[ START MAIN AUTOMATION LOGIC ]---
  try {
    console.group(`🚀 GAMMA AUTOMATION: ${fileName}`);
    logToConsoles(`🚀 Starting Gamma automation for: ${fileName}`);
    await checkStopSignal("Start");

    // === STEP 1-3: Navigate to Text Input ===
    logToConsoles("⏳ Step 1: Waiting for page...");
    await new Promise((resolve) => setTimeout(resolve, 3000));
    logToConsoles("🎯 Step 2: Clicking 'Create new'...");
    await waitAndClick('button[data-testid="create-from-ai-button"]');
    logToConsoles("📝 Step 3: Clicking 'Paste in text'...");
    await waitAndClick("button.chakra-button.css-1t1usgb");

    // === STEP 4-8: Generate First Slide ===
    logToConsoles("✏️ Step 4: Inserting Slide 1 text...");
    const editor = await waitForElement('div[contenteditable="true"][data-testid="ai-content-editor"]');
    await insertTextIntoEditor(editor, slide1Content);
    
    logToConsoles("🔒 Step 5: Selecting 'Preserve this exact text'...");
    try {
     const preserveRadio = await waitForElement('input[type="radio"][value="preserve"]');
     preserveRadio.click();
    } catch (error) {
     logToConsoles("⚠️ Radio button not found, trying text...");
     const preserveLabel = await waitForElementWithText("Preserve this exact text");
     preserveLabel.click();
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
    
    if (!editor.textContent || editor.textContent.trim().length < 10) {
     logToConsoles("🚨 Text disappeared! Re-inserting...");
     await insertTextIntoEditor(editor, slide1Content);
    }
    
    logToConsoles("➡️ Step 6: Clicking 'Continue'...");
    await waitAndClick("button.chakra-button.css-wnguz0");
    
    const promptWaitTime = (config && config.promptWaitTime) ? config.promptWaitTime * 1000 : 15000;
    logToConsoles(`⏳ Step 7: Waiting ${promptWaitTime / 1000}s for prompt editor...`);
    await new Promise((resolve) => setTimeout(resolve, promptWaitTime));
    
    logToConsoles("✨ Step 8: Clicking 'Generate'...");
    await waitAndClick("button.chakra-button.css-1w21vqj");

    // === STEP 9: Wait for *Initial* Slide Generation ===
    logToConsoles("⏳ Step 9: Waiting for initial generation (Slide 1)...");
    await waitForGeneration("Slide 1");
    
    // === **STEP 10 - Loop for Remaining Slides** ===
    const remainingSlides = extractRemainingSlides(fullContent);
    
    if (remainingSlides && remainingSlides.length > 0) {
     logToConsoles(`🔄 Found ${remainingSlides.length} additional slides. Starting loop...`);
     
     for (let i = 0; i < remainingSlides.length; i++) {
       const slideContent = remainingSlides[i];
       const slideNumber = i + 2;
       
       await checkStopSignal(`Start of loop for Slide ${slideNumber}`);
       logToConsoles(`---[ Processing Slide ${slideNumber} ]---`);

       // === NEW 2-STEP CLICK PROCESS ===
       try {
         // Step 10.2a: Click the dropdown menu
         logToConsoles(`🎨 Step 10.2a (Slide ${slideNumber}): Clicking 'Add Card' dropdown...`);
         const addCardDropdown = await waitForElement('button[aria-label="Open add card menu"]');
         if (!addCardDropdown) throw new Error("Could not find 'Add Card' dropdown.");
         addCardDropdown.click();
         await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait for menu

         // Step 10.2b: Click "Add new with AI" from the menu
         logToConsoles(`🎨 Step 10.2b (Slide ${slideNumber}): Clicking 'Add new with AI'...`);
         const addNewWithAiButton = await waitForElementWithText("Add new with AI");
         if (!addNewWithAiButton) throw new Error("Could not find 'Add new with AI' menu item.");
         addNewWithAiButton.click();
         await new Promise((resolve) => setTimeout(resolve, 1500)); // Wait for textarea

       } catch (insertCardError) {
         logToConsoles(`⚠️ 'Add new with AI' flow failed. Aborting loop.`, insertCardError);
         throw new Error("Could not find 'Add new with AI' flow buttons.");
       }
       
       // === NEW TEXTAREA SELECTOR ===
       try {
         logToConsoles(`📝 Step 10.3 (Slide ${slideNumber}): Filling textarea...`);
         const textarea = await waitForElement('textarea[placeholder="Describe what you\'d like to make"]');
         if (!textarea) throw new Error("Could not find the 'Describe...' textarea.");
         await insertTextIntoTextarea(textarea, slideContent);
       } catch (textareaError) {
         logToConsoles(`⚠️ Textarea not found. Aborting loop.`, textareaError);
         throw new Error("Could not find card textarea.");
       }
       
       try {
         logToConsoles(`🚀 Step 10.4 (Slide ${slideNumber}): Clicking 'Generate Card'...`);
         const generateCardButton = await waitForElement('button.chakra-button.css-1czt23e[aria-label="Generate card"]');
         
         if (generateCardButton.disabled) {
           logToConsoles("⚠️ Generate Card button disabled, waiting...");
           let waitCount = 0;
           while (generateCardButton.disabled && waitCount < 10) {
             await new Promise((resolve) => setTimeout(resolve, 1000));
             waitCount++;
             await checkStopSignal(`Waiting for 'Generate Card' btn ${waitCount}s`);
           }
         }
         generateCardButton.click();
       } catch (genCardError) {
         logToConsoles(`⚠️ 'Generate Card' button not found. Aborting loop.`, genCardError);
         throw new Error("Could not find 'Generate Card' button.");
       }

       logToConsoles(`⏳ Step 10.5 (Slide ${slideNumber}): Waiting for card generation...`);
       await waitForGeneration(`Slide ${slideNumber}`);
       logToConsoles(`✅ Card for Slide ${slideNumber} complete!`);
     }
     logToConsoles("✅ All additional slides processed.");
    } else {
     logToConsoles("ℹ️ No additional slides found.");
    }

    // =================================================================
    // === STEP 10.5: Return to Dashboard (Button Version) ===
    // =================================================================
    logToConsoles("🏠 Step 10.5: Returning to dashboard...");
    await checkStopSignal("Step 10.5 - Go to dashboard");
    
    try {
      // Using your exact element info: find the button by its aria-label.
      // This is the most stable selector.
      logToConsoles("🎯 Looking for 'Home' button...");
      await waitAndClick('button[aria-label="Home"]', 5000); 
      
      // Wait for navigation to start
      await new Promise((resolve) => setTimeout(resolve, 3000));
      
    } catch (dashboardError) {
      logToConsoles("⚠️ Could not find or click the 'Home' button. Proceeding.", dashboardError);
    }

// === Wait 4 seconds for grid to load ===
    logToConsoles("⏳ Waiting 4 seconds for dashboard grid to load...");
    await new Promise((resolve) => setTimeout(resolve, 4000));

    // =================================================================
    // === STEP 10.6: Find New Presentation and Click Menu ===
    // =================================================================
    logToConsoles("📊 Step 10.6: Finding newest presentation in grid...");
    await checkStopSignal("Step 10.6 - Find in grid");

    let newPresentationId = null;
    try {
      // 1. Find the main grid container
      const grid = document.querySelector('div[data-testid="docs-view-doc-grid"]');
      if (!grid) {
          throw new Error("Could not find the dashboard grid container.");
      }
      logToConsoles("✅ Dashboard grid container found.");

      // 2. Find the very first child div (the newest presentation)
      const firstItem = grid.querySelector('div[data-doc-grid-item-id]');
      
      if (firstItem) {
        // 3. Get the ID from the 'data-doc-grid-item-id' attribute
        newPresentationId = firstItem.getAttribute('data-doc-grid-item-id');
        logToConsoles(`✅ Found newest presentation. ID: ${newPresentationId}`);
        
        // 4. Find and click the three-dot menu button *within* this item
        logToConsoles("🖱️ Step 10.7: Finding three-dot menu button...");
        const menuButton = firstItem.querySelector('button[data-dashboard-doc-menu="true"]');
  
        if (menuButton) {
          logToConsoles("✅ Found menu button, clicking...");
          menuButton.click();
          await new Promise((resolve) => setTimeout(resolve, 1500)); // Wait for menu to open
        } else {
          throw new Error("Found the presentation item, but could not find its menu button.");
        }

// 5. (Step 10.8) Click "Rename..." from the menu
        logToConsoles("🖱️ Step 10.8: Clicking 'Rename...' from menu...");
        const renameMenuItem = await waitForElementWithText("Rename...", 5000);
        renameMenuItem.click();
        await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait for rename modal

        // 6. (Step 10.9) Find input and set new name
        logToConsoles("✏️ Step 10.9: Finding rename input and setting new name...");
        const inputElement = await waitForElement('[role="dialog"] input[placeholder]', 5000);
        
        // Use the same logic as your old rename function
        const baseName = fileName.split('/').pop();
        newFileName = baseName.split('.')[0].split('-')[0]; // Gets "myfile" from "folder/myfile-001.txt"
        
        logToConsoles(`ℹ️ Setting name to: ${newFileName}`);
        inputElement.value = newFileName;
        inputElement.dispatchEvent(new Event('input', { bubbles: true }));
        inputElement.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 500));

        // 7. (Step 10.10) Click "Rename" confirmation button
        logToConsoles("🖱️ Step 10.10: Clicking 'Rename' confirmation button...");
        
        // Find all buttons and get the one with the *exact* text "Rename"
        const allButtons = Array.from(document.querySelectorAll('button'));
        const renameButton = allButtons.find(btn => btn.textContent.trim() === "Rename" && !btn.textContent.includes("..."));
        
        if (!renameButton) {
            throw new Error("Could not find the 'Rename' confirmation button.");
        }
        
        renameButton.click();

        // 8. (Step 10.11) Wait 4 seconds for rename to save
        logToConsoles("⏳ Step 10.11: Waiting 4 seconds for rename to complete...");
        await new Promise((resolve) => setTimeout(resolve, 4000));

        // 9. (Step 10.12) Click the three-dot menu AGAIN
            //logToConsoles("🖱️ Step 10.12: Finding three-dot menu button *again*...");
            // Re-find the menu button on the *same* item
            //const menuButtonAgain = firstItem.querySelector('button[data-dashboard-doc-menu="true"]');
            //if (!menuButtonAgain) {
                //throw new Error("Could not find the menu button for the *second* time.");
            //}
            //menuButtonAgain.click();
            //await new Promise((resolve) => setTimeout(resolve, 1500)); // Wait for menu to open

            // 10. (Step 10.13) Click "Share..." from the menu
            logToConsoles("🖱️ Step 10.13: Clicking 'Share...' from menu...");
            const shareMenuItem = await waitForElementWithText("Share...");
            if (!shareMenuItem) throw new Error("Could not find 'Share...' menu item.");
            shareMenuItem.click();
            await new Promise((resolve) => setTimeout(resolve, 1500)); // Wait for share modal to open
            // ===================================================================

            //STEPS TO EXPORT

            logToConsoles(":hourglass_flowing_sand: Step 12: Clicking 'Export' tab...");
    try {
      await waitAndClick(
        'button[aria-controls="export"][data-tab="true"]',
        5000
      );
      logToConsoles(":white_tick: Clicked 'Export' tab.");
    } catch (exportError) {
      logToConsoles(":warning: 'Export' tab not found, proceeding.", exportError);
    }
    // === STEP 13: Click 'Export as PNGs' ===
    logToConsoles(":hourglass_flowing_sand: Step 13: Clicking 'Export as PNGs'...");
    try {
      const exportTextElement = await waitForElementWithText(
        "Export as PNGs",
        5000
      );
      const clickableButton = exportTextElement.closest("button");
      if (clickableButton) {
        logToConsoles(
          ":white_tick: Found 'Export as PNGs' text, clicking parent button..."
        );
        clickableButton.click();
      } else {
        logToConsoles(":warning: Could not find parent button, clicking fallback.");
        exportTextElement.parentElement.click();
      }
      // Increased wait time for download to start
      await new Promise((resolve) => setTimeout(resolve, 10000));
      } catch (exportPngError) {
      logToConsoles(":warning: 'Export as PNGs' not found.", exportPngError);
    }
      } else {
        throw new Error("Grid was found, but it contains no items.");
      }
    } catch (gridError) {
      logToConsoles("⚠️ Could not find the new presentation in the grid.", gridError);
Note     // We can still finish, but we won't have the ID
    }



    // === STEP 11: Get URL and Finish ===
    // The URL will now be the dashboard, not the presentation
    const finalUrl = "https://gamma.app/docs"; 
    logToConsoles("🎉 AUTOMATION COMPLETED (Returned to Dashboard)");
    console.groupEnd();
    return finalUrl;

  } catch (error) {
    logToConsoles(`❌ AUTOMATION FAILED: ${error.message}`);
    logToConsoles(`🔍 Stack: ${error.stack}`);
    console.groupEnd();
    
    if (error.message.includes("Automation stopped by user")) {
       return "STOPPED_BY_USER";
    }
    
    throw new Error(`Automation step failed: ${error.message}`);
  }
  // ---[ END MAIN AUTOMATION LOGIC ]---
}