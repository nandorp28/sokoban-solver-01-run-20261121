// Sokoban solver for make.fun's sokoban-solver-01-run-20261121.
//
// Idea: the generator builds every level as one hallway with one to four
// small rooms hanging off it, each room holding 3-4 boxes and as many goals,
// and a box pushed out of a room through its door can never come back. So a
// level splits into independent per-room puzzles: solve each room on its own
// with a push-optimal A* (pushes are what the score counts), then stitch the
// rooms together with plain walks along the hallway.
//
// Per room the search is A* over pushes. A state is the sorted box squares
// plus the player's reachable region (canonicalised to its lowest square).
// The estimate is the cheapest assignment of boxes to goals by shortest
// floor distances, which no single push can shrink by more than one, so it
// never overestimates. Dead squares (found by pulling a box back from every
// goal), 2x2 blocks with no goal, and unreachable boxes are pruned. The
// search is cut off by a fixed expansion budget, never by the clock, so two
// runs write the same bytes. If the optimal search runs out of budget, a
// weighted A* falls back to any solution rather than none.
//
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const DIRS = [
  { dx: 0, dy: -1, ch: 'u' },
  { dx: 0, dy: 1, ch: 'd' },
  { dx: -1, dy: 0, ch: 'l' },
  { dx: 1, dy: 0, ch: 'r' },
];

// Fixed work budgets (expansions), never the wall clock: the run must be
// byte-identical when executed twice, so the search stops on work done.
const OPT_BUDGET = 300_000;
const GREEDY_BUDGET = 150_000;
const WHOLE_LEVEL_BUDGET = 50_000;
const TOTAL_BUDGET = 1_200_000;
let spent = 0;

