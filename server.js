const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

// Health check route
app.get('/', (req, res) => {
    res.send('Catan Backend is Live and Running!');
});

const io = new Server(server, {
  cors: {
    origin: ["https://catan.cloud", "http://catan.cloud", "https://www.catan.cloud", "http://www.catan.cloud"],
    methods: ["GET", "POST"]
  }
});

// --- GAME LOBBY STATE ---
let connectedPlayers = 0;
let currentBoardState = null;

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    // 1. ASSIGN PLAYER NUMBER
    // Increment the player count and assign it to the newly connected user
    connectedPlayers++;
    const playerNumber = connectedPlayers;
    socket.emit('assignPlayer', playerNumber);
    console.log(`Assigned Player ${playerNumber} to ${socket.id}`);

    // If a player refreshes or joins late after the game started, send them the board
    if (currentBoardState) {
        socket.emit('syncBoard', currentBoardState);
    }

    // 2. HOST STARTS GAME
    // Listen for the Host (Player 1) generating the board
    socket.on('initBoard', (data) => {
        console.log('Host initialized the board. Syncing to network...');
        currentBoardState = data; // Save the board state on the server
        
        // Broadcast the board to everyone EXCEPT the Host (since the Host already rendered it)
        socket.broadcast.emit('syncBoard', data); 
    });

    // 3. IN-GAME ACTIONS
    // When a player rolls dice, builds, or moves the robber
    socket.on('gameAction', (data) => {
        // Relay the action to all OTHER players
        socket.broadcast.emit('gameAction', data); 
    });

    // 4. DISCONNECT LOGIC
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        connectedPlayers--;
        if (connectedPlayers < 0) connectedPlayers = 0;
        
        // If everyone leaves the server, clear the board state for the next game
        if (connectedPlayers === 0) {
            console.log('Lobby empty. Resetting board.');
            currentBoardState = null;
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Backend listening on port ${PORT}`);
});
