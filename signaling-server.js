const { createServer } = require("http");
const { randomUUID } = require("crypto");
const { WebSocketServer } = require("ws");

const port = Number(process.env.PORT || 3001);
const rooms = new Map();

function send(socket, message) {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function roomPeers(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Map());
  }

  return rooms.get(roomId);
}

function broadcast(roomId, fromId, message) {
  const peers = rooms.get(roomId);
  if (!peers) return;

  for (const [peerId, peer] of peers.entries()) {
    if (peerId !== fromId) {
      send(peer.socket, message);
    }
  }
}

const server = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
    return;
  }

  response.writeHead(200, { "content-type": "text/plain" });
  response.end("PulseCall signaling server");
});

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (socket) => {
  socket.peerId = null;
  socket.roomId = null;

  socket.on("message", (raw) => {
    let message;

    try {
      message = JSON.parse(raw.toString());
    } catch {
      send(socket, { type: "error", message: "Invalid message." });
      return;
    }

    if (message.type === "join") {
      const roomId = String(message.roomId || "").trim();
      const name = String(message.name || "Guest").trim().slice(0, 40);

      if (!roomId) {
        send(socket, { type: "error", message: "Room ID is required." });
        return;
      }

      const peers = roomPeers(roomId);
      const peerId = randomUUID();
      const existingPeers = [...peers.entries()].map(([id, peer]) => ({
        id,
        name: peer.name,
      }));

      socket.peerId = peerId;
      socket.roomId = roomId;
      peers.set(peerId, { socket, name });

      send(socket, {
        type: "joined",
        peerId,
        peers: existingPeers,
      });

      broadcast(roomId, peerId, {
        type: "peer-joined",
        peer: { id: peerId, name },
      });
      return;
    }

    if (!socket.peerId || !socket.roomId) {
      send(socket, { type: "error", message: "Join a room before signaling." });
      return;
    }

    if (message.type === "signal" && message.to) {
      const peers = rooms.get(socket.roomId);
      const recipient = peers && peers.get(message.to);

      if (recipient) {
        send(recipient.socket, {
          type: "signal",
          from: socket.peerId,
          payload: message.payload,
        });
      }
    }
  });

  socket.on("close", () => {
    const { roomId, peerId } = socket;
    if (!roomId || !peerId) return;

    const peers = rooms.get(roomId);
    if (!peers) return;

    peers.delete(peerId);
    broadcast(roomId, peerId, { type: "peer-left", peerId });

    if (peers.size === 0) {
      rooms.delete(roomId);
    }
  });
});

server.listen(port, () => {
  console.log(`PulseCall signaling server running on port ${port}`);
});
