let selectedFiles = [];
let isRunning = false; // This 'isRunning' is just for the UI

// Predefined list of all markdown files in the input folder
const INPUT_FILES = [
  // 383 Augmented Analytics
  ...Array.from(
    { length: 2 }, // Kept your change for testing
    (_, i) =>
      `input/383 Augmented Analytics AutoML & Intelligent Data Discovery/${String(
        i + 1
      ).padStart(2, "0")}-c.md`
  ),
  // 385 Knowledge Management
  ...Array.from(
    { length: 75 },
    (_, i) =>
      `input/385 Knowledge Management Systems Information Architecture & Discovery/${String(
        i + 1
      ).padStart(2, "0")}-c.md`
  ),
  // 389 Web3 Economics
  ...Array.from(
    { length: 34 },
    (_, i) =>
      `input/389 Web3 Economics Mastery Tokenomics, DAOs & Decentralized Business Models/${String(
        i + 1
      ).padStart(2, "0")}-c.md`
  ),
];

document.addEventListener("DOMContentLoaded", async function () {
  const folderInput = document.getElementById("folderInput");
  const startBtn = document.getElementById("startBtn");
  const stopBtn = document.getElementById("stopBtn");
  const downloadBtn = document.getElementById("downloadBtn");
  const fileCount = document.getElementById("fileCount");
  const progress = document.getElementById("progress");
  const progressFill = document.getElementById("progressFill");
  const progressText = document.getElementById("progressText");
  const resultsDiv = document.getElementById("results");
  const resultsList = document.getElementById("resultsList");
  const liveStatus = document.getElementById("liveStatus");
  const currentStep = document.getElementById("currentStep");
  const stepDetails = document.getElementById("stepDetails");
  const promptWait = document.getElementById("promptWait");
  const generationWait = document.getElementById("generationWait");

  // Check if automation is already running and restore state
  await checkAutomationStatus(); // This now handles all UI restoration

  // Automatically load predefined files
  console.log("🔍 Loading predefined input files...");
  await loadPredefinedFiles();

  // Listen for status updates from background script
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === "statusUpdate") {
      updateStatus(message.step, message.details);
      
      if (message.progress !== undefined) {
        updateProgress(message.progress);
      }
      
      // Check if batch is finished
      if (message.step.includes("Batch complete") || message.step.includes("stopped")) {
        hideAutomationStatus();
        // After a batch, we'll have new results, so ask for the state again
        checkAutomationStatus();
      } else {
        showAutomationRunning();
      }
    }

    if (message.action === "debugLog") {
      console.log("🔧 DEBUG:", message.message, message.data);
    }
  });

  // Handle manual folder selection (backup option)
  folderInput.addEventListener("change", function (e) {
    const files = Array.from(e.target.files);
    selectedFiles = files.filter(
      (file) =>
        file.name.endsWith("-c.md") ||
        file.webkitRelativePath.includes("input/")
    );
    updateFileCount();
    console.log("📁 Manual selection:", selectedFiles.length, "files");
  });

  async function loadPredefinedFiles() {
    try {
      console.log("📋 Loading ALL files from Course 383...");

      const filesToLoad = INPUT_FILES.filter((file) =>
        file.includes("383 Augmented Analytics")
      );

      selectedFiles = [];

      for (const filePath of filesToLoad) {
        try {
          const response = await fetch(chrome.runtime.getURL(filePath));
          if (response.ok) {
            const content = await response.text();
            selectedFiles.push({
              name: filePath.split("/").pop(),
              path: filePath,
              content: content,
              webkitRelativePath: filePath,
            });
            console.log("✅ Loaded:", filePath);
          }
        } catch (error) {
          console.log("❌ Error loading:", filePath, error);
        }
      }
      updateFileCount();
      // We don't need to save to storage, we'll send the files on start
    } catch (error) {
      console.error("❌ Error loading files:", error);
      fileCount.textContent = "Error loading files. Please try again.";
    }
  }

  function updateFileCount() {
    if (selectedFiles.length > 0) {
      fileCount.textContent = `Ready to process: ${selectedFiles.length} files (Course 383)`;
      progressText.textContent = `Ready to process ${selectedFiles.length} files.`;
      startBtn.disabled = false;
      console.log("✅ Files ready:", selectedFiles.length);
    } else {
      fileCount.textContent = "No files loaded.";
      startBtn.disabled = true;
    }
  }

  // Start automation
  startBtn.addEventListener("click", async function () {
    if (selectedFiles.length === 0 || isRunning) return;

    // Get config
    const config = {
      promptWaitTime: parseInt(promptWait.value) || 15,
      generationWaitTime: parseInt(generationWait.value) || 10,
    };

    // Update UI immediately
    showAutomationRunning();
    updateProgress(0);
    progressText.textContent = "Sending job to background...";

    // Send ONE message to start the whole batch
    chrome.runtime.sendMessage({
      action: "startBatchAutomation",
      files: selectedFiles,
      config: config
    }, (response) => {
      if (response && response.success) {
        updateStatus("🚀 Batch Started", "Processing in background...");
      } else {
        updateStatus("❌ Error starting batch", response ? response.error : "Unknown error");
        hideAutomationStatus();
      }
    });
  });

  // Stop automation
  stopBtn.addEventListener("click", function () {
    chrome.runtime.sendMessage({ action: "stopAutomation" });
    // The UI will update when the 'statusUpdate' message comes back
    updateStatus("⏹️ Sending stop signal...", "Waiting for current step to finish");
  });

  // Download results
  downloadBtn.addEventListener("click", function () {
    downloadResults();
  });
  
  async function checkAutomationStatus() {
    try {
      const response = await chrome.runtime.sendMessage({
        action: "getAutomationStatus",
      });

      if (response && response.isRunning) {
        console.log("🔄 Automation is already running, restoring status...");
        showAutomationRunning();
        updateStatus(
          response.currentStep || "🔄 Automation in progress...",
          response.currentDetails || "Checking current status..."
        );
        if (response.progress !== undefined) {
          updateProgress(response.progress);
        }
      } else {
         hideAutomationStatus();
      }

      // ALWAYS check for results, even if not running
      if (response && response.results && Object.keys(response.results).length > 0) {
        console.log("🔄 Restoring results...");
        showResults(response.results); // Pass results to show
      }

    } catch (error) {
      console.log("ℹ️ Could not get background status", error.message);
      hideAutomationStatus(); // Ensure UI is reset if background is unreachable
    }
  }

  function showAutomationRunning() {
    isRunning = true;
    startBtn.classList.add("hidden");
    stopBtn.classList.remove("hidden");
    liveStatus.classList.remove("hidden");
    progress.classList.remove("hidden");
  }

  function hideAutomationStatus() {
    isRunning = false;
    startBtn.classList.remove("hidden");
    stopBtn.classList.add("hidden");
    liveStatus.classList.add("hidden");
    progress.classList.add("hidden");
    progressText.textContent = "Ready to start...";
  }

  function updateStatus(step, details) {
    currentStep.textContent = step;
    stepDetails.textContent = details;
    console.log(`${step}: ${details}`);
  }

  function updateProgress(percent) {
    progressFill.style.width = `${percent}%`;
    progressText.textContent = `${Math.round(percent)}% Complete`;
  }
  
  // This function now accepts the results object
  function showResults(resultsData) {
    if (!resultsData || Object.keys(resultsData).length === 0) {
        resultsDiv.classList.add("hidden");
        return;
    }

    resultsDiv.classList.remove("hidden");
    downloadBtn.classList.remove("hidden");
    resultsList.innerHTML = "";

    let successCount = 0;
    let failureCount = 0;

    Object.entries(resultsData).forEach(([fileName, url]) => {
      const item = document.createElement("div");
      item.className = "result-item";

      const fileSpan = document.createElement("span");
      fileSpan.className = "result-file";
      fileSpan.textContent = fileName;

      const statusSpan = document.createElement("span");

      if (url.startsWith("http")) {
        const link = document.createElement("a");
        link.href = url;
        link.target = "_blank";
        link.className = "result-url success";
        link.textContent = "✅ Open";
        statusSpan.appendChild(link);
        successCount++;
      } else {
        statusSpan.textContent = `❌ ${url}`;
        statusSpan.style.color = "red";
        failureCount++;
      }

      item.appendChild(fileSpan);
      item.appendChild(statusSpan);
      resultsList.appendChild(item);
    });

    // Show summary
    const summaryDiv = document.createElement("div");
    summaryDiv.className = "results-summary";
    summaryDiv.innerHTML = `
        <strong>Summary:</strong> 
        ✅ ${successCount} successful, 
        ❌ ${failureCount} failed, 
        📈 ${((successCount / (successCount + failureCount)) * 100).toFixed(
          1
        )}% success rate
    `;
    resultsList.insertBefore(summaryDiv, resultsList.firstChild);
  }

  function downloadResults() {
    // We don't have the 'results' object anymore. Ask the background for it.
    chrome.runtime.sendMessage({ action: "getAutomationStatus" }, (response) => {
        if (response && response.results) {
            const dataStr = JSON.stringify(response.results, null, 2);
            const dataBlob = new Blob([dataStr], { type: "application/json" });

            const link = document.createElement("a");
            link.href = URL.createObjectURL(dataBlob);
            link.download = "gamma-results.json";
            link.click();
        } else {
            console.error("Could not get results to download.");
        }
    });
  }
});