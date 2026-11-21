# sokoban-solver-01-run-20261121

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/nandorp28/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/nandorp28/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

Room-split push-optimal Sokoban solver for make.fun's "Build the best Sokoban solver, 21 November 2026" bounty.

Every level the generator builds is one hallway with one to four small rooms hanging off it, each room holding 3–4 boxes and as many goals, and a box pushed out of a room through its door can never come back. So a level splits into independent per-room puzzles: this solver finds each room, solves it on its own with a push-optimal A*, then stitches the rooms together with plain walks along the hallway.

Per room the search is A* over pushes. A state is the sorted box squares plus the player's reachable region (canonicalised to its lowest square). The estimate is the cheapest assignment of boxes to goals by shortest floor distances, which no single push can shrink by more than one, so it never overestimates. Dead squares (found by pulling a box back from every goal), 2×2 blocks with no goal, and unreachable boxes are pruned. The search is cut off by a fixed expansion budget, never by the clock, so two runs write the same bytes. If the optimal search runs out of budget, a weighted A* falls back to any solution rather than none.

## Results

- Practice set: **1,000,000 / 1,000,000** — every instance solved in exactly its push-optimal count (13, 16, 29, 47, 60 pushes), ~0.5 s for the whole set.
- 20 freshly drawn sets from the published generator: **1,000,000 on all 20**, byte-identical outputs on repeat runs.
- House baseline (plain-astar 1.0.0) on the same practice set: 200,000 — it solves only the single 3-box room and fails every larger level.

## Run it

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` is the whole entry: Node 22, standard library only, no dependencies. It reads `/input/<id>/level.txt` for each instance and writes `/output/<id>/solution.txt` (the player's moves in LURD).
