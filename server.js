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
//  SLOT MANAGEMENT
//  4 persistent player slots. Players reconnect via token.
// ══════════════════════════════════════════════════════════

let slots = [null, null, null, null]; // index 0 = Player 1
const tokenToSlot = new Map();        // sessionToken → playerNum (1-based)

function genToken() { return crypto.randomBytes(16).toString('hex'); }

function findSlotByToken(token) {
  const p = tokenToSlot.get(token);
  return (p && slots[p - 1]) ? p : null;
}

function assignNewSlot(socketId) {
  const idx = slots.findIndex(s => s === null);
  if (idx === -1) return null;
  const token = genToken();
  const p = idx + 1;
  slots[idx] = { token, socketId, name: `Player ${p}`, connected: true };
  tokenToSlot.set(token, p);
  return { playerNum: p, token };
}

function playerNumForSocket(socketId) {
  const idx = slots.findIndex(s => s && s.socketId === socketId);
  return idx === -1 ? null : idx + 1;
}

function getLobbySnapshot() {
  return {
    phase: gState.phase,
    numPlayers: gState.numPlayers,
    slots: slots.map((s, i) => s ? { playerNum: i+1, name: s.name, connected: s.connected } : null)
  };
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
    setupOrder: [], setupIndex: 0,
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
  };
}

let gState = freshGState();

function totalRes(p) {
  const inv = gState.inventories[p];
  if (!inv) return 0;
  return RESOURCES.reduce((s, r) => s + (inv[r] || 0), 0);
}
function totalPts(p) {
  let pts = gState.basePoints[p] || 0;
  if (gState.longestRoadHolder === p) pts += 2;
  if (gState.largestArmyHolder === p) pts += 2;
  return pts;
}
function canAfford(p, item) {
  const inv = gState.inventories[p]; const cost = COSTS[item];
  if (!inv || !cost) return false;
  return Object.entries(cost).every(([r, a]) => (inv[r] || 0) >= a);
}
function deduct(p, item) {
  const inv = gState.inventories[p]; const cost = COSTS[item];
  if (!inv || !cost) return;
  Object.entries(cost).forEach(([r, a]) => { inv[r] = Math.max(0, (inv[r] || 0) - a); });
}

// ── Broadcast authoritative inventories ──
// Each player gets their own full inventory privately.
// Everyone gets public counts (totals + piece counts for UI).
function broadcastInventories() {
  const publicCounts = {};
  for (let p = 1; p <= 4; p++) {
    publicCounts[p] = {
      totalCards: totalRes(p),
      roads: gState.roads[p] || 0,
      settlements: gState.settlements[p] || 0,
      cities: gState.cities[p] || 0,
      playedKnights: gState.playedKnights[p] || 0,
      points: totalPts(p),
    };
    // Private full inventory to the actual player
    const slot = slots[p - 1];
    if (slot && slot.connected && slot.socketId) {
      const sock = io.sockets.sockets.get(slot.socketId);
      if (sock) sock.emit('myInventory', gState.inventories[p]);
    }
  }
  io.emit('publicCounts', publicCounts);
}

