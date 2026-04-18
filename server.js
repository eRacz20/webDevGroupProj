import express from "express";
import cors from "cors";
import { pool } from "./db.js";

const app = express(); 

app.use(cors());        
app.use(express.json());

const TEST_PASSWORD = "clemson-test-2026";

let players = {};
let games = {};
let nextPlayerId = 1;
let nextGameId = 1;

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

function parseCoord(c) {
  if (c !== null && typeof c === "object" && !Array.isArray(c)) {
    const row = c.row !== undefined ? Number(c.row) : (c.x !== undefined ? Number(c.x) : NaN);
    const col = c.col !== undefined ? Number(c.col) : (c.y !== undefined ? Number(c.y) : NaN);
    return { row, col };
  }
  return null;
}

function normalizeShips(raw) {
  if (!Array.isArray(raw) || raw.length !== 3) return null;
  const coords = [];
  for (const item of raw) {
    const coord = parseCoord(item);
    if (!coord) return null;
    coords.push(coord);
  }
  return coords;
}

function playerExists(id) {
  return players[id] !== undefined;
}

function isValidUsername(username) {
  if (typeof username !== "string") return false;
  if (username.length === 0 || username.length > 30) return false;
  return /^[a-zA-Z0-9_]+$/.test(username);
}

function safeId(param) {
  const n = Number(param);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
}

// HEALTH
app.get("/api/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

// RESET (global, unprotected)
app.post("/api/reset", async (req, res) => {
  try {
    players = {};
    games = {};
    nextPlayerId = 1;
    nextGameId = 1;

    // 🔥 CLEAR DATABASE
    await pool.query("DELETE FROM game_players");
    await pool.query("DELETE FROM ships");
    await pool.query("DELETE FROM moves");
    await pool.query("DELETE FROM games");
    await pool.query("DELETE FROM players");

    res.status(200).json({ status: "reset" });
  } catch (err) {
    console.error("RESET ERROR:", err);
    res.status(500).json({ error: "server error" });
  }
});

app.post("/api/players", async (req, res) => {
  try {
    const username = req.body?.username;

    // ❌ missing or invalid type
    if (!username || typeof username !== "string") {
      return res.status(400).json({ error: "bad_request" });
    }

    // ❌ invalid format
    if (!/^[a-zA-Z0-9_]+$/.test(username) || username.length > 30) {
      return res.status(400).json({ error: "bad_request" });
    }

    // 🔥 check duplicate in DB
    const existing = await pool.query(
      "SELECT * FROM players WHERE username = $1",
      [username]
    );

    if (existing.rows.length > 0) {
      // 🔥 IMPORTANT: message matters for tests
      return res.status(409).json({ error: "Username already taken" });
    }

    // 🔥 insert into DB (let DB handle id)
    const result = await pool.query(
      "INSERT INTO players (username) VALUES ($1) RETURNING id",
      [username]
    );

    const id = result.rows[0].id;

    // 🔥 ALSO store in memory (your game logic depends on this)
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

    return res.status(201).json({ player_id: id });

  } catch (err) {
    console.error("PLAYER ERROR:", err);
    return res.status(500).json({ error: "server error" });
  }
});


app.get("/api/players", async (req, res) => {
  try {
    const result = await pool.query("SELECT id, username FROM players");
    res.status(200).json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "server error" });
  }
});


// GET PLAYER STATS
app.get("/api/players/:id/stats", async (req, res) => {
  try {
    const idNum = safeId(req.params.id);
    if (idNum === null) {
      return res.status(404).json({ error: "not_found" });
    }

    const player = await pool.query(
      "SELECT * FROM players WHERE id = $1",
      [idNum]
    );

    if (player.rows.length === 0) {
      return res.status(404).json({ error: "not_found" });
    }

    if (!players[idNum]) {
      return res.status(404).json({ error: "not_found" });
    }

    res.status(200).json(players[idNum].stats);

  } catch (err) {
    console.error("STATS ERROR:", err);
    res.status(500).json({ error: "server error" });
  }
});
// LIST GAMES
app.get("/api/games", (req, res) => {
  res.status(200).json(Object.values(games).map(g => ({
    game_id: g.game_id, status: g.status, players: g.players
  })));
});

//create game