// ---------------------------------------------------------------- parsing

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: Set<number>;
  boxes: number[];
  player: number;
}

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const w = Math.max(...rows.map((r) => r.length));
  const h = rows.length;
  const wall = new Uint8Array(w * h);
  const goals = new Set<number>();
  const boxes: number[] = [];
  let player = 0;
  rows.forEach((row, y) => {
    for (let x = 0; x < w; x++) {
      const ch = row[x] ?? '#';
      const i = y * w + x;
      if (ch === '#') wall[i] = 1;
      if ('.*+'.includes(ch)) goals.add(i);
      if ('$*'.includes(ch)) boxes.push(i);
      if ('@+'.includes(ch)) player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

// ------------------------------------------------------- room decomposition

interface Room {
  cells: number[]; // global squares: the room's floor plus its entry square
  loc: Map<number, number>; // global square -> local index
  goals: number[]; // local indices of goal squares
  goalSet: Set<number>;
  boxes: number[]; // local indices, sorted
  entry: number; // local index of the hallway square outside the door
  door: number; // local index of the room square touching the hallway
  n: number;
}

function decompose(level: Level): Room[] | null {
  const { w, h, wall, player } = level;
  const hallRow = Math.floor(player / w);
  // Rooms are the connected components of floor squares once the hallway
  // row is taken out; each opens onto the hallway through exactly one door.
  const seen = new Uint8Array(w * h);
  const rooms: Room[] = [];
  const neighbours = (i: number): number[] => {
    const out: number[] = [];
    const x = i % w;
    const y = Math.floor(i / w);
    if (x > 0) out.push(i - 1);
    if (x < w - 1) out.push(i + 1);
    if (y > 0) out.push(i - w);
    if (y < h - 1) out.push(i + w);
    return out.filter((j) => !wall[j] && Math.floor(j / w) !== hallRow);
  };
  for (let i = 0; i < w * h; i++) {
    if (wall[i] || Math.floor(i / w) === hallRow || seen[i]) continue;
    const comp: number[] = [];
    const stack = [i];
    seen[i] = 1;
    while (stack.length > 0) {
      const u = stack.pop()!;
      comp.push(u);
      for (const v of neighbours(u)) {
        if (!seen[v]) {
          seen[v] = 1;
          stack.push(v);
        }
      }
    }
    const compSet = new Set(comp);
    const roomBoxes = level.boxes.filter((b) => compSet.has(b));
    if (roomBoxes.length === 0) continue;
    // The door is the room square touching a hallway square.
    const doors = comp.filter((c) => {
      const x = c % w;
      const y = Math.floor(c / w);
      const up = y > 0 ? c - w : -1;
      const down = y < h - 1 ? c + w : -1;
      void x;
      return (
        (up >= 0 && Math.floor(up / w) === hallRow && !wall[up]) ||
        (down >= 0 && Math.floor(down / w) === hallRow && !wall[down])
      );
    });
    if (doors.length !== 1) return null;
    const door = doors[0]!;
    const dy = Math.floor(door / w) < hallRow ? 1 : -1;
    const entry = door + dy * w;
    if (wall[entry] || Math.floor(entry / w) !== hallRow) return null;
    const cells = [...comp, entry];
    const loc = new Map<number, number>();
    cells.forEach((c, k) => loc.set(c, k));
    const goals = [...level.goals].filter((g) => compSet.has(g)).map((g) => loc.get(g)!);
    const boxes = roomBoxes.map((b) => loc.get(b)!).sort((a, b) => a - b);
    rooms.push({
      cells,
      loc,
      goals,
      goalSet: new Set(goals),
      boxes,
      entry: loc.get(entry)!,
      door: loc.get(door)!,
      n: cells.length,
    });
  }
  const boxed = rooms.reduce((s, r) => s + r.boxes.length, 0);
  if (boxed !== level.boxes.length) return null;
  return rooms;
}

// ------------------------------------------------------------ walking (BFS)

function walkPath(
  from: number,
  to: number,
  w: number,
  floor: (i: number) => boolean,
  blocked: Set<number>,
): string | null {
  if (from === to) return '';
  const prev = new Map<number, number>();
  const step = new Map<number, string>();
  const queue = [from];
  prev.set(from, -1);
  for (let head = 0; head < queue.length; head++) {
    const u = queue[head]!;
    for (const d of DIRS) {
      const v = u + d.dy * w + d.dx;
      if (prev.has(v) || blocked.has(v) || !floor(v)) continue;
      prev.set(v, u);
      step.set(v, d.ch);
      if (v === to) {
        let moves = '';
        for (let t = v; t !== from; t = prev.get(t)!) moves = step.get(t)! + moves;
        return moves;
      }
      queue.push(v);
    }
  }
  return null;
}

// ------------------------------------------------------- per-room A* search

interface PushStep {
  box: number; // global square the box is pushed from
  dx: number;
  dy: number;
  ch: string;
}

// All-pairs shortest floor distances inside a room (walls only, no boxes).
function roomDistances(room: Room, level: Level): Int32Array {
  const n = room.n;
  const dist = new Int32Array(n * n).fill(-1);
  const w = level.w;
  for (let s = 0; s < n; s++) {
    const start = room.cells[s]!;
    const d = new Int32Array(n).fill(-1);
    d[s] = 0;
    const queue = [s];
    for (let head = 0; head < queue.length; head++) {
      const u = queue[head]!;
      const gu = room.cells[u]!;
      for (const dir of DIRS) {
        const gv = gu + dir.dy * w + dir.dx;
        const v = room.loc.get(gv);
        if (v === undefined || d[v] !== -1) continue;
        d[v] = d[u]! + 1;
        queue.push(v);
      }
    }
    for (let t = 0; t < n; t++) dist[s * n + t] = d[t]!;
  }
  return dist;
}

// Squares a box can never leave: pull a box backwards from every goal; a
// square is live when a live neighbour can be reached by pushing from a
// floor square on the far side. Goals are live by definition.
function liveSquares(room: Room, level: Level): Uint8Array {
  const n = room.n;
  const live = new Uint8Array(n);
  for (const g of room.goals) live[g] = 1;
  const w = level.w;
  let changed = true;
  while (changed) {
    changed = false;
    for (let c = 0; c < n; c++) {
      if (live[c]) continue;
      const gc = room.cells[c]!;
      for (const dir of DIRS) {
        const gl = gc + dir.dy * w + dir.dx;
        const l = room.loc.get(gl);
        if (l === undefined || !live[l]) continue;
        const gb = gc - dir.dy * w - dir.dx;
        if (room.loc.get(gb) === undefined) continue;
        live[c] = 1;
        changed = true;
        break;
      }
    }
  }
  return live;
}

// 2x2 blocks (as local indices, -1 for a wall square) that contain a given
// square; a block with no goal whose four squares are all wall-or-box is dead.
function blocksFor(room: Room, level: Level): number[][][] {
  const w = level.w;
  const h = level.h;
  const perCell: number[][][] = Array.from({ length: room.n }, () => []);
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const cells = [y * w + x, y * w + x + 1, (y + 1) * w + x, (y + 1) * w + x + 1];
      const locals = cells.map((c) => room.loc.get(c) ?? -1);
      if (!locals.some((l) => l >= 0)) continue;
      const hasGoal = locals.some((l) => l >= 0 && room.goalSet.has(l));
      if (hasGoal) continue;
      for (const l of locals) {
        if (l >= 0) perCell[l]!.push(locals);
      }
    }
  }
  return perCell;
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = items.slice(0, i).concat(items.slice(i + 1));
    for (const p of permutations(rest)) out.push([items[i]!, ...p]);
  }
  return out;
}

