import mongoose from 'mongoose';

const teamSchema = new mongoose.Schema({
  name: { type: String, required: true },
  owner: { type: String, required: true },
  socketId: { type: String },
  purse: { type: Number, default: 120 }, // ₹120 Cr default
  playersBought: [{
    name: String,
    role: String,
    price: Number
  }]
});

const roomSchema = new mongoose.Schema({
  roomId: { type: String, required: true, unique: true },
  host: { type: String, required: true }, // host socketId or username
  status: { type: String, enum: ['LOBBY', 'AUCTION', 'FINISHED'], default: 'LOBBY' },
  teams: [teamSchema],
  players: [{
    name: String,
    role: String,
    basePrice: Number, // in Cr
    isSold: { type: Boolean, default: false },
    soldTo: { type: String, default: null },
    soldPrice: { type: Number, default: 0 }
  }],
  currentAuction: {
    playerIndex: { type: Number, default: 0 },
    currentBid: { type: Number, default: 0 },
    highestBidder: { type: String, default: null }, // team name
    timeLeft: { type: Number, default: 15 }
  }
});

export default mongoose.model('Room', roomSchema);
