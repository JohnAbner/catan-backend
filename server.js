const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
app.get('/', (req, res) => res.send('Catan Backend is Live!'));

const io = new Server(server, {
  cors: {
    origin: ['https://catan.cloud','http://catan.cloud','https://www.catan.cloud','http://www.catan.cloud'],
    methods: ['GET','POST']
  }
});

// ══════════════════════════════════════════════════════════
//  UTILITIES
// ══════════════════════════════════════════════════════════

function genToken() { return crypto.randomBytes(16).toString('hex'); }
function genGameId() { return crypto.randomBytes(4).toString('hex').toUpperCase(); }

// ══════════════════════════════════════════════════════════
//  GAME REGISTRY — supports multiple concurrent games
// ══════════════════════════════════════════════════════════

// Map of gameId → { slots, tokenToSlot, gState, tradeTimeout }
const games = new Map();

// Map of socketId → gameId (for quick reverse lookup on disconnect)
const socketToGame = new Map();

function createGame(gameId) {
  const game = {
    gameId,
    slots: [null, null, null, null],
    tokenToSlot: new Map(),
    gState: freshGState(),
    tradeTimeout: null,
  };
  games.set(gameId, game);
  return game;
}

function getGameForSocket(socketId) {
  const gid = socketToGame.get(socketId);
  return gid ? games.get(gid) : null;
}

function findOpenGame() {
  // Return a game that is in lobby phase and has open slots
  for (const [, game] of games) {
    if (game.gState.phase === 'lobby' && game.slots.some(s => s === null)) {
      return game;
    }
  }
  return null;
}

// ══════════════════════════════════════════════════════════
//  SLOT MANAGEMENT (per-game)
// ══════════════════════════════════════════════════════════

function findSlotByToken(game, token) {
  const p = game.tokenToSlot.get(token);
  return (p && game.slots[p - 1]) ? p : null;
}

function assignNewSlot(game, socketId) {
  const idx = game.slots.findIndex(s => s === null);
  if (idx === -1) return null;
  const token = genToken();
  const p = idx + 1;
  game.slots[idx] = { token, socketId, name: `Player ${p}`, connected: true };
  game.tokenToSlot.set(token, p);
  return { playerNum: p, token };
}

function playerNumForSocket(game, socketId) {
  const idx = game.slots.findIndex(s => s && s.socketId === socketId);
  return idx === -1 ? null : idx + 1;
}

function getLobbySnapshot(game) {
  return {
    gameId: game.gameId,
    phase: game.gState.phase,
    numPlayers: game.gState.numPlayers,
    slots: game.slots.map((s, i) => s ? { playerNum: i+1, name: s.name, connected: s.connected } : null)
  };
}

// Emit to everyone in a game
function emitToGame(game, event, data) {
  io.to(game.gameId).emit(event, data);
}

// ══════════════════════════════════════════════════════════
//  AUTHORITATIVE GAME STATE
// ══════════════════════════════════════════════════════════

const COSTS = {
  road:    { wood:1, brick:1 },
  house:   { wood:1, brick:1, wheat:1, sheep:1 },
  city:    { wheat:2, ore:3 },
  devCard: { sheep:1, wheat:1, ore:1 }
};
const RESOURCES = ['wheat','wood','brick','sheep','ore'];

function freshInv() {
  return { wheat:0, wood:0, brick:0, sheep:0, ore:0, knight:0, road_building:0, monopoly:0, yop:0, vp:0 };
}

function freshGState() {
  return {
    phase: 'lobby',
    numPlayers: 4,
    activePlayer: 1,
    // Setup: each entry is { player, action } — 'house' or 'road'
    // This makes the server fully authoritative about what is expected next.
    setupQueue: [],   // [{player, action}]
    setupIndex: 0,
    // Legacy: keep setupOrder for client display
    setupOrder: [],
    hasRolled: false, freeRoads: 0,
    isRobberPhase: false, discardQueue: [],
    devCardPlayedThisTurn: false, devCardBoughtThisTurn: null,
    blueprint: [], devDeck: [], devPurchased: 0, robberHexId: null,
    builds: {},
    inventories: { 1:freshInv(), 2:freshInv(), 3:freshInv(), 4:freshInv() },
    settlements: {1:0,2:0,3:0,4:0}, cities:{1:0,2:0,3:0,4:0}, roads:{1:0,2:0,3:0,4:0},
    basePoints: {1:0,2:0,3:0,4:0},
    longestRoadHolder: null, longestRoadLength: 0,
    largestArmyHolder: null, largestArmySize: 0,
    playedKnights: {1:0,2:0,3:0,4:0},
    activeTrade: null, skipTimer: null,
    // Track the vertex index of the last house placed during setup
    // so clients know which adjacent edges are valid for the road
    lastSetupHouseNodeIndex: null,
  };
}

