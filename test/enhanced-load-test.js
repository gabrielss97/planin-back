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
const SUCCESS_THRESHOLD = 85;  // % success rate to continue to next round
const USE_LOCAL = process.env.USE_LOCAL === 'true';
const SERVER_URL = USE_LOCAL ? 'http://localhost:3000' : 'https://planin-back.onrender.com';
const SITE_URL = USE_LOCAL ? 'http://localhost:3000' : 'https://planin2000.com';
const RENDER_WARMUP_TIME = 60000; // 60 seconds to warm up Render service
const CONNECTION_TIMEOUT = 45000; // 45 seconds timeout for connections
const STAGGER_INTERVAL = 3000;    // Time between client connection attempts
const RETRY_ATTEMPTS = 2;         // Number of retries for failed clients
const BROWSER_LAUNCH_TIMEOUT = 30000; // 30 seconds timeout for browser launch

// Test state
let currentRound = 0;
let currentClients = START_CLIENTS;
let testStartTime = 0;
let roundStartTime = 0;
let hostBrowser = null;
let hostPage = null;
let hostId = null;
let clientBrowsers = [];
let shouldContinue = true;

// Metrics
const metrics = {
  totalBrowserLaunches: 0,
  successfulBrowserLaunches: 0,
  failedBrowserLaunches: 0,
  totalConnections: 0,
  successfulConnections: 0,
  failedConnections: 0,
  totalVotes: 0,
  successfulVotes: 0,
  messagingErrors: 0,
  avgConnectionTime: 0,
  peakMemoryUsage: 0,
  errors: []
};

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
  const elapsed = testStartTime ? Math.floor((performance.now() - testStartTime) / 1000) + 's' : '--';
  
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

// Record error
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

// Create a new browser instance with timeout and retries
async function createBrowser(headless = true, retries = 2) {
  metrics.totalBrowserLaunches++;
  
  for (let attempt = 0; attempt <= retries; attempt++) {
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
          '--disable-gpu',
          '--js-flags=--max_old_space_size=500' // Limit memory usage
        ],
        timeout: BROWSER_LAUNCH_TIMEOUT
      });
      
      metrics.successfulBrowserLaunches++;
      return browser;
    } catch (err) {
      if (attempt < retries) {
        log(`Browser launch failed, retrying (${attempt + 1}/${retries})...`, 'warning');
        await new Promise(r => setTimeout(r, 5000)); // Wait 5s before retry
      } else {
        metrics.failedBrowserLaunches++;
        recordError('browser_launch_error', err.message);
        return null;
      }
    }
  }
}

