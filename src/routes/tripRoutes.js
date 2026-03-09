// ─── Trip REST Routes ─────────────────────────────────────────────────────────
//
// HTTP endpoints called by the PHP / logical backend to:
//   1. Notify new trips to drivers
//   2. Update trip status (accepted, cancelled, completed, etc.)

const express = require("express");

const EVENTS = require("../config/events");
const connectionManager = require("../services/connectionManager");
const driverQueue = require("../services/driverQueue");
const offerManager = require("../services/offerManager");
const log = require("../utils/logger")("TripRoutes");

const router = express.Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sendOk = (res) => res.json({ ok: true });

const sendError = (res, status, message) =>
  res.status(status).json({ ok: false, message });

// ─── POST /notify-new-trip ────────────────────────────────────────────────────
//
// Called by PHP backend when a new trip is created.
// Receives { tripId, drivers[] } — adds trip to each driver's queue and
// offers it if they have no active offer.

router.post("/notify-new-trip", (req, res) => {
  const { io } = req.app.locals;
  const { tripId, drivers } = req.body;

  if (!tripId || !drivers || !Array.isArray(drivers)) {
    return sendError(res, 400, "tripId and drivers[] are required");
  }

  log.info(
    `New trip ${tripId} → notifying ${drivers.length} driver(s): [${drivers.join(", ")}]`
  );

  drivers.forEach((driverId) => {
    const added = driverQueue.addTripToDriver(driverId, tripId);

    if (added && !offerManager.hasOffer(driverId)) {
      // Driver is idle — offer this trip immediately
      offerManager.offerNextTrip(io, driverId);
    }
    // If driver already has an active offer, the new trip waits in queue
  });

  sendOk(res);
});

// ─── POST /trip-status-update ─────────────────────────────────────────────────
//
// Called by PHP backend when a trip's status changes.
// Handles: TRIP_ACCEPTED, TRIP_CANCELLED, TRIP_COMPLETED, TRIP_CLOSED_BY_USER,
//          RIDE_REVOKED

router.post("/trip-status-update", (req, res) => {
  const { io } = req.app.locals;
  const { status, tripId, driverId, userId, by } = req.body;

  if (!status || !tripId) {
    return sendError(res, 400, "status and tripId are required");
  }

  log.info(`Trip status update: ${status} for trip ${tripId}`);

  switch (status) {
    // ── TRIP_ACCEPTED ───────────────────────────────────────────────────────
    case EVENTS.TRIP_ACCEPTED: {
      // Join driver + user to the trip room for further communication
      connectionManager.joinDriverToTripRoom(io, driverId, tripId);
      connectionManager.joinUserToTripRoom(io, userId, tripId);

      // Notify driver + user in the trip room
      io.to(connectionManager.tripRoom(tripId)).emit(EVENTS.TRIP_ACCEPTED, {
        tripId,
        driverId,
      });

      // Notify all other drivers that this trip is taken
      io.emit(EVENTS.CLOSE_RIDE_REQ, { driverId, tripId });

      // Remove trip from ALL driver queues
      driverQueue.removeTripFromAllDrivers(tripId);

      // Clear offers for drivers who were viewing this trip → offer them next
      offerManager.clearAllOffersForTrip(io, tripId);

      break;
    }

    // ── TRIP_CANCELLED ──────────────────────────────────────────────────────
    case EVENTS.TRIP_CANCELLED: {
      io.to(connectionManager.tripRoom(tripId)).emit(EVENTS.TRIP_CANCELLED, {
        tripId,
      });

      if (by === "user") {
        io.to(connectionManager.tripRoom(tripId)).emit(
          EVENTS.RIDE_CANCEL_BY_USER,
          { tripId }
        );
      }

      if (by === "driver") {
        io.to(connectionManager.tripRoom(tripId)).emit(
          EVENTS.RIDE_CANCEL_BY_DRIVER,
          { tripId }
        );
      }

      break;
    }

    // ── TRIP_COMPLETED ──────────────────────────────────────────────────────
    case EVENTS.TRIP_COMPLETED: {
      io.to(connectionManager.tripRoom(tripId)).emit(EVENTS.TRIP_COMPLETED, {
        tripId,
      });

      break;
    }

    // ── TRIP_CLOSED_BY_USER ─────────────────────────────────────────────────
    case EVENTS.TRIP_CLOSED_BY_USER: {
      // User cancelled their search — remove from all driver queues
      driverQueue.removeTripFromAllDrivers(tripId);
      offerManager.clearAllOffersForTrip(io, tripId);

      io.emit(EVENTS.TRIP_CLOSED_BY_USER, { tripId });

      break;
    }

    // ── RIDE_REVOKED ────────────────────────────────────────────────────────
    case EVENTS.RIDE_REVOKED: {
      // Trip revoked (timeout from user side) — remove from all queues
      driverQueue.removeTripFromAllDrivers(tripId);
      offerManager.clearAllOffersForTrip(io, tripId);

      io.emit(EVENTS.RIDE_REVOKED, { tripId });

      break;
    }

    // ── UNKNOWN ─────────────────────────────────────────────────────────────
    default: {
      return sendError(res, 400, `Invalid status: ${status}`);
    }
  }

  sendOk(res);
});

module.exports = router;
