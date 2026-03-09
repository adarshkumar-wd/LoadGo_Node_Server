// ─── Connection Manager ───────────────────────────────────────────────────────
//
// Tracks online drivers and users by mapping their IDs to Socket.IO socket IDs.
// Provides helpers for room management (trip rooms).

const log = require("../utils/logger")("ConnectionManager");

// ─── State ────────────────────────────────────────────────────────────────────

/** @type {Record<string, string>}  driverId → socketId */
const onlineDrivers = {};

/** @type {Record<string, string>}  userId → socketId */
const onlineUsers = {};

// ─── Room helper ──────────────────────────────────────────────────────────────

/**
 * Returns the Socket.IO room name for a given trip.
 * @param {number|string} tripId
 * @returns {string}
 */
const tripRoom = (tripId) => `trip_${tripId}`;

// ─── Driver methods ───────────────────────────────────────────────────────────

function addDriver(driverId, socketId) {
  onlineDrivers[driverId] = socketId;
  log.info(`Driver ${driverId} connected (socket: ${socketId})`);
}

function removeDriverBySocketId(socketId) {
  const driverId = Object.keys(onlineDrivers).find(
    (id) => onlineDrivers[id] === socketId
  );
  if (driverId) {
    delete onlineDrivers[driverId];
    log.info(`Driver ${driverId} disconnected`);
  }
  return driverId || null;
}

function getDriverSocketId(driverId) {
  return onlineDrivers[driverId] || null;
}

function getAllDriverIds() {
  return Object.keys(onlineDrivers);
}

// ─── User methods ─────────────────────────────────────────────────────────────

function addUser(userId, socketId) {
  onlineUsers[userId] = socketId;
  log.info(`User ${userId} connected (socket: ${socketId})`);
}

function removeUserBySocketId(socketId) {
  const userId = Object.keys(onlineUsers).find(
    (id) => onlineUsers[id] === socketId
  );
  if (userId) {
    delete onlineUsers[userId];
    log.info(`User ${userId} disconnected`);
  }
  return userId || null;
}

function getUserSocketId(userId) {
  return onlineUsers[userId] || null;
}

// ─── Room operations ──────────────────────────────────────────────────────────

/**
 * Joins a driver's socket to a trip room.
 * @param {object} io — Socket.IO server instance
 * @param {string|number} driverId
 * @param {string|number} tripId
 */
function joinDriverToTripRoom(io, driverId, tripId) {
  const socketId = onlineDrivers[driverId];
  if (!socketId) return;

  const socket = io.sockets.sockets.get(socketId);
  if (socket) {
    socket.join(tripRoom(tripId));
    log.debug(`Driver ${driverId} joined room ${tripRoom(tripId)}`);
  }
}

/**
 * Joins a user's socket to a trip room.
 * @param {object} io — Socket.IO server instance
 * @param {string|number} userId
 * @param {string|number} tripId
 */
function joinUserToTripRoom(io, userId, tripId) {
  const socketId = onlineUsers[userId];
  if (!socketId) return;

  const socket = io.sockets.sockets.get(socketId);
  if (socket) {
    socket.join(tripRoom(tripId));
    log.debug(`User ${userId} joined room ${tripRoom(tripId)}`);
  }
}

module.exports = {
  addDriver,
  removeDriverBySocketId,
  getDriverSocketId,
  getAllDriverIds,
  addUser,
  removeUserBySocketId,
  getUserSocketId,
  joinDriverToTripRoom,
  joinUserToTripRoom,
  tripRoom,
};
