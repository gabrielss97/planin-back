const { Peer } = require('peerjs');
const colors = require('colors');
const { performance } = require('perf_hooks');
// Add WebRTC support for Node.js
const wrtc = require('wrtc');

// Configuration
const NUM_CLIENTS = 20;
const TEST_DURATION_MS = 60000; // 1 minute test
const STAGGERED_CONNECT_INTERVAL_MS = 200; // Time between each client connection
const SERVER_URL = process.env.SERVER_URL || 'https://planin-back.onrender.com';
const USE_LOCAL = process.env.USE_LOCAL === 'true';
const VOTE_INTERVAL_MS = 5000; // Time between votes

// Server configurations
const serverConfig = USE_LOCAL ? {
  host: 'localhost',
  port: 3000,
  path: '/peerjs',
  secure: false,
  debug: 0,
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' }
    ]
  },
  wrtc: wrtc // Add WebRTC implementation for Node.js
} : {
  host: 'planin-back.onrender.com',
  path: '/peerjs',
  secure: true,
  debug: 0,
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' }
    ]
  },
  wrtc: wrtc // Add WebRTC implementation for Node.js
};

// Fallback configuration (cloud PeerJS server)
const fallbackConfig = {
  debug: 0,
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' }
    ]
  },
  wrtc: wrtc // Add WebRTC implementation for Node.js
};

// Metrics
const metrics = {
  connectionsAttempted: 0,
  connectionsSuccessful: 0,
  connectionsFailed: 0,
  messagesAttempted: 0,
  messagesDelivered: 0,
  messagesFailed: 0,
  connectionLatencies: [],
  messageLatencies: [],
  errors: []
};

// Clients tracking
const clients = [];
let hostPeer = null;
let hostId = null;
let testStartTime = null;
let testEndTime = null;
let hostConnections = [];

// Cards values
const cardValues = ['0', '1', '2', '3', '5', '8', '13', '21', '34', '55', '89', 'XP', '?', '☕'];

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

// Create host and start test
async function startTest() {
  log('Starting integration test with following configuration:');
  log(`Server: ${USE_LOCAL ? 'Local' : 'Production'}`);
  log(`Number of clients: ${NUM_CLIENTS}`);
  log(`Test duration: ${TEST_DURATION_MS / 1000} seconds`);
  
  testStartTime = performance.now();
  
  // Create host peer
  try {
    log('Creating host peer...');
    hostPeer = new Peer(undefined, serverConfig);
    
    hostPeer.on('open', (id) => {
      hostId = id;
      log(`Host peer created with ID: ${hostId}`, 'success');
      
      // Setup host connection handlers
      hostPeer.on('connection', (conn) => {
        const startTime = performance.now();
        log(`Incoming connection from peer: ${conn.peer}`);
        
        conn.on('open', () => {
          hostConnections.push(conn);
          metrics.connectionsSuccessful++;
          const latency = performance.now() - startTime;
          metrics.connectionLatencies.push(latency);
          log(`Connection established with ${conn.peer} (latency: ${latency.toFixed(2)}ms)`, 'success');
          
          // Send current user list to new connection
          const userList = {
            type: 'user_list',
            users: hostConnections.map(c => `User-${c.peer.substring(0, 5)}`)
          };
          conn.send(userList);
          
          // Broadcast new user to all other connections
          hostConnections.forEach(c => {
            if (c !== conn && c.open) {
              c.send({
                type: 'user_joined',
                name: `User-${conn.peer.substring(0, 5)}`
              });
            }
          });
        });
        
        conn.on('data', (data) => {
          // Handle received data from connected peers
          if (data.type === 'vote') {
            // Broadcast vote to all connections
            hostConnections.forEach(c => {
              if (c !== conn && c.open) {
                c.send(data);
              }
            });
          }
        });
        
        conn.on('error', (err) => {
          log(`Error in connection with ${conn.peer}: ${err.message}`, 'error');
          metrics.errors.push({
            type: 'connection_error',
            peer: conn.peer,
            message: err.message,
            time: new Date().toISOString()
          });
        });
        
        conn.on('close', () => {
          log(`Connection closed with ${conn.peer}`, 'warning');
          const index = hostConnections.indexOf(conn);
          if (index !== -1) {
            hostConnections.splice(index, 1);
          }
        });
      });
      
      // Start connecting clients
      createClients();
    });
    
    hostPeer.on('error', (err) => {
      log(`Host peer error: ${err.type} - ${err.message}`, 'error');
      metrics.errors.push({
        type: 'host_error',
        message: err.message,
        error_type: err.type,
        time: new Date().toISOString()
      });
      
      // Try with fallback if the custom server fails
      if (!hostPeer._open && serverConfig.host !== 'localhost') {
        log('Attempting to use fallback PeerJS server...', 'warning');
        hostPeer = new Peer(undefined, fallbackConfig);
      }
    });
    
  } catch (err) {
    log(`Failed to create host peer: ${err.message}`, 'error');
    metrics.errors.push({
      type: 'host_creation_error',
      message: err.message,
      time: new Date().toISOString()
    });
    process.exit(1);
  }
  
  // Set up test timeout
  setTimeout(() => {
    endTest();
  }, TEST_DURATION_MS);
}