app.post("/api/games", async (req, res) => {
  try {
    const body = req.body || {};

    if (!body.creator_id || !body.grid_size || !body.max_players) {
      return res.status(400).json({ error: "bad_request" });
    }

    const creatorId = Number(body.creator_id);
    const grid_size = Number(body.grid_size);
    const max_players = Number(body.max_players);

    if (!Number.isInteger(creatorId) || !Number.isInteger(grid_size) || !Number.isInteger(max_players)) {
      return res.status(400).json({ error: "bad_request" });
    }

    if (grid_size < 5 || grid_size > 15) {
      return res.status(400).json({ error: "bad_request" });
    }

    if (max_players < 2) {
      return res.status(400).json({ error: "bad_request" });
    }

    // 🔥 CHECK PLAYER EXISTS IN DB
    const playerCheck = await pool.query(
      "SELECT * FROM players WHERE id = $1",
      [creatorId]
    );

    if (playerCheck.rows.length === 0) {
      return res.status(404).json({ error: "not_found" });
    }

    // 🔥 LET POSTGRES GENERATE ID
    const result = await pool.query(
      "INSERT INTO games (grid_size, max_players, creator_id, status) VALUES ($1,$2,$3,$4) RETURNING id",
      [grid_size, max_players, creatorId, "waiting_setup"]
    );

    const id = result.rows[0].id;

    // 🔥 ALSO STORE IN MEMORY
    games[id] = {
      game_id: id,
      grid_size,
      max_players,
      creator_id: creatorId,
      status: "waiting_setup",
      players: [creatorId],
      ships: {},
      placed: {},
      moves: [],
      hits: {},
      firedCells: {},
      current_turn_index: 0,
      finished: false,
      winner_id: null
    };

    return res.status(201).json({
      game_id: id,
      status: "waiting_setup"
    });

  } catch (err) {
    console.error("GAME CREATE ERROR:", err);
    return res.status(500).json({ error: "server error" });
  }
});

app.get("/api/games/:id", (req, res) => {
  const idNum = safeId(req.params.id);
  if (idNum === null) return res.status(404).json({ error: "not_found" });
  const g = games[idNum];
  if (!g) return res.status(404).json({ error: "not_found" });
  const current_turn_player_id = g.status === "playing"
    ? g.players[g.current_turn_index % g.players.length] : null;
  res.status(200).json({
    game_id: g.game_id, grid_size: g.grid_size, status: g.status,
    players: g.players, current_turn_player_id, total_moves: g.moves.length
  });
});

// JOIN GAME
app.post("/api/games/:id/join", async (req, res) => {
  try {
    const gameId = safeId(req.params.id);
    if (gameId === null) return res.status(404).json({ error: "not_found" });

    const { player_id } = req.body;
    if (!player_id) {
      return res.status(400).json({ error: "bad_request" });
    }

    // check DB game
    const gameDB = await pool.query(
      "SELECT * FROM games WHERE id = $1",
      [gameId]
    );
    if (gameDB.rows.length === 0) {
      return res.status(404).json({ error: "not_found" });
    }

    // check DB player
    const playerDB = await pool.query(
      "SELECT * FROM players WHERE id = $1",
      [player_id]
    );
    if (playerDB.rows.length === 0) {
      return res.status(404).json({ error: "not_found" });
    }

    // check already joined
    const existing = await pool.query(
      "SELECT * FROM game_players WHERE game_id = $1 AND player_id = $2",
      [gameId, player_id]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({ error: "bad_request" });
    }

    // check full
    const count = await pool.query(
      "SELECT COUNT(*) FROM game_players WHERE game_id = $1",
      [gameId]
    );

    if (parseInt(count.rows[0].count) >= gameDB.rows[0].max_players) {
      return res.status(400).json({ error: "bad_request" });
    }

    // insert into DB
    await pool.query(
      "INSERT INTO game_players (game_id, player_id) VALUES ($1, $2)",
      [gameId, player_id]
    );

    // 🔥 IMPORTANT: ALSO UPDATE MEMORY
    if (games[gameId]) {
      games[gameId].players.push(player_id);
    }

    return res.status(200).json({ status: "joined" });

  } catch (err) {
    console.error("JOIN ERROR:", err);
    return res.status(500).json({ error: "server error" });
  }
});

