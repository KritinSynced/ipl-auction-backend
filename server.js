import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Room from './models/Room.js';
import { getMockPlayers } from './data/players.js';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.send('IPL Auction Backend is running!');
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 5000;

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch((err) => console.error('MongoDB connection error:', err));

const generateRoomId = () => Math.random().toString(36).substring(2, 8).toUpperCase();

// Active timers memory store { roomId: intervalId }
const roomTimers = {};

io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  socket.on('createRoom', async ({ hostName, teamName }, callback) => {
    try {
      const roomId = generateRoomId();
      const players = getMockPlayers();
      const newRoom = new Room({
        roomId, host: socket.id, status: 'LOBBY', players,
        teams: [{ name: teamName, owner: hostName, socketId: socket.id }]
      });
      await newRoom.save();
      socket.join(roomId);
      callback({ success: true, roomId, room: newRoom });
    } catch (error) {
      callback({ success: false, message: 'Failed to create room' });
    }
  });

  socket.on('joinRoom', async ({ roomId, userName, teamName }, callback) => {
    try {
      const room = await Room.findOne({ roomId: roomId.toUpperCase() });
      if (!room) return callback({ success: false, message: 'Room not found' });
      if (room.status !== 'LOBBY') return callback({ success: false, message: 'Auction already started' });
      if (room.teams.some(t => t.name === teamName)) return callback({ success: false, message: 'Team already taken' });

      room.teams.push({ name: teamName, owner: userName, socketId: socket.id });
      await room.save();
      socket.join(roomId);
      io.to(roomId).emit('roomUpdated', room);
      callback({ success: true, room });
    } catch (error) {
      callback({ success: false, message: 'Failed to join room' });
    }
  });

  // --- AUCTION LOGIC ---
  const advanceToNextPlayer = async (roomId) => {
    const room = await Room.findOne({ roomId });
    if (!room) return;

    room.currentAuction.playerIndex += 1;
    if (room.currentAuction.playerIndex >= room.players.length) {
      room.status = 'FINISHED';
      await room.save();
      io.to(roomId).emit('auctionEnded', room);
      clearInterval(roomTimers[roomId]);
      delete roomTimers[roomId];
      return;
    }

    const currentPlayer = room.players[room.currentAuction.playerIndex];
    room.currentAuction.currentBid = currentPlayer.basePrice;
    room.currentAuction.highestBidder = null;
    room.currentAuction.timeLeft = 15;
    await room.save();
    
    io.to(roomId).emit('nextPlayer', room);
    startTimer(roomId);
  };

  const startTimer = (roomId) => {
    if (roomTimers[roomId]) clearInterval(roomTimers[roomId]);
    
    roomTimers[roomId] = setInterval(async () => {
      const room = await Room.findOne({ roomId });
      if (!room) return clearInterval(roomTimers[roomId]);

      if (room.currentAuction.timeLeft > 0) {
        room.currentAuction.timeLeft -= 1;
        await room.save();
        io.to(roomId).emit('timerUpdate', room.currentAuction.timeLeft);
      } else {
        // Timer reached 0, player is sold
        clearInterval(roomTimers[roomId]);
        const currentPlayer = room.players[room.currentAuction.playerIndex];
        currentPlayer.isSold = true;

        if (room.currentAuction.highestBidder) {
          currentPlayer.soldTo = room.currentAuction.highestBidder;
          currentPlayer.soldPrice = room.currentAuction.currentBid;

          // Deduct purse
          const winningTeam = room.teams.find(t => t.name === room.currentAuction.highestBidder);
          if (winningTeam) {
            winningTeam.purse -= room.currentAuction.currentBid;
            // precision fix
            winningTeam.purse = Math.round(winningTeam.purse * 10) / 10;
            winningTeam.playersBought.push({
              name: currentPlayer.name,
              role: currentPlayer.role,
              price: room.currentAuction.currentBid
            });
          }
        }

        await room.save();
        io.to(roomId).emit('playerSold', { room, player: currentPlayer });

        setTimeout(() => advanceToNextPlayer(roomId), 4000); // Wait 4s before next player
      }
    }, 1000);
  };

  socket.on('startAuction', async ({ roomId }, callback) => {
    try {
      const room = await Room.findOne({ roomId });
      if (!room || room.host !== socket.id) return callback({ success: false, message: 'Unauthorized' });
      
      room.status = 'AUCTION';
      const firstPlayer = room.players[0];
      room.currentAuction.currentBid = firstPlayer.basePrice;
      room.currentAuction.highestBidder = null;
      room.currentAuction.timeLeft = 15;
      
      await room.save();
      io.to(roomId).emit('auctionStarted', room);
      startTimer(roomId);
      callback({ success: true });
    } catch (error) {
      callback({ success: false, message: 'Failed to start auction' });
    }
  });

  socket.on('placeBid', async ({ roomId, teamName, bidAmount }, callback) => {
    try {
      const room = await Room.findOne({ roomId });
      if (!room || room.status !== 'AUCTION') return callback({ success: false, message: 'Invalid room state' });

      const team = room.teams.find(t => t.name === teamName);
      if (!team) return callback({ success: false, message: 'Team not found' });
      if (team.purse < bidAmount) return callback({ success: false, message: 'Insufficient purse' });
      
      // Initial bid can be basePrice if no highest bidder, otherwise must be greater
      if (room.currentAuction.highestBidder && bidAmount <= room.currentAuction.currentBid) {
        return callback({ success: false, message: 'Bid must be higher than current bid' });
      }

      room.currentAuction.currentBid = bidAmount;
      room.currentAuction.highestBidder = teamName;
      room.currentAuction.timeLeft = 15; // Reset timer
      
      await room.save();
      io.to(roomId).emit('newBid', { currentAuction: room.currentAuction });
      callback({ success: true });
    } catch (error) {
      console.error(error);
      callback({ success: false, message: 'Bid failed' });
    }
  });

  // Basic chat
  socket.on('sendMessage', ({ roomId, userName, message }) => {
    io.to(roomId).emit('newMessage', { userName, message, timestamp: new Date() });
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
