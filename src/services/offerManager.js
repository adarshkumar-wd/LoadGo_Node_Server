// ─── Offer Manager ────────────────────────────────────────────────────────────
//
// Manages the "currently displayed trip" for each driver. Each driver can have
// at most ONE active offer at a time. The offer has a screen timer (30s) that,
// when expired, triggers a rotation callback.
//
// Data structure:
//   activeOffers[driverId] = {
//     tripId: 123,
//     screenTimerId: <setTimeout ID>,
//   }

const { SCREEN_TIMER_MS, ROTATION_GAP_MS } = require("../config");
const driverQueue = require("./driverQueue");
const connectionManager = require("./connectionManager");
const EVENTS = require("../config/events");
const log = require("../utils/logger")("OfferManager");

// ─── State ────────────────────────────────────────────────────────────────────

/** @type {Record<string, {tripId: number, screenTimerId: ReturnType<typeof setTimeout>}>} */
const activeOffers = {};

// ─── Core function: Offer next trip to a driver ──────────────────────────────

/**
 * Offers the next available trip from a driver's queue.
 * If the driver already has an active offer, this is a no-op.
 *
 * This is the central orchestration function that ties together
 * driverQueue + offerManager + socket emission.
 *
 * @param {object} io — Socket.IO server instance
 * @param {string|number} driverId
 */
function offerNextTrip(io, driverId) {
  // Don't override an existing offer
  if (activeOffers[driverId]) {
    log.debug(`Driver ${driverId} already has an active offer, skipping`);
    return;
  }

  const nextTrip = driverQueue.getNextTrip(driverId);

  if (!nextTrip) {
    log.debug(`No trips in queue for driver ${driverId}`);
    return;
  }

  const now = Date.now();
  const bgTimeLeft = nextTrip.bgExpireAt - now;

  // Screen time is the lesser of 30s or remaining background time
  const screenTimeMs = Math.min(SCREEN_TIMER_MS, bgTimeLeft);

  if (screenTimeMs <= 0) {
    // Trip already expired, clean it and try the next one
    driverQueue.rotateCurrentTrip(driverId);
    offerNextTrip(io, driverId);
    return;
  }

  // Start the screen timer
  const screenTimerId = setTimeout(() => {
    onScreenTimeout(io, driverId);
  }, screenTimeMs);

  activeOffers[driverId] = {
    tripId: nextTrip.tripId,
    screenTimerId,
  };

  // Emit OFFER_TRIP to the driver's socket
  const socketId = connectionManager.getDriverSocketId(driverId);
  if (socketId) {
    io.to(socketId).emit(EVENTS.OFFER_TRIP, {
      tripId: nextTrip.tripId,
      screenTimeout: Math.ceil(screenTimeMs / 1000), // seconds for display
    });

    log.info(
      `Offered trip ${nextTrip.tripId} to driver ${driverId} ` +
        `(screen: ${Math.ceil(screenTimeMs / 1000)}s, ` +
        `bg left: ${Math.ceil(bgTimeLeft / 1000)}s, ` +
        `queue size: ${driverQueue.getQueueSize(driverId)})`
    );
  }
}

// ─── Screen timer expiry ──────────────────────────────────────────────────────

/**
 * Called when a driver's 30-second screen timer expires without action.
 * Rotates the current trip to the back and offers the next one after a gap.
 *
 * @param {object} io — Socket.IO server instance
 * @param {string|number} driverId
 */
