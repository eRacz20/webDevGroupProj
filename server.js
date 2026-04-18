import express from "express";
import cors from "cors";
import { pool } from "./db.js";

const app = express();

app.use(cors());
app.use(express.json());

const TEST_PASSWORD = "clemson-test-2026";

// ─── helpers ────────────────────────────────────────────────────────────────

function safeId(param) {
  const n = Number(param);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
}

function requireTestMode(req, res) {
  if (req.header("X-Test-Password") !== TEST_PASSWORD) {
    res.status(403).json({ error: "forbidden" });
    return false;
  }
  return true;
}

// ─── health ─────────────────────────────────────────────────────────────────

app.get("/api/health", (_req, res) => res.status(200).json({ status: "ok" }));

// ─── reset (dev utility) ────────────────────────────────────────────────────

app.post("/api/reset", async (_req, res) => {
  try {
    await pool.query("DELETE FROM game_players");
    await pool.query("DELETE FROM ships");
    await pool.query("DELETE FROM moves");
    await pool.query("DELETE FROM games");
    await pool.query("DELETE FROM players");
    res.status(200).json({ status: "reset" });
  } catch {
    res.status(500).json({ error: "server error" });
  }
});

// ─── players ────────────────────────────────────────────────────────────────

// GET /api/players
app.get("/api/players", async (_req, res) => {
  try {
    const result = await pool.query("SELECT id, username FROM players ORDER BY id");
    res.status(200).json(result.rows);
  } catch {
    res.status(500).json({ error: "server error" });
  }
});

// POST /api/players
app.post("/api/players", async (req, res) => {
  try {
    const username = req.body?.username;

    if (!username || typeof username !== "string" || username.trim() === "") {
      return res.status(400).json({ error: "bad_request" });
    }

    if (!/^[a-zA-Z0-9_]+$/.test(username) || username.length > 30) {
      return res.status(400).json({ error: "bad_request" });
    }

    // Check duplicate in DB (source of truth — works across restarts)
    const existing = await pool.query(
      "SELECT id FROM players WHERE username = $1",
      [username]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: "conflict" });
    }

    const result = await pool.query(
      "INSERT INTO players (username) VALUES ($1) RETURNING id",
      [username]
    );

    res.status(201).json({ player_id: result.rows[0].id });
  } catch {
    res.status(500).json({ error: "server error" });
  }
});

