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

// 🔥 FIXED PLAYER ID PARSER
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
// CREATE GAME
// ----------------------
app.post("/api/games", (req, res) => {
  console.log("BODY:", req.body);

  const playerId = getPlayerId(req.body);
  const grid_size = req.body.grid_size ?? 10;

  console.log("PLAYER ID:", playerId);

  if (playerId === null) {
    return res.status(400).json({ error: "player_id required" });
  }

  if (grid_size < 5 || grid_size > 15) {
    return res.status(400).json({ error: "invalid grid size" });
  }

  const id = nextGameId++;

  games[id] = {
    game_id: id,
    grid_size,
    status: "waiting",
    players: [playerId],
    ships: {},
    placed: {}
  };

  res.status(201).json({ game_id: id });
});

// ----------------------
app.get("/api/games/:id", (req, res) => {
  const g = games[req.params.id];
  if (!g) return res.status(404).json({ error: "not found" });
  res.json(g);
});

// ----------------------
app.post("/api/games/:id/join", (req, res) => {
  const playerId = getPlayerId(req.body);
  const g = games[req.params.id];

  if (!g) return res.status(404).json({ error: "not found" });
  if (playerId === null)
    return res.status(400).json({ error: "player_id required" });

  g.players.push(playerId);

  if (g.players.length >= 2) {
    g.status = "placing";
  }

  res.status(200).json({ message: "joined" });
});

// ----------------------
// SHIP PLACEMENT
// ----------------------
app.post("/api/games/:id/place", (req, res) => {
  const playerId = getPlayerId(req.body);
  const ships = req.body.ships;
  const g = games[req.params.id];

  if (!g) return res.status(404).json({ error: "not found" });
  if (playerId === null)
    return res.status(400).json({ error: "player_id required" });

  if (!ships || ships.length !== 3) {
    return res.status(400).json({ error: "must place 3 ships" });
  }

  const occupied = new Set();

  for (let ship of ships) {
    for (let coord of ship) {
      const [x, y] = coord;

      if (!isValidCoord(x, y, g.grid_size)) {
        return res.status(400).json({ error: "out of bounds" });
      }

      const key = `${x},${y}`;
      if (occupied.has(key)) {
        return res.status(400).json({ error: "overlap" });
      }

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
// TEST SHIPS
// ----------------------
app.post("/api/test/games/:id/ships", (req, res) => {
  if (!requireTestMode(req, res)) return;

  const playerId = getPlayerId(req.body);
  const ships = req.body.ships;
  const g = games[req.params.id];

  if (!g) return res.status(404).json({ error: "not found" });

  g.ships[playerId] = ships;
  g.placed[playerId] = true;

  res.status(200).json({ message: "test ships set" });
});

// ----------------------
// BOARD REVEAL
// ----------------------
app.get("/api/test/games/:id/board/:playerId", (req, res) => {
  if (!requireTestMode(req, res)) return;

  const g = games[req.params.id];
  if (!g) return res.status(404).json({ error: "not found" });

  res.status(200).json({
    ships: g.ships[req.params.playerId] || []
  });
});

// ----------------------
// FIRE GATING
// ----------------------
app.post("/api/games/:id/fire", (req, res) => {
  const g = games[req.params.id];

  if (!g) return res.status(404).json({ error: "not found" });

  if (Object.keys(g.placed).length < 2) {
    return res.status(400).json({ error: "not ready" });
  }

  res.status(200).json({ result: "ok" });
});

// ----------------------
app.get("/", (req, res) => {
  res.send("Battleship API running");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Running"));