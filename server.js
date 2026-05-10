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

// ─── SERVER STATE ───
let connectedPlayers = 0;
let currentBoardState = null;
let activeTrade = null;
let tradeTimeout = null;

let gameAchievements = {
  longestRoadHolder: null, longestRoadLength: 0,
  largestArmyHolder: null, largestArmySize: 0,
  playedKnights: { 1: 0, 2: 0, 3: 0, 4: 0 },
  roadLengths: { 1: 0, 2: 0, 3: 0, 4: 0 }
};

let playerInventories = {};
// buildHistory includes BUILD actions, DEV purchases, and ROBBER moves for reconnect replay
let buildHistory = [];
// devHistory tracks card purchases separately so deck state can be replayed
let devHistory = []; // [{player, cardType}] – cardType hidden from others as 'unknown'
let activePlayer = 1;
let setupIndex = 0;
let isSetupPhase = true;
let robberHexId = null;
let discardQueue = [];
let gameOver = false;

function initInventories(numPlayers) {
  playerInventories = {};
  for (let p = 1; p <= numPlayers; p++) {
    playerInventories[p] = { wheat:0, wood:0, brick:0, sheep:0, ore:0, knight:0, road_building:0, monopoly:0, yop:0, vp:0 };
  }
}

function resetGameState() {
  gameAchievements = {
    longestRoadHolder: null, longestRoadLength: 0,
    largestArmyHolder: null, largestArmySize: 0,
    playedKnights: { 1:0, 2:0, 3:0, 4:0 },
    roadLengths: { 1:0, 2:0, 3:0, 4:0 }
  };
  buildHistory = []; devHistory = [];
  activePlayer = 1; setupIndex = 0; isSetupPhase = true;
  robberHexId = null; discardQueue = []; gameOver = false;
  currentBoardState = null; playerInventories = {};
}

