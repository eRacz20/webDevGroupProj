import express from "express";
import cors from "cors";
import { pool } from "./db.js";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
// Fix for __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(cors());
app.use(express.json());
// Serve frontend files (index.html, CSS, JS)
app.use(express.static(__dirname));

const TEST_PASSWORD = "clemson-test-2026";

// ─── helpers ────────────────────────────────────────────────────────────────

function safeId(param) {
  const n = Number(param);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
}

// ─── health ──────────────────────────────────────────────────────────────────

app.get("/api/health", (_req, res) => res.status(200).json({ status: "ok" }));

// ─── reset (dev utility) ─────────────────────────────────────────────────────

app.post("/api/reset", async (_req, res) => {
  try {
    await pool.query("DELETE FROM moves");
    await pool.query("DELETE FROM ships");
    await pool.query("DELETE FROM game_players");
    await pool.query("DELETE FROM games");
    await pool.query("DELETE FROM players");
    res.status(200).json({ status: "reset" });
  } catch {
    res.status(500).json({ error: "server error" });
  }
});

// ─── players ─────────────────────────────────────────────────────────────────

app.get("/api/players", async (_req, res) => {
  try {
    const result = await pool.query("SELECT id, username FROM players ORDER BY id");
    res.status(200).json(result.rows);
  } catch {
    res.status(500).json({ error: "server error" });
  }
});

app.post("/api/players", async (req, res) => {
  try {
    const username = req.body?.username;

    if (!username || typeof username !== "string" || username.trim() === "") {
      return res.status(400).json({ error: "bad_request" });
    }
    if (!/^[a-zA-Z0-9_]+$/.test(username) || username.length > 30) {
      return res.status(400).json({ error: "bad_request" });
    }

    const existing = await pool.query(
      "SELECT id FROM players WHERE username = $1", [username]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: "conflict" });
    }

    const result = await pool.query(
      "INSERT INTO players (username) VALUES ($1) RETURNING id, username",
      [username]
    );

    res.status(201).json({
      player_id: result.rows[0].id,
      username: result.rows[0].username,
    });
  } catch {
    res.status(500).json({ error: "server error" });
  }
});

app.get("/api/players/:id/stats", async (req, res) => {
  try {
    const id = safeId(req.params.id);
    if (id === null) return res.status(404).json({ error: "not_found" });

    const result = await pool.query("SELECT * FROM players WHERE id = $1", [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "not_found" });
    }

    const p = result.rows[0];
    const total_shots = Number(p.total_shots ?? 0);
    const total_hits  = Number(p.total_hits  ?? 0);
    const accuracy    = total_shots > 0
      ? Math.round((total_hits / total_shots) * 100) / 100
      : 0;

    res.status(200).json({
      games_played: Number(p.games_played ?? 0),
      wins:         Number(p.wins         ?? 0),
      losses:       Number(p.losses       ?? 0),
      total_shots,
      total_hits,
      accuracy,
    });
  } catch {
    res.status(500).json({ error: "server error" });
  }
});

// ─── games ───────────────────────────────────────────────────────────────────

app.get("/api/games", async (_req, res) => {
  try {
    const result = await pool.query(
      "SELECT id AS game_id, status, grid_size, max_players, creator_id FROM games ORDER BY id"
    );
    res.status(200).json(result.rows);
  } catch {
    res.status(500).json({ error: "server error" });
  }
});

app.post("/api/games", async (req, res) => {
  try {
    const { creator_id, grid_size, max_players } = req.body ?? {};

    if (creator_id == null || grid_size == null || max_players == null) {
      return res.status(400).json({ error: "bad_request" });
    }

    const gs  = Number(grid_size);
    const mp  = Number(max_players);
    const cid = Number(creator_id);

    if (!Number.isFinite(gs) || !Number.isInteger(gs) || gs < 5 || gs > 15) {
      return res.status(400).json({ error: "bad_request" });
    }
    if (!Number.isFinite(mp) || !Number.isInteger(mp) || mp < 2) {
      return res.status(400).json({ error: "bad_request" });
    }
    if (!Number.isFinite(cid) || !Number.isInteger(cid) || cid <= 0) {
      return res.status(400).json({ error: "bad_request" });
    }

    const playerCheck = await pool.query(
      "SELECT id FROM players WHERE id = $1", [cid]
    );
    if (playerCheck.rows.length === 0) {
      return res.status(404).json({ error: "not_found" });
    }

    const gameResult = await pool.query(
      `INSERT INTO games (grid_size, max_players, creator_id, status)
       VALUES ($1, $2, $3, 'waiting_setup') RETURNING id`,
      [gs, mp, cid]
    );
    const game_id = gameResult.rows[0].id;

    await pool.query(
      "INSERT INTO game_players (game_id, player_id) VALUES ($1, $2)",
      [game_id, cid]
    );

    res.status(201).json({ game_id, status: "waiting_setup" });
  } catch (err) {
    console.error("POST /api/games error:", err);
    res.status(500).json({ error: "server error" });
  }
});

