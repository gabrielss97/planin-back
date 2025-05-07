const puppeteer = require('puppeteer');
const colors = require('colors');
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

// Configuration
const NUM_CLIENTS = 5; // Reduced for browser testing - more browsers take more resources
const TEST_DURATION_MS = 60000; // 1 minute test
const USE_LOCAL = process.env.USE_LOCAL === 'true';
const SERVER_URL = USE_LOCAL ? 'http://localhost:3000' : 'https://planin-back.onrender.com';
const SITE_URL = USE_LOCAL ? 'http://localhost:3000' : 'https://planin2000.com';
const RENDER_WARMUP_TIME = 30000; // 30 seconds to warm up Render service
const PAGE_NAVIGATION_TIMEOUT = 60000; // 60 seconds for page navigation
const UI_ELEMENT_TIMEOUT = 30000; // 30 seconds for UI elements to appear

// Metrics
const metrics = {
  browserLaunches: 0,
  successfulLaunches: 0,
  failedLaunches: 0,
  connectionsAttempted: 0,
  connectionsSuccessful: 0,
  connectionsFailed: 0,
  errors: []
};

// Test tracking
let browsers = [];
let hostId = null;
let testStartTime = null;
let testEndTime = null;

// Prepare directory for screenshots
const screenshotDir = path.join(__dirname, 'screenshots');
if (!fs.existsSync(screenshotDir)) {
  fs.mkdirSync(screenshotDir, { recursive: true });
}

// Log with timestamp
function log(message, type = 'info') {
  const timestamp = new Date().toISOString();
  const elapsed = testStartTime ? Math.floor((Date.now() - testStartTime) / 1000) + 's' : '--';
  
  if (type === 'error') {
    console.error(`[${timestamp}][${elapsed}] ${message}`.red);
  } else if (type === 'success') {
    console.log(`[${timestamp}][${elapsed}] ${message}`.green);
  } else if (type === 'warning') {
    console.log(`[${timestamp}][${elapsed}] ${message}`.yellow);
  } else {
    console.log(`[${timestamp}][${elapsed}] ${message}`);
  }
}

// Function to record error
function recordError(type, message, details = {}) {
  const error = {
    type,
    message,
    ...details,
    time: new Date().toISOString()
  };
  
  metrics.errors.push(error);
  log(`Error: ${type} - ${message}`, 'error');
}

// Warm up the Render server before starting tests
async function warmupServer() {
  log("Warming up the server (needed for Render's free tier)...");
  
  try {
    // Create a temporary browser to warmup the server
    const warmupBrowser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--disable-web-security',
        '--no-sandbox',
        '--disable-setuid-sandbox'
      ]
    });
    
    const page = await warmupBrowser.newPage();
    
    // Navigate to the server URL to wake it up
    log(`Sending warmup request to ${SERVER_URL}...`);
    await page.goto(SERVER_URL, { 
      waitUntil: 'networkidle2', 
      timeout: PAGE_NAVIGATION_TIMEOUT 
    });
    
    // Take a screenshot for debugging
    await page.screenshot({ 
      path: path.join(screenshotDir, 'server-warmup.png') 
    });
    
    // Close the warmup browser
    await warmupBrowser.close();
    
    // Give the server a moment to fully initialize
    log(`Waiting ${RENDER_WARMUP_TIME/1000} seconds for server to fully wake up...`);
    await new Promise(resolve => setTimeout(resolve, RENDER_WARMUP_TIME));
    
    log("Server warmup completed", 'success');
    return true;
  } catch (err) {
    log(`Server warmup failed: ${err.message}`, 'error');
    return false;
  }
}

// Create a new browser instance
async function createBrowser(headless = true) {
  metrics.browserLaunches++;
  
  try {
    const browser = await puppeteer.launch({
      headless: headless ? 'new' : false,
      args: [
        '--use-fake-ui-for-media-stream',  // Automatically allow camera/microphone permissions
        '--disable-web-security',          // Disable CORS restrictions
        '--no-sandbox',                    // Required in some environments
        '--disable-setuid-sandbox',        // Required in some environments
        '--disable-dev-shm-usage',         // Avoid memory issues on Docker/CI systems
        '--disable-accelerated-2d-canvas', // Reduce memory usage
        '--disable-gpu'                    // Reduce resource usage
      ]
    });
    
    metrics.successfulLaunches++;
    return browser;
  } catch (err) {
    metrics.failedLaunches++;
    recordError('browser_launch_error', err.message);
    return null;
  }
}

