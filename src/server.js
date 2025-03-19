const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const cors = require("cors");
const mongoose = require("mongoose");
const axios = require("axios");
const path = require("path");
require("dotenv").config();

// Initialize Express app
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

// MongoDB connection (if configured in .env)
if (process.env.MONGODB_URI) {
  mongoose
    .connect(process.env.MONGODB_URI)
    .then(() => console.log("MongoDB connected"))
    .catch((err) => console.error("MongoDB connection error:", err));
}

// Define ParkingLog schema for MongoDB
const logSchema = new mongoose.Schema({
  timestamp: { type: Date, default: Date.now },
  message: String,
});

const ParkingLog = mongoose.model("ParkingLog", logSchema);

// ESP32 status (simulated or from actual device)
let parkingStatus = {
  slot1: false,
  slot2: false,
  slot3: false,
  slot4: false,
};

let logs = [];

// Store ESP32 IP from environment variable or use direct connection
let ESP32_IP = process.env.ESP32_IP || null;

// Routes
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

// API endpoint to register ESP32
app.post("/register-esp32", (req, res) => {
  const { ip } = req.body;
  if (ip) {
    ESP32_IP = ip;
    console.log(`ESP32 registered with IP: ${ESP32_IP}`);
    res.status(200).json({ success: true });
  } else {
    res.status(400).json({ success: false, message: "No IP provided" });
  }
});

// API endpoint to get parking status
app.get("/api/status", async (req, res) => {
  try {
    // If we have a registered ESP32, get live data
    if (ESP32_IP) {
      try {
        const response = await axios.get(`http://${ESP32_IP}/getStatus`);
        parkingStatus = response.data;
      } catch (error) {
        console.error("Error fetching from ESP32:", error.message);
        // We'll return last known status if ESP32 is unreachable
      }
    }
    res.json(parkingStatus);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API endpoint to get logs
app.get("/api/logs", async (req, res) => {
  const since = req.query.since ? parseInt(req.query.since) : 0;

  try {
    let latestLogs = [];

    // Get from ESP32 if available
    if (ESP32_IP) {
      try {
        const response = await axios.get(
          `http://${ESP32_IP}/getLogs${since ? `?since=${since}` : ""}`
        );
        latestLogs = response.data;

        // Store logs in MongoDB if configured
        if (process.env.MONGODB_URI) {
          for (const log of latestLogs) {
            await ParkingLog.create({
              timestamp: new Date(log.t * 1000),
              message: log.m,
            });
          }
        } else {
          // In-memory storage if no MongoDB
          logs = logs.concat(latestLogs).slice(-100); // Keep last 100 logs
        }
      } catch (error) {
        console.error("Error fetching logs from ESP32:", error.message);
      }
    }

    // If we couldn't get logs from ESP32 or we're using MongoDB
    if (latestLogs.length === 0 && process.env.MONGODB_URI) {
      const dbLogs = await ParkingLog.find({
        timestamp: { $gt: new Date(since * 1000) },
      })
        .sort({ timestamp: -1 })
        .limit(20);

      latestLogs = dbLogs.map((log) => ({
        t: Math.floor(log.timestamp.getTime() / 1000),
        formatted: log.timestamp.toLocaleTimeString("vi-VN"),
        m: log.message,
      }));
    } else if (latestLogs.length === 0) {
      // Return in-memory logs
      latestLogs = logs.filter((log) => log.t > since);
    }

    res.json(latestLogs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Receive updates directly from ESP32
app.post("/api/update", (req, res) => {
  const { status, log } = req.body;

  if (status) {
    parkingStatus = status;
    // Emit updated status to all connected clients
    io.emit("statusUpdate", status);
  }

  if (log) {
    if (process.env.MONGODB_URI) {
      // Store in MongoDB
      ParkingLog.create({
        timestamp: new Date(log.timestamp * 1000),
        message: log.message,
      });
    } else {
      // In-memory storage
      logs.push({
        t: log.timestamp,
        formatted: new Date(log.timestamp * 1000).toLocaleTimeString("vi-VN"),
        m: log.message,
      });
      logs = logs.slice(-100); // Keep last 100 logs
    }

    // Emit new log to all connected clients
    io.emit("newLog", {
      t: log.timestamp,
      formatted: new Date(log.timestamp * 1000).toLocaleTimeString("vi-VN"),
      m: log.message,
    });
  }

  res.status(200).json({ success: true });
});

// Socket.io connection
io.on("connection", (socket) => {
  console.log("Client connected");

  // Send current status to newly connected client
  socket.emit("statusUpdate", parkingStatus);

  socket.on("disconnect", () => {
    console.log("Client disconnected");
  });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