app.get("/api/games/:id", async (req, res) => {
  try {
    const id = safeId(req.params.id);
    if (id === null) return res.status(404).json({ error: "not_found" });

    const gameRes = await pool.query("SELECT * FROM games WHERE id = $1", [id]);
    if (gameRes.rows.length === 0) {
      return res.status(404).json({ error: "not_found" });
    }
    const game = gameRes.rows[0];

    const playersRes = await pool.query(
      "SELECT player_id FROM game_players WHERE game_id = $1 ORDER BY player_id ASC", [id]
    );
    const players = playersRes.rows.map(r => r.player_id);

    const movesRes = await pool.query(
      "SELECT COUNT(*) AS cnt FROM moves WHERE game_id = $1", [id]
    );
    const total_moves = Number(movesRes.rows[0].cnt);

    let current_turn_player_id = null;
    if (game.status === "playing") {
      current_turn_player_id = game.current_turn_player_id ?? null;
    }

    res.status(200).json({
      game_id:               game.id,
      status:                game.status,
      grid_size:             game.grid_size,
      max_players:           game.max_players,
      creator_id:            game.creator_id,
      players,
      current_turn_player_id,
      total_moves,
      winner_id: game.winner_id ?? null,
    });
  } catch {
    res.status(500).json({ error: "server error" });
  }
});

// ─── join ─────────────────────────────────────────────────────────────────────

app.post("/api/games/:id/join", async (req, res) => {
  try {
    const game_id = safeId(req.params.id);
    if (game_id === null) return res.status(404).json({ error: "not_found" });

    const raw_pid = req.body?.player_id;
    if (raw_pid == null) {
      return res.status(400).json({ error: "bad_request" });
    }
    const player_id = Number(raw_pid);
    if (!Number.isFinite(player_id) || !Number.isInteger(player_id) || player_id <= 0) {
      return res.status(400).json({ error: "bad_request" });
    }

    // game exists?
    const gameRes = await pool.query("SELECT * FROM games WHERE id = $1", [game_id]);
    if (gameRes.rows.length === 0) {
      return res.status(404).json({ error: "not_found" });
    }
    const game = gameRes.rows[0];

    // player exists?
    const playerRes = await pool.query("SELECT id FROM players WHERE id = $1", [player_id]);
    if (playerRes.rows.length === 0) {
      return res.status(404).json({ error: "not_found" });
    }

    // game must be waiting_setup
    if (game.status !== "waiting_setup") {
      return res.status(400).json({ error: "bad_request" });
    }

    // already in game?
    const alreadyIn = await pool.query(
      "SELECT 1 FROM game_players WHERE game_id=$1 AND player_id=$2",
      [game_id, player_id]
    );
    if (alreadyIn.rows.length > 0) {
      return res.status(400).json({ error: "bad_request" });
    }

    // full?
    const countRes = await pool.query(
      "SELECT COUNT(*) AS cnt FROM game_players WHERE game_id=$1", [game_id]
    );
    if (Number(countRes.rows[0].cnt) >= game.max_players) {
      return res.status(400).json({ error: "bad_request" });
    }

    await pool.query(
      "INSERT INTO game_players (game_id, player_id) VALUES ($1, $2)",
      [game_id, player_id]
    );

    res.status(200).json({ status: "joined" });
  } catch {
    res.status(500).json({ error: "server error" });
  }
});

// ─── place ships ─────────────────────────────────────────────────────────────

