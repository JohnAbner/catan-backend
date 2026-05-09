const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

app.get('/', (req, res) => { res.send('Catan Backend is Live and Running!'); });

const io = new Server(server, {
  cors: {
    origin: ["https://catan.cloud", "http://catan.cloud", "https://www.catan.cloud", "http://www.catan.cloud"],
    methods: ["GET", "POST"]
  }
});

let connectedPlayers = 0;
let currentBoardState = null;
let activeTrade = null;
let tradeTimeout = null;

// Achievement & game-wide state
let gameAchievements = {
  longestRoadHolder: null,
  longestRoadLength: 0,
  largestArmyHolder: null,
  largestArmySize: 0,
  playedKnights: { 1: 0, 2: 0, 3: 0, 4: 0 },
  roadLengths: { 1: 0, 2: 0, 3: 0, 4: 0 }
};

// Full build state for reconnecting players
let buildHistory = []; // [{nodeIndex, nodeType, buildType, playerOwner, isFree}]
let activePlayer = 1;
let setupIndex = 0;
let isSetupPhase = true;
let robberHexId = null;

function resetGameState() {
  gameAchievements = {
    longestRoadHolder: null,
    longestRoadLength: 0,
    largestArmyHolder: null,
    largestArmySize: 0,
    playedKnights: { 1: 0, 2: 0, 3: 0, 4: 0 },
    roadLengths: { 1: 0, 2: 0, 3: 0, 4: 0 }
  };
  buildHistory = [];
  activePlayer = 1;
  setupIndex = 0;
  isSetupPhase = true;
  robberHexId = null;
}

io.on('connection', (socket) => {
    connectedPlayers++;
    const playerNumber = connectedPlayers;
    socket.emit('assignPlayer', playerNumber);

    if (currentBoardState) {
      socket.emit('syncBoard', currentBoardState);
      socket.emit('syncAchievements', gameAchievements);
      // Replay build history so late-joiners see the board state
      if (buildHistory.length > 0) {
        socket.emit('replayBuilds', buildHistory);
      }
    }

    socket.on('initBoard', (data) => {
        currentBoardState = data;
        resetGameState();
        socket.broadcast.emit('syncBoard', data);
    });

    socket.on('gameAction', (data) => {
        // Track builds for reconnect replay
        if (data.type === 'BUILD') {
          buildHistory.push(data);
        }
        // Track robber position
        if (data.type === 'MOVE_ROBBER') {
          robberHexId = data.hexId;
        }
        // Track setup/turn state
        if (data.type === 'END_TURN') {
          activePlayer = (activePlayer % (currentBoardState?.numPlayers || 4)) + 1;
        }
        // Track played knights
        if (data.type === 'PLAY_KNIGHT' && data.playerOwner) {
          if (!gameAchievements.playedKnights[data.playerOwner]) gameAchievements.playedKnights[data.playerOwner] = 0;
          gameAchievements.playedKnights[data.playerOwner]++;
        }
        // Relay to all other players
        socket.broadcast.emit('gameAction', data);
    });

    // --- ACHIEVEMENT: LONGEST ROAD ---
    socket.on('claimLongestRoad', (data) => {
        // data: { player, length }
        const { player, length } = data;
        gameAchievements.roadLengths[player] = length;

        if (length >= 5 && length > gameAchievements.longestRoadLength) {
            const prevHolder = gameAchievements.longestRoadHolder;
            gameAchievements.longestRoadHolder = player;
            gameAchievements.longestRoadLength = length;
            io.emit('longestRoadChanged', { newHolder: player, prevHolder, length });
        }
        io.emit('syncAchievements', gameAchievements);
    });

    // --- ACHIEVEMENT: LARGEST ARMY ---
    socket.on('claimLargestArmy', (data) => {
        // data: { player, knights }
        const { player, knights } = data;
        gameAchievements.playedKnights[player] = knights;

        if (knights >= 3 && knights > gameAchievements.largestArmySize) {
            const prevHolder = gameAchievements.largestArmyHolder;
            gameAchievements.largestArmyHolder = player;
            gameAchievements.largestArmySize = knights;
            io.emit('largestArmyChanged', { newHolder: player, prevHolder, knights });
        }
        io.emit('syncAchievements', gameAchievements);
    });

    // --- TRADE NEGOTIATION ---
    socket.on('offerTrade', (tradeData) => {
        // tradeData: { offerer, giveRes, giveAmt, recRes, recAmt, id }
        activeTrade = tradeData;
        socket.broadcast.emit('tradeOffered', activeTrade);
        if(tradeTimeout) clearTimeout(tradeTimeout);
        tradeTimeout = setTimeout(() => {
            if (activeTrade && activeTrade.id === tradeData.id) {
                io.emit('tradeTimeout', activeTrade.id);
                activeTrade = null;
            }
        }, 20000);
    });

    socket.on('cancelTrade', (tradeId) => {
        if (activeTrade && activeTrade.id === tradeId) {
            clearTimeout(tradeTimeout);
            io.emit('tradeCancelled', tradeId);
            activeTrade = null;
        }
    });

    socket.on('acceptTrade', (tradeId, acceptorId) => {
        if (activeTrade && activeTrade.id === tradeId) {
            clearTimeout(tradeTimeout);
            io.emit('tradeExecuted', {
                offerer: activeTrade.offerer,
                acceptor: acceptorId,
                giveRes: activeTrade.giveRes,
                giveAmt: activeTrade.giveAmt || 1,
                recRes: activeTrade.recRes,
                recAmt: activeTrade.recAmt || 1
            });
            activeTrade = null;
        }
    });

    // --- MONOPOLY ---
    socket.on('playMonopoly', (data) => {
        socket.broadcast.emit('monopolyDemand', data);
    });

    socket.on('monopolyYield', (data) => {
        io.emit('monopolyCollect', data);
    });

    // --- DISCARD ---
    socket.on('discardCards', (data) => {
        // Broadcast so all clients update that player's inventory
        socket.broadcast.emit('gameAction', { type: 'DISCARD_CARDS', player: data.player, discards: data.discards });
    });

    socket.on('disconnect', () => {
        connectedPlayers--;
        if (connectedPlayers <= 0) {
            connectedPlayers = 0;
            currentBoardState = null;
            activeTrade = null;
            resetGameState();
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`Catan Backend listening on port ${PORT}`); });
