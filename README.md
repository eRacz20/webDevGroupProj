Battleship API Project
Project Overview

This project is a RESTful API for a simplified multiplayer Battleship game. Users can create players, join games, place ships, and take turns firing at opponents. The backend handles all game logic, player statistics, and win conditions.

Built using Node.js and Express, the application stores data in-memory for simplicity and testing.

Architecture Summary

The system follows a client-server architecture:

Backend: Node.js + Express for routing and logic
Storage: In-memory objects (players, games)

Core Components:
Players: usernames and stats
Games: state, ships, turns, and moves
Helpers: validation and coordinate parsing

API Description
Players
POST /api/players – Create player
GET /api/players/:id/stats – Get stats
Games
POST /api/games – Create game
GET /api/games/:id – Game status
POST /api/games/:id/join – Join game
Gameplay
POST /api/games/:id/place – Place ships
POST /api/games/:id/fire – Fire at opponent
GET /api/games/:id/moves – Move history

Test (Protected)
Reset system, force ship placement, reveal board, restart game

Team Members
Evan Racz
Truc Le

AI Tool(s) Used
ChatGPT (OpenAI) for debugging, refining logic, and generating documentation.
Claude for assistance with writing functions and help debugging. 

Roles and Contributions
Evan Racz
  Set up the initial project structure and core API
  Implemented foundational features:
  Player creation and stats
  Game creation and joining
  Basic game state management
  Established the overall architecture and flow of the application
Truc Le
  Expanded the project with additional features
  Added more edge case handling and validation
  Improved gameplay logic and robustness
  Contributed additional testing and fixes
AI Contributions
Assisted with debugging and refining code
Suggested improvements for edge cases and validation
Helped structure and write documentation
Helped with writing and logic
Summary

This project demonstrates REST API design, backend game state management, and turn-based gameplay logic. It provides a solid foundation for future expansion into a full-stack multiplayer application.
