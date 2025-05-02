const express = require('express');
const { ExpressPeerServer } = require('peer');
const cors = require('cors');

const app = express();
app.use(cors());

const server = require('http').createServer(app);

const peerServer = ExpressPeerServer(server, {
  debug: true,
  path: '/'
});

app.use('/peerjs', peerServer);

app.get('/', (req, res) => {
  res.send('PeerJS server is running!');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`PeerJS server running on port ${PORT}`);
});
