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

// Parse a coordinate from any format: {row,col} / {x,y} / [row,col]
function parseCoord(c) {
  if (Array.isArray(c) && c.length === 2) {
    return { row: Number(c[0]), col: Number(c[1]) };
  }
  if (c !== null && typeof c === "object") {
    const row = c.row !== undefined ? Number(c.row) : (c.x !== undefined ? Number(c.x) : NaN);
    const col = c.col !== undefined ? Number(c.col) : (c.y !== undefined ? Number(c.y) : NaN);
    return { row, col };
  }
  return { row: NaN, col: NaN };
}

// Normalize ships array into [{row,col}, ...] with exactly 3 entries.
// Handles: flat coord array, nested single-cell arrays, raw [row,col] pairs.
function normalizeShips(raw) {
  if (!Array.isArray(raw)) return null;

  let coords;

  if (raw.length === 3) {
    const first = raw[0];

    // [ {row,col}, {row,col}, {row,col} ]  — spec format
    if (!Array.isArray(first) && typeof first === "object" && first !== null) {
      coords = raw.map(parseCoord);
    }
    // [ [row,col], [row,col], [row,col] ]  — flat number-pair arrays
    else if (Array.isArray(first) && first.length === 2 && typeof first[0] === "number") {
      coords = raw.map(parseCoord);
    }
    // [ [{row,col}], [{row,col}], [{row,col}] ]  — nested single-cell arrays
    else if (Array.isArray(first) && first.length === 1) {
      coords = raw.map(ship => parseCoord(ship[0]));
    }
    else {
      return null;
    }
  } else {
    return null;
  }

  return coords;
}

function playerExists(id) {
  return players[id] !== undefined;
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
  if (!username) {
    return res.status(400).json({ error: "username required" });
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
      accuracy: 0
    }
  };

  res.status(201).json({ player_id: id });
});

app.get("/api/players/:id/stats", (req, res) => {
  const p = players[Number(req.params.id)];
  if (!p) return res.status(404).json({ error: "not found" });
  res.json(p.stats);
});

// ----------------------
// CREATE GAME
// ----------------------
app.post("/api/games", (req, res) => {
  const body = req.body || {};
  const grid_size = body.grid_size ?? 10;
  const max_players = body.max_players ?? 2;

  if (grid_size < 5 || grid_size > 15) {
    return res.status(400).json({ error: "invalid grid size" });
  }
  if (max_players < 1) {
    return res.status(400).json({ error: "invalid max_players" });
  }

  const creatorId = getPlayerId(body);
  const id = nextGameId++;

  games[id] = {
    game_id: id,
    grid_size,
    max_players,
    status: "waiting",
    players: [],
    ships: {},
    placed: {},
    moves: [],
    hits: {},
    current_turn_index: 0,
    finished: false,
    winner_id: null
  };

  if (creatorId !== null && playerExists(creatorId)) {
    games[id].players.push(creatorId);
    games[id].hits[creatorId] = 0;
  }

  res.status(201).json({ game_id: id, status: "waiting" });
});

// ----------------------
// GET GAME
// ----------------------
app.get("/api/games/:id", (req, res) => {
  const g = games[Number(req.params.id)];
  if (!g) return res.status(404).json({ error: "not found" });

  res.json({
    game_id: g.game_id,
    grid_size: g.grid_size,
    status: g.status,
    current_turn_index: g.current_turn_index,
    active_players: g.players.length
  });
});

// ----------------------
// JOIN GAME
// ----------------------
app.post("/api/games/:id/join", (req, res) => {
  const g = games[Number(req.params.id)];
  if (!g) return res.status(404).json({ error: "not found" });

  const playerId = getPlayerId(req.body);
  if (playerId === null) {
    return res.status(400).json({ error: "player_id required" });
  }
  if (!playerExists(playerId)) {
    return res.status(404).json({ error: "player not found" });
  }
  if (g.players.includes(playerId)) {
    return res.status(400).json({ error: "already in game" });
  }
  if (g.players.length >= g.max_players) {
    return res.status(409).json({ error: "game is full" });
  }
  if (g.finished) {
    return res.status(400).json({ error: "game already finished" });
  }

  g.players.push(playerId);
  g.hits[playerId] = 0;

  if (g.players.length >= 2) {
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
  if (playerId === null || !playerExists(playerId)) {
    return res.status(403).json({ error: "invalid player" });
  }
  if (!g.players.includes(playerId)) {
    return res.status(403).json({ error: "not in game" });
  }
  if (g.placed[playerId]) {
    return res.status(400).json({ error: "already placed" });
  }

  const coords = normalizeShips(req.body.ships);
  if (!coords) {
    return res.status(400).json({ error: "must place 3 ships" });
  }
  if (coords.length !== 3) {
    return res.status(400).json({ error: "must place 3 ships" });
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
      return res.status(400).json({ error: "overlap" });
    }
    occupied.add(key);
  }

  g.ships[playerId] = coords;
  g.placed[playerId] = true;
  if (!(playerId in g.hits)) g.hits[playerId] = 0;

  if (g.players.length >= 2 && Object.keys(g.placed).length >= g.players.length) {
    g.status = "active";
  }

  res.status(200).json({ message: "ok" });
});

// ----------------------
// FIRE
// ----------------------
app.post("/api/games/:id/fire", (req, res) => {
  const g = games[Number(req.params.id)];
  if (!g) return res.status(404).json({ error: "not found" });

  if (g.finished) {
    return res.status(410).json({ error: "game already finished" });
  }
  if (g.players.length < 2 || Object.keys(g.placed).length < g.players.length) {
    return res.status(400).json({ error: "not ready" });
  }

  const playerId = getPlayerId(req.body);
  if (playerId === null || !playerExists(playerId)) {
    return res.status(403).json({ error: "invalid player" });
  }
  if (!g.players.includes(playerId)) {
    return res.status(403).json({ error: "not in game" });
  }

  const currentPlayerId = g.players[g.current_turn_index % g.players.length];
  if (playerId !== currentPlayerId) {
    return res.status(403).json({ error: "not your turn" });
  }

  const row = req.body.row !== undefined ? Number(req.body.row) : NaN;
  const col = req.body.col !== undefined ? Number(req.body.col) : NaN;

  if (Number.isNaN(row) || Number.isNaN(col)) {
    return res.status(400).json({ error: "invalid coordinate" });
  }
  if (row < 0 || col < 0 || row >= g.grid_size || col >= g.grid_size) {
    return res.status(400).json({ error: "out of bounds" });
  }

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
  shooter.stats.accuracy = shooter.stats.total_hits / shooter.stats.total_shots;

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

  if (g.players.length >= 2 && Object.keys(g.placed).length >= g.players.length) {
    g.status = "active";
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
  g.current_turn_index = 0;
  g.finished = false;
  g.winner_id = null;
  g.status = "waiting";

  for (const pid of g.players) {
    g.hits[pid] = 0;
  }

  res.status(200).json({ message: "restarted" });
});

// ----------------------
app.get("/", (req, res) => {
  res.send("Battleship API running");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on port ${PORT}`));
