// ─── Realtime Server — Entry Point ────────────────────────────────────────────
//
// Sets up Express + Socket.IO, mounts REST routes and socket handlers,
// and starts the server.

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const { PORT } = require("./config");
const { registerHandlers } = require("./handlers/socketHandlers");
const tripRoutes = require("./routes/tripRoutes");
const log = require("./utils/logger")("Server");

// ─── Express + HTTP ───────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

// ─── Socket.IO ────────────────────────────────────────────────────────────────

const io = new Server(server, {
  cors: { origin: "*" },
});

// Make io accessible in route handlers via req.app.locals
app.locals.io = io;

// ─── REST Routes ──────────────────────────────────────────────────────────────

app.use("/", tripRoutes);

// Health check endpoint
app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// ─── Socket Connections ───────────────────────────────────────────────────────

io.on("connection", (socket) => {
  log.info(`New socket connection: ${socket.id}`);
  registerHandlers(io, socket);
});

// ─── Start Server ─────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  log.info(`Realtime Server running on port ${PORT}`);
  log.info(`Health check: http://localhost:${PORT}/health`);
});
