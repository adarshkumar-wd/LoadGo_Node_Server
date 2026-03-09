const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const axios = require("axios");

const PORT = 4000;
const BACKEND_BASE_URL = "https://loadgo.in/loadgotest/";

const EVENTS = {
  NEW_RIDE: "NEW_RIDE",
  TRIP_ACCEPTED: "TRIP_ACCEPTED",
  RIDE_ACCEPTED_FROM_OTHER_DRIVER: "RIDE_ACCEPTED_FROM_OTHER_DRIVER",
  TRIP_CANCELLED: "TRIP_CANCELLED",
  RIDE_CANCEL_BY_USER: "RIDE_CANCEL_BY_USER",
  RIDE_CANCEL_BY_DRIVER: "RIDE_CANCEL_BY_DRIVER",
  TRIP_CLOSED_BY_USER: "TRIP_CLOSED_BY_USER",
  TRIP_COMPLETED: "TRIP_COMPLETED",
  CLOSE_RIDE_REQ: "CLOSE_RIDE_REQ",
  RIDE_REVOKED: "RIDE_REVOKED",

  REGISTER_USER: "REGISTER_USER",
  REGISTER_DRIVER: "REGISTER_DRIVER",
};

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" },
});

const onlineDrivers = {};
const onlineUsers = {};

const tripRoom = (tripId) => `trip_${tripId}`;

const joinDriverToTripRoom = (driverId, tripId) => {
  const socketId = onlineDrivers[driverId];
  if (!socketId) return;

  const driverSocket = io.sockets.sockets.get(socketId);

  if (driverSocket) {
    driverSocket.join(tripRoom(tripId));
  }
};

const joinUserToTripRoom = (userId, tripId) => {
  const socketId = onlineUsers[userId];
  if (!socketId) return;

  const userSocket = io.sockets.sockets.get(socketId);

  if (userSocket) {
    userSocket.join(tripRoom(tripId));
  }
};

const broadcastNewRideToAllDrivers = (tripId, afterComplete = false) => {
  Object.values(onlineDrivers).forEach((socketId) => {
    io.to(socketId).emit(EVENTS.NEW_RIDE, {
      tripId,
      AFTER_COMPLETE: afterComplete,
    });
  });
};

const sendOk = (res) => res.json({ ok: true });

/* -------------------- SOCKET CONNECTION -------------------- */

io.on("connection", (socket) => {

  socket.on(EVENTS.REGISTER_USER, async ({ userId, tripId }) => {

    onlineUsers[userId] = socket.id;

    if (tripId) {
      socket.join(tripRoom(tripId));
    }

    try {
      const { data } = await axios.get(
        `${BACKEND_BASE_URL}/verify-user`,
        { params: { userId } }
      );

      if (data?.activeTripId) {
        socket.join(tripRoom(data.activeTripId));
      }

    } catch (err) {}
  });

  socket.on(EVENTS.REGISTER_DRIVER, async ({ driverId, tripId }) => {

    onlineDrivers[driverId] = socket.id;

    if (tripId) {
      socket.join(tripRoom(tripId));
    }

    try {

      const { data } = await axios.get(
        `${BACKEND_BASE_URL}/verify-driver`,
        { params: { driverId } }
      );

      if (data?.activeTripId) {
        socket.join(tripRoom(data.activeTripId));
        return;
      }

      const { data: searchingTrips } = await axios.get(
        `${BACKEND_BASE_URL}/searching-trips`
      );

      searchingTrips.forEach((trip) => {
        socket.emit(EVENTS.NEW_RIDE, { tripId: trip.id });
      });

    } catch (err) {}
  });

  socket.on("disconnect", () => {

    const driverId = Object.keys(onlineDrivers).find(
      (id) => onlineDrivers[id] === socket.id
    );

    if (driverId) delete onlineDrivers[driverId];

    const userId = Object.keys(onlineUsers).find(
      (id) => onlineUsers[id] === socket.id
    );

    if (userId) delete onlineUsers[userId];

  });

});

/* -------------------- NEW RIDE -------------------- */

app.post("/notify-new-trip", (req, res) => {

  const { trip, drivers } = req.body;

  if (!trip || !drivers || !Array.isArray(drivers)) {
    return res.status(400).json({
      ok: false,
      message: "trip and drivers required",
    });
  }

  drivers.forEach((driverId) => {

    const socketId = onlineDrivers[driverId];

    if (socketId) {
      io.to(socketId).emit(EVENTS.NEW_RIDE, { trip });
    }

  });

  sendOk(res);

});

/* -------------------- SINGLE STATUS UPDATE API -------------------- */

app.post("/trip-status-update", (req, res) => {

  const { status, tripId, driverId, userId, by } = req.body;

  if (!status || !tripId) {
    return res.status(400).json({
      ok: false,
      message: "status and tripId required",
    });
  }

  switch (status) {

    case EVENTS.TRIP_ACCEPTED:

      joinDriverToTripRoom(driverId, tripId);
      joinUserToTripRoom(userId, tripId);

      io.to(tripRoom(tripId)).emit(EVENTS.TRIP_ACCEPTED, {
        tripId,
        driverId,
      });

      io.emit(EVENTS.RIDE_ACCEPTED_FROM_OTHER_DRIVER, {
        tripId,
        driverId,
      });

      io.emit(EVENTS.CLOSE_RIDE_REQ, { driverId, tripId });

      break;


    case EVENTS.TRIP_CANCELLED:

      io.to(tripRoom(tripId)).emit(EVENTS.TRIP_CANCELLED, { tripId });

      if (by === "user") {
        io.to(tripRoom(tripId)).emit(EVENTS.RIDE_CANCEL_BY_USER, { tripId });
      }

      if (by === "driver") {
        io.to(tripRoom(tripId)).emit(EVENTS.RIDE_CANCEL_BY_DRIVER, { tripId });
      }

      break;


    case EVENTS.TRIP_COMPLETED:

      io.to(tripRoom(tripId)).emit(EVENTS.TRIP_COMPLETED, { tripId });

      break;


    case EVENTS.TRIP_CLOSED_BY_USER:

      io.emit(EVENTS.TRIP_CLOSED_BY_USER, { tripId });

      break;


    case EVENTS.RIDE_REVOKED:

      io.emit(EVENTS.RIDE_REVOKED, { tripId });

      break;


    default:

      return res.status(400).json({
        ok: false,
        message: "Invalid status",
      });

  }

  sendOk(res);

});

/* -------------------- SERVER START -------------------- */

server.listen(PORT, () => {
  console.log(`Realtime Server running on port ${PORT}`);
});