// Create host browser and get room ID
async function createHostBrowser() {
  log('Creating host browser...');
  
  const browser = await createBrowser();
  if (!browser) {
    recordError('host_browser_error', 'Failed to create host browser');
    return null;
  }
  
  try {
    // Open a new page and navigate to the site
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    
    // Enable console logging
    page.on('console', message => {
      const type = message.type();
      const text = message.text();
      if (type === 'error') {
        recordError('page_console_error', text, { browser: 'host' });
      } else if (type === 'warning') {
        log(`Host console warning: ${text}`, 'warning');
      } else if (text.includes('ID:')) {
        // Try to extract room ID from console logs
        const match = text.match(/ID:\s*([a-zA-Z0-9]+)/);
        if (match && match[1]) {
          hostId = match[1];
          log(`Extracted room ID from console: ${hostId}`, 'success');
        }
      }
    });
    
    // Navigate to the app
    log(`Navigating to ${SITE_URL}`);
    await page.goto(SITE_URL, { 
      waitUntil: 'networkidle2', 
      timeout: PAGE_NAVIGATION_TIMEOUT
    });
    
    // Take a screenshot
    await page.screenshot({ path: path.join(screenshotDir, 'host-initial.png') });
    
    // Wait for page to be fully loaded
    log('Waiting for create room button...');
    await page.waitForSelector('#createBtn', { timeout: UI_ELEMENT_TIMEOUT });
    
    // Click create room button
    log('Clicking create room button...');
    await page.click('#createBtn');
    
    // Wait for the name modal and enter a name
    log('Waiting for name modal...');
    await page.waitForSelector('#createNameModal', { visible: true, timeout: UI_ELEMENT_TIMEOUT });
    await page.type('#createNameInput', 'TestHost');
    
    // Click confirm button
    log('Confirming room creation...');
    await page.click('#confirmCreateBtn');
    
    // Wait for the room to be created and the room ID to be visible
    log('Waiting for room ID to be displayed...');
    await page.waitForSelector('#roomIdDisplay', { visible: true, timeout: UI_ELEMENT_TIMEOUT });
    
    // Take a screenshot after room creation
    await page.screenshot({ path: path.join(screenshotDir, 'host-room-created.png') });
    
    // Get the room ID
    hostId = await page.evaluate(() => {
      return document.getElementById('roomIdDisplay').textContent;
    });
    
    log(`Host created room with ID: ${hostId}`, 'success');
    
    return { browser, page };
  } catch (err) {
    await browser.close();
    recordError('host_setup_error', err.message);
    return null;
  }
}

// Create a client browser that connects to the host
async function createClientBrowser(index) {
  if (!hostId) {
    recordError('client_browser_error', 'No host ID available', { client: index });
    return null;
  }
  
  log(`Creating client browser ${index}...`);
  
  const browser = await createBrowser();
  if (!browser) {
    recordError('client_browser_error', `Failed to create client browser ${index}`);
    return null;
  }
  
  try {
    // Open a new page and navigate to the site
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    
    // Enable console logging
    page.on('console', message => {
      const type = message.type();
      const text = message.text();
      if (type === 'error') {
        recordError('page_console_error', text, { browser: `client-${index}` });
      }
    });
    
    // Navigate to the app
    log(`Client ${index}: Navigating to ${SITE_URL}`);
    await page.goto(SITE_URL, { 
      waitUntil: 'networkidle2', 
      timeout: PAGE_NAVIGATION_TIMEOUT
    });
    
    // Take a screenshot
    await page.screenshot({ path: path.join(screenshotDir, `client-${index}-initial.png`) });
    
    // Wait for page to be fully loaded
    await page.waitForSelector('#joinBtn', { timeout: UI_ELEMENT_TIMEOUT });
    
    // Enter the room ID
    await page.type('#joinId', hostId);
    
    // Click join button
    metrics.connectionsAttempted++;
    await page.click('#joinBtn');
    
    // Wait for the name modal and enter a name
    await page.waitForSelector('#joinNameModal', { visible: true, timeout: UI_ELEMENT_TIMEOUT });
    await page.type('#joinNameInput', `TestClient${index}`);
    
    // Click confirm button
    await page.click('#confirmJoinBtn');
    
    // Wait for successful connection - check if vote buttons are visible
    await page.waitForSelector('.voteBtn', { visible: true, timeout: UI_ELEMENT_TIMEOUT });
    
    // Take a screenshot after joining the room
    await page.screenshot({ path: path.join(screenshotDir, `client-${index}-joined.png`) });
    
    metrics.connectionsSuccessful++;
    log(`Client ${index} successfully connected to room`, 'success');
    
    // Perform a vote
    setTimeout(async () => {
      try {
        const buttons = await page.$$('.voteBtn');
        if (buttons.length > 0) {
          // Pick a random vote button
          const randomIndex = Math.floor(Math.random() * buttons.length);
          await buttons[randomIndex].click();
          log(`Client ${index} voted`);
          
          // Take screenshot after voting
          await page.screenshot({ path: path.join(screenshotDir, `client-${index}-voted.png`) });
        }
      } catch (err) {
        recordError('vote_error', err.message, { client: index });
      }
    }, 3000 + (index * 1000)); // Stagger votes
    
    return { browser, page };
  } catch (err) {
    metrics.connectionsFailed++;
    await browser.close();
    recordError('client_setup_error', err.message, { client: index });
    return null;
  }
}