function totalRes(gState, p) {
  const inv = gState.inventories[p];
  if (!inv) return 0;
  return RESOURCES.reduce((s, r) => s + (inv[r] || 0), 0);
}
function totalPts(gState, p) {
  let pts = gState.basePoints[p] || 0;
  if (gState.longestRoadHolder === p) pts += 2;
  if (gState.largestArmyHolder === p) pts += 2;
  return pts;
}
function canAfford(gState, p, item) {
  const inv = gState.inventories[p]; const cost = COSTS[item];
  if (!inv || !cost) return false;
  return Object.entries(cost).every(([r, a]) => (inv[r] || 0) >= a);
}
function deduct(gState, p, item) {
  const inv = gState.inventories[p]; const cost = COSTS[item];
  if (!inv || !cost) return;
  Object.entries(cost).forEach(([r, a]) => { inv[r] = Math.max(0, (inv[r] || 0) - a); });
}

// ── Broadcast authoritative inventories ──
function broadcastInventories(game) {
  const { gState, slots } = game;
  const publicCounts = {};
  for (let p = 1; p <= 4; p++) {
    publicCounts[p] = {
      totalCards: totalRes(gState, p),
      roads: gState.roads[p] || 0,
      settlements: gState.settlements[p] || 0,
      cities: gState.cities[p] || 0,
      playedKnights: gState.playedKnights[p] || 0,
      points: totalPts(gState, p),
    };
    const slot = slots[p - 1];
    if (slot && slot.connected && slot.socketId) {
      const sock = io.sockets.sockets.get(slot.socketId);
      if (sock) sock.emit('myInventory', gState.inventories[p]);
    }
  }
  emitToGame(game, 'publicCounts', publicCounts);
}

// ── Turn state snapshot ──
function turnSnapshot(gState) {
  const currentEntry = gState.setupQueue[gState.setupIndex];
  return {
    phase: gState.phase,
    activePlayer: gState.activePlayer,
    setupIndex: gState.setupIndex,
    setupOrder: gState.setupOrder,
    setupQueue: gState.setupQueue,
    setupActionExpected: currentEntry ? currentEntry.action : 'house',
    lastSetupHouseNodeIndex: gState.lastSetupHouseNodeIndex,
    hasRolled: gState.hasRolled,
    freeRoads: gState.freeRoads,
    isRobberPhase: gState.isRobberPhase,
    discardQueue: gState.discardQueue,
    devCardPlayedThisTurn: gState.devCardPlayedThisTurn,
    devCardBoughtThisTurn: gState.devCardBoughtThisTurn,
    devPurchased: gState.devPurchased,
    robberHexId: gState.robberHexId,
    settlements: gState.settlements,
    cities: gState.cities,
    roads: gState.roads,
    playedKnights: gState.playedKnights,
    basePoints: gState.basePoints,
    longestRoadHolder: gState.longestRoadHolder, longestRoadLength: gState.longestRoadLength,
    largestArmyHolder: gState.largestArmyHolder, largestArmySize: gState.largestArmySize,
  };
}

// ── Send full state to a reconnecting player ──
function sendFullState(game, socketId, playerNum) {
  const sock = io.sockets.sockets.get(socketId);
  if (!sock) return;
  const { gState } = game;
  sock.emit('fullState', {
    gameId: game.gameId,
    turn: turnSnapshot(gState),
    builds: gState.builds,
    blueprint: gState.blueprint,
    devDeck: gState.devDeck,
    numPlayers: gState.numPlayers,
    setupOrder: gState.setupOrder,
    myInventory: gState.inventories[playerNum] || freshInv(),
    lobbySlots: getLobbySnapshot(game).slots,
  });
}

// ── Auto-advance turn if active player is disconnected ──
function clearSkip(game) {
  if (game.gState.skipTimer) { clearTimeout(game.gState.skipTimer); game.gState.skipTimer = null; }
}

function scheduleSkip(game) {
  clearSkip(game);
  const { gState, slots } = game;
  if (gState.phase !== 'playing' && gState.phase !== 'setup') return;
  const slot = slots[gState.activePlayer - 1];
  if (slot && slot.connected) return;
  emitToGame(game, 'skipScheduled', { disconnectedPlayer: gState.activePlayer });
  gState.skipTimer = setTimeout(() => {
    const skipped = gState.activePlayer;
    emitToGame(game, 'systemMessage', `Player ${skipped} disconnected — skipping their turn.`);
    advanceTurn(game);
    emitToGame(game, 'turnSkipped', { skippedPlayer: skipped, newActivePlayer: gState.activePlayer });
  }, 25_000);
}

