# Backend2-Realtime — Socket & API Documentation

A Node.js real-time server built with **Express** + **Socket.IO**.  
Runs on **port 4000** and communicates with the main backend at `http://localhost:8000`.

---

## Table of Contents

- [Socket.IO Events](#socketio-events)
  - [Client → Server (Listeners)](#client--server-listeners)
  - [Server → Client (Emitters)](#server--client-emitters)
- [REST API Endpoints](#rest-api-endpoints)

---

## Socket.IO Events

### Client → Server (Listeners)

These are events the **client emits** and the server listens for.

---

#### `REGISTER_USER`

Registers a user and joins them to a trip room so they receive trip-related events.

**Payload:**

```json
{
  "userId": "string",
  "tripId": "string | number"
}
```

| Field    | Type             | Required | Description                  |
|----------|------------------|----------|------------------------------|
| `userId` | `string`         | ✅       | The ID of the user           |
| `tripId` | `string\|number` | ✅       | The trip the user belongs to |

**Side Effects:**
- Socket joins the room `trip_<tripId>`

---

#### `REGISTER_DRIVER`

Registers a driver online, optionally joins them to a trip room, and emits any currently searching trips back to this driver.

**Payload:**

```json
{
  "driverId": "string",
  "tripId": "string | number | null"
}
```

| Field      | Type             | Required | Description                                          |
|------------|------------------|----------|------------------------------------------------------|
| `driverId` | `string`         | ✅       | Unique ID of the driver                              |
| `tripId`   | `string\|number` | ❌       | If provided, driver joins the corresponding trip room |

**Side Effects:**
- Tracks driver's `socketId` in memory (`onlineDrivers`)
- If `tripId` is provided, socket joins room `trip_<tripId>`
- Fetches all trips with status `searching` from the backend and emits a `NEW_RIDE` event for each one back to this driver

---

### Server → Client (Emitters)

These are events the **server emits** to connected clients.

---

#### `NEW_RIDE`

Notifies a driver that a new ride request is available.

**Payload:**

```json
{
  "tripId": "string | number",
  "AFTER_COMPLETE": "boolean"
}
```

| Field            | Type             | Description                                                  |
|------------------|------------------|--------------------------------------------------------------|
| `tripId`         | `string\|number` | The ID of the new trip                                       |
| `AFTER_COMPLETE` | `boolean`        | `true` if the ride was created after a trip was completed. Defaults to `false` |

**Sent to:** All online drivers (via REST trigger) or a specific driver (on `REGISTER_DRIVER`)

---

#### `TRIP_ACCEPTED`

Notifies everyone in the trip room that a driver has accepted the trip.

**Payload:**

```json
{
  "tripId": "string | number",
  "driverId": "string"
}
```

| Field      | Type             | Description              |
|------------|------------------|--------------------------|
| `tripId`   | `string\|number` | The accepted trip's ID   |
| `driverId` | `string`         | The driver who accepted  |

**Sent to:** All sockets in room `trip_<tripId>`

---

#### `CLOSE_RIDE_REQ`

Broadcast to all connected clients to signal that this ride request should be closed (e.g., no longer shown to other drivers).

**Payload:**

```json
{
  "driverId": "string",
  "tripId": "string | number"
}
```

**Sent to:** All connected sockets (`io.emit`)

---

#### `TRIP_CANCELLED`

Notifies everyone in the trip room that the trip has been cancelled.

**Payload:**

```json
{
  "tripId": "string | number"
}
```

**Sent to:** All sockets in room `trip_<tripId>`

---

#### `TRIP_CLOSED_BY_USER`

Broadcast to all connected clients that a user closed/withdrew the trip.

**Payload:**

```json
{
  "tripId": "string | number"
}
```

**Sent to:** All connected sockets (`io.emit`)

---

#### `TRIP_COMPLETED`

Notifies everyone in the trip room that the trip has been completed.

**Payload:**

```json
{
  "tripId": "string | number"
}
```

**Sent to:** All sockets in room `trip_<tripId>`

---

## REST API Endpoints

All endpoints accept and return **JSON**. All successful responses return:

```json
{ "ok": true }
```

---

### `POST /notify-new-trip`

Broadcasts a new ride request to **all currently online drivers**.

**Request Body:**

```json
{
  "tripId": "string | number",
  "AFTER_COMPLETE": "boolean"
}
```

| Field            | Type             | Required | Description                                          |
|------------------|------------------|----------|------------------------------------------------------|
| `tripId`         | `string\|number` | ✅       | The ID of the new trip                               |
| `AFTER_COMPLETE` | `boolean`        | ❌       | Indicates if this trip appeared after a prior completion. Defaults to `false` |

**Emits:** `NEW_RIDE` → all online drivers

---

### `POST /notify-trip-accepted`

Notifies the trip room that a driver accepted the trip, and tells all clients to close the ride request UI.

**Request Body:**

```json
{
  "tripId": "string | number",
  "driverId": "string"
}
```

| Field      | Type             | Required | Description                     |
|------------|------------------|----------|---------------------------------|
| `tripId`   | `string\|number` | ✅       | ID of the trip that was accepted |
| `driverId` | `string`         | ✅       | ID of the driver who accepted   |

**Emits:**
- `TRIP_ACCEPTED` → room `trip_<tripId>`
- `CLOSE_RIDE_REQ` → all connected sockets

**Side Effect:** The accepting driver's socket is joined to room `trip_<tripId>` (if not already)

---

### `POST /notify-trip-cancelled`

Notifies all participants in a trip room that the trip was cancelled.

**Request Body:**

```json
{
  "tripId": "string | number"
}
```

| Field    | Type             | Required | Description          |
|----------|------------------|----------|----------------------|
| `tripId` | `string\|number` | ✅       | ID of the cancelled trip |

**Emits:** `TRIP_CANCELLED` → room `trip_<tripId>`

---

### `POST /notify-trip-closed`

Broadcast to all clients that a user closed/withdrew the trip.

**Request Body:**

```json
{
  "tripId": "string | number"
}
```

| Field    | Type             | Required | Description        |
|----------|------------------|----------|--------------------|
| `tripId` | `string\|number` | ✅       | ID of the closed trip |

**Emits:** `TRIP_CLOSED_BY_USER` → all connected sockets

---

### `POST /notify-trip-completed`

Notifies all participants in the trip room that the trip is complete.

**Request Body:**

```json
{
  "tripId": "string | number"
}
```

| Field    | Type             | Required | Description           |
|----------|------------------|----------|-----------------------|
| `tripId` | `string\|number` | ✅       | ID of the completed trip |

**Emits:** `TRIP_COMPLETED` → room `trip_<tripId>`

---

## Room Naming Convention

All trip-specific rooms follow this pattern:

```
trip_<tripId>
```

For example, a trip with ID `42` uses the room name `trip_42`.

---

## Driver Online State

The server maintains an in-memory map of currently online drivers:

```
onlineDrivers: { [driverId]: socketId }
```

- Populated on `REGISTER_DRIVER`
- Automatically cleared when the driver's socket **disconnects**
