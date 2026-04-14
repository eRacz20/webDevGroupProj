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
function getPlayerId(body) {
  if (!body) return null;
  if (body.player_id !== undefined) return Number(body.player_id);
  if (body.playerId !== undefined) return Number(body.playerId);
  if (body.creator_id !== undefined) return Number(body.creator_id);
  return null;
}

function requireTestMode(req, res) {
  const header = req.header("X-Test-Password");
  if (header !== TEST_PASSWORD) {
    res.status(403).json({ error: "Forbidden" });
    return false;
  }
  return true;
}

// Parse a coordinate from {row,col} or {x,y} object only — NOT arrays (spec v2.3 rejects array ships)
function parseCoord(c) {
  if (c !== null && typeof c === "object" && !Array.isArray(c)) {
    const row = c.row !== undefined ? Number(c.row) : (c.x !== undefined ? Number(c.x) : NaN);
    const col = c.col !== undefined ? Number(c.col) : (c.y !== undefined ? Number(c.y) : NaN);
    return { row, col };
  }
  return null; // arrays and other types rejected
}

// Normalize ships array into [{row,col}, ...] with exactly 3 entries.
// Spec v2.3: only accepts [{row,col}, ...] object format — array formats return null (400).
function normalizeShips(raw) {
  if (!Array.isArray(raw) || raw.length !== 3) return null;

  const coords = [];
  for (const item of raw) {
    const coord = parseCoord(item);
    if (!coord) return null; // array-format ships rejected per spec
    coords.push(coord);
  }
  return coords;
}

function playerExists(id) {
  return players[id] !== undefined;
}

// Validate username: 1–30 chars, alphanumeric + underscore only, no spaces
function isValidUsername(username) {
  if (typeof username !== "string") return false;
  if (username.length === 0 || username.length > 30) return false;
  return /^[a-zA-Z0-9_]+$/.test(username);
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
  const username = req.body?.username;

  if (!username || typeof username !== "string") {
    return res.status(400).json({ error: "username required" });
  }
  if (!isValidUsername(username)) {
    return res.status(400).json({ error: "invalid username" });
  }

  // Duplicate username → 409
  const duplicate = Object.values(players).find(p => p.username === username);
  if (duplicate) {
    return res.status(409).json({ error: "username taken" });
  }

  const id = nextPlayerId++;
  players[id] = {
    username,
    stats: {
      games_played: 0,
      wins: 0,
      losses: 0,
      total_shots: 0,
      total_hits: 0,
      accuracy: 0.0   // float, not integer
    }
  };

  res.status(201).json({ player_id: id });
});

app.get("/api/players/:id/stats", (req, res) => {
  const idNum = Number(req.params.id);
  if (!idNum || idNum <= 0) return res.status(404).json({ error: "not found" });
  const p = players[idNum];
  if (!p) return res.status(404).json({ error: "not found" });
  res.json(p.stats);
});

// ----------------------
// CREATE GAME
// ----------------------
app.post("/api/games", (req, res) => {
  const body = req.body || {};

  // All three fields required
  if (body.grid_size === undefined) {
    return res.status(400).json({ error: "grid_size required" });
  }
  if (body.max_players === undefined) {
    return res.status(400).json({ error: "max_players required" });
  }

  const creatorId = getPlayerId(body);
  if (creatorId === null) {
    return res.status(400).json({ error: "creator_id required" });
  }

  // grid_size must be a number (not a string)
  if (typeof body.grid_size === "string") {
    return res.status(400).json({ error: "invalid grid_size" });
  }

  const grid_size = Number(body.grid_size);
  const max_players = Number(body.max_players);

  if (isNaN(grid_size) || grid_size < 5 || grid_size > 15) {
    return res.status(400).json({ error: "invalid grid size" });
  }
  if (isNaN(max_players) || max_players < 2) {
    return res.status(400).json({ error: "invalid max_players" });
  }
  if (!playerExists(creatorId)) {
    return res.status(400).json({ error: "creator not found" });
  }

  const id = nextGameId++;

  games[id] = {
    game_id: id,
    grid_size,
    max_players,
    status: "waiting_setup",   // spec v2.3 required value
    players: [creatorId],
    ships: {},
    placed: {},
    moves: [],
    hits: { [creatorId]: 0 },
    firedCells: {},            // track fired cells per player for duplicate-shot detection
    current_turn_index: 0,
    finished: false,
    winner_id: null
  };

  res.status(201).json({ game_id: id, status: "waiting_setup" });
});

// ----------------------
// GET GAME
// ----------------------
app.get("/api/games/:id", (req, res) => {
  const g = games[Number(req.params.id)];
  if (!g) return res.status(404).json({ error: "not found" });

  // current_turn_player_id is null until game is actively playing
  const current_turn_player_id =
    g.status === "playing"
      ? g.players[g.current_turn_index % g.players.length]
      : null;

  res.json({
    game_id: g.game_id,
    grid_size: g.grid_size,
    status: g.status,
    players: g.players,
    current_turn_player_id,
    total_moves: g.moves.length
  });
});

