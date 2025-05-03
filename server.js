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
  origin: ['http://localhost:3000', 'http://localhost:5500', 'http://127.0.0.1:5500', 'https://planin-back.onrender.com', '*'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept', 'Origin', 'X-Requested-With'],
  exposedHeaders: ['Content-Length', 'Content-Type'],
  credentials: true
};

// Armazenamento de peers
const connectedPeers = new Set();

// Configuração para rate limiting
const ipRequestCounts = new Map();
const MAX_REQUESTS_PER_HOUR = 100;
const RATE_LIMIT_RESET_INTERVAL = 60 * 60 * 1000; // 1 hora em ms

// Função para limpar contadores de rate limit periodicamente
setInterval(() => {
  ipRequestCounts.clear();
}, RATE_LIMIT_RESET_INTERVAL);

// Middleware para rate limiting
function rateLimiter(req, res, next) {
  const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  
  if (!ipRequestCounts.has(ip)) {
    ipRequestCounts.set(ip, 1);
  } else {
    const currentCount = ipRequestCounts.get(ip);
    if (currentCount >= MAX_REQUESTS_PER_HOUR) {
      return res.status(429).json({ 
        error: 'Muitas requisições. Tente novamente mais tarde.' 
      });
    }
    ipRequestCounts.set(ip, currentCount + 1);
  }
  
  next();
}

// Configuração do servidor Express
const app = express();
app.use(cors(CORS_OPTIONS));
app.use(express.json({ limit: '10kb' })); // Limitar tamanho do corpo das requisições
app.use(rateLimiter); // Aplicar rate limiting em todas as rotas
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

// Função para sanitizar dados de entrada
function sanitizeInput(data) {
  if (typeof data !== 'object' || data === null) return {};
  
  const sanitized = {};
  
  // Lista de campos permitidos
  const allowedFields = ['timestamp'];
  
  for (const field of allowedFields) {
    if (data[field] && typeof data[field] === 'string') {
      // Limitar tamanho e sanitizar
      sanitized[field] = data[field].substring(0, 50);
    }
  }
  
  return sanitized;
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

// Servir arquivos estáticos do frontend
app.use(express.static(path.join(__dirname, '../planin-front')));

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
    // Obter o endereço IP do visitante
    const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    
    // Sanitizar dados de entrada
    const sanitizedData = sanitizeInput(req.body);
    
    // Ler dados atuais
    const visitorData = readVisitorCount();
    
    // Verificar se este IP já foi registrado (evitar contagem duplicada)
    const visitorExists = visitorData.visitors.some(visitor => visitor.ip === ip);
    
    if (!visitorExists) {
      // Adicionar novo visitante com dados sanitizados
      visitorData.visitors.push({
        ip,
        timestamp: new Date().toISOString(),
        ...sanitizedData
      });
      
      // Limitar o número de visitantes armazenados (manter apenas os 10000 mais recentes)
      if (visitorData.visitors.length > 10000) {
        visitorData.visitors = visitorData.visitors.slice(-10000);
      }
      
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
