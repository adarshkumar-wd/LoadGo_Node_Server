# LoadGo — Realtime Server Integration Guide

> **Audience:** Frontend (React Native) & PHP Backend developers
> **Server:** Node.js + Socket.IO running on port `4000`

---

## Architecture Overview

```
┌──────────────┐          ┌───────────────┐          ┌──────────────────┐
│  USER APP    │◄────────►│  NODE REALTIME │◄────────►│  PHP BACKEND     │
│  (React      │  Socket  │  SERVER       │  REST    │  (Logical)       │
│   Native)    │          │  :4000        │          │                  │
├──────────────┤          │               │          │  - creates trips │
│  DRIVER APP  │◄────────►│  - queues     │          │  - accepts trips │
│  (React      │  Socket  │  - timers     │          │  - manages state │
│   Native)    │          │  - rooms      │          │                  │
└──────────────┘          └───────────────┘          └──────────────────┘
```

**Key principle:** The Node server manages driver trip queues and timers. The driver app is a "dumb client" — it only renders what the server sends. PHP is the source of truth for trip data.

---

## For PHP Backend Developers

### REST APIs to Call on Node Server

Base URL: `http://<node-server>:4000`

---

#### `POST /notify-new-trip`

Call this after creating a trip and filtering eligible drivers (within 3km radius).

**Request:**
```json
{
  "tripId": 12345,
  "drivers": [101, 102, 103]
}
```
- `tripId` — ID of the newly created trip
- `drivers` — Array of driver IDs within 3km radius

**Response:** `{ "ok": true }`

**What happens internally:**
- Trip is added to each online driver's queue with a 5-minute background timer
- If a driver is idle, they immediately see the trip
- If a driver is viewing another trip, this trip waits in their queue

---

#### `POST /trip-status-update`

Call this whenever a trip's status changes in the PHP database.

**Request:**
```json
{
  "status": "<EVENT_NAME>",
  "tripId": 12345,
  "driverId": 101,
  "userId": 55,
  "by": "user"
}
```

**Valid status values:**

| Status | Required Fields | When to Call |
|---|---|---|
| `TRIP_ACCEPTED` | `tripId, driverId, userId` | After `/accept-trip` succeeds |
| `TRIP_CANCELLED` | `tripId, by` (`"user"` or `"driver"`) | Trip cancelled after acceptance |
| `TRIP_COMPLETED` | `tripId` | Trip finished |
| `TRIP_CLOSED_BY_USER` | `tripId` | User cancels while still searching |
| `RIDE_REVOKED` | `tripId` | Trip expired / timed out from user side |

**Response:** `{ "ok": true }`

**What happens internally:**
- `TRIP_ACCEPTED` → Removes trip from all driver queues, notifies driver + user
- `TRIP_CLOSED_BY_USER` / `RIDE_REVOKED` → Removes trip from all driver queues
- `TRIP_CANCELLED` / `TRIP_COMPLETED` → Notifies trip room members only

---

#### `GET /health`

Health check endpoint. Returns:
```json
{ "status": "ok", "uptime": 12345.67 }
```

---

### APIs Node Server Calls on PHP Backend

> ⚠️ **PHP must expose these endpoints.** Base URL is configured in Node as `BACKEND_BASE_URL`.

| Method | Endpoint | Params/Body | When Node Calls It |
|---|---|---|---|
| `GET` | `/verify-driver` | `?driverId=101` | Driver connects. Must return `{ "activeTripId": 123 }` or `{}` |
| `GET` | `/verify-user` | `?userId=55` | User connects. Must return `{ "activeTripId": 123 }` or `{}` |
| `GET` | `/searching-trips` | — | Driver connects with no active trip. Must return `[{ "id": 101 }, { "id": 102 }]` |
| `POST` | `/accept-trip` | `{ "tripId": 101, "driverId": 42 }` | Driver accepts a trip. Must return `{ "success": true }` or `{ "success": false }` (if already taken) |

---

## For Frontend (React Native) Developers

### Connection Setup

```js
import { io } from "socket.io-client";

const socket = io("http://<node-server>:4000", {
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
});
```

---

### Driver App — Events to EMIT

#### `REGISTER_DRIVER` — On app open / reconnect

```js
socket.emit("REGISTER_DRIVER", {
  driverId: 42,          // required
  tripId: 123 || null,   // pass if driver had an active trip (stored locally)
});
```

#### `ACCEPT_OFFER` — Driver taps Accept

```js
socket.emit("ACCEPT_OFFER", { tripId: 101 });
```

