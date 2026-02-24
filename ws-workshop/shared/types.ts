export type ClientMessage =
  | { type: "set-nick"; nick: string }
  | { type: "chat"; text: string }
  | { type: "typing" }
  | { type: "leave" }
  | { type: "join-room"; room: string }
  | { type: "leave-room"; room: string };

export type ServerMessage =
  | { type: "chat"; nick: string; text: string; ts: number }
  | { type: "system"; text: string }
  | { type: "user-list"; room: string; users: string[] }
  | { type: "room-list"; rooms: string[] }
  | { type: "room-current"; room: string }
  | { type: "typing"; nick: string };
