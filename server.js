const express = require('express');
const { ExpressPeerServer } = require('peer');
const cors = require('cors');
const http = require('http');
const fs = require('fs');
const path = require('path');

// Configurações
const PORT = process.env.PORT || 3000;
const PEER_CONFIG = {
  debug: process.env.DEBUG === 'true',
  path: '/',
  allow_discovery: true,
  // Aumentando o timeout para melhorar conexões simultâneas
  alive_timeout: 120000, // 2 minutos
  key: 'peerjs',
  proxied: true,
  ssl: process.env.NODE_ENV === 'production' ? {} : undefined,
  // Ajustes para lidar com muitas conexões simultâneas
  concurrent_limit: 50, // Limite de conexões simultâneas por peer
  connection_timeout: 30000 // 30 segundos
};

const CORS_OPTIONS = {
  origin: ['http://localhost:3000', 'http://localhost:5500', 'http://127.0.0.1:5500', 'https://planin-back.onrender.com', 'https://www.planin2000.com', 'https://planin2000.com', '*'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept', 'Origin', 'X-Requested-With'],
  exposedHeaders: ['Content-Length', 'Content-Type'],
  credentials: true
};

// Armazenamento de peers
const connectedPeers = new Set();
const peerTimestamps = new Map(); // Para monitorar atividade dos peers

// Configuração para rate limiting
const ipRequestCounts = new Map();
const MAX_REQUESTS_PER_HOUR = 200; // Aumentado para comportar mais usuários
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

// Middleware para logging de performance
function performanceLogger(req, res, next) {
  const start = process.hrtime();
  
  res.on('finish', () => {
    const [seconds, nanoseconds] = process.hrtime(start);
    const ms = seconds * 1000 + nanoseconds / 1000000;
    
    // Apenas logar requisições lentas (>100ms)
    if (ms > 100) {
      console.log(`[PERF] ${req.method} ${req.originalUrl} completed in ${ms.toFixed(2)}ms`);
    }
  });
  
  next();
}

// Configuração do servidor Express
const app = express();

// Middleware para adicionar cabeçalhos de segurança
app.use((req, res, next) => {
  // Adicionar cabeçalhos de segurança que no frontend estavam como meta tags
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  
  // Adicionar cabeçalhos CORS explícitos para garantir acesso do domínio em produção
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Origin, X-Requested-With');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  
  // Adicionar cabeçalhos específicos para WebSockets
  if (req.headers.upgrade && req.headers.upgrade.toLowerCase() === 'websocket') {
    res.setHeader('Sec-WebSocket-Protocol', 'peerjs');
    // Aumentar o timeout para websockets
    req.socket.setTimeout(120000);
  }
  
  next();
});

app.use(cors(CORS_OPTIONS));
app.use(express.json({ limit: '10kb' })); // Limitar tamanho do corpo das requisições
app.use(rateLimiter); // Aplicar rate limiting em todas as rotas
app.use(performanceLogger); // Adicionar logger de performance

// Ajustar timeout do servidor
const server = http.createServer(app);
server.keepAliveTimeout = 120000; // 2 minutos (120 segundos)
server.headersTimeout = 65000; // Precisa ser menor que o keepAliveTimeout (65 segundos)

// Configuração do servidor PeerJS
const peerServer = ExpressPeerServer(server, PEER_CONFIG);

// Manipuladores de eventos do PeerJS
function handlePeerConnection(client) {
  const id = client.getId ? client.getId() : client.id;
  connectedPeers.add(id);
  peerTimestamps.set(id, Date.now());
  
  // Log de diagnóstico
  const connectedCount = connectedPeers.size;
  console.log(`Peer conectado: ${id} (Total: ${connectedCount})`);
  
  // Verificar carga do servidor se o número de conexões estiver alto
  if (connectedCount > 30) {
    const memoryUsage = process.memoryUsage();
    console.log(`[MONITOR] Conexões: ${connectedCount}, Memória: ${Math.round(memoryUsage.rss / 1024 / 1024)}MB`);
  }
}

function handlePeerDisconnect(client) {
  const id = client.getId ? client.getId() : client.id;
  connectedPeers.delete(id);
  peerTimestamps.delete(id);
  console.log(`Peer desconectado: ${id} (Total: ${connectedPeers.size})`);
}

peerServer.on('connection', handlePeerConnection);
peerServer.on('disconnect', handlePeerDisconnect);

// Rotas
app.use('/peerjs', peerServer);

// Endpoint para status do servidor
app.get('/status', (req, res) => {
  res.json({
    status: 'ok',
    connections: connectedPeers.size,
    uptime: process.uptime()
  });
});

// Servir arquivos estáticos do frontend
app.use(express.static(path.join(__dirname, '../planin-front')));

app.get('/', (req, res) => {
  res.send('PeerJS server is running!');
});

// Detectar e limpar peers inativos
const PEER_CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutos
const PEER_INACTIVE_TIMEOUT = 30 * 60 * 1000; // 30 minutos

setInterval(() => {
  const now = Date.now();
  let inactivePeers = 0;
  
  peerTimestamps.forEach((timestamp, id) => {
    if (now - timestamp > PEER_INACTIVE_TIMEOUT) {
      // Peer inativo por mais de 30 minutos
      connectedPeers.delete(id);
      peerTimestamps.delete(id);
      inactivePeers++;
    }
  });
  
  if (inactivePeers > 0) {
    console.log(`[CLEANUP] Removidos ${inactivePeers} peers inativos`);
  }
}, PEER_CLEANUP_INTERVAL);

// Handler para erros não tratados
process.on('uncaughtException', (err) => {
  console.error('Erro não tratado:', err);
  // Continuar executando - não encerrar o processo
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Promessa rejeitada não tratada:', reason);
  // Continuar executando - não encerrar o processo
});

// Inicializar servidor
server.listen(PORT, () => {
  console.log(`Servidor PeerJS rodando na porta ${PORT}`);
  console.log(`Modo: ${process.env.NODE_ENV || 'development'}`);
});