#### `REJECT_OFFER` — Driver taps Reject

```js
socket.emit("REJECT_OFFER", { tripId: 101 });
```

---

### Driver App — Events to LISTEN

#### `OFFER_TRIP` — Show a trip to the driver

```js
socket.on("OFFER_TRIP", ({ tripId, screenTimeout }) => {
  // tripId: number — the trip to show
  // screenTimeout: number — seconds for the countdown display (usually 30)
  setCurrentTrip(tripId);
  setTimeLeft(screenTimeout);
});
```

> **Important:** The server sends ONE trip at a time. No queue management needed on the app.

#### `OFFER_EXPIRED` — Screen timer expired, server is rotating

```js
socket.on("OFFER_EXPIRED", ({ tripId }) => {
  // Clear the current trip display
  // Next OFFER_TRIP will arrive automatically after ~3 seconds
  setCurrentTrip(null);
});
```

#### `TRIP_ACCEPTED` — Driver's accept was confirmed

```js
socket.on("TRIP_ACCEPTED", ({ tripId, driverId }) => {
  // Trip is now active — show active trip UI
  setCurrentTrip(null);
  setActiveTrip(tripId);
});
```

#### `CLOSE_RIDE_REQ` — Another driver accepted this trip

```js
socket.on("CLOSE_RIDE_REQ", ({ tripId }) => {
  // If this trip is currently displayed, it will be auto-replaced
  // by the next OFFER_TRIP from server. No action needed.
});
```

#### `TRIP_CANCELLED` — Active trip was cancelled

```js
socket.on("TRIP_CANCELLED", ({ tripId }) => {
  setActiveTrip(null);
});
```

#### `TRIP_COMPLETED` — Active trip completed

```js
socket.on("TRIP_COMPLETED", ({ tripId }) => {
  setActiveTrip(null);
});
```

---

### User App — Events to EMIT

#### `REGISTER_USER` — On app open / reconnect

```js
socket.emit("REGISTER_USER", {
  userId: 55,            // required
  tripId: 123 || null,   // pass if user had an active trip
});
```

---

### User App — Events to LISTEN

| Event | Payload | Meaning |
|---|---|---|
| `TRIP_ACCEPTED` | `{ tripId, driverId }` | A driver accepted! Show driver info |
| `TRIP_CANCELLED` | `{ tripId }` | Trip was cancelled |
| `RIDE_CANCEL_BY_USER` | `{ tripId }` | Confirmation of user's own cancellation |
| `RIDE_CANCEL_BY_DRIVER` | `{ tripId }` | Driver cancelled the trip |
| `TRIP_COMPLETED` | `{ tripId }` | Trip finished |

---

## Timer System (How it works — FYI)

Developers **don't need to implement timers** on the app. The server handles everything. But for context:

| Timer | Duration | Managed by | Purpose |
|---|---|---|---|
| **Background** | 5 minutes | Server | Each trip lives in a driver's queue for max 5 mins, then auto-removed |
| **Screen** | 30 seconds | Server (authority) + App (display only) | Trip shown for 30s, then auto-rotates to next trip |

- The `screenTimeout` value in `OFFER_TRIP` is the number to count down on screen
- Even if the app's visual countdown drifts, the server enforces the real timeout
- After timeout/reject, there's a **3-second gap** before the next trip appears

---

## Example: Full Trip Lifecycle

```
1. User creates trip     → PHP POST /create-trip
2. PHP filters drivers   → finds drivers [42, 55, 78] within 3km
3. PHP notifies Node     → POST /notify-new-trip { tripId: 500, drivers: [42, 55, 78] }
4. Node queues trip      → added to each driver's queue
5. Node offers to idle   → OFFER_TRIP { tripId: 500, screenTimeout: 30 } to each driver
6. Driver 42 ACCEPTS     → ACCEPT_OFFER { tripId: 500 }
7. Node calls PHP        → POST /accept-trip { tripId: 500, driverId: 42 }
8. PHP confirms          → { success: true }
9. PHP updates Node      → POST /trip-status-update { status: TRIP_ACCEPTED, ... }
10. Node notifies all:
    - Driver 42 + User   → TRIP_ACCEPTED { tripId: 500, driverId: 42 }
    - Drivers 55, 78     → CLOSE_RIDE_REQ { tripId: 500 }
    - Trip 500 removed from all queues
11. Driver completes     → PHP POST /complete-trip
12. PHP updates Node     → POST /trip-status-update { status: TRIP_COMPLETED, ... }
13. Node notifies room   → TRIP_COMPLETED { tripId: 500 }
```
