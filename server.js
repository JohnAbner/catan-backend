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

// Game state variables
let gameAchievements = {
  longestRoadHolder: null,
  longestRoadLength: 0,
  largestArmyHolder: null,
  largestArmySize: 0,
  playedKnights: { 1: 0, 2: 0, 3: 0, 4: 0 },
  roadLengths: { 1: 0, 2: 0, 3: 0, 4: 0 }
};
let playerInventories = {}; // Populated on game start
let buildHistory = [];
let activePlayer = 1;
let setupIndex = 0;
let isSetupPhase = true;
let robberHexId = null;
let discardQueue = [];

function initializePlayerInventories(numPlayers) {
    playerInventories = {};
    for (let p = 1; p <= numPlayers; p++) {
        playerInventories[p] = { wheat: 0, wood: 0, brick: 0, sheep: 0, ore: 0, knight: 0, road_building: 0, monopoly: 0, yop: 0, vp: 0 };
    }
}

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
  currentBoardState = null;
  playerInventories = {};
}

io.on('connection', (socket) => {
    connectedPlayers++;
    const playerNumber = connectedPlayers;
    socket.emit('assignPlayer', playerNumber);

    if (currentBoardState) {
      socket.emit('syncBoard', currentBoardState);
      socket.emit('syncAchievements', gameAchievements);
      if (buildHistory.length > 0) {
        socket.emit('replayBuilds', { history: buildHistory, setupState: { isSetupPhase, setupIndex } });
      }
    }

    socket.on('initBoard', (data) => {
        resetGameState();
        currentBoardState = data;
        initializePlayerInventories(data.numPlayers);
        const desertHex = data.blueprint.findIndex(hex => hex.type === 'desert');
        if(desertHex !== -1) {
            robberHexId = desertHex;
            buildHistory.push({ type: 'MOVE_ROBBER', hexId: robberHexId });
        }
        socket.broadcast.emit('syncBoard', data);
    });

    socket.on('gameAction', (data) => {
        if (data.type === 'BUILD') {
          buildHistory.push(data);
          if(isSetupPhase && data.buildType === 'road') {
              setupIndex++;
              if(setupIndex >= (currentBoardState?.numPlayers || 4) * 2) {
                isSetupPhase = false;
                activePlayer = 1;
              }
          }
        }
        else if (data.type === 'MOVE_ROBBER_AND_STEAL') {
            const { stealer, hexId, victim } = data;

            // 1. Move the Robber
            robberHexId = hexId;
            const lastAction = buildHistory[buildHistory.length - 1];
            if (!lastAction || lastAction.type !== 'MOVE_ROBBER' || lastAction.hexId !== hexId) {
                buildHistory.push({ type: 'MOVE_ROBBER', hexId });
            }
            io.emit('gameAction', { type: 'MOVE_ROBBER', hexId });

            let stealMsg = `Robber moved to hex ${hexId}.`;

            // 2. Perform Steal (Server is the strict authority)
            if (victim && playerInventories[victim]) {
                const inv = playerInventories[victim];
                let resourcePool = [];
                const resourceTypes = ['wood', 'brick', 'sheep', 'wheat', 'ore']; 
                
                resourceTypes.forEach(res => {
                    if (inv[res] && inv[res] > 0) {
                        for (let i = 0; i < inv[res]; i++) {
                            resourcePool.push(res);
                        }
                    }
                });

                if (resourcePool.length > 0) {
                    const stolenResource = resourcePool[Math.floor(Math.random() * resourcePool.length)];
                    
                    playerInventories[victim][stolenResource]--;
                    if (!playerInventories[stealer][stolenResource]) playerInventories[stealer][stolenResource] = 0;
                    playerInventories[stealer][stolenResource]++;

                    io.emit('gameAction', { type: 'STEAL', stealer, victim, resource: stolenResource });
                    stealMsg = `Player ${stealer} stole from Player ${victim}!`;
                } else {
                    stealMsg = `Player ${victim} had no resources to steal.`;
                }
            } else {
                stealMsg += " No one to steal from.";
            }
            
            // 3. End the robber phase for everyone
            io.emit('gameAction', { type: 'END_ROBBER_PHASE', msg: stealMsg });
            return; // Prevent fall-through to the general broadcast
        }
        else if (data.type === 'END_TURN') {
          activePlayer = (activePlayer % (currentBoardState?.numPlayers || 4)) + 1;
        }
        else if (data.type === 'PLAY_KNIGHT' && data.playerOwner) {
          if (!gameAchievements.playedKnights[data.playerOwner]) gameAchievements.playedKnights[data.playerOwner] = 0;
          gameAchievements.playedKnights[data.playerOwner]++;
        }
        
        // General broadcast for actions that need to be relayed
        socket.broadcast.emit('gameAction', data);
    });

    socket.on('claimLongestRoad', (data) => {
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

    socket.on('claimLargestArmy', (data) => {
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

    socket.on('offerTrade', (tradeData) => {
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

    socket.on('playMonopoly', (data) => {
        socket.broadcast.emit('monopolyDemand', data);
    });

    socket.on('monopolyYield', (data) => {
        if(playerInventories[data.caster]) {
            playerInventories[data.caster][data.resource] += data.amount;
        }
        io.emit('monopolyCollect', data);
    });
    
    socket.on('startDiscard', (playersToDiscard) => {
        discardQueue = playersToDiscard;
        if (discardQueue.length === 0) {
            io.emit('allDiscardsComplete');
        }
    });

    socket.on('discardCards', (data) => {
        // Broadcast to other clients so they can update the UI
        socket.broadcast.emit('gameAction', { type: 'DISCARD_CARDS', player: data.player, discards: data.discards });
        
        // Update server's master inventory
        const pInv = playerInventories[data.player];
        if (pInv) {
            for (const [res, amt] of Object.entries(data.discards)) {
                if(pInv[res] !== undefined) {
                    pInv[res] -= amt;
                }
            }
        }
        
        // Check if the discard phase is over
        discardQueue = discardQueue.filter(p => p !== data.player);
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