// Start the test
async function startTest() {
  log('Starting browser-based integration test with following configuration:');
  log(`Server: ${USE_LOCAL ? 'Local' : 'Production'}`);
  log(`Number of clients: ${NUM_CLIENTS}`);
  log(`Test duration: ${TEST_DURATION_MS / 1000} seconds`);
  
  testStartTime = performance.now();
  
  // Warm up the server first (only for non-local tests)
  if (!USE_LOCAL) {
    const warmupSuccessful = await warmupServer();
    if (!warmupSuccessful) {
      log('Server warmup failed. Test may experience issues.', 'warning');
    }
  }
  
  // Create the host browser
  const host = await createHostBrowser();
  if (!host) {
    log('Failed to create host. Exiting test.', 'error');
    await endTest();
    return;
  }
  
  browsers.push(host);
  
  // Give some time for the host to fully establish
  await new Promise(resolve => setTimeout(resolve, 5000));
  
  // Create client browsers
  for (let i = 0; i < NUM_CLIENTS; i++) {
    const client = await createClientBrowser(i + 1);
    if (client) {
      browsers.push(client);
    }
    
    // Stagger client creation to avoid overwhelming the system
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  
  // Set timeout to end the test
  setTimeout(async () => {
    await endTest();
  }, TEST_DURATION_MS);
}

// End the test and report metrics
async function endTest() {
  testEndTime = performance.now();
  const testDuration = (testEndTime - testStartTime) / 1000;
  
  log(`\n${'='.repeat(50)}`);
  log(`TEST COMPLETED - Duration: ${testDuration.toFixed(2)} seconds`);
  log(`${'='.repeat(50)}\n`);
  
  // Calculate success rates
  const browserSuccessRate = metrics.successfulLaunches / metrics.browserLaunches * 100;
  const connectionSuccessRate = metrics.connectionsSuccessful / metrics.connectionsAttempted * 100;
  
  // Log summary
  log(`BROWSERS:`);
  log(`- Attempted launches: ${metrics.browserLaunches}`);
  log(`- Successful launches: ${metrics.successfulLaunches} (${browserSuccessRate.toFixed(2)}%)`);
  log(`- Failed launches: ${metrics.failedLaunches}`);
  log(``);
  
  log(`CONNECTIONS:`);
  log(`- Attempted: ${metrics.connectionsAttempted}`);
  log(`- Successful: ${metrics.connectionsSuccessful} (${connectionSuccessRate.toFixed(2)}%)`);
  log(`- Failed: ${metrics.connectionsFailed}`);
  log(``);
  
  log(`ERRORS: ${metrics.errors.length}`);
  if (metrics.errors.length > 0) {
    // Group errors by type
    const errorsByType = metrics.errors.reduce((acc, error) => {
      const type = error.type;
      if (!acc[type]) acc[type] = 0;
      acc[type]++;
      return acc;
    }, {});
    
    // Display error types and counts
    Object.entries(errorsByType).forEach(([type, count]) => {
      log(`- ${type}: ${count} occurrences`, 'warning');
    });
    
    // Display last 5 detailed errors
    log("\nLast 5 errors:");
    metrics.errors.slice(-5).forEach((error, i) => {
      log(`${i+1}. [${error.type}] ${error.message} (${error.time})`, 'error');
    });
  }
  
  // Clean up browsers
  log("\nClosing browsers...");
  
  for (const item of browsers) {
    if (item && item.browser) {
      await item.browser.close();
    }
  }
  
  log("All browsers closed. Test completed.", 'success');
  log(`Screenshots saved to ${screenshotDir}`);
  process.exit(0);
}

// Handle process signals
process.on('SIGINT', async () => {
  log("\nReceived SIGINT. Stopping test...", 'warning');
  await endTest();
});

// Start the test
startTest().catch(async (err) => {
  recordError('unhandled_error', err.message);
  await endTest();
}); 