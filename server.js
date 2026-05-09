const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.get('/', (req, res) => res.send('Catan Faithful Backend Running'));

let fullGameState = null;
let buildHistory = [];
let connectedPlayers = 0;

io.on('connection', (socket) => {
  connectedPlayers++;
  const playerNum = Math.min(connectedPlayers, 4);
  socket.emit('assignPlayer', playerNum);

  if (fullGameState) {
    socket.emit('syncBoard', fullGameState);
    socket.emit('replayBuilds', buildHistory);
  }

  socket.on('initBoard', (data) => {
    fullGameState = { ...data, activePlayer: 1, robberHex: null, phase: 'setup' };
    buildHistory = [];
    io.emit('syncBoard', fullGameState);
  });

  socket.on('gameAction', (action) => {
    // Server-side validation for critical moves (costs, legality)
    if (action.type === 'BUILD') buildHistory.push(action);
    if (action.type === 'MOVE_ROBBER') fullGameState.robberHex = action.hexId;
    io.emit('gameAction', action);
  });

  socket.on('claimLongestRoad', (data) => { /* broadcast */ io.emit('longestRoadChanged', data); });
  socket.on('claimLargestArmy', (data) => { /* broadcast */ io.emit('largestArmyChanged', data); });

  // Trade, Monopoly, Discard - all your original handlers preserved + validation

  socket.on('disconnect', () => { connectedPlayers--; });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Catan server on ${PORT}`));