// Warm up the Render server before starting tests
async function warmupServer() {
  log("Warming up the server (needed for Render's free tier)...");
  
  try {
    // Create a temporary browser to warmup the server
    const warmupBrowser = await createBrowser(true);
    if (!warmupBrowser) {
      log("Failed to create browser for server warmup", 'error');
      return false;
    }
    
    const page = await warmupBrowser.newPage();
    
    // Navigate to the server URL to wake it up
    log(`Sending warmup request to ${SERVER_URL}...`);
    await page.goto(SERVER_URL, { 
      waitUntil: 'networkidle2', 
      timeout: 60000 
    });
    
    // Take a screenshot for debugging
    await page.screenshot({ 
      path: path.join(screenshotDir, 'server-warmup.png') 
    });
    
    // Check server status
    try {
      await page.goto(`${SERVER_URL}/status`, { 
        waitUntil: 'networkidle2', 
        timeout: 30000 
      });
      
      const statusContent = await page.content();
      log(`Server status response: ${statusContent.includes('status') ? 'OK' : 'Not ready'}`, 
        statusContent.includes('status') ? 'success' : 'warning');
    } catch (err) {
      log(`Server status check failed: ${err.message}`, 'warning');
    }
    
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
    
    // Monitor performance
    await hostPage.setRequestInterception(true);
    hostPage.on('request', request => {
      request.continue();
    });
    
    // Log console messages
    hostPage.on('console', message => {
      const type = message.type();
      const text = message.text();
      
      if (type === 'error') {
        recordError('host_console_error', text);
      } else if (type === 'warning') {
        log(`Host console warning: ${text}`, 'warning');
      } else if (text.includes('room ID') || text.includes('peer ID')) {
        log(`Host info: ${text}`);
      }
    });
    
    // Handle page errors
    hostPage.on('pageerror', error => {
      recordError('host_page_error', error.message);
    });
    
    // Navigate to site
    log(`Navigating to ${SITE_URL}`);
    await hostPage.goto(SITE_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    
    // Take initial screenshot
    await hostPage.screenshot({ 
      path: path.join(screenshotDir, `round-${currentRound}-host-initial.png`)
    });
    
    // Create room
    log('Waiting for create room button...');
    await hostPage.waitForSelector('#createBtn', { timeout: 30000 });
    await hostPage.click('#createBtn');
    
    // Enter name
    log('Entering host name...');
    await hostPage.waitForSelector('#createNameModal', { visible: true, timeout: 20000 });
    await hostPage.type('#createNameInput', `LoadTestHost-Round${currentRound}`);
    await hostPage.click('#confirmCreateBtn');
    
    // Wait for room creation
    log('Waiting for room creation...');
    await hostPage.waitForSelector('#roomIdDisplay', { visible: true, timeout: 45000 });
    
    // Get room ID
    hostId = await hostPage.evaluate(() => {
      const element = document.getElementById('roomIdDisplay');
      return element ? element.textContent : null;
    });
    
    if (!hostId) {
      throw new Error('Could not retrieve room ID');
    }
    
    log(`Host created room with ID: ${hostId}`, 'success');
    
    // Take screenshot
    await hostPage.screenshot({ 
      path: path.join(screenshotDir, `round-${currentRound}-host-room-created.png`)
    });
    
    return true;
  } catch (err) {
    recordError('host_setup_error', err.message);
    if (hostBrowser) {
      try {
        await hostBrowser.close();
      } catch (closeErr) {
        // Ignore close errors
      }
      hostBrowser = null;
    }
    return false;
  }
}

// Create a client that connects to the host
async function createClient(index) {
  metrics.totalConnections++;
  
  if (!hostId) {
    recordError('client_connection_error', `No host ID available for client ${index}`);
    return null;
  }
  
  let browser = null;
  let page = null;
  
  try {
    log(`Creating client ${index}...`);
    browser = await createBrowser();
    if (!browser) return null;
    
    page = await browser.newPage();
    await page.setViewport({ width: 1024, height: 768 });
    
    // Monitor performance
    const connectionStart = performance.now();
    let isConnected = false;
    
    // Log console errors
    page.on('console', message => {
      const text = message.text();
      if (message.type() === 'error') {
        recordError('client_console_error', text, { clientIndex: index });
      } else if (text.includes('connected') || text.includes('joined')) {
        log(`Client ${index} info: ${text}`);
        isConnected = true;
        
        const connectionTime = performance.now() - connectionStart;
        metrics.avgConnectionTime = 
          (metrics.avgConnectionTime * metrics.successfulConnections + connectionTime) / 
          (metrics.successfulConnections + 1);
      }
    });
    
    // Handle page errors
    page.on('pageerror', error => {
      recordError('client_page_error', error.message, { clientIndex: index });
    });
    
    // Navigate to site with retry logic
    for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
      try {
        log(`Client ${index} navigating to site (attempt ${attempt + 1})...`);
        await page.goto(SITE_URL, { waitUntil: 'networkidle2', timeout: 45000 });
        break;
      } catch (err) {
        if (attempt === RETRY_ATTEMPTS - 1) throw err;
        log(`Client ${index} navigation failed, retrying...`, 'warning');
        await new Promise(r => setTimeout(r, 5000));
      }
    }
    
    // Join the room
    log(`Client ${index} joining room ${hostId}...`);
    await page.waitForSelector('#joinBtn', { timeout: 30000 });
    await page.type('#joinId', hostId);
    await page.click('#joinBtn');
    
    // Enter name
    log(`Client ${index} entering name...`);
    await page.waitForSelector('#joinNameModal', { visible: true, timeout: 20000 });
    await page.type('#joinNameInput', `Client-R${currentRound}-${index}`);
    await page.click('#confirmJoinBtn');
    
    // Wait for connection (look for vote buttons)
    log(`Client ${index} waiting for connection...`);
    await page.waitForSelector('.voteBtn', { visible: true, timeout: CONNECTION_TIMEOUT });
    
    metrics.successfulConnections++;
    log(`Client ${index} connected successfully`, 'success');
    
    // Take screenshot
    await page.screenshot({ 
      path: path.join(screenshotDir, `round-${currentRound}-client-${index}-connected.png`) 
    });
    
    // Randomly vote after a delay
    setTimeout(async () => {
      try {
        if (page.isClosed()) return;
        
        const voteButtons = await page.$$('.voteBtn');
        if (voteButtons.length > 0) {
          metrics.totalVotes++;
          const randomButton = voteButtons[Math.floor(Math.random() * voteButtons.length)];
          await randomButton.click();
          metrics.successfulVotes++;
          log(`Client ${index} voted`);
          
          // Take screenshot after voting
          if (!page.isClosed()) {
            await page.screenshot({ 
              path: path.join(screenshotDir, `round-${currentRound}-client-${index}-voted.png`) 
            });
          }
        }
      } catch (err) {
        recordError('client_vote_error', err.message, { clientIndex: index });
      }
    }, 10000 + Math.random() * 30000); // Random delay between 10-40 seconds
    
    return { browser, page };
  } catch (err) {
    metrics.failedConnections++;
    recordError('client_connection_error', err.message, { clientIndex: index });
    
    // Take error screenshot if possible
    if (page && !page.isClosed()) {
      try {
        await page.screenshot({ 
          path: path.join(screenshotDir, `round-${currentRound}-client-${index}-error.png`) 
        });
      } catch (screenshotErr) {
        // Ignore screenshot errors
      }
    }
    
    // Clean up resources
    if (browser) {
      try {
        await browser.close();
      } catch (closeErr) {
        // Ignore close errors
      }
    }
    
    return null;
  }
}

