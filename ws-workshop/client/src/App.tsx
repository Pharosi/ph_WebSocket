import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { ClientMessage, ServerMessage } from "../../shared/types";

const API_URL = "http://localhost:8080";
const WS_URL = "ws://localhost:8080";
const DEFAULT_ROOM = "#general";
const TOKEN_STORAGE_KEY = "ws_token";
const USER_STORAGE_KEY = "ws_username";

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
  const [username, setUsername] = useState<string>(() => localStorage.getItem(USER_STORAGE_KEY) ?? "");
  const [password, setPassword] = useState<string>("");
  const [token, setToken] = useState<string>(() => localStorage.getItem(TOKEN_STORAGE_KEY) ?? "");
  const [authError, setAuthError] = useState<string>("");
  const [input, setInput] = useState<string>("");
  const [messages, setMessages] = useState<ServerMessage[]>([]);
  const [users, setUsers] = useState<string[]>([]);
  const [typingNick, setTypingNick] = useState<string>("");
  const [status, setStatus] = useState<ConnectionState>("Deconnecte");
  const [rooms, setRooms] = useState<string[]>([DEFAULT_ROOM]);
  const [activeRoom, setActiveRoom] = useState<string>(DEFAULT_ROOM);
  const [roomDraft, setRoomDraft] = useState<string>("");

  const wsRef = useRef<WebSocket | null>(null);
  const activeRoomRef = useRef<string>(DEFAULT_ROOM);
  const endRef = useRef<HTMLDivElement | null>(null);
  const typingDebounceRef = useRef<number | null>(null);
  const typingIndicatorRef = useRef<number | null>(null);

  const canChat = useMemo(() => wsRef.current?.readyState === WebSocket.OPEN, [status]);

  useEffect(() => {
    activeRoomRef.current = activeRoom;
  }, [activeRoom]);

  useEffect(() => {
    if (!token) {
      wsRef.current?.close();
      wsRef.current = null;
      setStatus("Deconnecte");
      setUsers([]);
      setTypingNick("");
      return;
    }

    setStatus("Connexion...");

    const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus("Connecte");
      setAuthError("");
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
            if (parsed.nick === username) {
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

    ws.onclose = (event) => {
      setStatus("Deconnecte");
      if (event.code === 4001) {
        localStorage.removeItem(TOKEN_STORAGE_KEY);
        setToken("");
        setAuthError("Session invalide ou expiree. Reconnectez-vous.");
      }
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
  }, [token, username]);

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

  const submitLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const rawUsername = username.trim();
    const loginKey = rawUsername.toLowerCase();
    if (!loginKey || !password.trim()) {
      setAuthError("Saisissez un username et un password.");
      return;
    }

    try {
      const response = await fetch(`${API_URL}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: loginKey, password }),
      });

      const payload = (await response.json()) as { token?: string; username?: string; error?: string };
      if (!response.ok || !payload.token) {
        setAuthError(payload.error ?? "Echec de connexion.");
        return;
      }

      const resolvedUsername = payload.username ?? rawUsername;
      setUsername(resolvedUsername);
      setToken(payload.token);
      localStorage.setItem(USER_STORAGE_KEY, resolvedUsername);
      localStorage.setItem(TOKEN_STORAGE_KEY, payload.token);
      setPassword("");
      setAuthError("");
      setMessages((prev) => [...prev, { type: "system", text: `Authentifie en tant que ${resolvedUsername}.` }]);
    } catch {
      setAuthError("Le serveur est indisponible.");
    }
  };

  const logout = () => {
    wsRef.current?.close();
    wsRef.current = null;
    setToken("");
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    setAuthError("");
    setStatus("Deconnecte");
    setUsers([]);
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
            <button type="button" className="disconnect-btn" onClick={logout} disabled={!token}>
              Se deconnecter
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
                disabled={!token}
              />
              <button type="submit" disabled={!token}>
                Creer / rejoindre
              </button>
            </form>

            <div className="room-list">
              {rooms.map((room) => (
                <button
                  key={room}
                  type="button"
                  className={`room-item ${room === activeRoom ? "active" : ""}`}
                  onClick={() => joinRoom(room)}
                  disabled={!token}
                >
                  {room}
                </button>
              ))}
            </div>
          </aside>

          <section className="chat-panel">
            <form className="auth-form" onSubmit={submitLogin}>
              <input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="Username (raphael ou beatrice)"
                disabled={Boolean(token)}
              />
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Password"
                disabled={Boolean(token)}
              />
              <button type="submit" disabled={Boolean(token)}>
                {token ? "Authentifie" : "Se connecter"}
              </button>
            </form>

            {authError ? <p className="auth-error">{authError}</p> : null}

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
                placeholder={token ? `Message dans ${activeRoom}` : "Connectez-vous d'abord"}
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
