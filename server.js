const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

app.get('/', (req, res) => { res.send('Catan Backend is Live!'); });

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

let connectedPlayers = 0;
let currentBoardState = null;
let gameAchievements = {
  longestRoadHolder: null,
  longestRoadLength: 0,
  largestArmyHolder: null,
  largestArmySize: 0,
  playedKnights: { 1: 0, 2: 0, 3: 0, 4: 0 }
};
let buildHistory = [];

function resetGameState() {
  gameAchievements = {
    longestRoadHolder: null,
    longestRoadLength: 0,
    largestArmyHolder: null,
    largestArmySize: 0,
    playedKnights: { 1: 0, 2: 0, 3: 0, 4: 0 }
  };
  buildHistory = [];
}

io.on('connection', (socket) => {
  connectedPlayers++;
  const playerNumber = connectedPlayers;
  socket.emit('assignPlayer', playerNumber);

  if (currentBoardState) {
    socket.emit('syncBoard', currentBoardState);
    socket.emit('syncAchievements', gameAchievements);
    if (buildHistory.length > 0) {
      socket.emit('replayBuilds', buildHistory);
    }
  }

  socket.on('initBoard', (data) => {
    currentBoardState = data;
    resetGameState();
    socket.broadcast.emit('syncBoard', data);
    console.log('Game initialized with', data.numPlayers, 'players');
  });

  socket.on('gameAction', (data) => {
    if (data.type === 'BUILD') {
      buildHistory.push(data);
    }
    if (data.type === 'MOVE_ROBBER') {
      // Track robber
    }
    socket.broadcast.emit('gameAction', data);
  });

  socket.on('claimLongestRoad', (data) => {
    const { player, length } = data;
    if (length >= 5 && length > gameAchievements.longestRoadLength) {
      const prevHolder = gameAchievements.longestRoadHolder;
      gameAchievements.longestRoadHolder = player;
      gameAchievements.longestRoadLength = length;
      io.emit('longestRoadChanged', { newHolder: player, prevHolder, length });
    }
    io.emit('syncAchievements', gameAchievements);
  });

  socket.on('claimLargestArmy', (data) => {
    const { player, knights } = data;
    if (knights >= 3 && knights > gameAchievements.largestArmySize) {
      const prevHolder = gameAchievements.largestArmyHolder;
      gameAchievements.largestArmyHolder = player;
      gameAchievements.largestArmySize = knights;
      io.emit('largestArmyChanged', { newHolder: player, prevHolder, knights });
    }
    io.emit('syncAchievements', gameAchievements);
  });

  socket.on('offerTrade', (tradeData) => {
    socket.broadcast.emit('tradeOffered', tradeData);
  });

  socket.on('acceptTrade', (tradeId, acceptorId) => {
    // Handle trade execution
    io.emit('tradeExecuted', { tradeId, acceptorId });
  });

  socket.on('playMonopoly', (data) => {
    socket.broadcast.emit('monopolyDemand', data);
  });

  socket.on('monopolyYield', (data) => {
    io.emit('monopolyCollect', data);
  });

  socket.on('discardCards', (data) => {
    socket.broadcast.emit('gameAction', { type: 'DISCARD_CARDS', player: data.player, discards: data.discards });
  });

  socket.on('disconnect', () => {
    connectedPlayers--;
    if (connectedPlayers <= 0) {
      connectedPlayers = 0;
      currentBoardState = null;
      resetGameState();
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { 
  console.log(`Catan Backend listening on port ${PORT}`); 
});
