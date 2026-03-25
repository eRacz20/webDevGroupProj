import express from "express";

const app = express();
app.use(express.json());

const TEST_PASSWORD = "clemson-test-2026";

let players = {};
let games = {};
let nextPlayerId = 1;
let nextGameId = 1;

// ----------------------
// HELPERS
// ----------------------
function requireTestMode(req, res) {
  const header = req.header("X-Test-Password");
  if (header !== TEST_PASSWORD) {
    res.status(403).json({ error: "Forbidden" });
    return false;
  }
  return true;
}

function isValidCoord(x, y, size) {
  return x >= 0 && y >= 0 && x < size && y < size;
}

// ----------------------
// RESET
// ----------------------
app.post("/api/reset", (req, res) => {
  players = {};
  games = {};
  nextPlayerId = 1;
  nextGameId = 1;
  res.json({ status: "reset" });
});

// ----------------------
// PLAYERS
// ----------------------
app.post("/api/players", (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: "username required" });

  const id = nextPlayerId++;
  players[id] = {
    id,
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
// GAMES
// ----------------------
app.post("/api/games", (req, res) => {
  const { playerId, grid_size = 10 } = req.body;

  if (!playerId) return res.status(400).json({ error: "player_id required" });
  if (grid_size < 5 || grid_size > 15)
    return res.status(400).json({ error: "invalid grid size" });

  const id = nextGameId++;
  games[id] = {
    game_id: id,
    grid_size,
    status: "waiting",
    players: [playerId],
    ships: {},
    shots: [],
    placed: {}
  };

  res.status(201).json({ game_id: id });
});

app.get("/api/games/:id", (req, res) => {
  const g = games[req.params.id];
  if (!g) return res.status(404).json({ error: "not found" });
  res.json(g);
});

app.post("/api/games/:id/join", (req, res) => {
  const { playerId } = req.body;
  const g = games[req.params.id];

  if (!g) return res.status(404).json({ error: "not found" });

  g.players.push(playerId);
  if (g.players.length >= 2) g.status = "placing";

  res.json({ message: "joined" });
});

// ----------------------
// SHIP PLACEMENT
// ----------------------
app.post("/api/games/:id/place", (req, res) => {
  const { playerId, ships } = req.body;
  const g = games[req.params.id];

  if (!g) return res.status(404).json({ error: "not found" });
  if (!ships || ships.length !== 3)
    return res.status(400).json({ error: "must place 3 ships" });

  const occupied = new Set();

  for (let ship of ships) {
    for (let coord of ship) {
      const { x, y } = coord;

      if (!isValidCoord(x, y, g.grid_size))
        return res.status(400).json({ error: "out of bounds" });

      const key = `${x},${y}`;
      if (occupied.has(key))
        return res.status(400).json({ error: "overlap" });

      occupied.add(key);
    }
  }

  g.ships[playerId] = ships;
  g.placed[playerId] = true;

  if (Object.keys(g.placed).length >= 2) {
    g.status = "playing";
  }

  res.status(201).json({ message: "ships placed" });
});

// ----------------------
// TEST MODE SHIPS
// ----------------------
app.post("/api/test/games/:id/ships", (req, res) => {
  if (!requireTestMode(req, res)) return;

  const { playerId, ships } = req.body;
  const g = games[req.params.id];

  if (!g) return res.status(404).json({ error: "not found" });

  g.ships[playerId] = ships;
  g.placed[playerId] = true;

  res.json({ message: "test ships set" });
});

// ----------------------
// BOARD REVEAL
// ----------------------
app.get("/api/test/games/:id/board/:playerId", (req, res) => {
  if (!requireTestMode(req, res)) return;

  const g = games[req.params.id];
  if (!g) return res.status(404).json({ error: "not found" });

  res.json({ ships: g.ships[req.params.playerId] || [] });
});

// ----------------------
// FIRE (gating only)
// ----------------------
app.post("/api/games/:id/fire", (req, res) => {
  const g = games[req.params.id];

  if (!g) return res.status(404).json({ error: "not found" });

  if (Object.keys(g.placed).length < 2) {
    return res.status(400).json({ error: "not ready" });
  }

  res.json({ result: "ok" });
});

// ----------------------
app.get("/", (req, res) => {
  res.send("Battleship API running");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Running"));