// ─── CONNECTIONS ───
io.on('connection', (socket) => {
  connectedPlayers++;
  const playerNumber = connectedPlayers;
  socket.emit('assignPlayer', playerNumber);

  // Send full game state to reconnecting/late-joining players
  if (currentBoardState) {
    socket.emit('syncBoard', currentBoardState);
    socket.emit('syncAchievements', gameAchievements);
    if (buildHistory.length > 0) {
      socket.emit('replayBuilds', { history: buildHistory, setupState: { isSetupPhase, setupIndex, activePlayer } });
    }
    // Tell them how many dev cards have been bought (so deck size stays in sync)
    if (devHistory.length > 0) {
      socket.emit('syncDeckSize', { purchased: devHistory.length });
    }
    if (gameOver) {
      socket.emit('gameAlreadyOver');
    }
  }

  // ─── GAME INIT ───
  socket.on('initBoard', (data) => {
    resetGameState();
    currentBoardState = data;
    initInventories(data.numPlayers);
    // Find the desert hex for initial robber placement
    const desertIdx = data.blueprint.findIndex(h => h.type === 'desert');
    if (desertIdx !== -1) {
      robberHexId = desertIdx;
      buildHistory.push({ type: 'MOVE_ROBBER', hexId: robberHexId });
    }
    socket.broadcast.emit('syncBoard', data);
  });

  // ─── GAME ACTIONS ───
  socket.on('gameAction', (data) => {
    // ── BUILD ──
    if (data.type === 'BUILD') {
      buildHistory.push(data);
      if (isSetupPhase && data.buildType === 'road') {
        setupIndex++;
        if (setupIndex >= (currentBoardState?.numPlayers || 4) * 2) {
          isSetupPhase = false;
          activePlayer = 1;
        }
      }
      // Update server inventory for resource distribution (roads/cities don't cost in setup)
      if (!isSetupPhase && !data.isFree && playerInventories[data.playerOwner]) {
        const costs = { road:{wood:1,brick:1}, house:{wood:1,brick:1,wheat:1,sheep:1}, city:{wheat:2,ore:3} };
        const cost = costs[data.buildType];
        if (cost) Object.entries(cost).forEach(([r,a]) => playerInventories[data.playerOwner][r] = Math.max(0,(playerInventories[data.playerOwner][r]||0)-a));
      }
    }
    // ── SERVER-AUTHORITATIVE ROBBER MOVE & STEAL ──
    else if (data.type === 'MOVE_ROBBER_AND_STEAL') {
      const { stealer, hexId, victim } = data;
      robberHexId = hexId;

      // Prevent duplicate MOVE_ROBBER entries
      const last = buildHistory[buildHistory.length - 1];
      if (!last || last.type !== 'MOVE_ROBBER' || last.hexId !== hexId) {
        buildHistory.push({ type: 'MOVE_ROBBER', hexId });
      }
      io.emit('gameAction', { type: 'MOVE_ROBBER', hexId });

      let stealMsg = `Robber moved to hex ${hexId}.`;

      if (victim && playerInventories[victim]) {
        const inv = playerInventories[victim];
        const pool = [];
        ['wood','brick','sheep','wheat','ore'].forEach(r => {
          for (let i = 0; i < (inv[r] || 0); i++) pool.push(r);
        });
        if (pool.length > 0) {
          const stolen = pool[Math.floor(Math.random() * pool.length)];
          playerInventories[victim][stolen] = Math.max(0, (playerInventories[victim][stolen] || 0) - 1);
          if (!playerInventories[stealer][stolen]) playerInventories[stealer][stolen] = 0;
          playerInventories[stealer][stolen]++;
          io.emit('gameAction', { type: 'STEAL', stealer, victim, resource: stolen });
          stealMsg = `Player ${stealer} stole 1 ${stolen} from Player ${victim}!`;
        } else {
          stealMsg = `Player ${victim} had no resources to steal.`;
        }
      } else if (!victim) {
        stealMsg = 'Robber placed. No one to rob.';
      }

      io.emit('gameAction', { type: 'END_ROBBER_PHASE', msg: stealMsg });
      return; // Do not fall through to general broadcast
    }
    // ── END TURN ──
    else if (data.type === 'END_TURN') {
      activePlayer = (activePlayer % (currentBoardState?.numPlayers || 4)) + 1;
    }
    // ── KNIGHT TRACKING ──
    else if (data.type === 'PLAY_KNIGHT' && data.playerOwner) {
      if (!gameAchievements.playedKnights[data.playerOwner]) gameAchievements.playedKnights[data.playerOwner] = 0;
      gameAchievements.playedKnights[data.playerOwner]++;
      if (playerInventories[data.playerOwner]) {
        playerInventories[data.playerOwner].knight = Math.max(0, (playerInventories[data.playerOwner].knight||0) - 1);
      }
    }
    // ── DEV CARD PURCHASE (update server inventory) ──
    else if (data.type === 'BUY_DEV' && data.playerOwner) {
      devHistory.push({ player: data.playerOwner });
      if (playerInventories[data.playerOwner]) {
        const inv = playerInventories[data.playerOwner];
        inv.sheep = Math.max(0,(inv.sheep||0)-1);
        inv.wheat = Math.max(0,(inv.wheat||0)-1);
        inv.ore   = Math.max(0,(inv.ore||0)-1);
      }
      // Broadcast deck size to all so counters stay synced
      io.emit('syncDeckSize', { purchased: devHistory.length });
    }
    // ── BANK TRADE (update server inventory) ──
    else if (data.type === 'BANK_TRADE' && playerInventories[data.player]) {
      const inv = playerInventories[data.player];
      inv[data.give]    = Math.max(0, (inv[data.give]||0) - (data.giveAmt||4));
      inv[data.receive] = (inv[data.receive]||0) + 1;
    }

    // General relay to all OTHER clients
    socket.broadcast.emit('gameAction', data);
  });

  // ─── ACHIEVEMENTS ───
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

  // ─── GAME OVER ───
  socket.on('gameWon', (data) => {
    if (!gameOver) {
      gameOver = true;
      io.emit('gameOver', data);
    }
  });

  // ─── TRADE ───
  socket.on('offerTrade', (tradeData) => {
    activeTrade = tradeData;
    socket.broadcast.emit('tradeOffered', activeTrade);
    if (tradeTimeout) clearTimeout(tradeTimeout);
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
        offerer:  activeTrade.offerer,
        acceptor: acceptorId,
        giveRes:  activeTrade.giveRes,
        giveAmt:  activeTrade.giveAmt || 1,
        recRes:   activeTrade.recRes,
        recAmt:   activeTrade.recAmt || 1
      });
      activeTrade = null;
    }
  });

  // ─── MONOPOLY ───
  socket.on('playMonopoly', (data) => {
    socket.broadcast.emit('monopolyDemand', data);
  });

  socket.on('monopolyYield', (data) => {
    if (playerInventories[data.caster]) {
      playerInventories[data.caster][data.resource] = (playerInventories[data.caster][data.resource]||0) + data.amount;
    }
    if (playerInventories[data.victim]) {
      playerInventories[data.victim][data.resource] = Math.max(0, (playerInventories[data.victim][data.resource]||0) - data.amount);
    }
    io.emit('monopolyCollect', data);
  });

  // ─── DISCARD ───
  socket.on('startDiscard', (playersToDiscard) => {
    discardQueue = Array.isArray(playersToDiscard) ? [...playersToDiscard] : [];
    if (discardQueue.length === 0) io.emit('allDiscardsComplete');
  });

  socket.on('discardCards', (data) => {
    // Update server inventory
    if (playerInventories[data.player]) {
      const inv = playerInventories[data.player];
      Object.entries(data.discards || {}).forEach(([r, a]) => {
        inv[r] = Math.max(0, (inv[r]||0) - a);
      });
    }
    // Broadcast to other clients so their local copies stay in sync
    socket.broadcast.emit('gameAction', { type: 'DISCARD_CARDS', player: data.player, discards: data.discards });
    // Remove from queue and signal if done
    discardQueue = discardQueue.filter(p => p !== data.player);
    if (discardQueue.length === 0) io.emit('allDiscardsComplete');
  });

  // ─── CHAT ───
  socket.on('chatMessage', (data) => {
    const msg = String(data.msg || '').slice(0, 120).replace(/</g,'&lt;').replace(/>/g,'&gt;');
    if (!msg) return;
    io.emit('chatMessage', { player: playerNumber, msg });
  });

  // ─── DISCONNECT ───
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
server.listen(PORT, () => console.log(`Catan Backend listening on port ${PORT}`));