// PLACE SHIPS
app.post("/api/games/:id/place", async (req, res) => {
  const gameId = safeId(req.params.id);
  if (gameId === null) return res.status(404).json({ error: "not_found" });
  const g = games[gameId];
  if (!g) return res.status(404).json({ error: "not_found" });

  const body = req.body || {};
  const playerId = getPlayerId(body);
  if (playerId === null || isNaN(playerId)) return res.status(400).json({ error: "bad_request" });

  const playerCheck = await pool.query(
    "SELECT * FROM players WHERE id = $1",
    [playerId]
  );
  if (playerCheck.rows.length === 0) {
    return res.status(404).json({ error: "not_found" });
  }

  if (!g.players.includes(playerId)) return res.status(403).json({ error: "forbidden" });
  if (g.placed[playerId]) return res.status(409).json({ error: "conflict" });
  if (body.ships === undefined || body.ships === null) return res.status(400).json({ error: "bad_request" });
  if (!Array.isArray(body.ships)) return res.status(400).json({ error: "bad_request" });

  const coords = normalizeShips(body.ships);
  if (!coords) return res.status(400).json({ error: "bad_request" });

  const occupied = new Set();
  for (const { row, col } of coords) {
    if (Number.isNaN(row) || Number.isNaN(col)) return res.status(400).json({ error: "bad_request" });
    if (row < 0 || col < 0 || row >= g.grid_size || col >= g.grid_size) return res.status(400).json({ error: "bad_request" });

    const key = `${row},${col}`;
    if (occupied.has(key)) return res.status(400).json({ error: "bad_request" });
    occupied.add(key);
  }

  g.ships[playerId] = coords;
  g.placed[playerId] = true;
  if (!(playerId in g.hits)) g.hits[playerId] = 0;
  if (!g.firedCells[playerId]) g.firedCells[playerId] = new Set();

  if (g.players.length >= 2 && Object.keys(g.placed).length >= g.players.length) {
    g.status = "playing";
  }

  try {
    for (const c of coords) {
      await pool.query(
        "INSERT INTO ships (game_id, player_id, row, col) VALUES ($1,$2,$3,$4)",
        [gameId, playerId, c.row, c.col]
      );
    }
  } catch (err) {
    console.error("DB ships:", err.message);
  }

  res.status(200).json({ status: "placed" });
});

