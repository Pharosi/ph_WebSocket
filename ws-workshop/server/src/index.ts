import http from "http";
import jwt from "jsonwebtoken";
import { WebSocket, WebSocketServer } from "ws";
import { ClientMessage, ServerMessage } from "../../shared/types";

type ChatSocket = WebSocket & { username: string; room: string };
type AuthPayload = { username: string };

const PORT = 8080;
const SECRET = "mon-secret-ws-tp";
const DEFAULT_ROOM = "#general";

const validUsers = new Map<string, { password: string; displayName: string }>([
  ["raphael", { password: "pass1", displayName: "Raphael" }],
  ["beatrice", { password: "pass2", displayName: "Béatrice" }],
  ["béatrice", { password: "pass2", displayName: "Béatrice" }],
]);

const rooms = new Map<string, Set<WebSocket>>([[DEFAULT_ROOM, new Set<WebSocket>()]]);

function setCorsHeaders(res: http.ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function jsonResponse(
  res: http.ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>,
): void {
  setCorsHeaders(res);
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    req.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
    });

    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(JSON.parse(raw || "{}"));
      } catch {
        reject(new Error("invalid-json"));
      }
    });

    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    setCorsHeaders(res);
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method === "POST" && req.url === "/login") {
    try {
      const body = (await readJsonBody(req)) as { username?: string; password?: string };
      const username = body.username?.trim().toLowerCase() ?? "";
      const password = body.password?.trim() ?? "";

      if (!username || !password) {
        jsonResponse(res, 400, { error: "Identifiants manquants." });
        return;
      }

      const user = validUsers.get(username);
      if (!user || user.password !== password) {
        jsonResponse(res, 401, { error: "Identifiants invalides." });
        return;
      }

      const token = jwt.sign({ username: user.displayName }, SECRET, { expiresIn: "1h" });
      jsonResponse(res, 200, { token, username: user.displayName });
      return;
    } catch {
      jsonResponse(res, 400, { error: "Payload JSON invalide." });
      return;
    }
  }

  jsonResponse(res, 404, { error: "Route introuvable." });
});

const wss = new WebSocketServer({ server });

function sendToClient(ws: WebSocket, message: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function parseClientMessage(raw: string): ClientMessage | null {
  try {
    return JSON.parse(raw) as ClientMessage;
  } catch {
    return null;
  }
}

function ensureRoom(room: string): Set<WebSocket> {
  const existing = rooms.get(room);
  if (existing) {
    return existing;
  }

  const created = new Set<WebSocket>();
  rooms.set(room, created);
  return created;
}

function removeRoomIfEmpty(room: string): void {
  if (room === DEFAULT_ROOM) {
    return;
  }

  const members = rooms.get(room);
  if (members && members.size === 0) {
    rooms.delete(room);
  }
}

function normalizeRoomName(rawRoom: string): string | null {
  const compact = rawRoom.trim().toLowerCase().replace(/\s+/g, "-");
  if (!compact) {
    return null;
  }

  return compact.startsWith("#") ? compact : `#${compact}`;
}

function getRoomsList(): string[] {
  const list = Array.from(rooms.keys()).sort((a, b) => a.localeCompare(b));
  if (!list.includes(DEFAULT_ROOM)) {
    list.unshift(DEFAULT_ROOM);
  }

  return list;
}

function broadcastRoomList(): void {
  const payload: ServerMessage = { type: "room-list", rooms: getRoomsList() };
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(payload));
    }
  });
}

function broadcastToRoom(room: string, message: ServerMessage, exclude?: WebSocket): void {
  const members = rooms.get(room);
  if (!members) {
    return;
  }

  members.forEach((member) => {
    if (member !== exclude && member.readyState === WebSocket.OPEN) {
      member.send(JSON.stringify(message));
    }
  });
}

function getUsersForRoom(room: string): string[] {
  const members = rooms.get(room);
  if (!members) {
    return [];
  }

  return Array.from(members)
    .map((member) => (member as ChatSocket).username)
    .filter((username): username is string => Boolean(username))
    .sort((a, b) => a.localeCompare(b));
}

function broadcastUserList(room: string): void {
  const users = getUsersForRoom(room);
  broadcastToRoom(room, { type: "user-list", room, users });
}

function sendRoomState(socket: ChatSocket): void {
  sendToClient(socket, { type: "room-current", room: socket.room });
  sendToClient(socket, { type: "user-list", room: socket.room, users: getUsersForRoom(socket.room) });
}

