const puppeteer = require('puppeteer');
const colors = require('colors');
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

// Configuration
const START_CLIENTS = 5;       // Start with this many clients
const MAX_CLIENTS = 30;        // Maximum number of clients to test
const STEP_SIZE = 5;           // Add this many clients each round
const PER_ROUND_TIME_MS = 3 * 60 * 1000; // 3 minutes per test round
const COOLDOWN_TIME_MS = 30 * 1000;     // 30 seconds between rounds
const SUCCESS_THRESHOLD = 90;  // % success rate to continue to next round
const USE_LOCAL = process.env.USE_LOCAL === 'true';
const SERVER_URL = USE_LOCAL ? 'http://localhost:3000' : 'https://planin-back.onrender.com';
const SITE_URL = USE_LOCAL ? 'http://localhost:3000' : 'https://planin2000.com';

// Test state
let currentRound = 0;
let currentClients = START_CLIENTS;
let testStartTime = performance.now();
let roundStartTime = 0;
let hostBrowser = null;
let hostPage = null;
let hostId = null;
let clientBrowsers = [];
let shouldContinue = true;

// Results tracking
const results = [];

// Prepare directory for screenshots
const screenshotDir = path.join(__dirname, 'load-test-screenshots');
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

// Create a new browser instance
async function createBrowser(headless = true) {
  try {
    const browser = await puppeteer.launch({
      headless: headless ? 'new' : false,
      args: [
        '--use-fake-ui-for-media-stream',
        '--disable-web-security',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu'
      ]
    });
    return browser;
  } catch (err) {
    log(`Browser launch error: ${err.message}`, 'error');
    return null;
  }
}