// Run a test round with gradual client scaling
async function runTestRound(numClients) {
  currentRound++;
  roundStartTime = performance.now();
  log(`Starting round ${currentRound} with ${numClients} clients`, 'success');
  
  // Reset round-specific metrics
  const roundMetrics = {
    clientsAttempted: numClients,
    clientsConnected: 0,
    connectionRate: 0,
    avgConnectionTime: 0,
    votesAttempted: 0,
    votesSuccessful: 0,
    errors: []
  };
  
  // Set up the host first
  const hostSetupSuccess = await setupHost();
  if (!hostSetupSuccess) {
    log(`Failed to set up host for round ${currentRound}`, 'error');
    return false;
  }
  
  // Create clients gradually in groups
  clientBrowsers = [];
  const batchSize = Math.min(5, Math.ceil(numClients / 3)); // Create clients in small batches
  const batches = Math.ceil(numClients / batchSize);
  
  for (let batch = 0; batch < batches; batch++) {
    const startIdx = batch * batchSize;
    const endIdx = Math.min(startIdx + batchSize, numClients);
    
    log(`Creating clients ${startIdx+1}-${endIdx} (batch ${batch+1}/${batches})...`);
    
    // Launch clients in this batch with slight staggering
    const batchPromises = [];
    for (let i = startIdx; i < endIdx; i++) {
      // Stagger client creation
      await new Promise(r => setTimeout(r, STAGGER_INTERVAL));
      
      // Create client (don't await here to allow parallel creation within batch)
      batchPromises.push(createClient(i+1));
    }
    
    // Wait for all clients in this batch to be created
    const batchResults = await Promise.all(batchPromises);
    const successfulClients = batchResults.filter(client => client !== null);
    
    // Add successful clients to the list
    clientBrowsers.push(...successfulClients);
    
    // Log batch stats
    log(`Batch ${batch+1} complete: ${successfulClients.length}/${batchPromises.length} clients connected`);
    
    // Give the system a moment to stabilize
    if (batch < batches - 1) {
      log(`Waiting for system to stabilize before next batch...`);
      await new Promise(r => setTimeout(r, 10000));
    }
  }
  
  // Count successful connections
  roundMetrics.clientsConnected = clientBrowsers.length;
  roundMetrics.connectionRate = (roundMetrics.clientsConnected / numClients) * 100;
  roundMetrics.avgConnectionTime = metrics.avgConnectionTime;
  
  log(`Successfully connected ${roundMetrics.clientsConnected}/${numClients} clients (${roundMetrics.connectionRate.toFixed(1)}%)`, 
    roundMetrics.connectionRate >= SUCCESS_THRESHOLD ? 'success' : 'warning');
  
  // Check memory usage
  const memoryUsage = process.memoryUsage();
  const memoryUsageMB = Math.round(memoryUsage.rss / 1024 / 1024);
  metrics.peakMemoryUsage = Math.max(metrics.peakMemoryUsage, memoryUsageMB);
  
  log(`Current memory usage: ${memoryUsageMB}MB`);
  
  // Save host's view of the room with all connected clients
  if (hostPage && !hostPage.isClosed()) {
    await hostPage.screenshot({ 
      path: path.join(screenshotDir, `round-${currentRound}-host-with-${roundMetrics.clientsConnected}-clients.png`),
      fullPage: true
    });
  }
  
  // Let the test run for the configured duration
  log(`Running test for ${PER_ROUND_TIME_MS/1000} seconds...`);
  await new Promise(resolve => setTimeout(resolve, PER_ROUND_TIME_MS));
  
  // Finalize round metrics
  roundMetrics.votesAttempted = metrics.totalVotes;
  roundMetrics.votesSuccessful = metrics.successfulVotes;
  roundMetrics.errors = metrics.errors.slice(); // Copy current errors
  
  // Save final host view
  if (hostPage && !hostPage.isClosed()) {
    await hostPage.screenshot({ 
      path: path.join(screenshotDir, `round-${currentRound}-final-host-view.png`),
      fullPage: true
    });
  }
  
  // Calculate test results
  const roundDurationMs = performance.now() - roundStartTime;
  const roundResult = {
    round: currentRound,
    numClients: numClients,
    successfulClients: roundMetrics.clientsConnected,
    successRate: roundMetrics.connectionRate,
    durationMs: roundDurationMs,
    avgConnectionTimeMs: roundMetrics.avgConnectionTime,
    votesAttempted: roundMetrics.votesAttempted,
    votesSuccessful: roundMetrics.votesSuccessful,
    memoryUsageMB: memoryUsageMB,
    errorCount: roundMetrics.errors.length,
    timestamp: new Date().toISOString()
  };
  
  results.push(roundResult);
  
  // Determine if we should continue
  const success = roundMetrics.connectionRate >= SUCCESS_THRESHOLD;
  return success;
}