function moveSocketToRoom(socket: ChatSocket, nextRoom: string): void {
  const previousRoom = socket.room;
  if (previousRoom === nextRoom) {
    sendRoomState(socket);
    return;
  }

  const previousMembers = ensureRoom(previousRoom);
  previousMembers.delete(socket);

  broadcastToRoom(previousRoom, {
    type: "system",
    text: `${socket.username} a quitte ${previousRoom}`,
  });

  broadcastUserList(previousRoom);
  removeRoomIfEmpty(previousRoom);

  const nextMembers = ensureRoom(nextRoom);
  nextMembers.add(socket);
  socket.room = nextRoom;

  sendRoomState(socket);

  broadcastToRoom(nextRoom, {
    type: "system",
    text: `${socket.username} a rejoint ${nextRoom}`,
  });

  broadcastUserList(nextRoom);
  broadcastRoomList();
}

function getTokenFromRequest(req: http.IncomingMessage): string | null {
  if (!req.url) {
    return null;
  }

  const host = req.headers.host ?? `localhost:${PORT}`;
  const url = new URL(req.url, `http://${host}`);
  return url.searchParams.get("token");
}

function verifyToken(token: string | null): string | null {
  if (!token) {
    return null;
  }

  try {
    const decoded = jwt.verify(token, SECRET) as AuthPayload | string;
    if (typeof decoded !== "object" || !decoded.username) {
      return null;
    }

    return decoded.username;
  } catch {
    return null;
  }
}

wss.on("connection", (ws, req) => {
  const token = getTokenFromRequest(req);
  const username = verifyToken(token);

  if (!username) {
    ws.close(4001, "Unauthorized");
    return;
  }

  const socket = ws as ChatSocket;
  const clientAddress = req.socket.remoteAddress ?? "unknown";

  socket.username = username;
  socket.room = DEFAULT_ROOM;
  ensureRoom(DEFAULT_ROOM).add(socket);

  console.log(`Client connecte : ${clientAddress} (${socket.username})`);

  broadcastToRoom(socket.room, {
    type: "system",
    text: `${socket.username} a rejoint ${socket.room}`,
  });

  broadcastUserList(socket.room);

  ws.on("message", (message) => {
    const payload = parseClientMessage(message.toString());
    if (!payload || !payload.type) {
      sendToClient(ws, { type: "system", text: "Message invalide." });
      return;
    }

    switch (payload.type) {
      case "join-room": {
        const nextRoom = normalizeRoomName(payload.room);
        if (!nextRoom) {
          sendToClient(ws, { type: "system", text: "Nom de room invalide." });
          return;
        }

        moveSocketToRoom(socket, nextRoom);
        return;
      }

      case "leave-room": {
        const room = normalizeRoomName(payload.room);
        if (!room || room !== socket.room) {
          return;
        }

        if (socket.room === DEFAULT_ROOM) {
          sendToClient(ws, { type: "system", text: "Vous etes deja dans #general." });
          return;
        }

        moveSocketToRoom(socket, DEFAULT_ROOM);
        return;
      }

      case "chat": {
        const text = payload.text.trim();
        if (!text) {
          return;
        }

        broadcastToRoom(socket.room, {
          type: "chat",
          nick: socket.username,
          text,
          ts: Date.now(),
        });
        return;
      }

      case "typing": {
        broadcastToRoom(socket.room, { type: "typing", nick: socket.username }, ws);
        return;
      }

      default: {
        sendToClient(ws, { type: "system", text: "Type non supporte." });
      }
    }
  });

  ws.on("close", () => {
    const room = socket.room;
    const members = rooms.get(room);
    if (members) {
      members.delete(socket);
    }

    broadcastToRoom(room, { type: "system", text: `${socket.username} a quitte ${room}` });
    broadcastUserList(room);
    removeRoomIfEmpty(room);
    broadcastRoomList();

    console.log(`Client deconnecte : ${clientAddress} (${socket.username})`);
  });

  sendToClient(ws, { type: "system", text: `Connexion etablie pour ${socket.username}.` });
  sendToClient(ws, { type: "room-current", room: socket.room });
  sendToClient(ws, { type: "room-list", rooms: getRoomsList() });
  sendToClient(ws, { type: "user-list", room: socket.room, users: getUsersForRoom(socket.room) });
  broadcastRoomList();
});

server.listen(PORT, () => {
  console.log(`Serveur HTTP + WebSocket pret sur http://localhost:${PORT}`);
});