// ── Core turn advance (for PLAYING phase only) ──
function advanceTurn(game) {
  clearSkip(game);
  const { gState } = game;
  gState.hasRolled = false;
  gState.freeRoads = 0;
  gState.devCardPlayedThisTurn = false;
  gState.devCardBoughtThisTurn = null;
  gState.isRobberPhase = false;
  gState.discardQueue = [];
  gState.activePlayer = (gState.activePlayer % gState.numPlayers) + 1;
  emitToGame(game, 'turnState', turnSnapshot(gState));
  broadcastInventories(game);
  scheduleSkip(game);
}

// ── Advance setup phase after a road is placed ──
function advanceSetup(game) {
  clearSkip(game);
  const { gState } = game;
  gState.setupIndex++;
  if (gState.setupIndex >= gState.setupQueue.length) {
    // Setup done → start playing
    gState.phase = 'playing';
    gState.activePlayer = 1;
    gState.hasRolled = false;
    gState.lastSetupHouseNodeIndex = null;
  } else {
    const next = gState.setupQueue[gState.setupIndex];
    gState.activePlayer = next.player;
    // lastSetupHouseNodeIndex is cleared — it will be set when a house is placed
    if (next.action === 'house') gState.lastSetupHouseNodeIndex = null;
  }
  emitToGame(game, 'turnState', turnSnapshot(gState));
  broadcastInventories(game);
  scheduleSkip(game);
}

function checkWin(game, p) {
  const { gState } = game;
  if (totalPts(gState, p) >= 10 && gState.phase !== 'over') {
    gState.phase = 'over';
    emitToGame(game, 'gameOver', { player: p, points: totalPts(gState, p) });
  }
}
function checkLargestArmy(game, p) {
  const { gState } = game;
  const k = gState.playedKnights[p] || 0;
  if (k >= 3 && k > gState.largestArmySize) {
    const prev = gState.largestArmyHolder;
    gState.largestArmyHolder = p; gState.largestArmySize = k;
    emitToGame(game, 'largestArmyChanged', { newHolder: p, prevHolder: prev, knights: k });
    emitToGame(game, 'turnState', turnSnapshot(gState));
    checkWin(game, p);
  }
}

// ══════════════════════════════════════════════════════════
//  CONNECTIONS
// ══════════════════════════════════════════════════════════