app.post("/api/games/:id/place", async (req, res) => {
  try {
    const game_id = safeId(req.params.id);
    if (game_id === null) return res.status(404).json({ error: "not_found" });

    const { player_id, ships } = req.body ?? {};

    if (player_id == null) return res.status(400).json({ error: "bad_request" });
    const pid = Number(player_id);
    if (!Number.isFinite(pid) || !Number.isInteger(pid) || pid <= 0) {
      return res.status(400).json({ error: "bad_request" });
    }

    if (ships == null || !Array.isArray(ships) || ships.length === 0) {
      return res.status(400).json({ error: "bad_request" });
    }
    if (ships.length < 3) {
      return res.status(400).json({ error: "bad_request" });
    }

    const gameRes = await pool.query("SELECT * FROM games WHERE id = $1", [game_id]);
    if (gameRes.rows.length === 0) return res.status(404).json({ error: "not_found" });
    const game = gameRes.rows[0];

    // player must be in game
    const inGame = await pool.query(
      "SELECT 1 FROM game_players WHERE game_id=$1 AND player_id=$2",
      [game_id, pid]
    );
    if (inGame.rows.length === 0) {
      return res.status(403).json({ error: "forbidden" });
    }

    if (game.status !== "waiting_setup") {
      return res.status(400).json({ error: "bad_request" });
    }

    for (const s of ships) {
      if (typeof s !== "object" || Array.isArray(s) || s === null) {
        return res.status(400).json({ error: "bad_request" });
      }
      if (s.row == null || s.col == null) {
        return res.status(400).json({ error: "bad_request" });
      }
      const r = Number(s.row), c = Number(s.col);
      if (!Number.isInteger(r) || !Number.isInteger(c)) {
        return res.status(400).json({ error: "bad_request" });
      }
      if (r < 0 || r >= game.grid_size || c < 0 || c >= game.grid_size) {
        return res.status(400).json({ error: "bad_request" });
      }
    }

    const coords = ships.map(s => `${s.row},${s.col}`);
    if (new Set(coords).size !== coords.length) {
      return res.status(400).json({ error: "bad_request" });
    }

    const alreadyPlaced = await pool.query(
      "SELECT 1 FROM ships WHERE game_id=$1 AND player_id=$2", [game_id, pid]
    );
    if (alreadyPlaced.rows.length > 0) {
      return res.status(409).json({ error: "conflict" });
    }

    for (const s of ships) {
      await pool.query(
        "INSERT INTO ships (game_id, player_id, row, col) VALUES ($1,$2,$3,$4)",
        [game_id, pid, Number(s.row), Number(s.col)]
      );
    }

    const playerCountRes = await pool.query(
      "SELECT COUNT(*) AS cnt FROM game_players WHERE game_id=$1", [game_id]
    );
    const placedCountRes = await pool.query(
      "SELECT COUNT(DISTINCT player_id) AS cnt FROM ships WHERE game_id=$1", [game_id]
    );
    const totalPlayers = Number(playerCountRes.rows[0].cnt);
    const totalPlaced  = Number(placedCountRes.rows[0].cnt);

    if (totalPlaced >= totalPlayers && totalPlayers >= 2) {
      const firstPlayerRes = await pool.query(
        "SELECT player_id FROM game_players WHERE game_id=$1 ORDER BY player_id ASC LIMIT 1",
        [game_id]
      );
      const firstPlayer = firstPlayerRes.rows[0].player_id;
      await pool.query(
        "UPDATE games SET status='playing', current_turn_player_id=$1 WHERE id=$2",
        [firstPlayer, game_id]
      );
    }

    res.status(200).json({ status: "placed" });
  } catch (err) {
    console.error("POST /api/games/:id/place error:", err);
    res.status(500).json({ error: "server error" });
  }
});

// ─── fire ─────────────────────────────────────────────────────────────────────

