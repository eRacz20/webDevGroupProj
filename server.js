import express from "express";

const app = express();
app.use(express.json());

let players = {};
let games = {};
let nextPlayerId = 1;
let nextGameId = 1;

// ----------------------
// RESET (TEST)
// ----------------------
app.post("/api/reset", (req, res) => {
  players = {};
  games = {};
  nextPlayerId = 1;
  nextGameId = 1;

  res.json({ status: "reset" });
});

// ----------------------
// CREATE PLAYER
// ----------------------
app.post("/api/players", (req, res) => {
  const { username } = req.body;

  if (!username) {
    return res.status(400).json({ error: "username required" });
  }

  const id = nextPlayerId++;
  players[id] = {
    id,
    username,
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

// ----------------------
// PLAYER STATS
// ----------------------
app.get("/api/players/:id/stats", (req, res) => {
  const player = players[req.params.id];

  if (!player) {
    return res.status(404).json({ error: "not found" });
  }

  res.json(player.stats);
});

// ----------------------
// CREATE GAME
// ----------------------
app.post("/api/games", (req, res) => {
  const { playerId, grid_size = 10 } = req.body;

  if (!playerId) {
    return res.status(400).json({ error: "playerId required" });
  }

  if (grid_size < 5 || grid_size > 15) {
    return res.status(400).json({ error: "invalid grid size" });
  }

  const gameId = nextGameId++;

  games[gameId] = {
    game_id: gameId,
    grid_size,
    status: "waiting",
    players: [playerId]
  };

  res.status(201).json({
    game_id: gameId,
    status: "waiting"
  });
});

// ----------------------
// GET GAME
// ----------------------
app.get("/api/games/:id", (req, res) => {
  const game = games[req.params.id];

  if (!game) {
    return res.status(404).json({ error: "not found" });
  }

  res.json(game);
});

// ----------------------
// JOIN GAME
// ----------------------
app.post("/api/games/:id/join", (req, res) => {
  const { playerId } = req.body;
  const game = games[req.params.id];

  if (!game) {
    return res.status(404).json({ error: "not found" });
  }

  if (game.status !== "waiting") {
    return res.status(409).json({ error: "not joinable" });
  }

  game.players.push(playerId);

  res.json({ message: "joined" });
});

// ----------------------
app.get("/", (req, res) => {
  res.send("Battleship API running");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running"));