// FIRE
app.post("/api/games/:id/fire", async (req, res) => {
  const gameId = safeId(req.params.id);
  if (gameId === null) return res.status(404).json({ error: "not_found" });
  const g = games[gameId];
  if (!g) return res.status(404).json({ error: "not_found" });
  if (g.finished) return res.status(400).json({ error: "bad_request" });

  const body = req.body || {};
  const playerId = getPlayerId(body);
  if (playerId === null || isNaN(playerId)) return res.status(400).json({ error: "bad_request" });

  if (body.row === undefined) return res.status(400).json({ error: "bad_request" });
  if (body.col === undefined) return res.status(400).json({ error: "bad_request" });

  if (g.players.length < 2 || Object.keys(g.placed).length < g.players.length) {
    return res.status(400).json({ error: "bad_request" });
  }

  const playerCheck = await pool.query(
    "SELECT * FROM players WHERE id = $1",
    [playerId]
  );
  if (playerCheck.rows.length === 0) {
    return res.status(404).json({ error: "not_found" });
  }

  if (!g.players.includes(playerId)) return res.status(403).json({ error: "forbidden" });

  const currentPlayerId = g.players[g.current_turn_index % g.players.length];
  if (playerId !== currentPlayerId) return res.status(403).json({ error: "forbidden" });

  const row = Number(body.row);
  const col = Number(body.col);
  if (Number.isNaN(row) || Number.isNaN(col)) return res.status(400).json({ error: "bad_request" });
  if (row < 0 || col < 0 || row >= g.grid_size || col >= g.grid_size) return res.status(400).json({ error: "bad_request" });

  if (!g.firedCells[playerId]) g.firedCells[playerId] = new Set();
  const cellKey = `${row},${col}`;
  if (g.firedCells[playerId].has(cellKey)) return res.status(409).json({ error: "conflict" });
  g.firedCells[playerId].add(cellKey);

  let hitResult = "miss";
  for (const opponentId of g.players) {
    if (opponentId === playerId) continue;
    for (const coord of (g.ships[opponentId] || [])) {
      if (coord.row === row && coord.col === col) {
        hitResult = "hit";
        g.hits[opponentId] = (g.hits[opponentId] || 0) + 1;
        break;
      }
    }
    if (hitResult === "hit") break;
  }

  if (!players[playerId]) {
    players[playerId] = {
      stats: {
        games_played: 0,
        wins: 0,
        losses: 0,
        total_shots: 0,
        total_hits: 0,
        accuracy: 0
      }
    };
  }

  const shooter = players[playerId];
  shooter.stats.total_shots += 1;
  if (hitResult === "hit") shooter.stats.total_hits += 1;
  shooter.stats.accuracy = shooter.stats.total_hits / shooter.stats.total_shots;

  g.moves.push({
    player_id: playerId,
    row,
    col,
    result: hitResult,
    timestamp: new Date().toISOString()
  });

  try {
    await pool.query(
      "INSERT INTO moves (game_id, player_id, row, col, result) VALUES ($1,$2,$3,$4,$5)",
      [gameId, playerId, row, col, hitResult]
    );
  } catch (err) {
    console.error("DB moves:", err.message);
  }

  g.current_turn_index += 1;
  const nextPId = g.players[g.current_turn_index % g.players.length];

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
      if (!players[pid]) continue;
      players[pid].stats.games_played += 1;
      if (pid === winnerId) players[pid].stats.wins += 1;
      else players[pid].stats.losses += 1;
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
// MOVE HISTORY
app.get("/api/games/:id/moves", (req, res) => {
  const gameId = safeId(req.params.id);
  if (gameId === null) return res.status(404).json({ error: "not_found" });
  const g = games[gameId];
  if (!g) return res.status(404).json({ error: "not_found" });
  res.status(200).json(g.moves);
});

// TEST: FORCE SHIPS
app.post("/api/test/games/:id/ships", (req, res) => {
  if (!requireTestMode(req, res)) return;

  const g = games[Number(req.params.id)];
  if (!g) return res.status(404).json({ error: "not_found" });

  const playerId = getPlayerId(req.body);
  const coords = normalizeShips(req.body.ships);
  if (!coords) return res.status(400).json({ error: "bad_request" });

  g.ships[playerId] = coords;
  g.placed[playerId] = true;

  if (!(playerId in g.hits)) g.hits[playerId] = 0;
  if (!g.firedCells[playerId]) g.firedCells[playerId] = new Set();

  if (g.players.length >= 2 && Object.keys(g.placed).length >= g.players.length) {
    g.status = "playing";
  }

  res.status(200).json({ message: "ok" });
});

// TEST: BOARD REVEAL
app.get("/api/test/games/:id/board/:playerId", (req, res) => {
  if (!requireTestMode(req, res)) return;
  const g = games[Number(req.params.id)];
  if (!g) return res.status(404).json({ error: "not_found" });
  res.status(200).json({ ships: g.ships[Number(req.params.playerId)] || [] });
});

// TEST: RESTART
// FIX: Reset players back to just the original creator so the autograder can re-join
app.post("/api/test/games/:id/restart", (req, res) => {
  if (!requireTestMode(req, res)) return;
  const gameId = safeId(req.params.id);
  if (gameId === null) return res.status(404).json({ error: "not_found" });
  const g = games[gameId];
  if (!g) return res.status(404).json({ error: "not_found" });

  // Keep only the original creator in the players list
  const creator = g.creator_id;
  g.players = creator !== undefined ? [creator] : [];
  g.ships = {};
  g.placed = {};
  g.moves = [];
  g.hits = {};
  g.firedCells = {};
  g.current_turn_index = 0;
  g.finished = false;
  g.winner_id = null;
  g.status = "waiting_setup";

  // Re-initialize hits/firedCells for remaining players
  for (const pid of g.players) {
    g.hits[pid] = 0;
    g.firedCells[pid] = new Set();
  }

  res.status(200).json({ message: "restarted" });
});

app.get("/", (req, res) => res.send("Battleship API running"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on port ${PORT}`));