// Create clients and connect to host
async function createClients() {
  log(`Creating ${NUM_CLIENTS} clients with staggered connections...`);
  
  for (let i = 0; i < NUM_CLIENTS; i++) {
    // Stagger connections to reduce simultaneous load
    setTimeout(() => {
      createAndConnectClient(i);
    }, i * STAGGERED_CONNECT_INTERVAL_MS);
  }
}

// Create a single client and connect to host
function createAndConnectClient(index) {
  try {
    const clientPeer = new Peer(undefined, serverConfig);
    const clientInfo = {
      index,
      peer: clientPeer,
      connection: null,
      id: null,
      connected: false,
      connectionStart: performance.now()
    };
    
    clients.push(clientInfo);
    
    clientPeer.on('open', (id) => {
      clientInfo.id = id;
      log(`Client ${index} created with ID: ${id}`);
      metrics.connectionsAttempted++;
      
      // Connect to host
      try {
        const conn = clientPeer.connect(hostId, { reliable: true });
        clientInfo.connection = conn;
        
        conn.on('open', () => {
          clientInfo.connected = true;
          log(`Client ${index} (${id}) connected to host`, 'success');
          
          // Send join notification
          conn.send({
            type: 'user_joined',
            name: `User-${id.substring(0, 5)}`
          });
          
          // Schedule periodic votes
          scheduleRandomVotes(clientInfo);
        });
        
        conn.on('data', (data) => {
          // Handle data from host (not critical for this test)
        });
        
        conn.on('error', (err) => {
          log(`Client ${index} connection error: ${err.message}`, 'error');
          metrics.errors.push({
            type: 'client_connection_error',
            client: index,
            id,
            message: err.message,
            time: new Date().toISOString()
          });
          metrics.connectionsFailed++;
        });
        
        conn.on('close', () => {
          log(`Client ${index} connection closed`, 'warning');
          clientInfo.connected = false;
        });
        
      } catch (err) {
        log(`Client ${index} failed to connect to host: ${err.message}`, 'error');
        metrics.errors.push({
          type: 'client_connect_error',
          client: index,
          id: clientInfo.id,
          message: err.message,
          time: new Date().toISOString()
        });
        metrics.connectionsFailed++;
      }
    });
    
    clientPeer.on('error', (err) => {
      log(`Client ${index} peer error: ${err.type} - ${err.message}`, 'error');
      metrics.errors.push({
        type: 'client_peer_error',
        client: index,
        message: err.message,
        error_type: err.type,
        time: new Date().toISOString()
      });
      
      // Try with fallback if the custom server fails and we're not already using it
      if (!clientPeer._open && !clientInfo.connected && serverConfig.host !== 'localhost') {
        log(`Attempting to use fallback PeerJS server for client ${index}...`, 'warning');
        
        // Clean up the old peer
        if (clientInfo.peer) {
          clientInfo.peer.destroy();
        }
        
        // Create a new peer with fallback config
        const fallbackPeer = new Peer(undefined, fallbackConfig);
        clientInfo.peer = fallbackPeer;
        
        fallbackPeer.on('open', (id) => {
          clientInfo.id = id;
          log(`Client ${index} recreated with fallback and ID: ${id}`);
          
          // Connect to host with fallback
          const conn = fallbackPeer.connect(hostId, { reliable: true });
          clientInfo.connection = conn;
          
          conn.on('open', () => {
            clientInfo.connected = true;
            log(`Client ${index} (${id}) connected to host using fallback`, 'success');
            
            // Send join notification
            conn.send({
              type: 'user_joined',
              name: `User-${id.substring(0, 5)}`
            });
            
            // Schedule periodic votes
            scheduleRandomVotes(clientInfo);
          });
        });
      }
    });
    
  } catch (err) {
    log(`Failed to create client ${index}: ${err.message}`, 'error');
    metrics.errors.push({
      type: 'client_creation_error',
      client: index,
      message: err.message,
      time: new Date().toISOString()
    });
  }
}

