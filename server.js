const express = require('express');
const { ExpressPeerServer } = require('peer');
const cors = require('cors');
const http = require('http');
const fs = require('fs');
const path = require('path');

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
app.use(express.json()); // Para processar requisições JSON
const server = http.createServer(app);

// Caminho para arquivo de contagem de visitantes
const VISITOR_FILE = path.join(__dirname, 'visitors.json');

// Função para ler o contador de visitantes
function readVisitorCount() {
  try {
    if (fs.existsSync(VISITOR_FILE)) {
      const data = fs.readFileSync(VISITOR_FILE, 'utf8');
      return JSON.parse(data);
    }
    // Se o arquivo não existir, criar um novo
    const initialData = { totalVisits: 0, visitors: [] };
    fs.writeFileSync(VISITOR_FILE, JSON.stringify(initialData, null, 2));
    return initialData;
  } catch (error) {
    console.error('Erro ao ler arquivo de visitantes:', error);
    return { totalVisits: 0, visitors: [] };
  }
}

// Função para salvar o contador de visitantes
function saveVisitorCount(data) {
  try {
    fs.writeFileSync(VISITOR_FILE, JSON.stringify(data, null, 2));
    return true;
  } catch (error) {
    console.error('Erro ao salvar arquivo de visitantes:', error);
    return false;
  }
}

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

// Rota para registrar uma nova visita
app.post('/register-visit', (req, res) => {
  try {
    // Obter o endereço IP do visitante e um timestamp
    const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    
    // Ler dados atuais
    const visitorData = readVisitorCount();
    
    // Verificar se este IP já foi registrado (evitar contagem duplicada)
    const visitorExists = visitorData.visitors.some(visitor => visitor.ip === ip);
    
    if (!visitorExists) {
      // Adicionar novo visitante
      visitorData.visitors.push({
        ip,
        timestamp: new Date().toISOString(),
        ...req.body
      });
      
      // Incrementar contagem total
      visitorData.totalVisits += 1;
      
      // Salvar dados atualizados
      saveVisitorCount(visitorData);
    }
    
    // Retornar contagem total
    res.json({ totalVisits: visitorData.totalVisits });
  } catch (error) {
    console.error('Erro ao registrar visita:', error);
    res.status(500).json({ error: 'Erro ao registrar visita' });
  }
});

// Rota para obter a contagem total de visitantes
app.get('/visitor-count', (req, res) => {
  try {
    const visitorData = readVisitorCount();
    res.json({ totalVisits: visitorData.totalVisits });
  } catch (error) {
    console.error('Erro ao buscar contagem de visitantes:', error);
    res.status(500).json({ error: 'Erro ao buscar contagem de visitantes' });
  }
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
console.log(`Servidor rodando na porta ${PORT}`);
