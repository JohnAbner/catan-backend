const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

// --- NEW: Health Check Route ---
app.get('/', (req, res) => {
    res.send('Catan Backend is Live and Running!');
});

// Allow requests from your static website
const io = new Server(server, {
  cors: {
    origin: ["https://catan.cloud", "http://catan.cloud", "https://www.catan.cloud", "http://www.catan.cloud"],
    methods: ["GET", "POST"]
  }
});

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    socket.on('gameAction', (data) => {
        io.emit('gameAction', data); 
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Backend listening on port ${PORT}`);
});
