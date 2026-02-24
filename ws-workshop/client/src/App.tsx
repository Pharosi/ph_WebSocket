import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { ClientMessage, ServerMessage } from "../../shared/types";

const WS_URL = "ws://localhost:8080";
const DEFAULT_ROOM = "#general";

type ConnectionState = "Connexion..." | "Connecte" | "Deconnecte" | "Erreur de reseau";

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function normalizeRoomName(raw: string): string {
  const compact = raw.trim().toLowerCase().replace(/\s+/g, "-");
  if (!compact) {
    return "";
  }

  return compact.startsWith("#") ? compact : `#${compact}`;
}

function isServerMessage(payload: unknown): payload is ServerMessage {
  if (!payload || typeof payload !== "object" || !("type" in payload)) {
    return false;
  }

  const candidate = payload as { type?: string };
  return ["chat", "system", "user-list", "typing", "room-list", "room-current"].includes(
    String(candidate.type),
  );
}

export default function App() {
  const [nickname, setNickname] = useState<string>("");
  const [nicknameDraft, setNicknameDraft] = useState<string>("");
  const [input, setInput] = useState<string>("");
  const [messages, setMessages] = useState<ServerMessage[]>([]);
  const [users, setUsers] = useState<string[]>([]);
  const [typingNick, setTypingNick] = useState<string>("");
  const [status, setStatus] = useState<ConnectionState>("Connexion...");
  const [rooms, setRooms] = useState<string[]>([DEFAULT_ROOM]);
  const [activeRoom, setActiveRoom] = useState<string>(DEFAULT_ROOM);
  const [roomDraft, setRoomDraft] = useState<string>("");

  const wsRef = useRef<WebSocket | null>(null);
  const nicknameRef = useRef<string>("");
  const activeRoomRef = useRef<string>(DEFAULT_ROOM);
  const endRef = useRef<HTMLDivElement | null>(null);
  const typingDebounceRef = useRef<number | null>(null);
  const typingIndicatorRef = useRef<number | null>(null);

  const canChat = useMemo(
    () => Boolean(nickname && wsRef.current?.readyState === WebSocket.OPEN),
    [nickname, status],
  );

  useEffect(() => {
    nicknameRef.current = nickname;
  }, [nickname]);

  useEffect(() => {
    activeRoomRef.current = activeRoom;
  }, [activeRoom]);

  useEffect(() => {
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus("Connecte");
    };

    ws.onmessage = (event) => {
      try {
        const parsed = JSON.parse(String(event.data)) as unknown;
        if (!isServerMessage(parsed)) {
          return;
        }

        switch (parsed.type) {
          case "chat":
          case "system": {
            setMessages((prev) => [...prev, parsed]);
            return;
          }
          case "user-list": {
            if (parsed.room === activeRoomRef.current) {
              setUsers(parsed.users);
            }
            return;
          }
          case "room-list": {
            setRooms(parsed.rooms);
            return;
          }
          case "room-current": {
            setActiveRoom(parsed.room);
            setTypingNick("");
            return;
          }
          case "typing": {
            if (parsed.nick === nicknameRef.current) {
              return;
            }

            setTypingNick(parsed.nick);
            if (typingIndicatorRef.current) {
              window.clearTimeout(typingIndicatorRef.current);
            }
            typingIndicatorRef.current = window.setTimeout(() => {
              setTypingNick("");
            }, 1200);
            return;
          }
          default:
            return;
        }
      } catch {
        setMessages((prev) => [...prev, { type: "system", text: "Message JSON invalide recu." }]);
      }
    };

    ws.onclose = () => {
      setStatus("Deconnecte");
      setMessages((prev) => [...prev, { type: "system", text: "Connexion fermee." }]);
    };

    ws.onerror = () => {
      setStatus("Erreur de reseau");
      setMessages((prev) => [...prev, { type: "system", text: "Impossible de communiquer avec le serveur." }]);
    };

    return () => {
      ws.close();
      if (typingDebounceRef.current) {
        window.clearTimeout(typingDebounceRef.current);
      }
      if (typingIndicatorRef.current) {
        window.clearTimeout(typingIndicatorRef.current);
      }
    };
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const sendMessage = (payload: ClientMessage) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return;
    }

    wsRef.current.send(JSON.stringify(payload));
  };

  const joinRoom = (room: string) => {
    const normalized = normalizeRoomName(room);
    if (!normalized) {
      return;
    }

    setUsers([]);
    sendMessage({ type: "join-room", room: normalized });
  };

  const submitNickname = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleanNickname = nicknameDraft.trim();
    if (!cleanNickname || nickname) {
      return;
    }

    setNickname(cleanNickname);
    sendMessage({ type: "set-nick", nick: cleanNickname });
  };

  const submitMessage = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleanInput = input.trim();
    if (!cleanInput || !canChat) {
      return;
    }

    sendMessage({ type: "chat", text: cleanInput });
    setInput("");
  };

  const submitRoom = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = normalizeRoomName(roomDraft);
    if (!normalized) {
      return;
    }

    joinRoom(normalized);
    setRoomDraft("");
  };

  const onInputChange = (value: string) => {
    setInput(value);
    if (!canChat) {
      return;
    }

    if (typingDebounceRef.current) {
      window.clearTimeout(typingDebounceRef.current);
    }

    typingDebounceRef.current = window.setTimeout(() => {
      sendMessage({ type: "typing" });
    }, 300);
  };

  const toggleChatParticipation = () => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    if (nickname) {
      sendMessage({ type: "leave" });
      setNickname("");
      setInput("");
      return;
    }

    const cleanNickname = nicknameDraft.trim();
    if (!cleanNickname) {
      setMessages((prev) => [...prev, { type: "system", text: "Saisissez un pseudo pour entrer." }]);
      return;
    }

    setNickname(cleanNickname);
    sendMessage({ type: "set-nick", nick: cleanNickname });
  };

  return (
    <main className="shell">
      <section className="panel">
        <header className="panel-header">
          <div>
            <p className="eyebrow">COURS WEBSOCKET</p>
            <h1>Salon Vrai Chat</h1>
            <p className="active-room">Room active : {activeRoom}</p>
          </div>
          <div className="header-actions">
            <span className={`status ${status === "Connecte" ? "ok" : "warn"}`}>{status}</span>
            <button
              type="button"
              className="disconnect-btn"
              onClick={toggleChatParticipation}
              disabled={!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN}
            >
              {nickname ? "Quitter la conversation" : "Entrer dans la conversation"}
            </button>
          </div>
        </header>

        <div className="workspace">
          <aside className="rooms-panel" aria-label="Rooms disponibles">
            <h2>Rooms</h2>
            <form className="room-form" onSubmit={submitRoom}>
              <input
                value={roomDraft}
                onChange={(event) => setRoomDraft(event.target.value)}
                placeholder="#nouvelle-room"
              />
              <button type="submit">Creer / rejoindre</button>
            </form>

            <div className="room-list">
              {rooms.map((room) => (
                <button
                  key={room}
                  type="button"
                  className={`room-item ${room === activeRoom ? "active" : ""}`}
                  onClick={() => joinRoom(room)}
                >
                  {room}
                </button>
              ))}
            </div>
          </aside>

          <section className="chat-panel">
            <form className="nickname-form" onSubmit={submitNickname}>
              <label htmlFor="nickname">Pseudo</label>
              <input
                id="nickname"
                value={nicknameDraft}
                onChange={(event) => setNicknameDraft(event.target.value)}
                placeholder="Ex: Raphael"
                disabled={Boolean(nickname)}
              />
              <button type="submit" disabled={Boolean(nickname)}>
                {nickname ? "Pseudo verrouille" : "Valider"}
              </button>
            </form>

            <section className="online-users" aria-label="Utilisateurs en ligne">
              <p>En ligne dans {activeRoom}</p>
              <div>
                {users.length === 0 ? <span className="user-pill empty">Aucun utilisateur</span> : null}
                {users.map((user) => (
                  <span key={user} className="user-pill">
                    {user}
                  </span>
                ))}
              </div>
            </section>

            <div className="messages" role="log" aria-live="polite">
              {messages.map((message, index) => {
                if (message.type === "system") {
                  return (
                    <article key={`system-${index}`} className="message system">
                      <span>{message.text}</span>
                    </article>
                  );
                }

                if (message.type === "chat") {
                  return (
                    <article key={`chat-${message.nick}-${message.ts}-${index}`} className="message chat">
                      <p>
                        <strong>{message.nick}</strong>
                        <span>{message.text}</span>
                      </p>
                      <time className="chat-time">{formatTimestamp(message.ts)}</time>
                    </article>
                  );
                }

                return null;
              })}
              <div ref={endRef} />
            </div>

            {typingNick ? <p className="typing-indicator">{typingNick} est en train d'ecrire...</p> : null}

            <form className="composer" onSubmit={submitMessage}>
              <input
                value={input}
                onChange={(event) => onInputChange(event.target.value)}
                placeholder={nickname ? `Message dans ${activeRoom}` : "Definissez d'abord votre pseudo"}
                disabled={!canChat}
              />
              <button type="submit" disabled={!canChat}>
                Envoyer
              </button>
            </form>
          </section>
        </div>
      </section>
    </main>
  );
}
