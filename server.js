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
let activeTrade = null; // Tracks the current trade offer
let tradeTimeout = null;

io.on('connection', (socket) => {
    connectedPlayers++;
    const playerNumber = connectedPlayers;
    socket.emit('assignPlayer', playerNumber);

    if (currentBoardState) socket.emit('syncBoard', currentBoardState);

    socket.on('initBoard', (data) => {
        currentBoardState = data;
        socket.broadcast.emit('syncBoard', data); 
    });

    socket.on('gameAction', (data) => {
        // Relay standard actions
        socket.broadcast.emit('gameAction', data); 
    });

    // --- NEW: TRADE NEGOTIATION SYSTEM ---
    socket.on('offerTrade', (tradeData) => {
        // tradeData: { offerer, giveRes, giveAmt, recRes, recAmt, id }
        activeTrade = tradeData;
        socket.broadcast.emit('tradeOffered', activeTrade);
        
        // 15-second timeout
        if(tradeTimeout) clearTimeout(tradeTimeout);
        tradeTimeout = setTimeout(() => {
            if (activeTrade && activeTrade.id === tradeData.id) {
                io.emit('tradeTimeout', activeTrade.id);
                activeTrade = null;
            }
        }, 15000);
    });

    socket.on('acceptTrade', (tradeId, acceptorId) => {
        if (activeTrade && activeTrade.id === tradeId) {
            clearTimeout(tradeTimeout);
            // Broadcast the successful trade to everyone
            io.emit('tradeExecuted', { 
                offerer: activeTrade.offerer, 
                acceptor: acceptorId, 
                giveRes: activeTrade.giveRes, 
                recRes: activeTrade.recRes 
            });
            activeTrade = null;
        }
    });

    // --- NEW: MONOPOLY SYSTEM ---
    socket.on('playMonopoly', (data) => {
        // Ask all other players to report how much of the resource they have
        socket.broadcast.emit('monopolyDemand', data);
    });

    socket.on('monopolyYield', (data) => {
        // Route the stolen resources back to the caster
        io.emit('monopolyCollect', data);
    });

    socket.on('disconnect', () => {
        connectedPlayers--;
        if (connectedPlayers <= 0) { connectedPlayers = 0; currentBoardState = null; activeTrade = null; }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`Backend listening on port ${PORT}`); });