// ----------------------
// JOIN GAME
// ----------------------
app.post("/api/games/:id/join", (req, res) => {
  const g = games[Number(req.params.id)];
  if (!g) return res.status(404).json({ error: "not found" });

  const body = req.body || {};

  // player_id as string → 400
  if (body.player_id !== undefined && typeof body.player_id === "string") {
    return res.status(400).json({ error: "player_id must be integer" });
  }

  const playerId = getPlayerId(body);
  if (playerId === null) {
    return res.status(400).json({ error: "player_id required" });
  }
  if (!playerExists(playerId)) {
    return res.status(404).json({ error: "player not found" });
  }
  if (g.players.includes(playerId)) {
    return res.status(400).json({ error: "already in game" });   // 400 not 409
  }
  if (g.players.length >= g.max_players) {
    return res.status(400).json({ error: "game is full" });       // 400 not 409
  }
  if (g.finished || g.status === "playing") {
    return res.status(400).json({ error: "game not joinable" });
  }

  g.players.push(playerId);
  g.hits[playerId] = 0;
  g.firedCells[playerId] = new Set();

  // Transition to placing when enough players have joined
  if (g.players.length >= g.max_players) {
    g.status = "placing";
  }

  res.status(200).json({ message: "joined" });
});

// ----------------------
// SHIP PLACEMENT
// ----------------------
app.post("/api/games/:id/place", (req, res) => {
  const g = games[Number(req.params.id)];
  if (!g) return res.status(404).json({ error: "not found" });

  const playerId = getPlayerId(req.body);
  if (playerId === null) {
    return res.status(400).json({ error: "player_id required" });
  }
  if (!playerExists(playerId)) {
    return res.status(400).json({ error: "player not found" });
  }
  if (!g.players.includes(playerId)) {
    return res.status(400).json({ error: "not in game" });
  }
  if (g.placed[playerId]) {
    return res.status(409).json({ error: "already placed" });   // 409 for duplicate place
  }
  if (req.body.ships === undefined) {
    return res.status(400).json({ error: "ships required" });
  }

  const coords = normalizeShips(req.body.ships);
  if (!coords) {
    return res.status(400).json({ error: "must place 3 ships as objects" });
  }

  const occupied = new Set();
  for (const { row, col } of coords) {
    if (Number.isNaN(row) || Number.isNaN(col)) {
      return res.status(400).json({ error: "invalid coordinate" });
    }
    if (row < 0 || col < 0 || row >= g.grid_size || col >= g.grid_size) {
      return res.status(400).json({ error: "out of bounds" });
    }
    const key = `${row},${col}`;
    if (occupied.has(key)) {
      return res.status(400).json({ error: "duplicate coordinates" });
    }
    occupied.add(key);
  }

  g.ships[playerId] = coords;
  g.placed[playerId] = true;
  if (!(playerId in g.hits)) g.hits[playerId] = 0;
  if (!g.firedCells[playerId]) g.firedCells[playerId] = new Set();

  // Transition to playing when all players have placed
  if (g.players.length >= 2 && Object.keys(g.placed).length >= g.players.length) {
    g.status = "playing";
  }

  res.status(200).json({ message: "ok" });
});

