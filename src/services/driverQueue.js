// ─── Driver Queue Service ─────────────────────────────────────────────────────
//
// Manages a per-driver queue of incoming trips. Each trip entry carries a
// background expiry timestamp (5 minutes from when it was added). Trips that
// exceed their background timer are silently purged.
//
// Data structure:
//   driverQueues[driverId] = [
//     { tripId: 123, addedAt: <ms>, bgExpireAt: <ms> },
//     ...
//   ]

const { BACKGROUND_TIMER_MS } = require("../config");
const log = require("../utils/logger")("DriverQueue");

// ─── State ────────────────────────────────────────────────────────────────────

/** @type {Record<string, Array<{tripId: number, addedAt: number, bgExpireAt: number}>>} */
const driverQueues = {};

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Remove background-expired entries from a driver's queue. */
function purgeExpired(driverId) {
  if (!driverQueues[driverId]) return;

  const now = Date.now();
  const before = driverQueues[driverId].length;

  driverQueues[driverId] = driverQueues[driverId].filter(
    (entry) => entry.bgExpireAt > now
  );

  const removed = before - driverQueues[driverId].length;
  if (removed > 0) {
    log.info(
      `Purged ${removed} expired trip(s) from driver ${driverId}'s queue`
    );
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Add a trip to a driver's queue (with 5-min background timer).
 * Skips if the trip is already in the queue.
 *
 * @param {string|number} driverId
 * @param {number} tripId
 * @returns {boolean} true if the trip was added, false if it already existed
 */
function addTripToDriver(driverId, tripId) {
  if (!driverQueues[driverId]) {
    driverQueues[driverId] = [];
  }

  // Don't add duplicates
  if (driverQueues[driverId].some((entry) => entry.tripId === tripId)) {
    return false;
  }

  const now = Date.now();

  driverQueues[driverId].push({
    tripId,
    addedAt: now,
    bgExpireAt: now + BACKGROUND_TIMER_MS,
  });

  log.info(
    `Trip ${tripId} added to driver ${driverId}'s queue ` +
      `(queue size: ${driverQueues[driverId].length})`
  );

  return true;
}

/**
 * Remove a specific trip from a driver's queue.
 *
 * @param {string|number} driverId
 * @param {number} tripId
 */
function removeTripFromDriver(driverId, tripId) {
  if (!driverQueues[driverId]) return;

  driverQueues[driverId] = driverQueues[driverId].filter(
    (entry) => entry.tripId !== tripId
  );
}

/**
 * Remove a trip from ALL drivers' queues.
 * Used when a trip is accepted, cancelled, or revoked.
 *
 * @param {number} tripId
 * @returns {string[]} — list of driverIds that had the trip removed
 */
function removeTripFromAllDrivers(tripId) {
  const affectedDrivers = [];

  for (const driverId of Object.keys(driverQueues)) {
    const hadTrip = driverQueues[driverId].some(
      (entry) => entry.tripId === tripId
    );

    if (hadTrip) {
      driverQueues[driverId] = driverQueues[driverId].filter(
        (entry) => entry.tripId !== tripId
      );
      affectedDrivers.push(driverId);
    }
  }

  if (affectedDrivers.length > 0) {
    log.info(
      `Trip ${tripId} removed from ${affectedDrivers.length} driver queue(s)`
    );
  }

  return affectedDrivers;
}

/**
 * Get the next non-expired trip from the front of a driver's queue.
 * Automatically purges expired entries.
 *
 * @param {string|number} driverId
 * @returns {{ tripId: number, addedAt: number, bgExpireAt: number } | null}
 */
function getNextTrip(driverId) {
  purgeExpired(driverId);

  if (!driverQueues[driverId] || driverQueues[driverId].length === 0) {
    return null;
  }

  return driverQueues[driverId][0];
}

/**
 * Rotate: move the front trip to the back of the queue (if still alive).
 * Returns the new front trip (or null if queue is empty).
 *
 * @param {string|number} driverId
 * @returns {{ tripId: number, addedAt: number, bgExpireAt: number } | null}
 */
function rotateCurrentTrip(driverId) {
  if (!driverQueues[driverId] || driverQueues[driverId].length === 0) {
    return null;
  }

  const current = driverQueues[driverId].shift();

  // Only put it back if it hasn't expired
  if (current && current.bgExpireAt > Date.now()) {
    driverQueues[driverId].push(current);
  } else {
    log.info(
      `Trip ${current?.tripId} expired during rotation for driver ${driverId}`
    );
  }

  // Clean up any other expired entries
  purgeExpired(driverId);

  return driverQueues[driverId][0] || null;
}

/**
 * Get the full queue for a driver (for debugging/inspection).
 *
 * @param {string|number} driverId
 * @returns {Array<{tripId: number, addedAt: number, bgExpireAt: number}>}
 */
function getQueue(driverId) {
  purgeExpired(driverId);
  return driverQueues[driverId] || [];
}

/**
 * Get the queue size for a driver.
 *
 * @param {string|number} driverId
 * @returns {number}
 */
function getQueueSize(driverId) {
  purgeExpired(driverId);
  return (driverQueues[driverId] || []).length;
}

/**
 * Check if a driver currently has a specific trip in their queue.
 *
 * @param {string|number} driverId
 * @param {number} tripId
 * @returns {boolean}
 */
function hasTripInQueue(driverId, tripId) {
  if (!driverQueues[driverId]) return false;
  return driverQueues[driverId].some((entry) => entry.tripId === tripId);
}

/**
 * Clear a driver's entire queue (used on disconnect after timeout).
 *
 * @param {string|number} driverId
 */
function clearDriver(driverId) {
  delete driverQueues[driverId];
  log.info(`Queue cleared for driver ${driverId}`);
}

/**
 * Get all driver IDs who have a specific trip in their queue.
 *
 * @param {number} tripId
 * @returns {string[]}
 */
function getDriversWithTrip(tripId) {
  return Object.keys(driverQueues).filter(
    (driverId) =>
      driverQueues[driverId] &&
      driverQueues[driverId].some((entry) => entry.tripId === tripId)
  );
}

module.exports = {
  addTripToDriver,
  removeTripFromDriver,
  removeTripFromAllDrivers,
  getNextTrip,
  rotateCurrentTrip,
  getQueue,
  getQueueSize,
  hasTripInQueue,
  clearDriver,
  getDriversWithTrip,
};