io.on('connection', (socket) => {

  // ── JOIN / RECONNECT ──
  // Client sends: { token, gameId } — gameId is optional (for reconnect or joining specific game)
  socket.on('join', ({ token, gameId: requestedGameId } = {}) => {
    let game = null;
    let playerNum = null;
    let isReconnect = false;
    let assignedToken = token;

    // --- Try to reconnect with token (gameId required for reconnect) ---
    if (token && requestedGameId) {
      game = games.get(requestedGameId);
      if (game) {
        playerNum = findSlotByToken(game, token);
        if (playerNum) {
          game.slots[playerNum - 1].socketId = socket.id;
          game.slots[playerNum - 1].connected = true;
          isReconnect = true;
        }
      }
    }

    // --- New player joining ---
    if (!playerNum) {
      // If they specified a gameId, try to join that specific game
      if (requestedGameId) {
        game = games.get(requestedGameId);
        if (!game) {
          socket.emit('serverError', `Game ${requestedGameId} not found.`);
          return;
        }
        if (game.gState.phase !== 'lobby') {
          socket.emit('serverError', `Game ${requestedGameId} is already in progress.`);
          return;
        }
      } else {
        // Find an open lobby or create a new one
        game = findOpenGame();
        if (!game) {
          const newId = genGameId();
          game = createGame(newId);
        }
      }

      if (game.gState.phase !== 'lobby') {
        socket.emit('serverError', 'Game already in progress — no open slots.');
        return;
      }
      const result = assignNewSlot(game, socket.id);
      if (!result) {
        socket.emit('serverError', 'Lobby is full (4 players max).');
        return;
      }
      playerNum = result.playerNum;
      assignedToken = result.token;
    }

    // Join the socket.io room for this game
    socket.join(game.gameId);
    socketToGame.set(socket.id, game.gameId);

    socket.emit('slotAssigned', {
      playerNum,
      token: assignedToken,
      gameId: game.gameId,
      isReconnect,
      isHost: playerNum === 1
    });
    emitToGame(game, 'lobbyUpdate', getLobbySnapshot(game));

    if (isReconnect && game.gState.phase !== 'lobby') {
      sendFullState(game, socket.id, playerNum);
      clearSkip(game);
      // Brief delay to avoid race with the disconnect message on other clients
      setTimeout(() => {
        emitToGame(game, 'systemMessage', `Player ${playerNum} (${game.slots[playerNum-1]?.name}) reconnected!`);
      }, 300);
    }
  });

  // ── DISCONNECT ──
  socket.on('disconnect', () => {
    const game = getGameForSocket(socket.id);
    socketToGame.delete(socket.id);
    if (!game) return;

    const p = playerNumForSocket(game, socket.id);
    if (!p) return;
    game.slots[p - 1].connected = false;
    emitToGame(game, 'lobbyUpdate', getLobbySnapshot(game));

    if (game.gState.phase !== 'lobby') {
      // Only announce and schedule skip — do NOT immediately advance
      // This avoids the infinite loop when someone refreshes during setup
      emitToGame(game, 'systemMessage', `Player ${p} (${game.slots[p-1]?.name}) disconnected.`);
      if (game.gState.activePlayer === p) scheduleSkip(game);
    }

    // If everyone is gone, clean up after grace period
    setTimeout(() => {
      if (!game.slots.some(s => s && s.connected)) {
        clearSkip(game);
        if (game.tradeTimeout) clearTimeout(game.tradeTimeout);
        games.delete(game.gameId);
        console.log(`Game ${game.gameId}: all players disconnected — removed.`);
      }
    }, 60_000);
  });

  // ── LOBBY CONTROLS ──
  socket.on('setNumPlayers', (n) => {
    const game = getGameForSocket(socket.id);
    if (!game) return;
    if (playerNumForSocket(game, socket.id) !== 1 || game.gState.phase !== 'lobby') return;
    game.gState.numPlayers = Math.max(2, Math.min(4, parseInt(n) || 4));
    emitToGame(game, 'lobbyUpdate', getLobbySnapshot(game));
  });

  socket.on('setName', (name) => {
    const game = getGameForSocket(socket.id);
    if (!game) return;
    const p = playerNumForSocket(game, socket.id);
    if (!p) return;
    const clean = String(name || '').slice(0, 20).replace(/[<>&]/g, '').trim() || `Player ${p}`;
    game.slots[p - 1].name = clean;
    emitToGame(game, 'lobbyUpdate', getLobbySnapshot(game));
  });

  // ── HOST STARTS GAME ──
  socket.on('hostStartGame', (data) => {
    const game = getGameForSocket(socket.id);
    if (!game) return;
    const p = playerNumForSocket(game, socket.id);
    if (p !== 1 || game.gState.phase !== 'lobby') return;

    const { numPlayers, blueprint, deck } = data;

    // Reset game state but keep slot assignments
    const savedSlots = [...game.slots];
    game.gState = freshGState();
    game.slots = savedSlots;

    const { gState } = game;
    gState.numPlayers = numPlayers;
    gState.blueprint = blueprint;
    gState.devDeck = [...deck];
    gState.phase = 'setup';

    // Build snake-draft setup ORDER (for display)
    const order = [];
    for (let i = 1; i <= numPlayers; i++) order.push(i);
    for (let i = numPlayers; i >= 1; i--) order.push(i);
    gState.setupOrder = order;

    // Build explicit setup QUEUE: alternating house/road pairs
    // Forward: P1-house, P1-road, P2-house, P2-road, ...
    // Reverse: PN-house, PN-road, ..., P1-house, P1-road
    gState.setupQueue = [];
    for (let i = 1; i <= numPlayers; i++) {
      gState.setupQueue.push({ player: i, action: 'house' });
      gState.setupQueue.push({ player: i, action: 'road' });
    }
    for (let i = numPlayers; i >= 1; i--) {
      gState.setupQueue.push({ player: i, action: 'house' });
      gState.setupQueue.push({ player: i, action: 'road' });
    }

    gState.setupIndex = 0;
    gState.activePlayer = gState.setupQueue[0].player;
    gState.lastSetupHouseNodeIndex = null;

    const di = blueprint.findIndex(h => h.type === 'desert');
    gState.robberHexId = di !== -1 ? di : 0;

    emitToGame(game, 'gameStarted', {
      gameId: game.gameId,
      numPlayers,
      blueprint,
      deck,
      setupOrder: gState.setupOrder,
      setupQueue: gState.setupQueue,
      robberHexId: gState.robberHexId
    });
    emitToGame(game, 'turnState', turnSnapshot(gState));
    broadcastInventories(game);
    scheduleSkip(game);
  });

  // ══════════════════════════════════════════════════════
  //  ALL GAME ACTIONS — server is authority
  // ══════════════════════════════════════════════════════

  socket.on('gameAction', (data) => {
    const game = getGameForSocket(socket.id);
    if (!game) return;
    const p = playerNumForSocket(game, socket.id);
    if (!p) return;
    const { gState } = game;

    // ── ROLL DICE ──
    if (data.type === 'ROLL_DICE') {
      if (gState.activePlayer !== p || gState.hasRolled || gState.phase !== 'playing') return;
      const { die1, die2, distribution } = data;
      const total = (die1 || 1) + (die2 || 1);
      gState.hasRolled = true;

      if (total !== 7 && Array.isArray(distribution)) {
        distribution.forEach(({ player, resource, amount }) => {
          if (player >= 1 && player <= 4 && RESOURCES.includes(resource) && amount > 0) {
            gState.inventories[player][resource] = (gState.inventories[player][resource] || 0) + amount;
          }
        });
      }

      if (total === 7) {
        gState.discardQueue = [];
        for (let i = 1; i <= gState.numPlayers; i++) {
          if (totalRes(gState, i) > 7) gState.discardQueue.push(i);
        }
        gState.isRobberPhase = true;
      }

      emitToGame(game, 'gameAction', { type: 'ROLL_DICE', die1, die2, rollTotal: total, distribution: distribution || [] });
      emitToGame(game, 'turnState', turnSnapshot(gState));
      broadcastInventories(game);

      if (total === 7 && gState.discardQueue.length === 0) emitToGame(game, 'allDiscardsComplete');
      return;
    }

    // ── BUILD ──
    if (data.type === 'BUILD') {
      const { nodeIndex, nodeType, buildType, isFree } = data;
      const isSetup = gState.phase === 'setup';

      if (!isSetup && gState.phase !== 'playing') return;

      // ── Setup phase validation ──
      if (isSetup) {
        // Must be this player's turn
        if (gState.activePlayer !== p) return;
        // Must match the expected action for this step
        const currentEntry = gState.setupQueue[gState.setupIndex];
        if (!currentEntry || currentEntry.player !== p || currentEntry.action !== buildType) return;
        // Road must be adjacent to the house just placed this turn
        if (buildType === 'road') {
          // We trust the client sent a valid adjacent edge; server records the house node
          // for highlight validation. The actual adjacency check is done client-side.
          // (Full server-side geometry would require duplicating the hex layout math here.)
        }
      } else {
        // Normal play validation
        if (!isFree) {
          if (!canAfford(gState, p, buildType)) return;
          deduct(gState, p, buildType);
        }
      }

      const key = `${nodeType[0]}-${nodeIndex}`;
      gState.builds[key] = { buildType, player: p };

      if (buildType === 'house') {
        gState.settlements[p] = (gState.settlements[p] || 0) + 1;
        gState.basePoints[p] = (gState.basePoints[p] || 0) + 1;
        if (isSetup) {
          // Record the house node so the next road knows where to attach
          gState.lastSetupHouseNodeIndex = nodeIndex;
          // Advance to the road step (next entry in the queue is always the road for same player)
          advanceSetup(game);
        } else {
          emitToGame(game, 'gameAction', { type: 'BUILD', nodeIndex, nodeType, buildType, playerOwner: p, isFree });
          emitToGame(game, 'turnState', turnSnapshot(gState));
          broadcastInventories(game);
          checkWin(game, p);
        }
        return;
      }

      if (buildType === 'city') {
        gState.settlements[p] = Math.max(0, (gState.settlements[p] || 0) - 1);
        gState.cities[p] = (gState.cities[p] || 0) + 1;
        gState.basePoints[p] = (gState.basePoints[p] || 0) + 1;
        emitToGame(game, 'gameAction', { type: 'BUILD', nodeIndex, nodeType, buildType, playerOwner: p, isFree });
        emitToGame(game, 'turnState', turnSnapshot(gState));
        broadcastInventories(game);
        checkWin(game, p);
        return;
      }

      if (buildType === 'road') {
        gState.roads[p] = (gState.roads[p] || 0) + 1;
        if (!isSetup && isFree && gState.freeRoads > 0) gState.freeRoads--;

        if (isSetup) {
          // Emit the build BEFORE advancing so clients can render the road
          emitToGame(game, 'gameAction', { type: 'BUILD', nodeIndex, nodeType, buildType, playerOwner: p, isFree: true });
          // Grant second-round resources (handled separately by client SETUP_GRANT)
          // Advance setup: this completes one full house+road pair
          advanceSetup(game);
        } else {
          emitToGame(game, 'gameAction', { type: 'BUILD', nodeIndex, nodeType, buildType, playerOwner: p, isFree });
          emitToGame(game, 'turnState', turnSnapshot(gState));
          broadcastInventories(game);
          checkWin(game, p);
        }
        return;
      }

      // Fallback emit for anything else
      emitToGame(game, 'gameAction', { type: 'BUILD', nodeIndex, nodeType, buildType, playerOwner: p, isFree });
      emitToGame(game, 'turnState', turnSnapshot(gState));
      broadcastInventories(game);
      checkWin(game, p);
      return;
    }

    // ── SETUP GRANT (second-round setup starting resources) ──
    if (data.type === 'SETUP_GRANT') {
      if (Array.isArray(data.resources)) {
        data.resources.forEach(({ resource, amount }) => {
          if (RESOURCES.includes(resource) && amount > 0)
            gState.inventories[p][resource] = (gState.inventories[p][resource] || 0) + amount;
        });
        broadcastInventories(game);
      }
      return;
    }

    // ── END TURN ──
    if (data.type === 'END_TURN') {
      if (gState.phase !== 'playing' || gState.activePlayer !== p) return;
      if (!gState.hasRolled || gState.isRobberPhase || gState.freeRoads > 0) return;
      advanceTurn(game);
      emitToGame(game, 'gameAction', { type: 'END_TURN' });
      return;
    }

    // ── BUY DEV CARD ──
    if (data.type === 'BUY_DEV') {
      if (gState.phase !== 'playing' || gState.activePlayer !== p || !gState.hasRolled) return;
      if (!canAfford(gState, p, 'devCard') || gState.devDeck.length === 0) return;
      deduct(gState, p, 'devCard');
      const drawn = gState.devDeck.pop();
      gState.devPurchased++;
      gState.devCardBoughtThisTurn = drawn;
      gState.inventories[p][drawn === 'vp' ? 'vp' : drawn] = (gState.inventories[p][drawn] || 0) + 1;
      if (drawn === 'vp') {
        gState.basePoints[p] = (gState.basePoints[p] || 0) + 1;
        emitToGame(game, 'gameAction', { type: 'AWARD_VP', playerOwner: p });
        checkWin(game, p);
      }
      // Tell only the buyer what they drew
      const buyerSock = io.sockets.sockets.get(game.slots[p-1]?.socketId);
      if (buyerSock) buyerSock.emit('devCardDrawn', { cardType: drawn });
      emitToGame(game, 'gameAction', { type: 'BUY_DEV', playerOwner: p });
      emitToGame(game, 'turnState', turnSnapshot(gState));
      broadcastInventories(game);
      return;
    }

    // ── PLAY KNIGHT ──
    if (data.type === 'PLAY_KNIGHT') {
      if (gState.activePlayer !== p || gState.isRobberPhase) return;
      const inv = gState.inventories[p];
      if ((inv.knight || 0) <= 0 || gState.devCardPlayedThisTurn) return;
      if (gState.devCardBoughtThisTurn === 'knight' && (inv.knight || 0) <= 1) return;
      inv.knight = Math.max(0, (inv.knight || 0) - 1);
      gState.devCardPlayedThisTurn = true;
      gState.playedKnights[p] = (gState.playedKnights[p] || 0) + 1;
      gState.isRobberPhase = true;
      gState.discardQueue = [];
      emitToGame(game, 'gameAction', { type: 'PLAY_KNIGHT', playerOwner: p });
      emitToGame(game, 'turnState', turnSnapshot(gState));
      broadcastInventories(game);
      checkLargestArmy(game, p);
      return;
    }

    // ── PLAY ROAD BUILDING ──
    if (data.type === 'PLAY_ROAD') {
      if (gState.phase !== 'playing' || gState.activePlayer !== p || !gState.hasRolled) return;
      const inv = gState.inventories[p];
      if ((inv.road_building || 0) <= 0 || gState.devCardPlayedThisTurn) return;
      if (gState.devCardBoughtThisTurn === 'road_building' && (inv.road_building || 0) <= 1) return;
      inv.road_building = Math.max(0, (inv.road_building || 0) - 1);
      gState.devCardPlayedThisTurn = true;
      gState.freeRoads = 2;
      emitToGame(game, 'gameAction', { type: 'PLAY_ROAD', playerOwner: p });
      emitToGame(game, 'turnState', turnSnapshot(gState));
      broadcastInventories(game);
      return;
    }

    // ── PLAY YEAR OF PLENTY ──
    if (data.type === 'PLAY_YOP') {
      if (gState.phase !== 'playing' || gState.activePlayer !== p || !gState.hasRolled) return;
      const inv = gState.inventories[p];
      if ((inv.yop || 0) <= 0 || gState.devCardPlayedThisTurn) return;
      if (gState.devCardBoughtThisTurn === 'yop' && (inv.yop || 0) <= 1) return;
      const { res1, res2 } = data;
      if (!RESOURCES.includes(res1) || !RESOURCES.includes(res2)) return;
      inv.yop = Math.max(0, (inv.yop || 0) - 1);
      inv[res1] = (inv[res1] || 0) + 1;
      inv[res2] = (inv[res2] || 0) + 1;
      gState.devCardPlayedThisTurn = true;
      emitToGame(game, 'gameAction', { type: 'PLAY_YOP', playerOwner: p, res1, res2 });
      emitToGame(game, 'turnState', turnSnapshot(gState));
      broadcastInventories(game);
      return;
    }

    // ── PLAY MONOPOLY ──
    if (data.type === 'PLAY_MONOPOLY') {
      if (gState.phase !== 'playing' || gState.activePlayer !== p || !gState.hasRolled) return;
      const inv = gState.inventories[p];
      if ((inv.monopoly || 0) <= 0 || gState.devCardPlayedThisTurn) return;
      if (gState.devCardBoughtThisTurn === 'monopoly' && (inv.monopoly || 0) <= 1) return;
      const { resource } = data;
      if (!RESOURCES.includes(resource)) return;
      inv.monopoly = Math.max(0, (inv.monopoly || 0) - 1);
      gState.devCardPlayedThisTurn = true;
      const yields = [];
      for (let i = 1; i <= gState.numPlayers; i++) {
        if (i === p) continue;
        const amt = gState.inventories[i][resource] || 0;
        if (amt > 0) {
          gState.inventories[i][resource] = 0;
          inv[resource] = (inv[resource] || 0) + amt;
          yields.push({ victim: i, amount: amt });
        }
      }
      emitToGame(game, 'gameAction', { type: 'PLAY_MONOPOLY', playerOwner: p, resource, yields });
      emitToGame(game, 'turnState', turnSnapshot(gState));
      broadcastInventories(game);
      return;
    }

    // ── ROBBER MOVE & STEAL ──
    if (data.type === 'MOVE_ROBBER_AND_STEAL') {
      if (!gState.isRobberPhase || gState.activePlayer !== p) return;
      if (gState.discardQueue.length > 0) return;
      const { hexId, victim } = data;
      gState.robberHexId = hexId;
      emitToGame(game, 'gameAction', { type: 'MOVE_ROBBER', hexId });

      let stealMsg = 'Robber placed.';
      if (victim && gState.inventories[victim]) {
        const pool = [];
        RESOURCES.forEach(r => {
          for (let i = 0; i < (gState.inventories[victim][r] || 0); i++) pool.push(r);
        });
        if (pool.length > 0) {
          const stolen = pool[Math.floor(Math.random() * pool.length)];
          gState.inventories[victim][stolen] = Math.max(0, (gState.inventories[victim][stolen] || 0) - 1);
          gState.inventories[p][stolen] = (gState.inventories[p][stolen] || 0) + 1;
          emitToGame(game, 'gameAction', { type: 'STEAL', stealer: p, victim, resource: stolen });
          stealMsg = `Player ${p} stole 1 ${stolen} from Player ${victim}!`;
        } else {
          stealMsg = `Player ${victim} had nothing to steal.`;
        }
      }
      gState.isRobberPhase = false;
      gState.discardQueue = [];
      emitToGame(game, 'gameAction', { type: 'END_ROBBER_PHASE', msg: stealMsg });
      emitToGame(game, 'turnState', turnSnapshot(gState));
      broadcastInventories(game);
      return;
    }

    // ── BANK TRADE ──
    if (data.type === 'BANK_TRADE') {
      if (gState.phase !== 'playing' || gState.activePlayer !== p || !gState.hasRolled) return;
      const { give, giveAmt, receive } = data;
      const inv = gState.inventories[p];
      if (!RESOURCES.includes(give) || !RESOURCES.includes(receive)) return;
      if ((inv[give] || 0) < giveAmt) return;
      inv[give] = Math.max(0, (inv[give] || 0) - giveAmt);
      inv[receive] = (inv[receive] || 0) + 1;
      emitToGame(game, 'gameAction', { type: 'BANK_TRADE', player: p, give, giveAmt, receive });
      broadcastInventories(game);
      return;
    }

    // ── DISCARD ──
    if (data.type === 'DISCARD_CARDS') {
      if (!gState.discardQueue.includes(p)) return;
      const { discards } = data;
      const inv = gState.inventories[p];
      Object.entries(discards || {}).forEach(([r, a]) => {
        if (RESOURCES.includes(r)) inv[r] = Math.max(0, (inv[r] || 0) - a);
      });
      gState.discardQueue = gState.discardQueue.filter(x => x !== p);
      emitToGame(game, 'gameAction', { type: 'DISCARD_CARDS', player: p, discards });
      broadcastInventories(game);
      if (gState.discardQueue.length === 0) emitToGame(game, 'allDiscardsComplete');
      emitToGame(game, 'turnState', turnSnapshot(gState));
      return;
    }

    // ── LONGEST ROAD CLAIM ──
    if (data.type === 'CLAIM_LONGEST_ROAD') {
      const { length } = data;
      if (length >= 5 && length > gState.longestRoadLength) {
        const prev = gState.longestRoadHolder;
        gState.longestRoadHolder = p;
        gState.longestRoadLength = length;
        emitToGame(game, 'longestRoadChanged', { newHolder: p, prevHolder: prev, length });
        emitToGame(game, 'turnState', turnSnapshot(gState));
        checkWin(game, p);
      }
      return;
    }
  });

  // ── TRADES ──
  socket.on('offerTrade', (td) => {
    const game = getGameForSocket(socket.id);
    if (!game) return;
    const p = playerNumForSocket(game, socket.id);
    if (!p || p !== game.gState.activePlayer || game.gState.phase !== 'playing') return;
    game.gState.activeTrade = { ...td, offerer: p, id: Date.now() };
    socket.to(game.gameId).emit('tradeOffered', game.gState.activeTrade);
    if (game.tradeTimeout) clearTimeout(game.tradeTimeout);
    game.tradeTimeout = setTimeout(() => {
      if (game.gState.activeTrade) {
        emitToGame(game, 'tradeTimeout', game.gState.activeTrade.id);
        game.gState.activeTrade = null;
      }
    }, 20_000);
  });

  socket.on('acceptTrade', (tradeId, acceptorId) => {
    const game = getGameForSocket(socket.id);
    if (!game) return;
    const { gState } = game;
    if (!gState.activeTrade || gState.activeTrade.id !== tradeId) return;
    const { offerer, giveRes, giveAmt = 1, recRes, recAmt = 1 } = gState.activeTrade;
    const oInv = gState.inventories[offerer];
    const aInv = gState.inventories[acceptorId];
    if (!oInv || !aInv) return;
    if ((oInv[giveRes] || 0) < giveAmt || (aInv[recRes] || 0) < recAmt) return;
    oInv[giveRes] = Math.max(0, (oInv[giveRes] || 0) - giveAmt);
    oInv[recRes]  = (oInv[recRes] || 0) + recAmt;
    aInv[giveRes] = (aInv[giveRes] || 0) + giveAmt;
    aInv[recRes]  = Math.max(0, (aInv[recRes] || 0) - recAmt);
    if (game.tradeTimeout) clearTimeout(game.tradeTimeout);
    gState.activeTrade = null;
    emitToGame(game, 'tradeExecuted', { offerer, acceptor: acceptorId, giveRes, giveAmt, recRes, recAmt });
    broadcastInventories(game);
  });

  socket.on('cancelTrade', () => {
    const game = getGameForSocket(socket.id);
    if (!game || !game.gState.activeTrade) return;
    if (game.tradeTimeout) clearTimeout(game.tradeTimeout);
    emitToGame(game, 'tradeCancelled', game.gState.activeTrade.id);
    game.gState.activeTrade = null;
  });

  // ── CHAT ──
  socket.on('chatMessage', ({ msg } = {}) => {
    const game = getGameForSocket(socket.id);
    if (!game) return;
    const p = playerNumForSocket(game, socket.id);
    if (!p) return;
    const safe = String(msg || '').slice(0, 120).replace(/</g,'&lt;').replace(/>/g,'&gt;');
    if (!safe) return;
    emitToGame(game, 'chatMessage', { player: p, name: game.slots[p-1]?.name || `P${p}`, msg: safe });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Catan server listening on port ${PORT}`));