// ----------------------
// FIRE
// ----------------------
app.post("/api/games/:id/fire", (req, res) => {
  const g = games[Number(req.params.id)];
  if (!g) return res.status(404).json({ error: "not found" });

  // Finished game → 400 (not 409 or 410)
  if (g.finished) {
    return res.status(400).json({ error: "game already finished" });
  }
  if (g.players.length < 2 || Object.keys(g.placed).length < g.players.length) {
    return res.status(400).json({ error: "not ready" });
  }

  const body = req.body || {};

  // Missing player_id → 400
  const playerId = getPlayerId(body);
  if (playerId === null) {
    return res.status(400).json({ error: "player_id required" });
  }
  if (!playerExists(playerId)) {
    return res.status(400).json({ error: "player not found" });
  }
  if (!g.players.includes(playerId)) {
    return res.status(403).json({ error: "not in game" });
  }

  // Out of turn → 403
  const currentPlayerId = g.players[g.current_turn_index % g.players.length];
  if (playerId !== currentPlayerId) {
    return res.status(403).json({ error: "not your turn" });
  }

  // Missing row/col → 400
  if (body.row === undefined) {
    return res.status(400).json({ error: "row required" });
  }
  if (body.col === undefined) {
    return res.status(400).json({ error: "col required" });
  }

  const row = Number(body.row);
  const col = Number(body.col);

  if (Number.isNaN(row) || Number.isNaN(col)) {
    return res.status(400).json({ error: "invalid coordinate" });
  }
  if (row < 0 || col < 0 || row >= g.grid_size || col >= g.grid_size) {
    return res.status(400).json({ error: "out of bounds" });
  }

  // Duplicate cell → 409
  if (!g.firedCells[playerId]) g.firedCells[playerId] = new Set();
  const cellKey = `${row},${col}`;
  if (g.firedCells[playerId].has(cellKey)) {
    return res.status(409).json({ error: "already targeted" });
  }
  g.firedCells[playerId].add(cellKey);

  // Check hit against all opponents
  let hitResult = "miss";
  for (const opponentId of g.players) {
    if (opponentId === playerId) continue;
    const opponentShips = g.ships[opponentId] || [];
    for (const coord of opponentShips) {
      if (coord.row === row && coord.col === col) {
        hitResult = "hit";
        g.hits[opponentId] = (g.hits[opponentId] || 0) + 1;
        break;
      }
    }
    if (hitResult === "hit") break;
  }

  // Update shooter stats
  const shooter = players[playerId];
  shooter.stats.total_shots += 1;
  if (hitResult === "hit") shooter.stats.total_hits += 1;
  shooter.stats.accuracy = parseFloat(
    (shooter.stats.total_hits / shooter.stats.total_shots).toFixed(10)
  );

  // Log move
  g.moves.push({
    player_id: playerId,
    row,
    col,
    result: hitResult,
    timestamp: new Date().toISOString()
  });

  // Advance turn
  g.current_turn_index += 1;
  const nextPId = g.players[g.current_turn_index % g.players.length];

  // Check win: any opponent with all ships hit → shooter wins
  let winnerId = null;
  for (const opponentId of g.players) {
    if (opponentId === playerId) continue;
    const shipCount = (g.ships[opponentId] || []).length;
    if ((g.hits[opponentId] || 0) >= shipCount && shipCount > 0) {
      winnerId = playerId;
      break;
    }
  }

  if (winnerId !== null) {
    g.finished = true;
    g.status = "finished";
    g.winner_id = winnerId;

    for (const pid of g.players) {
      const p = players[pid];
      if (!p) continue;
      p.stats.games_played += 1;
      if (pid === winnerId) {
        p.stats.wins += 1;
      } else {
        p.stats.losses += 1;
      }
    }

    return res.status(200).json({
      result: hitResult,
      next_player_id: null,
      game_status: "finished",
      winner_id: winnerId
    });
  }

  res.status(200).json({
    result: hitResult,
    next_player_id: nextPId,
    game_status: g.status
  });
});

// ----------------------
// MOVE LOG
// ----------------------
app.get("/api/games/:id/moves", (req, res) => {
  const g = games[Number(req.params.id)];
  if (!g) return res.status(404).json({ error: "not found" });
  res.json(g.moves);
});

// ----------------------
// TEST: DETERMINISTIC SHIP PLACEMENT
// ----------------------
app.post("/api/test/games/:id/ships", (req, res) => {
  if (!requireTestMode(req, res)) return;

  const g = games[Number(req.params.id)];
  if (!g) return res.status(404).json({ error: "not found" });

  const playerId = getPlayerId(req.body);
  const coords = normalizeShips(req.body.ships);

  if (!coords) {
    return res.status(400).json({ error: "invalid ships format" });
  }

  g.ships[playerId] = coords;
  g.placed[playerId] = true;
  if (!(playerId in g.hits)) g.hits[playerId] = 0;
  if (!g.firedCells[playerId]) g.firedCells[playerId] = new Set();

  if (g.players.length >= 2 && Object.keys(g.placed).length >= g.players.length) {
    g.status = "playing";
  }

  res.status(200).json({ message: "ok" });
});

// ----------------------
// TEST: BOARD REVEAL
// ----------------------
app.get("/api/test/games/:id/board/:playerId", (req, res) => {
  if (!requireTestMode(req, res)) return;

  const g = games[Number(req.params.id)];
  if (!g) return res.status(404).json({ error: "not found" });

  const ships = g.ships[Number(req.params.playerId)] || [];
  res.status(200).json({ ships });
});

// ----------------------
// TEST: RESTART GAME
// ----------------------
app.post("/api/test/games/:id/restart", (req, res) => {
  if (!requireTestMode(req, res)) return;

  const g = games[Number(req.params.id)];
  if (!g) return res.status(404).json({ error: "not found" });

  // Clear game state — player lifetime stats are NOT touched
  g.ships = {};
  g.placed = {};
  g.moves = [];
  g.hits = {};
  g.firedCells = {};
  g.current_turn_index = 0;
  g.finished = false;
  g.winner_id = null;
  g.status = "waiting_setup";   // spec v2.3: must be "waiting_setup" after restart

  for (const pid of g.players) {
    g.hits[pid] = 0;
    g.firedCells[pid] = new Set();
  }

  res.status(200).json({ message: "restarted" });
});

// ----------------------
app.get("/", (req, res) => {
  res.send("Battleship API running");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on port ${PORT}`));
