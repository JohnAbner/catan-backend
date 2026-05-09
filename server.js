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
let discardQueue = [];

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
  discardQueue = [];
  currentBoardState = null; // Also clear board state on full reset
}

io.on('connection', (socket) => {
    connectedPlayers++;
    const playerNumber = connectedPlayers;
    socket.emit('assignPlayer', playerNumber);

    if (currentBoardState) {
      socket.emit('syncBoard', currentBoardState);
      socket.emit('syncAchievements', gameAchievements);
      
      // NEW: Always replay history to ensure late joiners and refreshers are in sync
      if (buildHistory.length > 0) {
        socket.emit('replayBuilds', { history: buildHistory, setupState: { isSetupPhase, setupIndex } });
      }
    }

    socket.on('initBoard', (data) => {
        resetGameState(); // Ensure a clean slate before starting a new board
        currentBoardState = data;
        // The robber's initial position is part of the initial board state now
        const desertHex = data.blueprint.findIndex(hex => hex.type === 'desert');
        if(desertHex !== -1) {
            robberHexId = desertHex;
            buildHistory.push({ type: 'MOVE_ROBBER', hexId: robberHexId }); // Log initial robber position
        }
        socket.broadcast.emit('syncBoard', data);
    });

    socket.on('gameAction', (data) => {
        // Track builds for reconnect replay
        if (data.type === 'BUILD') {
          buildHistory.push(data);
          // NEW: Track setup phase state changes
          if(isSetupPhase) {
            if(data.buildType === 'road') {
              setupIndex++;
              if(setupIndex >= (currentBoardState?.numPlayers || 4) * 2) {
                isSetupPhase = false;
                activePlayer = 1;
              }
            }
          }
        }
        // Track robber position
        if (data.type === 'MOVE_ROBBER') {
          robberHexId = data.hexId;
          // To ensure robber state is re-playable, only add it if it's a new position
          const lastAction = buildHistory[buildHistory.length - 1];
          if (!lastAction || lastAction.type !== 'MOVE_ROBBER' || lastAction.hexId !== data.hexId) {
            buildHistory.push(data);
          }
        }
        // Track turn progression
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

    // --- NEW: DISCARD HANDLING ---
    socket.on('startDiscard', (playersToDiscard) => {
        discardQueue = playersToDiscard;
        // If the queue is already empty, proceed immediately
        if (discardQueue.length === 0) {
            io.emit('allDiscardsComplete');
        }
    });


    socket.on('monopolyYield', (data) => {
        io.emit('monopolyCollect', data);
    });

    // --- DISCARD ---
    socket.on('discardCards', (data) => {
        // First, inform all clients of the discard for UI updates
        socket.broadcast.emit('gameAction', { type: 'DISCARD_CARDS', player: data.player, discards: data.discards });

        // Then, manage the master queue
        discardQueue = discardQueue.filter(p => p !== data.player);

        // If the master queue is now empty, inform all clients
        if (discardQueue.length === 0) {
            io.emit('allDiscardsComplete');
        }
    });


    socket.on('disconnect', () => {
        connectedPlayers--;
        if (connectedPlayers <= 0) {
            connectedPlayers = 0;
            activeTrade = null;
            resetGameState();
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`Catan Backend listening on port ${PORT}`); });
