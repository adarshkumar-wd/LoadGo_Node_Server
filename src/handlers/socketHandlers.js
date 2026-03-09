// ─── Socket Event Handlers ────────────────────────────────────────────────────
//
// Registers all socket event listeners for each new client connection.
// Handles REGISTER_DRIVER, REGISTER_USER, ACCEPT_OFFER, REJECT_OFFER, disconnect.

const axios = require("axios");

const { BACKEND_BASE_URL } = require("../config");
const EVENTS = require("../config/events");
const connectionManager = require("../services/connectionManager");
const driverQueue = require("../services/driverQueue");
const offerManager = require("../services/offerManager");
const log = require("../utils/logger")("SocketHandlers");

/**
 * Register all socket event handlers on a new connection.
 *
 * @param {import("socket.io").Server} io — Socket.IO server instance
 * @param {import("socket.io").Socket} socket — The connected socket
 */
function registerHandlers(io, socket) {
  // ─── REGISTER_DRIVER ─────────────────────────────────────────────────────
  socket.on(EVENTS.REGISTER_DRIVER, async ({ driverId, tripId }) => {
    if (!driverId) {
      log.warn("REGISTER_DRIVER called without driverId");
      return;
    }

    connectionManager.addDriver(driverId, socket.id);

    // If driver has an active trip (reconnecting mid-trip)
    if (tripId) {
      socket.join(connectionManager.tripRoom(tripId));
      log.info(`Driver ${driverId} rejoined active trip ${tripId}`);
      return;
    }

    // Check with the PHP backend if driver has an active trip
    try {
      const { data } = await axios.get(`${BACKEND_BASE_URL}/verify-driver`, {
        params: { driverId },
      });

      if (data?.activeTripId) {
        socket.join(connectionManager.tripRoom(data.activeTripId));
        log.info(
          `Driver ${driverId} verified with active trip ${data.activeTripId}`
        );
        return;
      }
    } catch (err) {
      log.error(`Failed to verify driver ${driverId}:`, err.message);
    }

    // No active trip — fetch all SEARCHING trips and build the driver's queue
    try {
      const { data: searchingTrips } = await axios.get(
        `${BACKEND_BASE_URL}/searching-trips`
      );

      if (Array.isArray(searchingTrips) && searchingTrips.length > 0) {
        log.info(
          `Found ${searchingTrips.length} searching trip(s) for driver ${driverId}`
        );

        searchingTrips.forEach((trip) => {
          driverQueue.addTripToDriver(driverId, trip.id);
        });

        // Offer the first trip
        offerManager.offerNextTrip(io, driverId);
      } else {
        log.info(`No searching trips available for driver ${driverId}`);
      }
    } catch (err) {
      log.error(`Failed to fetch searching trips:`, err.message);
    }
  });

  // ─── REGISTER_USER ───────────────────────────────────────────────────────
  socket.on(EVENTS.REGISTER_USER, async ({ userId, tripId }) => {
    if (!userId) {
      log.warn("REGISTER_USER called without userId");
      return;
    }

    connectionManager.addUser(userId, socket.id);

    if (tripId) {
      socket.join(connectionManager.tripRoom(tripId));
    }

    // Verify with backend for any active trip
    try {
      const { data } = await axios.get(`${BACKEND_BASE_URL}/verify-user`, {
        params: { userId },
      });

      if (data?.activeTripId) {
        socket.join(connectionManager.tripRoom(data.activeTripId));
        log.info(
          `User ${userId} verified with active trip ${data.activeTripId}`
        );
      }
    } catch (err) {
      log.error(`Failed to verify user ${userId}:`, err.message);
    }
  });

  // ─── ACCEPT_OFFER ────────────────────────────────────────────────────────
  socket.on(EVENTS.ACCEPT_OFFER, async ({ tripId }) => {
    // Find the driverId from the socket
    const driverId = findDriverIdBySocket(socket.id);
    if (!driverId) {
      log.warn("ACCEPT_OFFER from unknown socket");
      return;
    }

    // Validate the offer
    const result = offerManager.handleAccept(driverId, tripId);

    if (!result.valid) {
      // Offer was stale or mismatched — just offer the next trip
      offerManager.clearOffer(driverId);
      offerManager.offerNextTrip(io, driverId);
      return;
    }

    // Call the PHP backend to accept the trip
    try {
      const { data } = await axios.post(`${BACKEND_BASE_URL}/accept-trip`, {
        tripId,
        driverId,
      });

      if (data?.success) {
        log.info(`Trip ${tripId} accepted by driver ${driverId} — confirmed`);
        // PHP backend will call /trip-status-update which handles:
        //   - TRIP_ACCEPTED emit to trip room
        //   - CLOSE_RIDE_REQ to all drivers
        //   - Removing trip from all queues
      } else {
        // Trip was already accepted by someone else
        log.warn(
          `Trip ${tripId} accept failed for driver ${driverId}: ${data?.message}`
        );

        // Remove this trip from the driver's queue and offer next
        driverQueue.removeTripFromDriver(driverId, tripId);
        offerManager.offerNextTrip(io, driverId);
      }
    } catch (err) {
      log.error(`Failed to accept trip ${tripId}:`, err.message);

      // On network error, assume acceptance failed — offer next trip
      driverQueue.removeTripFromDriver(driverId, tripId);
      offerManager.offerNextTrip(io, driverId);
    }
  });

  // ─── REJECT_OFFER ────────────────────────────────────────────────────────
  socket.on(EVENTS.REJECT_OFFER, ({ tripId }) => {
    const driverId = findDriverIdBySocket(socket.id);
    if (!driverId) {
      log.warn("REJECT_OFFER from unknown socket");
      return;
    }

    // Validate that this is the current offer
    const offer = offerManager.getOffer(driverId);
    if (!offer || offer.tripId !== tripId) {
      log.warn(
        `Driver ${driverId} rejected trip ${tripId} but current offer is ${
          offer ? offer.tripId : "none"
        }`
      );
      return;
    }

    // Handle rejection: rotate to back + 3s gap + offer next
    offerManager.handleReject(io, driverId);
  });

  // ─── DISCONNECT ──────────────────────────────────────────────────────────
  socket.on("disconnect", () => {
    const driverId = connectionManager.removeDriverBySocketId(socket.id);
    const userId = connectionManager.removeUserBySocketId(socket.id);

    if (driverId) {
      // Clear all offers and timers for this driver
      offerManager.cleanupDriver(driverId);
    }

    if (userId) {
      log.info(`User ${userId} disconnected`);
    }
  });
}

// ─── Helper ───────────────────────────────────────────────────────────────────

/**
 * Find a driverId by looking up which driver has the given socket ID.
 * This is the reverse lookup of connectionManager.
 *
 * @param {string} socketId
 * @returns {string|null}
 */
function findDriverIdBySocket(socketId) {
  // We need to search through all driver IDs — connectionManager
  // stores driverId → socketId, so we do a reverse lookup
  const allDriverIds = connectionManager.getAllDriverIds();
  return (
    allDriverIds.find(
      (id) => connectionManager.getDriverSocketId(id) === socketId
    ) || null
  );
}

module.exports = { registerHandlers };
