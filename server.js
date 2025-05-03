const express = require('express');
const { ExpressPeerServer } = require('peer');
const cors = require('cors');

const app = express();
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));

const server = require('http').createServer(app);

const peerServer = ExpressPeerServer(server, {
  debug: true,
  path: '/',
  allow_discovery: true,
  alive_timeout: 60000, // 60 segundos
  key: 'peerjs' // Chave padrão que o PeerJS espera
});

// Lista para manter registro dos peers conectados
let connectedPeers = new Set();

// Adicionar evento para logs
peerServer.on('connection', (client) => {
  const id = client.getId ? client.getId() : client.id;
  console.log(`Client connected: ${id}`);
  connectedPeers.add(id);
});

peerServer.on('disconnect', (client) => {
  const id = client.getId ? client.getId() : client.id;
  console.log(`Client disconnected: ${id}`);
  connectedPeers.delete(id);
});

app.use('/peerjs', peerServer);

app.get('/', (req, res) => {
  res.send('PeerJS server is running!');
});

// Endpoint para verificar peers ativos
app.get('/peers', (req, res) => {
  let activePeers = [];
  
  try {
    // Tenta obter peers da forma tradicional
    if (peerServer._clients && typeof peerServer._clients.getIds === 'function') {
      activePeers = peerServer._clients.getIds();
    } 
    // Fallback para nossa lista mantida manualmente
    else {
      activePeers = Array.from(connectedPeers);
    }
  } catch (err) {
    console.error('Erro ao obter lista de peers:', err);
    // Usa o fallback se ocorrer erro
    activePeers = Array.from(connectedPeers);
  }
  
  res.json({
    active: activePeers,
    count: activePeers.length
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`PeerJS server running on port ${PORT}`);
});
