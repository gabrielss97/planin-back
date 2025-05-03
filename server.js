const express = require('express');
const { ExpressPeerServer } = require('peer');
const cors = require('cors');
const http = require('http');

// Configurações
const PORT = process.env.PORT || 3000;
const PEER_CONFIG = {
  debug: false,
  path: '/',
  allow_discovery: true,
  alive_timeout: 60000,
  key: 'peerjs'
};

const CORS_OPTIONS = {
  origin: '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
};

// Armazenamento de peers
const connectedPeers = new Set();

// Configuração do servidor Express
const app = express();
app.use(cors(CORS_OPTIONS));
const server = http.createServer(app);

// Configuração do servidor PeerJS
const peerServer = ExpressPeerServer(server, PEER_CONFIG);

// Manipuladores de eventos do PeerJS
function handlePeerConnection(client) {
  const id = client.getId ? client.getId() : client.id;
  connectedPeers.add(id);
}

function handlePeerDisconnect(client) {
  const id = client.getId ? client.getId() : client.id;
  connectedPeers.delete(id);
}

peerServer.on('connection', handlePeerConnection);
peerServer.on('disconnect', handlePeerDisconnect);

// Rotas
app.use('/peerjs', peerServer);

app.get('/', (req, res) => {
  res.send('PeerJS server is running!');
});

app.get('/peers', (req, res) => {
  const activePeers = getActivePeers();
  
  res.json({
    active: activePeers,
    count: activePeers.length
  });
});

// Funções auxiliares
function getActivePeers() {
  try {
    if (peerServer._clients && typeof peerServer._clients.getIds === 'function') {
      return peerServer._clients.getIds();
    }
    return Array.from(connectedPeers);
  } catch {
    return Array.from(connectedPeers);
  }
}

// Inicializar servidor
server.listen(PORT);