app.post("/api/games/:id/fire", async (req, res) => {
  const game_id = safeId(req.params.id);
  if (game_id === null) return res.status(404).json({ error: "not_found" });

  const g = games[game_id];
  if (!g) return res.status(404).json({ error: "not_found" });

  if (g.finished) {
    return res.status(400).json({ error: "bad_request" });
  }

  const body = req.body || {};
  const pid = getPlayerId(body);
  if (pid === null || isNaN(pid)) {
    return res.status(400).json({ error: "bad_request" });
  }

  if (body.row === undefined || body.col === undefined) {
    return res.status(400).json({ error: "bad_request" });
  }

  const row = Number(body.row);
  const col = Number(body.col);

  if (Number.isNaN(row) || Number.isNaN(col)) {
    return res.status(400).json({ error: "bad_request" });
  }

  if (row < 0 || col < 0 || row >= g.grid_size || col >= g.grid_size) {
    return res.status(400).json({ error: "bad_request" });
  }

  if (!g.players.includes(pid)) {
    return res.status(403).json({ error: "forbidden" });
  }

  const currentPlayer = g.players[g.current_turn_index % g.players.length];
  if (pid !== currentPlayer) {
    return res.status(403).json({ error: "forbidden" });
  }

  if (!g.firedCells[pid]) g.firedCells[pid] = new Set();
  const key = `${row},${col}`;

  if (g.firedCells[pid].has(key)) {
    return res.status(409).json({ error: "conflict" });
  }

  g.firedCells[pid].add(key);

  let hit = false;
  let hitPlayerId = null;

  for (const other of g.players) {
    if (other === pid) continue;

    for (const s of g.ships[other] || []) {
      if (s.row === row && s.col === col && !s.hit) {
        s.hit = true;
        hit = true;
        hitPlayerId = other;
        break;
      }
    }
    if (hit) break;
  }

  // ensure stats object exists
  if (!players[pid]) {
    players[pid] = {
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

  players[pid].stats.total_shots++;
  if (hit) players[pid].stats.total_hits++;

  players[pid].stats.accuracy =
    players[pid].stats.total_hits / players[pid].stats.total_shots;

  let game_status = g.status;
  let winner_id = null;

  if (hit && hitPlayerId !== null) {
    const remainRes = await pool.query(
      "SELECT COUNT(*) AS cnt FROM ships WHERE game_id=$1 AND player_id=$2 AND hit=false",
      [game_id, hitPlayerId]
    );

    // 🔥 FIX: WIN WHEN THIS PLAYER HAS 0 SHIPS LEFT
    if (Number(remainRes.rows[0].cnt) === 0) {
      game_status = "finished";
      winner_id = pid;

      await pool.query(
        "UPDATE games SET status='finished', winner_id=$1 WHERE id=$2",
        [pid, game_id]
      );

      // winner
      await pool.query(
        "UPDATE players SET games_played = games_played + 1, wins = wins + 1 WHERE id = $1",
        [pid]
      );

      // losers
      const others = g.players.filter(p => p !== pid);
      for (const opp of others) {
        await pool.query(
          "UPDATE players SET games_played = games_played + 1, losses = losses + 1 WHERE id = $1",
          [opp]
        );
      }

      g.finished = true;
      g.status = "finished";
      g.winner_id = pid;
    }
  }

  // save move
  await pool.query(
    "INSERT INTO moves (game_id, player_id, row, col, result) VALUES ($1,$2,$3,$4,$5)",
    [game_id, pid, row, col, hit ? "hit" : "miss"]
  );

  if (!g.finished) {
    g.current_turn_index++;
  }

  const next_player_id = g.finished
    ? null
    : g.players[g.current_turn_index % g.players.length];

  res.status(200).json({
    result: hit ? "hit" : "miss",
    next_player_id,
    game_status,
    winner_id
  });
});

// ─── move history ─────────────────────────────────────────────────────────────

app.get("/api/games/:id/moves", async (req, res) => {
  try {
    const game_id = safeId(req.params.id);
    if (game_id === null) return res.status(404).json({ error: "not_found" });

    const gameRes = await pool.query("SELECT id FROM games WHERE id=$1", [game_id]);
    if (gameRes.rows.length === 0) return res.status(404).json({ error: "not_found" });

    const movesRes = await pool.query(
      "SELECT player_id, row, col, hit FROM moves WHERE game_id=$1 ORDER BY id ASC",
      [game_id]
    );
    res.status(200).json(movesRes.rows);
  } catch {
    res.status(500).json({ error: "server error" });
  }
});

// ─── test restart ─────────────────────────────────────────────────────────────

app.post("/api/test/games/:id/restart", async (req, res) => {
  // Auth check FIRST — before any DB work
  const header = req.header("X-Test-Password");
  if (!header || header !== TEST_PASSWORD) {
    return res.status(403).json({ error: "forbidden" });
  }

  try {
    const game_id = safeId(req.params.id);
    if (game_id === null) return res.status(404).json({ error: "not_found" });

    const gameRes = await pool.query("SELECT * FROM games WHERE id=$1", [game_id]);
    if (gameRes.rows.length === 0) return res.status(404).json({ error: "not_found" });

    const game = gameRes.rows[0];

    await pool.query("DELETE FROM moves WHERE game_id=$1", [game_id]);
    await pool.query("DELETE FROM ships WHERE game_id=$1", [game_id]);
    await pool.query("DELETE FROM game_players WHERE game_id=$1", [game_id]);
    await pool.query(
      "INSERT INTO game_players (game_id, player_id) VALUES ($1,$2)",
      [game_id, game.creator_id]
    );
    await pool.query(
      "UPDATE games SET status='waiting_setup', current_turn_player_id=NULL, winner_id=NULL WHERE id=$1",
      [game_id]
    );

    res.status(200).json({ status: "waiting_setup" });
  } catch {
    res.status(500).json({ error: "server error" });
  }
});

// ─── root ─────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on port ${PORT}`));