// Schedule random votes from clients
function scheduleRandomVotes(clientInfo) {
  const interval = Math.floor(Math.random() * VOTE_INTERVAL_MS) + VOTE_INTERVAL_MS/2;
  
  setTimeout(() => {
    if (clientInfo.connected && clientInfo.connection && clientInfo.connection.open) {
      const randomCard = cardValues[Math.floor(Math.random() * cardValues.length)];
      
      // Record metrics for this message
      const messageStart = performance.now();
      metrics.messagesAttempted++;
      
      // Send vote
      try {
        clientInfo.connection.send({
          type: 'vote',
          name: `User-${clientInfo.id.substring(0, 5)}`,
          vote: randomCard
        });
        
        metrics.messagesDelivered++;
        metrics.messageLatencies.push(performance.now() - messageStart);
        log(`Client ${clientInfo.index} voted: ${randomCard}`);
      } catch (err) {
        metrics.messagesFailed++;
        log(`Client ${clientInfo.index} failed to vote: ${err.message}`, 'error');
        metrics.errors.push({
          type: 'vote_error',
          client: clientInfo.index,
          id: clientInfo.id,
          message: err.message,
          time: new Date().toISOString()
        });
      }
      
      // Schedule next vote if test is still running
      if (testStartTime && !testEndTime) {
        scheduleRandomVotes(clientInfo);
      }
    }
  }, interval);
}

// End test and report metrics
function endTest() {
  testEndTime = performance.now();
  const testDuration = (testEndTime - testStartTime) / 1000;
  
  log(`\n${'='.repeat(50)}`);
  log(`TEST COMPLETED - Duration: ${testDuration.toFixed(2)} seconds`);
  log(`${'='.repeat(50)}\n`);
  
  // Calculate metrics
  const successRate = metrics.connectionsSuccessful / metrics.connectionsAttempted * 100;
  const avgConnectionLatency = metrics.connectionLatencies.length > 0 
    ? metrics.connectionLatencies.reduce((a, b) => a + b, 0) / metrics.connectionLatencies.length 
    : 0;
  const avgMessageLatency = metrics.messageLatencies.length > 0
    ? metrics.messageLatencies.reduce((a, b) => a + b, 0) / metrics.messageLatencies.length
    : 0;
  
  // Log summary
  log(`CONNECTIONS:`);
  log(`- Attempted: ${metrics.connectionsAttempted}`);
  log(`- Successful: ${metrics.connectionsSuccessful} (${successRate.toFixed(2)}%)`);
  log(`- Failed: ${metrics.connectionsFailed}`);
  log(`- Average latency: ${avgConnectionLatency.toFixed(2)}ms`);
  log(``);
  
  log(`MESSAGES:`);
  log(`- Attempted: ${metrics.messagesAttempted}`);
  log(`- Delivered: ${metrics.messagesDelivered} (${(metrics.messagesDelivered / metrics.messagesAttempted * 100).toFixed(2)}%)`);
  log(`- Failed: ${metrics.messagesFailed}`);
  log(`- Average latency: ${avgMessageLatency.toFixed(2)}ms`);
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
  
  // Clean up
  log("\nCleaning up connections...");
  
  // Disconnect clients
  clients.forEach(client => {
    if (client.peer) {
      client.peer.destroy();
    }
  });
  
  // Disconnect host
  if (hostPeer) {
    hostPeer.destroy();
  }
  
  log("Test completed.", 'success');
  process.exit(0);
}

// Handle process signals
process.on('SIGINT', () => {
  log("\nReceived SIGINT. Stopping test...", 'warning');
  endTest();
});

// Start the test
startTest(); 