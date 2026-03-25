import express from "express";

const app = express();
app.use(express.json());

let players = {};
let games = {};
let nextPlayerId = 1;
let nextGameId = 1;

// ----------------------
// HELPERS
// ----------------------
function getPlayerId(body) {
  if (!body) return null;

  if (body.playerId !== undefined) return Number(body.playerId);
  if (body.player_id !== undefined) return Number(body.player_id);

  return null;
}

// ----------------------
// RESET
// ----------------------
app.post("/api/reset", (req, res) => {
  players = {};
  games = {};
  nextPlayerId = 1;
  nextGameId = 1;

  res.status(200).json({ status: "reset" });
});

// ----------------------
// PLAYERS
// ----------------------
app.post("/api/players", (req, res) => {
  const username = req.body.username;

  if (!username) {
    return res.status(400).json({ error: "username required" });
  }

  const id = nextPlayerId++;

  players[id] = {
    stats: {
      games_played: 0,
      wins: 0,
      losses: 0,
      total_shots: 0,
      total_hits: 0,
      accuracy: 0
    }
  };

  res.status(201).json({ player_id: id });
});

app.get("/api/players/:id/stats", (req, res) => {
  const p = players[req.params.id];
  if (!p) return res.status(404).json({ error: "not found" });

  res.json(p.stats);
});

// ----------------------
// CREATE GAME (FIXED)
// ----------------------
app.post("/api/games", (req, res) => {
  const body = req.body || {};

  const playerId = getPlayerId(body);
  const grid_size = body.grid_size ?? 10;

  if (grid_size < 5 || grid_size > 15) {
    return res.status(400).json({ error: "invalid grid size" });
  }

  const id = nextGameId++;

  games[id] = {
    game_id: id,
    grid_size,
    status: "waiting",
    players: [],
    ships: {},
    placed: {}
  };

  // only add player if provided
  if (playerId !== null) {
    games[id].players.push(playerId);
  }

  res.status(201).json({ game_id: id });
});

// ----------------------
// GET GAME
// ----------------------
app.get("/api/games/:id", (req, res) => {
  const g = games[req.params.id];
  if (!g) return res.status(404).json({ error: "not found" });

  res.json(g);
});

// ----------------------
// JOIN GAME (FIXED)
// ----------------------
app.post("/api/games/:id/join", (req, res) => {
  const g = games[req.params.id];
  if (!g) return res.status(404).json({ error: "not found" });

  const playerId = getPlayerId(req.body);
  if (playerId === null) {
    return res.status(400).json({ error: "player_id required" });
  }

  g.players.push(playerId);

  if (g.players.length >= 2) {
    g.status = "placing";
  }

  res.status(200).json({ message: "joined" });
});

// ----------------------
app.get("/", (req, res) => {
  res.send("Battleship API running");
});

// ----------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Running"));