// Create host and get room ID
async function setupHost() {
  log('Creating host browser...');
  
  try {
    hostBrowser = await createBrowser();
    if (!hostBrowser) {
      log('Failed to create host browser', 'error');
      return false;
    }
    
    hostPage = await hostBrowser.newPage();
    await hostPage.setViewport({ width: 1280, height: 800 });
    
    // Log console messages
    hostPage.on('console', message => {
      const type = message.type();
      const text = message.text();
      
      if (type === 'error') {
        log(`Host console error: ${text}`, 'error');
      }
    });
    
    // Navigate to site
    log(`Navigating to ${SITE_URL}`);
    await hostPage.goto(SITE_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    
    // Take initial screenshot
    await hostPage.screenshot({ 
      path: path.join(screenshotDir, 'host-initial.png')
    });
    
    // Create room
    await hostPage.waitForSelector('#createBtn', { timeout: 30000 });
    await hostPage.click('#createBtn');
    
    // Enter name
    await hostPage.waitForSelector('#createNameModal', { visible: true, timeout: 10000 });
    await hostPage.type('#createNameInput', 'LoadTestHost');
    await hostPage.click('#confirmCreateBtn');
    
    // Wait for room creation
    await hostPage.waitForSelector('#roomIdDisplay', { visible: true, timeout: 30000 });
    
    // Get room ID
    hostId = await hostPage.evaluate(() => {
      return document.getElementById('roomIdDisplay').textContent;
    });
    
    log(`Host created room with ID: ${hostId}`, 'success');
    
    // Take screenshot
    await hostPage.screenshot({ 
      path: path.join(screenshotDir, 'host-room-created.png')
    });
    
    return true;
  } catch (err) {
    log(`Host setup error: ${err.message}`, 'error');
    if (hostBrowser) {
      await hostBrowser.close();
      hostBrowser = null;
    }
    return false;
  }
}

// Create a client that connects to the host
async function createClient(index) {
  if (!hostId) {
    log(`No host ID available for client ${index}`, 'error');
    return null;
  }
  
  try {
    log(`Creating client ${index}...`);
    const browser = await createBrowser();
    if (!browser) return null;
    
    const page = await browser.newPage();
    await page.setViewport({ width: 1024, height: 768 });
    
    // Log console errors
    page.on('console', message => {
      if (message.type() === 'error') {
        log(`Client ${index} console error: ${message.text()}`, 'error');
      }
    });
    
    // Navigate to site
    await page.goto(SITE_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    
    // Join the room
    await page.waitForSelector('#joinBtn', { timeout: 30000 });
    await page.type('#joinId', hostId);
    await page.click('#joinBtn');
    
    // Enter name
    await page.waitForSelector('#joinNameModal', { visible: true, timeout: 10000 });
    await page.type('#joinNameInput', `Client${index}`);
    await page.click('#confirmJoinBtn');
    
    // Wait for connection (look for vote buttons)
    await page.waitForSelector('.voteBtn', { visible: true, timeout: 30000 });
    
    log(`Client ${index} connected successfully`, 'success');
    
    // Take screenshot
    await page.screenshot({ 
      path: path.join(screenshotDir, `client-${index}-connected.png`) 
    });
    
    // Randomly vote after a delay
    setTimeout(async () => {
      try {
        if (page.isClosed()) return;
        
        const voteButtons = await page.$$('.voteBtn');
        if (voteButtons.length > 0) {
          const randomButton = voteButtons[Math.floor(Math.random() * voteButtons.length)];
          await randomButton.click();
          log(`Client ${index} voted`);
        }
      } catch (err) {
        // Ignore errors during voting
      }
    }, 5000 + Math.random() * 10000);
    
    return { browser, page, index };
  } catch (err) {
    log(`Error creating client ${index}: ${err.message}`, 'error');
    return null;
  }
}

// Run a test round with the specified number of clients
async function runTestRound(numClients) {
  currentRound++;
  roundStartTime = performance.now();
  
  log(`\n${'='.repeat(50)}`);
  log(`ROUND ${currentRound}: Testing with ${numClients} clients`, 'success');
  log(`${'='.repeat(50)}\n`);
  
  // Clear any existing clients
  await cleanupClients();
  clientBrowsers = [];
  
  // Setup metrics for this round
  const roundMetrics = {
    round: currentRound,
    clientsAttempted: numClients,
    clientsConnected: 0,
    successRate: 0,
    startTime: new Date().toISOString(),
    endTime: null,
    duration: 0,
    errors: []
  };
  
  // Create clients
  for (let i = 0; i < numClients; i++) {
    const clientNumber = i + 1;
    const client = await createClient(clientNumber);
    
    if (client) {
      clientBrowsers.push(client);
      roundMetrics.clientsConnected++;
    }
    
    // If we have many clients, add a small delay between creations
    if (numClients > 10) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    } else {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  // Calculate success rate
  roundMetrics.successRate = (roundMetrics.clientsConnected / roundMetrics.clientsAttempted) * 100;
  
  log(`Successfully connected ${roundMetrics.clientsConnected} of ${roundMetrics.clientsAttempted} clients (${roundMetrics.successRate.toFixed(2)}%)`);
  
  // Screenshot the host page to see all connected users
  if (hostPage && !hostPage.isClosed()) {
    await hostPage.screenshot({ 
      path: path.join(screenshotDir, `round-${currentRound}-host-with-${roundMetrics.clientsConnected}-clients.png`)
    });
  }
  
  // Let the test run for the specified duration
  log(`Running test with ${roundMetrics.clientsConnected} connected clients for ${PER_ROUND_TIME_MS/1000} seconds...`);
  await new Promise(resolve => setTimeout(resolve, PER_ROUND_TIME_MS));
  
  // Complete round metrics
  roundMetrics.endTime = new Date().toISOString();
  roundMetrics.duration = (performance.now() - roundStartTime) / 1000;
  
  // Add to results
  results.push(roundMetrics);
  
  // Determine if we should continue
  shouldContinue = roundMetrics.successRate >= SUCCESS_THRESHOLD;
  
  return roundMetrics;
}

// Clean up client browsers
async function cleanupClients() {
  if (clientBrowsers.length === 0) return;
  
  log(`Closing ${clientBrowsers.length} client browsers...`);
  
  for (const client of clientBrowsers) {
    try {
      if (client && client.browser) {
        await client.browser.close();
      }
    } catch (err) {
      // Ignore errors during cleanup
    }
  }
  
  clientBrowsers = [];
}

// Clean up all browsers
async function cleanup() {
  await cleanupClients();
  
  if (hostBrowser) {
    try {
      await hostBrowser.close();
    } catch (err) {
      // Ignore errors during cleanup
    }
    hostBrowser = null;
    hostPage = null;
  }
}

// Generate report
function generateReport() {
  const totalDuration = (performance.now() - testStartTime) / 1000;
  
  log(`\n${'='.repeat(50)}`);
  log(`LOAD TEST COMPLETED - Total Duration: ${totalDuration.toFixed(2)} seconds`);
  log(`${'='.repeat(50)}\n`);
  
  log('ROUND RESULTS:');
  
  results.forEach(result => {
    const statusColor = result.successRate >= SUCCESS_THRESHOLD ? 'green' : 'red';
    const statusText = result.successRate >= SUCCESS_THRESHOLD ? 'PASSED' : 'FAILED';
    
    console.log(`Round ${result.round}: ${result.clientsAttempted} clients attempted, ${result.clientsConnected} connected (${result.successRate.toFixed(2)}% success) - ${statusText}`.color(statusColor));
  });
  
  // Find optimal capacity (last successful round)
  let optimalCapacity = 0;
  for (const result of results) {
    if (result.successRate >= SUCCESS_THRESHOLD) {
      optimalCapacity = result.clientsAttempted;
    } else {
      break;
    }
  }
  
  log(`\nRECOMMENDED CAPACITY: ${optimalCapacity} simultaneous users`, 'success');
  
  // Write results to file
  const reportData = {
    date: new Date().toISOString(),
    totalDuration,
    optimalCapacity,
    rounds: results
  };
  
  const reportPath = path.join(__dirname, 'load-test-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(reportData, null, 2));
  log(`Report saved to ${reportPath}`);
}

// Main test function
async function runLoadTest() {
  log('Starting Planin Load Test');
  testStartTime = performance.now();
  
  // Setup host
  const hostSetupSuccess = await setupHost();
  if (!hostSetupSuccess) {
    log('Failed to set up host. Exiting test.', 'error');
    await cleanup();
    process.exit(1);
  }
  
  // Run test rounds with increasing client counts
  currentClients = START_CLIENTS;
  
  while (currentClients <= MAX_CLIENTS && shouldContinue) {
    try {
      await runTestRound(currentClients);
      
      if (shouldContinue) {
        // Cooldown period before next round
        log(`Cooling down for ${COOLDOWN_TIME_MS/1000} seconds before next round...`);
        await new Promise(resolve => setTimeout(resolve, COOLDOWN_TIME_MS));
        
        // Increase client count
        currentClients += STEP_SIZE;
      }
    } catch (err) {
      log(`Error in test round: ${err.message}`, 'error');
      shouldContinue = false;
    }
  }
  
  // Generate report
  generateReport();
  
  // Clean up
  await cleanup();
  
  log('Load test completed.', 'success');
}

// Handle process termination
process.on('SIGINT', async () => {
  log('Test interrupted. Cleaning up...', 'warning');
  await cleanup();
  generateReport();
  process.exit(0);
});

// Run the test
runLoadTest().catch(async err => {
  log(`Unhandled error: ${err.message}`, 'error');
  await cleanup();
  process.exit(1);
}); 