// ── Turn state snapshot (sent to everyone) ──
function turnSnapshot() {
  return {
    phase: gState.phase,
    activePlayer: gState.activePlayer,
    setupIndex: gState.setupIndex,
    setupOrder: gState.setupOrder,
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
function sendFullState(socketId, playerNum) {
  const sock = io.sockets.sockets.get(socketId);
  if (!sock) return;
  sock.emit('fullState', {
    turn: turnSnapshot(),
    builds: gState.builds,
    blueprint: gState.blueprint,
    devDeck: gState.devDeck,
    numPlayers: gState.numPlayers,
    setupOrder: gState.setupOrder,
    myInventory: gState.inventories[playerNum] || freshInv(),
    lobbySlots: getLobbySnapshot().slots,
  });
}

// ── Auto-advance turn if active player is disconnected ──
function clearSkip() {
  if (gState.skipTimer) { clearTimeout(gState.skipTimer); gState.skipTimer = null; }
}
function scheduleSkip() {
  clearSkip();
  if (gState.phase !== 'playing' && gState.phase !== 'setup') return;
  const slot = slots[gState.activePlayer - 1];
  if (slot && slot.connected) return;
  gState.skipTimer = setTimeout(() => {
    io.emit('systemMessage', `Player ${gState.activePlayer} disconnected — skipping their turn.`);
    advanceTurn();
  }, 25_000);
}

// ── Core turn advance ──
function advanceTurn() {
  clearSkip();
  gState.hasRolled = false;
  gState.freeRoads = 0;
  gState.devCardPlayedThisTurn = false;
  gState.devCardBoughtThisTurn = null;
  gState.isRobberPhase = false;
  gState.discardQueue = [];
  gState.activePlayer = (gState.activePlayer % gState.numPlayers) + 1;
  io.emit('turnState', turnSnapshot());
  broadcastInventories();
  scheduleSkip();
}

function checkWin(p) {
  if (totalPts(p) >= 10 && gState.phase !== 'over') {
    gState.phase = 'over';
    io.emit('gameOver', { player: p, points: totalPts(p) });
  }
}
function checkLargestArmy(p) {
  const k = gState.playedKnights[p] || 0;
  if (k >= 3 && k > gState.largestArmySize) {
    const prev = gState.largestArmyHolder;
    gState.largestArmyHolder = p; gState.largestArmySize = k;
    io.emit('largestArmyChanged', { newHolder: p, prevHolder: prev, knights: k });
    io.emit('turnState', turnSnapshot());
    checkWin(p);
  }
}

let tradeTimeout = null;

// ══════════════════════════════════════════════════════════
//  CONNECTIONS
// ══════════════════════════════════════════════════════════

io.on('connection', (socket) => {

  // ── JOIN / RECONNECT ──
  socket.on('join', ({ token } = {}) => {
    let playerNum = null;
    let isReconnect = false;
    let assignedToken = token;

    // Try reconnect with token
    if (token) {
      playerNum = findSlotByToken(token);
      if (playerNum) {
        slots[playerNum - 1].socketId = socket.id;
        slots[playerNum - 1].connected = true;
        isReconnect = true;
      }
    }

    // New player
    if (!playerNum) {
      if (gState.phase !== 'lobby') {
        socket.emit('serverError', 'Game already in progress — no open slots.');
        return;
      }
      const result = assignNewSlot(socket.id);
      if (!result) {
        socket.emit('serverError', 'Lobby is full (4 players max).');
        return;
      }
      playerNum = result.playerNum;
      assignedToken = result.token;
    }

    socket.emit('slotAssigned', { playerNum, token: assignedToken, isReconnect, isHost: playerNum === 1 });
    io.emit('lobbyUpdate', getLobbySnapshot());

    if (isReconnect && gState.phase !== 'lobby') {
      sendFullState(socket.id, playerNum);
      clearSkip();
      io.emit('systemMessage', `Player ${playerNum} (${slots[playerNum-1]?.name}) reconnected!`);
    }
  });

  // ── DISCONNECT ──
  socket.on('disconnect', () => {
    const p = playerNumForSocket(socket.id);
    if (!p) return;
    slots[p - 1].connected = false;
    io.emit('lobbyUpdate', getLobbySnapshot());

    if (gState.phase !== 'lobby') {
      io.emit('systemMessage', `Player ${p} (${slots[p-1]?.name}) disconnected.`);
      if (gState.activePlayer === p) scheduleSkip();
    }

    // If everyone is gone, reset after grace period
    setTimeout(() => {
      if (!slots.some(s => s && s.connected)) {
        slots = [null, null, null, null];
        tokenToSlot.clear();
        gState = freshGState();
        console.log('All players disconnected — server reset.');
      }
    }, 60_000);
  });

  // ── LOBBY CONTROLS ──
  socket.on('setNumPlayers', (n) => {
    if (playerNumForSocket(socket.id) !== 1 || gState.phase !== 'lobby') return;
    gState.numPlayers = Math.max(2, Math.min(4, parseInt(n) || 4));
    io.emit('lobbyUpdate', getLobbySnapshot());
  });

  socket.on('setName', (name) => {
    const p = playerNumForSocket(socket.id);
    if (!p) return;
    const clean = String(name || '').slice(0, 20).replace(/[<>&]/g, '').trim() || `Player ${p}`;
    slots[p - 1].name = clean;
    io.emit('lobbyUpdate', getLobbySnapshot());
  });

  // ── HOST STARTS GAME ──
  socket.on('hostStartGame', (data) => {
    const p = playerNumForSocket(socket.id);
    if (p !== 1 || gState.phase !== 'lobby') return;

    const { numPlayers, blueprint, deck } = data;

    // Reset game state but keep slot assignments
    const savedSlots = [...slots];
    gState = freshGState();
    slots = savedSlots;

    gState.numPlayers = numPlayers;
    gState.blueprint = blueprint;
    gState.devDeck = [...deck];
    gState.phase = 'setup';

    // Snake-draft setup order
    gState.setupOrder = [];
    for (let i = 1; i <= numPlayers; i++) gState.setupOrder.push(i);
    for (let i = numPlayers; i >= 1; i--) gState.setupOrder.push(i);
    gState.setupIndex = 0;
    gState.activePlayer = gState.setupOrder[0];

    const di = blueprint.findIndex(h => h.type === 'desert');
    gState.robberHexId = di !== -1 ? di : 0;

    io.emit('gameStarted', { numPlayers, blueprint, deck, setupOrder: gState.setupOrder, robberHexId: gState.robberHexId });
    io.emit('turnState', turnSnapshot());
    broadcastInventories();
    scheduleSkip();
  });

  // ══════════════════════════════════════════════════════
  //  ALL GAME ACTIONS — server is authority
  // ══════════════════════════════════════════════════════

  socket.on('gameAction', (data) => {
    const p = playerNumForSocket(socket.id);
    if (!p) return;

    // ── ROLL DICE ──
    if (data.type === 'ROLL_DICE') {
      if (gState.activePlayer !== p || gState.hasRolled || gState.phase !== 'playing') return;
      const { die1, die2, distribution } = data;
      const total = (die1 || 1) + (die2 || 1);
      gState.hasRolled = true;

      // CORE FIX: Apply resource distribution to server inventory.
      // Client sends [{player, resource, amount}] computed from board geometry.
      if (total !== 7 && Array.isArray(distribution)) {
        distribution.forEach(({ player, resource, amount }) => {
          if (player >= 1 && player <= 4 && RESOURCES.includes(resource) && amount > 0) {
            gState.inventories[player][resource] = (gState.inventories[player][resource] || 0) + amount;
          }
        });
      }

      // 7 → discard queue
      if (total === 7) {
        gState.discardQueue = [];
        for (let i = 1; i <= gState.numPlayers; i++) {
          if (totalRes(i) > 7) gState.discardQueue.push(i);
        }
        gState.isRobberPhase = true;
      }

      io.emit('gameAction', { type: 'ROLL_DICE', die1, die2, rollTotal: total, distribution: distribution || [] });
      io.emit('turnState', turnSnapshot());
      broadcastInventories();

      if (total === 7 && gState.discardQueue.length === 0) io.emit('allDiscardsComplete');
      return;
    }

    // ── BUILD ──
    if (data.type === 'BUILD') {
      const { nodeIndex, nodeType, buildType, isFree } = data;
      const isSetup = gState.phase === 'setup';

      if (!isSetup && gState.phase !== 'playing') return;
      if (!isSetup && !isFree) {
        if (!canAfford(p, buildType)) return;
        deduct(p, buildType);
      }

      const key = `${nodeType[0]}-${nodeIndex}`;
      gState.builds[key] = { buildType, player: p };

      if (buildType === 'house') {
        gState.settlements[p] = (gState.settlements[p] || 0) + 1;
        gState.basePoints[p] = (gState.basePoints[p] || 0) + 1;
      } else if (buildType === 'city') {
        gState.settlements[p] = Math.max(0, (gState.settlements[p] || 0) - 1);
        gState.cities[p] = (gState.cities[p] || 0) + 1;
        gState.basePoints[p] = (gState.basePoints[p] || 0) + 1;
      } else if (buildType === 'road') {
        gState.roads[p] = (gState.roads[p] || 0) + 1;
        if (isFree && gState.freeRoads > 0) gState.freeRoads--;
      }

      // Advance setup phase after a road is placed
      if (isSetup && buildType === 'road') {
        gState.setupIndex++;
        if (gState.setupIndex >= gState.setupOrder.length) {
          gState.phase = 'playing';
          gState.activePlayer = 1;
          gState.hasRolled = false;
        } else {
          gState.activePlayer = gState.setupOrder[gState.setupIndex];
        }
        io.emit('gameAction', { type: 'BUILD', nodeIndex, nodeType, buildType, playerOwner: p, isFree });
        io.emit('turnState', turnSnapshot());
        broadcastInventories();
        scheduleSkip();
        return;
      }

      io.emit('gameAction', { type: 'BUILD', nodeIndex, nodeType, buildType, playerOwner: p, isFree });
      io.emit('turnState', turnSnapshot());
      broadcastInventories();
      checkWin(p);
      return;
    }

    // ── SETUP GRANT (second-round setup starting resources) ──
    if (data.type === 'SETUP_GRANT') {
      if (Array.isArray(data.resources)) {
        data.resources.forEach(({ resource, amount }) => {
          if (RESOURCES.includes(resource) && amount > 0)
            gState.inventories[p][resource] = (gState.inventories[p][resource] || 0) + amount;
        });
        broadcastInventories();
      }
      return;
    }

    // ── END TURN ──
    if (data.type === 'END_TURN') {
      if (gState.phase !== 'playing' || gState.activePlayer !== p) return;
      if (!gState.hasRolled || gState.isRobberPhase || gState.freeRoads > 0) return;
      advanceTurn();
      io.emit('gameAction', { type: 'END_TURN' });
      return;
    }

    // ── BUY DEV CARD ──
    if (data.type === 'BUY_DEV') {
      if (gState.phase !== 'playing' || gState.activePlayer !== p || !gState.hasRolled) return;
      if (!canAfford(p, 'devCard') || gState.devDeck.length === 0) return;
      deduct(p, 'devCard');
      const drawn = gState.devDeck.pop();
      gState.devPurchased++;
      gState.devCardBoughtThisTurn = drawn;
      gState.inventories[p][drawn === 'vp' ? 'vp' : drawn] = (gState.inventories[p][drawn] || 0) + 1;
      if (drawn === 'vp') {
        gState.basePoints[p] = (gState.basePoints[p] || 0) + 1;
        io.emit('gameAction', { type: 'AWARD_VP', playerOwner: p });
        checkWin(p);
      }
      // Tell only the buyer what they drew
      socket.emit('devCardDrawn', { cardType: drawn });
      io.emit('gameAction', { type: 'BUY_DEV', playerOwner: p });
      io.emit('turnState', turnSnapshot());
      broadcastInventories();
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
      io.emit('gameAction', { type: 'PLAY_KNIGHT', playerOwner: p });
      io.emit('turnState', turnSnapshot());
      broadcastInventories();
      checkLargestArmy(p);
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
      io.emit('gameAction', { type: 'PLAY_ROAD', playerOwner: p });
      io.emit('turnState', turnSnapshot());
      broadcastInventories();
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
      io.emit('gameAction', { type: 'PLAY_YOP', playerOwner: p, res1, res2 });
      io.emit('turnState', turnSnapshot());
      broadcastInventories();
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
      io.emit('gameAction', { type: 'PLAY_MONOPOLY', playerOwner: p, resource, yields });
      io.emit('turnState', turnSnapshot());
      broadcastInventories();
      return;
    }

    // ── ROBBER MOVE & STEAL ──
    if (data.type === 'MOVE_ROBBER_AND_STEAL') {
      if (!gState.isRobberPhase || gState.activePlayer !== p) return;
      if (gState.discardQueue.length > 0) return;
      const { hexId, victim } = data;
      gState.robberHexId = hexId;
      io.emit('gameAction', { type: 'MOVE_ROBBER', hexId });

      let stealMsg = 'Robber placed.';
      if (victim && gState.inventories[victim]) {
        // Build pool from SERVER inventory — correct because distributions are applied at roll time
        const pool = [];
        RESOURCES.forEach(r => {
          for (let i = 0; i < (gState.inventories[victim][r] || 0); i++) pool.push(r);
        });
        if (pool.length > 0) {
          const stolen = pool[Math.floor(Math.random() * pool.length)];
          gState.inventories[victim][stolen] = Math.max(0, (gState.inventories[victim][stolen] || 0) - 1);
          gState.inventories[p][stolen] = (gState.inventories[p][stolen] || 0) + 1;
          io.emit('gameAction', { type: 'STEAL', stealer: p, victim, resource: stolen });
          stealMsg = `Player ${p} stole 1 ${stolen} from Player ${victim}!`;
        } else {
          stealMsg = `Player ${victim} had nothing to steal.`;
        }
      }
      gState.isRobberPhase = false;
      gState.discardQueue = [];
      io.emit('gameAction', { type: 'END_ROBBER_PHASE', msg: stealMsg });
      io.emit('turnState', turnSnapshot());
      broadcastInventories();
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
      io.emit('gameAction', { type: 'BANK_TRADE', player: p, give, giveAmt, receive });
      broadcastInventories();
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
      io.emit('gameAction', { type: 'DISCARD_CARDS', player: p, discards });
      broadcastInventories();
      if (gState.discardQueue.length === 0) io.emit('allDiscardsComplete');
      io.emit('turnState', turnSnapshot());
      return;
    }

    // ── LONGEST ROAD CLAIM ──
    if (data.type === 'CLAIM_LONGEST_ROAD') {
      const { length } = data;
      if (length >= 5 && length > gState.longestRoadLength) {
        const prev = gState.longestRoadHolder;
        gState.longestRoadHolder = p;
        gState.longestRoadLength = length;
        io.emit('longestRoadChanged', { newHolder: p, prevHolder: prev, length });
        io.emit('turnState', turnSnapshot());
        checkWin(p);
      }
      return;
    }
  });

  // ── TRADES ──
  socket.on('offerTrade', (td) => {
    const p = playerNumForSocket(socket.id);
    if (p !== gState.activePlayer || gState.phase !== 'playing') return;
    gState.activeTrade = { ...td, offerer: p, id: Date.now() };
    socket.broadcast.emit('tradeOffered', gState.activeTrade);
    if (tradeTimeout) clearTimeout(tradeTimeout);
    tradeTimeout = setTimeout(() => {
      if (gState.activeTrade) { io.emit('tradeTimeout', gState.activeTrade.id); gState.activeTrade = null; }
    }, 20_000);
  });

  socket.on('acceptTrade', (tradeId, acceptorId) => {
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
    if (tradeTimeout) clearTimeout(tradeTimeout);
    gState.activeTrade = null;
    io.emit('tradeExecuted', { offerer, acceptor: acceptorId, giveRes, giveAmt, recRes, recAmt });
    broadcastInventories();
  });

  socket.on('cancelTrade', () => {
    if (!gState.activeTrade) return;
    if (tradeTimeout) clearTimeout(tradeTimeout);
    io.emit('tradeCancelled', gState.activeTrade.id);
    gState.activeTrade = null;
  });

  // ── CHAT ──
  socket.on('chatMessage', ({ msg } = {}) => {
    const p = playerNumForSocket(socket.id);
    if (!p) return;
    const safe = String(msg || '').slice(0, 120).replace(/</g,'&lt;').replace(/>/g,'&gt;');
    if (!safe) return;
    io.emit('chatMessage', { player: p, name: slots[p-1]?.name || `P${p}`, msg: safe });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Catan server listening on port ${PORT}`));