function onScreenTimeout(io, driverId) {
  const offer = activeOffers[driverId];
  if (!offer) return;

  log.info(
    `Screen timer expired for driver ${driverId} on trip ${offer.tripId}`
  );

  // Notify driver that this offer expired
  const socketId = connectionManager.getDriverSocketId(driverId);
  if (socketId) {
    io.to(socketId).emit(EVENTS.OFFER_EXPIRED, { tripId: offer.tripId });
  }

  // Clear current offer
  delete activeOffers[driverId];

  // Rotate current trip to back of queue
  driverQueue.rotateCurrentTrip(driverId);

  // After the rotation gap, offer the next trip
  setTimeout(() => {
    offerNextTrip(io, driverId);
  }, ROTATION_GAP_MS);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Clear the active offer for a driver (stops the screen timer).
 *
 * @param {string|number} driverId
 */
function clearOffer(driverId) {
  const offer = activeOffers[driverId];
  if (!offer) return;

  clearTimeout(offer.screenTimerId);
  delete activeOffers[driverId];
  log.debug(`Offer cleared for driver ${driverId}`);
}

/**
 * Get the current active offer for a driver.
 *
 * @param {string|number} driverId
 * @returns {{ tripId: number, screenTimerId: ReturnType<typeof setTimeout> } | null}
 */
function getOffer(driverId) {
  return activeOffers[driverId] || null;
}

/**
 * Check if a driver currently has an active offer.
 *
 * @param {string|number} driverId
 * @returns {boolean}
 */
function hasOffer(driverId) {
  return !!activeOffers[driverId];
}

/**
 * Clear offers for ALL drivers who are currently being shown a specific trip.
 * Used when a trip is accepted/cancelled/revoked — those drivers need to see
 * their next trip instead.
 *
 * @param {object} io — Socket.IO server instance
 * @param {number} tripId
 */
function clearAllOffersForTrip(io, tripId) {
  const affectedDrivers = [];

  for (const driverId of Object.keys(activeOffers)) {
    if (activeOffers[driverId].tripId === tripId) {
      clearOffer(driverId);
      affectedDrivers.push(driverId);
    }
  }

  // After a brief gap, offer the next trip to each affected driver
  if (affectedDrivers.length > 0) {
    log.info(
      `Cleared offers for trip ${tripId} from ${affectedDrivers.length} driver(s), ` +
        `will offer next trip after ${ROTATION_GAP_MS}ms gap`
    );

    setTimeout(() => {
      affectedDrivers.forEach((driverId) => {
        offerNextTrip(io, driverId);
      });
    }, ROTATION_GAP_MS);
  }
}

/**
 * Handle driver rejection: clear current offer, rotate queue, offer next.
 *
 * @param {object} io — Socket.IO server instance
 * @param {string|number} driverId
 */
function handleReject(io, driverId) {
  const offer = activeOffers[driverId];
  if (!offer) return;

  log.info(`Driver ${driverId} rejected trip ${offer.tripId}`);

  // Clear the screen timer
  clearOffer(driverId);

  // Rotate current trip to back of queue (will come back later)
  driverQueue.rotateCurrentTrip(driverId);

  // After gap, show next trip
  setTimeout(() => {
    offerNextTrip(io, driverId);
  }, ROTATION_GAP_MS);
}

/**
 * Handle driver acceptance: clear offer, validate, and return trip info.
 *
 * @param {string|number} driverId
 * @param {number} tripId
 * @returns {{ valid: boolean, tripId: number | null }}
 */
function handleAccept(driverId, tripId) {
  const offer = activeOffers[driverId];

  if (!offer || offer.tripId !== tripId) {
    log.warn(
      `Driver ${driverId} tried to accept trip ${tripId} ` +
        `but current offer is ${offer ? offer.tripId : "none"}`
    );
    return { valid: false, tripId: null };
  }

  log.info(`Driver ${driverId} accepted trip ${tripId}`);

  // Clear screen timer
  clearOffer(driverId);

  return { valid: true, tripId };
}

/**
 * Full cleanup when a driver disconnects.
 *
 * @param {string|number} driverId
 */
function cleanupDriver(driverId) {
  clearOffer(driverId);
  driverQueue.clearDriver(driverId);
  log.info(`Full cleanup done for driver ${driverId}`);
}

module.exports = {
  offerNextTrip,
  clearOffer,
  getOffer,
  hasOffer,
  clearAllOffersForTrip,
  handleReject,
  handleAccept,
  cleanupDriver,
};