// Clean up all client browsers
async function cleanupClients() {
  log(`Cleaning up ${clientBrowsers.length} clients...`);
  
  const closePromises = clientBrowsers.map(async (client, index) => {
    try {
      if (client && client.browser) {
        await client.browser.close();
      }
    } catch (err) {
      log(`Error closing client ${index+1}: ${err.message}`, 'warning');
    }
  });
  
  await Promise.all(closePromises);
  clientBrowsers = [];
}

// Clean up all resources
async function cleanup() {
  log('Cleaning up all test resources...');
  
  // Clean up clients
  await cleanupClients();
  
  // Clean up host
  if (hostBrowser) {
    try {
      await hostBrowser.close();
    } catch (err) {
      log(`Error closing host browser: ${err.message}`, 'warning');
    }
    hostBrowser = null;
    hostPage = null;
  }
  
  log('Cleanup complete');
}

// Generate test report
function generateReport() {
  log('Generating test report...', 'success');
  
  // Calculate optimal capacity based on test results
  let recommendedCapacity = 0;
  let lastSuccessfulRound = null;
  
  for (const result of results) {
    if (result.successRate >= SUCCESS_THRESHOLD) {
      recommendedCapacity = result.numClients;
      lastSuccessfulRound = result;
    }
  }
  
  // Format test summary
  const summary = {
    testStartTime: new Date(testStartTime).toISOString(),
    testEndTime: new Date().toISOString(),
    totalDurationMs: performance.now() - testStartTime,
    roundsCompleted: results.length,
    optimalCapacity: recommendedCapacity,
    successThreshold: SUCCESS_THRESHOLD,
    browserMetrics: {
      totalLaunched: metrics.totalBrowserLaunches,
      successfulLaunches: metrics.successfulBrowserLaunches,
      failedLaunches: metrics.failedBrowserLaunches
    },
    connectionMetrics: {
      totalAttempted: metrics.totalConnections,
      successful: metrics.successfulConnections,
      failed: metrics.failedConnections,
      avgConnectionTimeMs: metrics.avgConnectionTime
    },
    votingMetrics: {
      totalVotes: metrics.totalVotes,
      successfulVotes: metrics.successfulVotes,
      voteSuccessRate: metrics.totalVotes ? (metrics.successfulVotes / metrics.totalVotes) * 100 : 0
    },
    errorMetrics: {
      totalErrors: metrics.errors.length,
      byType: {}
    },
    systemMetrics: {
      peakMemoryUsageMB: metrics.peakMemoryUsage
    },
    roundResults: results,
    serverType: USE_LOCAL ? 'local' : 'production',
    serverUrl: SERVER_URL
  };
  
  // Count errors by type
  metrics.errors.forEach(error => {
    if (!summary.errorMetrics.byType[error.type]) {
      summary.errorMetrics.byType[error.type] = 0;
    }
    summary.errorMetrics.byType[error.type]++;
  });
  
  // Write report to file
  const reportFile = path.join(__dirname, 'enhanced-load-test-report.json');
  fs.writeFileSync(reportFile, JSON.stringify(summary, null, 2));
  
  // Print summary
  console.log('\n' + '='.repeat(50));
  console.log('TEST SUMMARY'.bold);
  console.log('='.repeat(50));
  console.log(`Server:`.padEnd(25) + `${USE_LOCAL ? 'Local' : 'Production'}`);
  console.log(`Rounds completed:`.padEnd(25) + `${results.length}`);
  console.log(`Optimal capacity:`.padEnd(25) + `${recommendedCapacity} clients`.bold);
  console.log(`Success threshold:`.padEnd(25) + `${SUCCESS_THRESHOLD}%`);
  console.log(`Total duration:`.padEnd(25) + `${Math.round(summary.totalDurationMs / 1000 / 60)} minutes`);
  console.log(`Peak memory usage:`.padEnd(25) + `${metrics.peakMemoryUsage} MB`);
  console.log(`Browser success rate:`.padEnd(25) + `${(metrics.successfulBrowserLaunches / metrics.totalBrowserLaunches * 100).toFixed(1)}%`);
  console.log(`Connection success rate:`.padEnd(25) + `${(metrics.successfulConnections / metrics.totalConnections * 100).toFixed(1)}%`);
  console.log(`Avg connection time:`.padEnd(25) + `${Math.round(metrics.avgConnectionTime)}ms`);
  console.log(`Total errors:`.padEnd(25) + `${metrics.errors.length}`);
  console.log('='.repeat(50));
  
  if (lastSuccessfulRound) {
    console.log(`The server can handle ${recommendedCapacity} clients with a ${lastSuccessfulRound.successRate.toFixed(1)}% success rate.`.green.bold);
  } else if (results.length > 0) {
    console.log(`The server could not reliably handle even ${START_CLIENTS} clients.`.red.bold);
  } else {
    console.log(`No test rounds were completed successfully.`.red.bold);
  }
  
  console.log(`Detailed report saved to: ${reportFile}`);
  return summary;
}

