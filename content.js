// Content script for gamma.app
// This runs on every gamma.app page load

console.log('🤖 Gamma Automator content script loaded');

// Listen for messages from the extension
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'checkPageReady') {
    // Check if the page is ready for automation
    const isReady = document.readyState === 'complete' && 
                   document.querySelector('body') !== null;
    sendResponse({ ready: isReady });
  }
  
  if (request.action === 'logToMainConsole') {
    // Log automation messages to main browser console
    const timestamp = new Date().toISOString();
    console.log(`🤖 [${timestamp}] GAMMA AUTOMATION: ${request.message}`, request.data || '');
    sendResponse({ success: true });
  }
});

// Listen for messages from injected automation scripts
window.addEventListener('message', (event) => {
  if (event.data.type === 'GAMMA_DEBUG' || event.data.type === 'GAMMA_LOG') {
    // Forward automation logs to main browser console
    const timestamp = event.data.timestamp || new Date().toISOString();
    console.log(`🤖 [${timestamp}] GAMMA AUTOMATION: ${event.data.message}`, event.data.data || '');
    
    // Also send to background script for popup logging
    chrome.runtime.sendMessage({
      action: 'automationLog',
      message: event.data.message,
      data: event.data.data,
      timestamp: timestamp
    }).catch(() => {
      // Ignore errors if background script is not available
    });
  }
});

// Helper function to monitor page changes
function observePageChanges() {
  const observer = new MutationObserver((mutations) => {
    // Could be used to detect when generation is complete
    // or when new elements appear on the page
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true
  });
}

// Start observing when page loads
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', observePageChanges);
} else {
  observePageChanges();
}

// Add global logging function for automation scripts
window.gammaAutomationLog = function(message, data) {
  const timestamp = new Date().toISOString();
  console.log(`🤖 [${timestamp}] GAMMA AUTOMATION: ${message}`, data || '');
};


