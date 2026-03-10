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
//
// Status IDs (from PHP):
//   1 = Requested       (not handled here — handled by /notify-new-trip)
//   2 = Accepted
//   3 = Revoked
//   4 = Started         (driver started the trip / picked up passenger)
//   5 = Completed
//   6 = Cancelled By User
//   7 = Cancelled By Driver
//   8 = Request Timeout

const STATUS = {
  REQUESTED: 1,
  ACCEPTED: 2,
  REVOKED: 3,
  STARTED: 4,
  COMPLETED: 5,
  CANCELLED_BY_USER: 6,
  CANCELLED_BY_DRIVER: 7,
  REQUEST_TIMEOUT: 8,
};

router.post("/trip-status-update", (req, res) => {
  const { io } = req.app.locals;
  const { status, tripId, driverId, userId } = req.body;

  if (status === undefined || status === null || !tripId) {
    return sendError(res, 400, "status and tripId are required");
  }

  // Ensure status is a number (PHP may send it as string "2" or number 2)
  const statusCode = Number(status);

  log.info(`Trip status update: ${statusCode} for trip ${tripId}`);
  switch (statusCode) {
    // ── 2 = Accepted ────────────────────────────────────────────────────────
    case 2: {
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

    // ── 3 = Revoked ─────────────────────────────────────────────────────────
    case STATUS.REVOKED: {
      // Trip revoked by system — remove from all driver queues
      driverQueue.removeTripFromAllDrivers(tripId);
      offerManager.clearAllOffersForTrip(io, tripId);

      io.emit(EVENTS.RIDE_REVOKED, { tripId });

      break;
    }

    // ── 4 = Started (driver picked up passenger) ────────────────────────────
    case STATUS.STARTED: {
      io.to(connectionManager.tripRoom(tripId)).emit(EVENTS.TRIP_STARTED, {
        tripId,
        driverId,
      });

      break;
    }

    // ── 5 = Completed ───────────────────────────────────────────────────────
    case STATUS.COMPLETED: {
      io.to(connectionManager.tripRoom(tripId)).emit(EVENTS.TRIP_COMPLETED, {
        tripId,
      });

      break;
    }

    // ── 6 = Cancelled By User ───────────────────────────────────────────────
    case STATUS.CANCELLED_BY_USER: {
      // User cancelled — remove from all driver queues
      driverQueue.removeTripFromAllDrivers(tripId);
      offerManager.clearAllOffersForTrip(io, tripId);

      io.to(connectionManager.tripRoom(tripId)).emit(EVENTS.TRIP_CANCELLED, {
        tripId,
      });
      io.emit(EVENTS.RIDE_CANCEL_BY_USER, { tripId });

      break;
    }

    // ── 7 = Cancelled By Driver ─────────────────────────────────────────────
    case STATUS.CANCELLED_BY_DRIVER: {
      io.to(connectionManager.tripRoom(tripId)).emit(EVENTS.TRIP_CANCELLED, {
        tripId,
      });
      io.emit(EVENTS.RIDE_CANCEL_BY_DRIVER, { tripId });

      break;
    }

    // ── 8 = Request Timeout ─────────────────────────────────────────────────
    case STATUS.REQUEST_TIMEOUT: {
      // Trip timed out from user side — remove from all driver queues
      driverQueue.removeTripFromAllDrivers(tripId);
      offerManager.clearAllOffersForTrip(io, tripId);

      io.emit(EVENTS.RIDE_REVOKED, { tripId });

      break;
    }

    // ── Unknown ─────────────────────────────────────────────────────────────
    default: {
      return sendError(res, 400, `Invalid status code: ${statusCode}`);
    }
  }

  sendOk(res);
});

module.exports = router;
