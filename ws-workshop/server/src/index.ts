import { WebSocket, WebSocketServer } from "ws";
import { ClientMessage, ServerMessage } from "../../shared/types";

type ChatSocket = WebSocket & { nickname?: string; room: string };

const DEFAULT_ROOM = "#general";
const wss = new WebSocketServer({ port: 8080 });
const rooms = new Map<string, Set<WebSocket>>([[DEFAULT_ROOM, new Set<WebSocket>()]]);

console.log("Serveur WebSocket pret sur ws://localhost:8080");

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
    .map((member) => (member as ChatSocket).nickname)
    .filter((nickname): nickname is string => Boolean(nickname))
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

  const hadNickname = Boolean(socket.nickname);
  const nickname = socket.nickname;
  const previousMembers = ensureRoom(previousRoom);
  previousMembers.delete(socket);

  if (hadNickname && nickname) {
    broadcastToRoom(previousRoom, { type: "system", text: `${nickname} a quitte ${previousRoom}` });
  }

  broadcastUserList(previousRoom);
  removeRoomIfEmpty(previousRoom);

  const nextMembers = ensureRoom(nextRoom);
  nextMembers.add(socket);
  socket.room = nextRoom;

  sendRoomState(socket);

  if (hadNickname && nickname) {
    broadcastToRoom(nextRoom, { type: "system", text: `${nickname} a rejoint ${nextRoom}` });
  }

  broadcastUserList(nextRoom);
  broadcastRoomList();
}

wss.on("connection", (ws, req) => {
  const socket = ws as ChatSocket;
  const clientAddress = req.socket.remoteAddress ?? "unknown";
  socket.room = DEFAULT_ROOM;
  ensureRoom(DEFAULT_ROOM).add(socket);

  console.log(`Client connecte : ${clientAddress}`);

  ws.on("message", (message) => {
    const payload = parseClientMessage(message.toString());
    if (!payload || !payload.type) {
      sendToClient(ws, { type: "system", text: "Message invalide." });
      return;
    }

    switch (payload.type) {
      case "set-nick": {
        const nextNick = payload.nick.trim();
        if (!nextNick) {
          sendToClient(ws, { type: "system", text: "Pseudo vide refuse." });
          return;
        }

        const currentNick = socket.nickname;
        socket.nickname = nextNick;

        if (!currentNick) {
          broadcastToRoom(socket.room, { type: "system", text: `${nextNick} a rejoint ${socket.room}` });
        } else if (currentNick !== nextNick) {
          broadcastToRoom(socket.room, { type: "system", text: `${currentNick} est maintenant ${nextNick}` });
        }

        broadcastUserList(socket.room);
        return;
      }

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
        if (!socket.nickname) {
          sendToClient(ws, {
            type: "system",
            text: "Definissez un pseudo avant de discuter.",
          });
          return;
        }

        const text = payload.text.trim();
        if (!text) {
          return;
        }

        broadcastToRoom(socket.room, {
          type: "chat",
          nick: socket.nickname,
          text,
          ts: Date.now(),
        });
        return;
      }

      case "typing": {
        if (!socket.nickname) {
          return;
        }

        broadcastToRoom(socket.room, { type: "typing", nick: socket.nickname }, ws);
        return;
      }

      case "leave": {
        if (!socket.nickname) {
          return;
        }

        const oldNick = socket.nickname;
        socket.nickname = undefined;
        broadcastToRoom(socket.room, { type: "system", text: `${oldNick} a quitte ${socket.room}` });
        broadcastUserList(socket.room);
        return;
      }

      default: {
        sendToClient(ws, { type: "system", text: "Type non supporte." });
      }
    }
  });

  ws.on("close", () => {
    const nickname = socket.nickname;
    const room = socket.room;
    const members = rooms.get(room);
    if (members) {
      members.delete(socket);
    }

    if (nickname) {
      broadcastToRoom(room, { type: "system", text: `${nickname} a quitte ${room}` });
    }

    broadcastUserList(room);
    removeRoomIfEmpty(room);
    broadcastRoomList();

    console.log(`Client deconnecte : ${clientAddress}`);
  });

  sendToClient(ws, { type: "system", text: "Connexion etablie." });
  sendToClient(ws, { type: "room-current", room: socket.room });
  sendToClient(ws, { type: "room-list", rooms: getRoomsList() });
  sendToClient(ws, { type: "user-list", room: socket.room, users: getUsersForRoom(socket.room) });
  broadcastRoomList();
});