// Push-optimal A* for one room. Returns the push list, or null when the
// budget runs out or the room cannot be solved. requireExit: the player
// must be able to reach the door from the final square (so it can leave
// for the next room); a room that only solves without an exit is solved
// last by the caller.
function solveRoom(
  room: Room,
  level: Level,
  dist: Int32Array,
  live: Uint8Array,
  blocks: number[][][],
  budget: number,
  weight: number,
  requireExit: boolean,
): PushStep[] | null {
  const n = room.n;
  const w = level.w;
  const nb = room.boxes.length;
  const goalPerms = permutations(room.goals);
  const boxSetOf = (boxes: number[]): Set<number> => new Set(boxes);

  // Flood the player's reachable region from a square, boxes in the way.
  const region = (start: number, boxes: Set<number>): Set<number> => {
    const seen = new Set<number>([start]);
    const queue = [start];
    for (let head = 0; head < queue.length; head++) {
      const u = queue[head]!;
      const gu = room.cells[u]!;
      for (const dir of DIRS) {
        const gv = gu + dir.dy * w + dir.dx;
        const v = room.loc.get(gv);
        if (v === undefined || seen.has(v) || boxes.has(v)) continue;
        seen.add(v);
        queue.push(v);
      }
    }
    return seen;
  };
  const canonical = (reach: Set<number>): number => Math.min(...reach);

  const heuristic = (boxes: number[]): number => {
    let best = Infinity;
    for (const perm of goalPerms) {
      let sum = 0;
      for (let i = 0; i < nb; i++) {
        const d = dist[boxes[i]! * n + perm[i]!]!;
        if (d < 0) {
          sum = Infinity;
          break;
        }
        sum += d;
      }
      if (sum < best) best = sum;
    }
    return best;
  };

  const solved = (boxes: number[]): boolean => boxes.every((b) => room.goalSet.has(b));

  const dead2x2 = (boxes: Set<number>, moved: number): boolean => {
    for (const block of blocks[moved]!) {
      let allBlocked = true;
      let anyBox = false;
      for (const c of block) {
        if (c < 0) continue; // wall
        if (boxes.has(c)) {
          anyBox = true;
        } else {
          allBlocked = false;
          break;
        }
      }
      if (allBlocked && anyBox) return true;
    }
    return false;
  };

  // Node storage.
  const nodeBoxes: number[][] = [room.boxes.slice()];
  const nodePlayer: number[] = [room.entry];
  const nodeG: number[] = [0];
  const nodeParent: number[] = [-1];
  const nodePushBox: number[] = [-1];
  const nodePushDir: number[] = [-1];
  const keyOf = (boxes: number[], canon: number): number => {
    let k = canon;
    for (const b of boxes) k = k * 128 + b;
    return k;
  };

  const startRegion = region(room.entry, boxSetOf(room.boxes));
  const best = new Map<number, number>([[keyOf(room.boxes, canonical(startRegion)), 0]]);
  // Heap of [f, g, node], smallest f first, deeper g first on a tie.
  const heap: [number, number, number][] = [];
  const h0 = heuristic(room.boxes);
  if (h0 === Infinity) return null;
  const less = (a: [number, number, number], b: [number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && a[1] > b[1]);
  const heapPush = (e: [number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): [number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
        if (!less(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };
  heapPush([h0 * weight, 0, 0]);

  let expanded = 0;
  while (heap.length > 0) {
    if (expanded >= budget || spent >= TOTAL_BUDGET) return null;
    const [, g, s] = heapPop();
    const boxes = nodeBoxes[s]!;
    const player = nodePlayer[s]!;
    const reach = region(player, boxSetOf(boxes));
    const canon = canonical(reach);
    const k = keyOf(boxes, canon);
    if ((best.get(k) ?? Infinity) < g) continue;
    if (solved(boxes)) {
      if (!requireExit || reach.has(room.door)) {
        const pushes: PushStep[] = [];
        for (let t = s; t > 0; t = nodeParent[t]!) {
          const dir = DIRS[nodePushDir[t]!]!;
          const gb = nodeBoxes[nodeParent[t]!]![nodePushBox[t]!]!;
          pushes.push({ box: room.cells[gb]!, dx: dir.dx, dy: dir.dy, ch: dir.ch });
        }
        pushes.reverse();
        return pushes;
      }
      // Solved but the player cannot leave: keep searching for an exit.
    }
    expanded++;
    spent++;
    for (let bi = 0; bi < nb; bi++) {
      const b = boxes[bi]!;
      const gb = room.cells[b]!;
      for (let di = 0; di < 4; di++) {
        const dir = DIRS[di]!;
        const destG = gb + dir.dy * w + dir.dx;
        const dest = room.loc.get(destG);
        if (dest === undefined || boxes.includes(dest)) continue;
        const pushFromG = gb - dir.dy * w - dir.dx;
        const pushFrom = room.loc.get(pushFromG);
        if (pushFrom === undefined || !reach.has(pushFrom)) continue;
        if (!live[dest] && !room.goalSet.has(dest)) continue;
        const nb2 = boxes.slice();
        nb2[bi] = dest;
        nb2.sort((a, b2) => a - b2);
        const set2 = boxSetOf(nb2);
        if (dead2x2(set2, dest)) continue;
        const h = heuristic(nb2);
        if (h === Infinity) continue;
        const g2 = g + 1;
        const reach2 = region(b, set2);
        const k2 = keyOf(nb2, canonical(reach2));
        if ((best.get(k2) ?? Infinity) <= g2) continue;
        best.set(k2, g2);
        const t = nodeBoxes.length;
        nodeBoxes.push(nb2);
        nodePlayer.push(b);
        nodeG.push(g2);
        nodeParent.push(s);
        nodePushBox.push(bi);
        nodePushDir.push(di);
        heapPush([g2 + h * weight, g2, t]);
      }
    }
  }
  return null;
}

// ------------------------------------------------------------ whole level

function solveLevel(text: string): string {
  const level = parseLevel(text);
  const { w } = level;
  const rooms = decompose(level);
  if (rooms === null) {
    // Fallback: one push search over the whole level, no exit needed.
    return solveWholeLevel(level);
  }
  const boxNow = new Map<number, number>();
  for (const b of level.boxes) boxNow.set(b, b);
  let player = level.player;
  let moves = '';

  const floorGlobal = (i: number): boolean => i >= 0 && i < w * level.h && !level.wall[i];
  const blockedGlobal = (): Set<number> => new Set(boxNow.keys());

  interface RoomPlan {
    room: Room;
    pushes: PushStep[];
    needsExit: boolean;
  }
  const plans: RoomPlan[] = [];
  const noExit: RoomPlan[] = [];
  for (const room of rooms) {
    const dist = roomDistances(room, level);
    const live = liveSquares(room, level);
    const blocks = blocksFor(room, level);
    let pushes = solveRoom(room, level, dist, live, blocks, OPT_BUDGET, 1, true);
    let needsExit = true;
    if (pushes === null) {
      pushes = solveRoom(room, level, dist, live, blocks, GREEDY_BUDGET, 3, true);
    }
    if (pushes === null) {
      pushes = solveRoom(room, level, dist, live, blocks, GREEDY_BUDGET, 3, false);
      needsExit = false;
    }
    if (pushes === null) return '';
    const plan = { room, pushes, needsExit };
    if (needsExit) plans.push(plan);
    else noExit.push(plan);
  }
  // Rooms that trap the player go last: after them nobody needs to leave.
  const ordered = [...plans, ...noExit];

  for (const { room, pushes } of ordered) {
    // Walk the player to the room's entry square (hallway side of the door).
    const entryG = room.cells[room.entry]!;
    const walk = walkPath(player, entryG, w, floorGlobal, blockedGlobal());
    if (walk === null) return '';
    moves += walk;
    player = entryG;
    const roomFloor = (i: number): boolean => room.loc.has(i);
    for (const push of pushes) {
      const fromG = push.box - push.dy * w - push.dx;
      const roomBlocked = new Set<number>();
      for (const b of boxNow.keys()) {
        if (room.loc.has(b)) roomBlocked.add(b);
      }
      const leg = walkPath(player, fromG, w, roomFloor, roomBlocked);
      if (leg === null) return '';
      moves += leg;
      moves += push.ch;
      const destG = push.box + push.dy * w + push.dx;
      boxNow.delete(push.box);
      boxNow.set(destG, destG);
      player = push.box;
    }
  }
  return moves;
}

// Last resort when the level does not split into rooms: the same push
// search, run over the whole board with a small budget.
function solveWholeLevel(level: Level): string {
  const { w, h, wall } = level;
  const cells: number[] = [];
  for (let i = 0; i < w * h; i++) if (!wall[i]) cells.push(i);
  const loc = new Map<number, number>();
  cells.forEach((c, k) => loc.set(c, k));
  const room: Room = {
    cells,
    loc,
    goals: [...level.goals].map((g) => loc.get(g)!),
    goalSet: new Set([...level.goals].map((g) => loc.get(g)!)),
    boxes: level.boxes.map((b) => loc.get(b)!).sort((a, b) => a - b),
    entry: loc.get(level.player)!,
    door: loc.get(level.player)!,
    n: cells.length,
  };
  const dist = roomDistances(room, level);
  const live = liveSquares(room, level);
  const blocks = blocksFor(room, level);
  const pushes = solveRoom(room, level, dist, live, blocks, WHOLE_LEVEL_BUDGET, 1, false);
  if (pushes === null) return '';
  let moves = '';
  let player = level.player;
  const boxNow = new Set(level.boxes);
  const floorGlobal = (i: number): boolean => i >= 0 && i < w * h && !wall[i];
  for (const push of pushes) {
    const fromG = push.box - push.dy * w - push.dx;
    const leg = walkPath(player, fromG, w, floorGlobal, boxNow);
    if (leg === null) return '';
    moves += leg;
    moves += push.ch;
    boxNow.delete(push.box);
    boxNow.add(push.box + push.dy * w + push.dx);
    player = push.box;
  }
  return moves;
}

// ------------------------------------------------------------------- driver

for (const id of readdirSync(I).sort()) {
  const moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
