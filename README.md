# Madness Arena Web LAN / PVP

Browser version of the local 1v1 PVP test package. The Node.js server serves the web game and relays WebSocket messages between players in the same room.

## Run locally

- Install Node.js 18 or newer.
- Run `npm ci`.
- Run `npm start` and open `http://localhost:8787`.
- Run `npm test` for the two-player relay smoke test.

## Deploy to Render

Create a **Web Service** from this repository with:

- Build command: `npm ci`
- Start command: `npm start`

The server listens on the platform-provided `PORT` and serves the WebSocket endpoint at `/ws`. Use the HTTPS service URL in browsers; the client chooses secure WebSocket (`wss`) automatically. Free instances may sleep when idle and interrupt active rooms.

## Contents

- `server.js`: HTTP static server and two-player WebSocket room relay.
- `public/`: web client, bundled Ruffle runtime, and game SWF.
- `test-lan.js`: local smoke test.

This is an experimental 1v1 build; room/player state is in memory and resets when the server restarts.