// Main function to run the load test
async function runLoadTest() {
  log(`Starting enhanced load test for Planin 2000`, 'success');
  log(`Testing against ${USE_LOCAL ? 'local' : 'production'} server at ${SERVER_URL}`);
  log(`Starting with ${START_CLIENTS} clients, max ${MAX_CLIENTS} clients, steps of ${STEP_SIZE}`);
  
  testStartTime = performance.now();
  
  // Warm up server first
  const warmupSuccessful = await warmupServer();
  if (!warmupSuccessful) {
    log('Server warmup failed, proceeding with caution...', 'warning');
  }
  
  // Run test rounds with increasing client counts
  let currentClientCount = START_CLIENTS;
  let lastRoundSuccess = true;
  
  while (currentClientCount <= MAX_CLIENTS && lastRoundSuccess && shouldContinue) {
    // Run the current round
    lastRoundSuccess = await runTestRound(currentClientCount);
    
    // Clean up clients
    await cleanupClients();
    
    // Clean up host
    if (hostBrowser) {
      try {
        await hostBrowser.close();
      } catch (err) {
        // Ignore close errors
      }
      hostBrowser = null;
      hostPage = null;
    }
    
    // Determine if we should continue
    if (lastRoundSuccess) {
      // If successful and below max, increase client count
      if (currentClientCount < MAX_CLIENTS) {
        log(`Round with ${currentClientCount} clients was successful! Cooling down before next round...`);
        await new Promise(resolve => setTimeout(resolve, COOLDOWN_TIME_MS));
        
        currentClientCount += STEP_SIZE;
      } else {
        // Reached maximum client count successfully
        log(`Successfully tested maximum client count of ${MAX_CLIENTS}!`, 'success');
        break;
      }
    } else {
      // Round failed, stop increasing
      log(`Round with ${currentClientCount} clients did not meet success threshold.`, 'warning');
      break;
    }
  }
  
  // Generate final report
  try {
    await cleanup();
  } finally {
    generateReport();
  }
}

// Handle termination signals
process.on('SIGINT', async () => {
  log('Test interrupted, cleaning up...', 'warning');
  shouldContinue = false;
  
  try {
    await cleanup();
  } finally {
    generateReport();
    process.exit(0);
  }
});

// Run the load test
runLoadTest().catch(err => {
  log(`Unhandled error: ${err.message}`, 'error');
  cleanup().finally(() => {
    generateReport();
    process.exit(1);
  });
}); 