// GET /api/players/:id/stats
app.get("/api/players/:id/stats", async (req, res) => {
  try {
    const id = safeId(req.params.id);
    if (id === null) return res.status(404).json({ error: "not_found" });

    const result = await pool.query(
      "SELECT * FROM players WHERE id = $1",
      [id]
    );
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

// ─── games ──────────────────────────────────────────────────────────────────

// GET /api/games
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

// POST /api/games
app.post("/api/games", async (req, res) => {
  try {
    const { creator_id, grid_size, max_players } = req.body ?? {};

    if (creator_id == null || grid_size == null || max_players == null) {
      return res.status(400).json({ error: "bad_request" });
    }

    const gs = Number(grid_size);
    const mp = Number(max_players);
    const cid = Number(creator_id);

    if (!Number.isInteger(gs) || gs < 5 || gs > 15) {
      return res.status(400).json({ error: "bad_request" });
    }
    if (!Number.isInteger(mp) || mp < 2) {
      return res.status(400).json({ error: "bad_request" });
    }
    if (!Number.isFinite(cid) || !Number.isInteger(cid) || cid <= 0) {
      return res.status(400).json({ error: "bad_request" });
    }

    const playerCheck = await pool.query(
      "SELECT id FROM players WHERE id = $1",
      [cid]
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

// GET /api/games/:id
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
      "SELECT player_id FROM game_players WHERE game_id = $1",
      [id]
    );
    const players = playersRes.rows.map(r => r.player_id);

    const movesRes = await pool.query(
      "SELECT COUNT(*) AS cnt FROM moves WHERE game_id = $1",
      [id]
    );
    const total_moves = Number(movesRes.rows[0].cnt);

    // current turn: only meaningful when playing
    let current_turn_player_id = null;
    if (game.status === "playing" && players.length > 0) {
      current_turn_player_id = game.current_turn_player_id ?? players[0];
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
      winner_id:             game.winner_id ?? null,
    });
  } catch {
    res.status(500).json({ error: "server error" });
  }
});

// ─── join game ──────────────────────────────────────────────────────────────

// POST /api/games/:id/join
app.post("/api/games/:id/join", async (req, res) => {
  try {
    const game_id = safeId(req.params.id);
    if (game_id === null) return res.status(404).json({ error: "not_found" });

    const player_id = req.body?.player_id != null
      ? Number(req.body.player_id)
      : null;

    if (player_id == null || !Number.isInteger(player_id) || player_id <= 0) {
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

    // game must be in waiting_setup
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
      "SELECT COUNT(*) AS cnt FROM game_players WHERE game_id=$1",
      [game_id]
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

// ─── place ships ────────────────────────────────────────────────────────────

// POST /api/games/:id/place
app.post("/api/games/:id/place", async (req, res) => {
  try {
    const game_id = safeId(req.params.id);
    if (game_id === null) return res.status(404).json({ error: "not_found" });

    const { player_id, ships } = req.body ?? {};

    if (player_id == null) return res.status(400).json({ error: "bad_request" });
    const pid = Number(player_id);
    if (!Number.isInteger(pid) || pid <= 0) {
      return res.status(400).json({ error: "bad_request" });
    }

    if (!ships || !Array.isArray(ships)) {
      return res.status(400).json({ error: "bad_request" });
    }

    // game exists?
    const gameRes = await pool.query("SELECT * FROM games WHERE id = $1", [game_id]);
    if (gameRes.rows.length === 0) return res.status(404).json({ error: "not_found" });
    const game = gameRes.rows[0];

    // player in game?
    const inGame = await pool.query(
      "SELECT 1 FROM game_players WHERE game_id=$1 AND player_id=$2",
      [game_id, pid]
    );
    if (inGame.rows.length === 0) {
      return res.status(403).json({ error: "forbidden" });
    }

    // game must be waiting_setup
    if (game.status !== "waiting_setup") {
      return res.status(400).json({ error: "bad_request" });
    }

    // validate ships: need exactly 3, each must be an object with row/col
    if (ships.length < 3) return res.status(400).json({ error: "bad_request" });

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

    // duplicate coordinates?
    const coords = ships.map(s => `${s.row},${s.col}`);
    if (new Set(coords).size !== coords.length) {
      return res.status(400).json({ error: "bad_request" });
    }

    // already placed?
    const alreadyPlaced = await pool.query(
      "SELECT 1 FROM ships WHERE game_id=$1 AND player_id=$2",
      [game_id, pid]
    );
    if (alreadyPlaced.rows.length > 0) {
      return res.status(409).json({ error: "conflict" });
    }

    // insert ships
    for (const s of ships) {
      await pool.query(
        "INSERT INTO ships (game_id, player_id, row, col) VALUES ($1,$2,$3,$4)",
        [game_id, pid, Number(s.row), Number(s.col)]
      );
    }

    // check if all players have placed → transition to playing
    const playerCountRes = await pool.query(
      "SELECT COUNT(*) AS cnt FROM game_players WHERE game_id=$1",
      [game_id]
    );
    const placedCountRes = await pool.query(
      "SELECT COUNT(DISTINCT player_id) AS cnt FROM ships WHERE game_id=$1",
      [game_id]
    );

    const totalPlayers = Number(playerCountRes.rows[0].cnt);
    const totalPlaced  = Number(placedCountRes.rows[0].cnt);

    if (totalPlaced >= totalPlayers && totalPlayers >= 2) {
      // pick first player (lowest id among players in game)
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

// ─── fire ───────────────────────────────────────────────────────────────────

// POST /api/games/:id/fire
app.post("/api/games/:id/fire", async (req, res) => {
  try {
    const game_id = safeId(req.params.id);
    if (game_id === null) return res.status(404).json({ error: "not_found" });

    const { player_id, row, col } = req.body ?? {};

    if (player_id == null || row == null || col == null) {
      return res.status(400).json({ error: "bad_request" });
    }

    const pid = Number(player_id);
    const r   = Number(row);
    const c   = Number(col);

    if (!Number.isInteger(pid) || pid <= 0 ||
        !Number.isInteger(r)   ||
        !Number.isInteger(c)) {
      return res.status(400).json({ error: "bad_request" });
    }

    // game exists?
    const gameRes = await pool.query("SELECT * FROM games WHERE id = $1", [game_id]);
    if (gameRes.rows.length === 0) return res.status(404).json({ error: "not_found" });
    const game = gameRes.rows[0];

    // game must be playing
    if (game.status === "finished") {
      return res.status(400).json({ error: "bad_request" });
    }
    if (game.status !== "playing") {
      return res.status(400).json({ error: "bad_request" });
    }

    // bounds check
    if (r < 0 || r >= game.grid_size || c < 0 || c >= game.grid_size) {
      return res.status(400).json({ error: "bad_request" });
    }

    // correct turn?
    if (game.current_turn_player_id !== pid) {
      return res.status(403).json({ error: "forbidden" });
    }

    // duplicate fire?
    const dupRes = await pool.query(
      "SELECT 1 FROM moves WHERE game_id=$1 AND player_id=$2 AND row=$3 AND col=$4",
      [game_id, pid, r, c]
    );
    if (dupRes.rows.length > 0) {
      return res.status(409).json({ error: "conflict" });
    }

    // get all other players
    const othersRes = await pool.query(
      "SELECT player_id FROM game_players WHERE game_id=$1 AND player_id != $2",
      [game_id, pid]
    );
    const others = othersRes.rows.map(rw => rw.player_id);

    // check hit against any opponent's ships
    let hit = false;
    let hitPlayerId = null;
    for (const opp of others) {
      const shipRes = await pool.query(
        "SELECT id FROM ships WHERE game_id=$1 AND player_id=$2 AND row=$3 AND col=$4",
        [game_id, opp, r, c]
      );
      if (shipRes.rows.length > 0) {
        hit = true;
        hitPlayerId = opp;
        // mark ship as hit
        await pool.query(
          "UPDATE ships SET hit=true WHERE game_id=$1 AND player_id=$2 AND row=$3 AND col=$4",
          [game_id, opp, r, c]
        );
        break;
      }
    }

    // record move
    await pool.query(
      "INSERT INTO moves (game_id, player_id, row, col, hit) VALUES ($1,$2,$3,$4,$5)",
      [game_id, pid, r, c, hit]
    );

    // update stats
    await pool.query(
      "UPDATE players SET total_shots = total_shots + 1, total_hits = total_hits + $1 WHERE id = $2",
      [hit ? 1 : 0, pid]
    );

    // check if hitPlayerId has all ships sunk
    let game_status = "playing";
    let winner_id   = null;
    let next_player_id = null;

    if (hit && hitPlayerId !== null) {
      const remainRes = await pool.query(
        "SELECT COUNT(*) AS cnt FROM ships WHERE game_id=$1 AND player_id=$2 AND (hit IS NULL OR hit=false)",
        [game_id, hitPlayerId]
      );
      if (Number(remainRes.rows[0].cnt) === 0) {
        // that opponent is eliminated; check if game over (only 1 player left with ships)
        const aliveRes = await pool.query(
          `SELECT DISTINCT s.player_id FROM ships s
           WHERE s.game_id=$1
             AND EXISTS (
               SELECT 1 FROM ships s2
               WHERE s2.game_id=$1 AND s2.player_id=s.player_id
                 AND (s2.hit IS NULL OR s2.hit=false)
             )`,
          [game_id]
        );
        if (aliveRes.rows.length <= 1) {
          game_status = "finished";
          winner_id = pid;
          await pool.query(
            "UPDATE games SET status='finished', winner_id=$1 WHERE id=$2",
            [pid, game_id]
          );
          // update winner/loser stats
          await pool.query(
            "UPDATE players SET games_played = games_played + 1, wins = wins + 1 WHERE id = $1",
            [pid]
          );
          for (const opp of others) {
            await pool.query(
              "UPDATE players SET games_played = games_played + 1, losses = losses + 1 WHERE id = $1",
              [opp]
            );
          }
        }
      }
    }

    // determine next turn (rotate through players)
    if (game_status === "playing") {
      const allPlayersRes = await pool.query(
        "SELECT player_id FROM game_players WHERE game_id=$1 ORDER BY player_id ASC",
        [game_id]
      );
      const allPlayers = allPlayersRes.rows.map(rw => rw.player_id);
      const idx = allPlayers.indexOf(pid);
      next_player_id = allPlayers[(idx + 1) % allPlayers.length];
      await pool.query(
        "UPDATE games SET current_turn_player_id=$1 WHERE id=$2",
        [next_player_id, game_id]
      );
    } else {
      next_player_id = null;
    }

    res.status(200).json({
      result: hit ? "hit" : "miss",
      next_player_id,
      game_status,
      winner_id,
    });
  } catch (err) {
    console.error("POST /api/games/:id/fire error:", err);
    res.status(500).json({ error: "server error" });
  }
});

// ─── move history ───────────────────────────────────────────────────────────

// GET /api/games/:id/moves
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

// ─── test restart ───────────────────────────────────────────────────────────

// POST /api/test/games/:id/restart
app.post("/api/test/games/:id/restart", async (req, res) => {
  if (!requireTestMode(req, res)) return;

  try {
    const game_id = safeId(req.params.id);
    if (game_id === null) return res.status(404).json({ error: "not_found" });

    const gameRes = await pool.query("SELECT * FROM games WHERE id=$1", [game_id]);
    if (gameRes.rows.length === 0) return res.status(404).json({ error: "not_found" });

    const game = gameRes.rows[0];

    // delete moves and ships for this game, reset status
    await pool.query("DELETE FROM moves WHERE game_id=$1", [game_id]);
    await pool.query("DELETE FROM ships WHERE game_id=$1", [game_id]);

    // restore original players (just creator)
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

// ─── root ────────────────────────────────────────────────────────────────────

app.get("/", (_req, res) => res.send("Battleship API running"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on port ${PORT}`));