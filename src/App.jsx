import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { Undo2, Eraser, Lightbulb, Palette, Pencil, Hash, Shuffle, Settings, Sun, Moon, Play, Pause, Timer } from "lucide-react";

/* ============================================================
   STATIC BOARD GEOMETRY
   ============================================================ */
const SIZE = 9;

function rc(idx) { return [Math.floor(idx / 9), idx % 9]; }
function at(r, c) { return r * 9 + c; }
function label(idx) { const [r, c] = rc(idx); return `R${r + 1}C${c + 1}`; }
function formatTime(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

const ROW_UNITS = Array.from({ length: 9 }, (_, r) => Array.from({ length: 9 }, (_, c) => at(r, c)));
const COL_UNITS = Array.from({ length: 9 }, (_, c) => Array.from({ length: 9 }, (_, r) => at(r, c)));
const BOX_UNITS = Array.from({ length: 9 }, (_, b) => {
  const br = Math.floor(b / 3) * 3, bc = (b % 3) * 3;
  const cells = [];
  for (let dr = 0; dr < 3; dr++) for (let dc = 0; dc < 3; dc++) cells.push(at(br + dr, bc + dc));
  return cells;
});
const ALL_UNITS = [...ROW_UNITS, ...COL_UNITS, ...BOX_UNITS];
const UNIT_KIND = [
  ...ROW_UNITS.map((_, i) => ({ kind: "row", name: `Row ${i + 1}` })),
  ...COL_UNITS.map((_, i) => ({ kind: "col", name: `Column ${i + 1}` })),
  ...BOX_UNITS.map((_, i) => ({ kind: "box", name: `Box ${i + 1}` })),
];

const PEERS = Array.from({ length: 81 }, (_, idx) => {
  const [r, c] = rc(idx);
  const box = BOX_UNITS[Math.floor(r / 3) * 3 + Math.floor(c / 3)];
  const set = new Set([...ROW_UNITS[r], ...COL_UNITS[c], ...box]);
  set.delete(idx);
  return [...set];
});

/* ============================================================
   BOARD STATE HELPERS
   ============================================================ */
function emptyCell() { return { given: false, value: 0, notes: new Map(), color: null }; }
function emptyBoard() { return Array.from({ length: 81 }, emptyCell); }

function loadPuzzle(str) {
  const clean = str.trim();
  return clean.split("").map((ch) => {
    const v = ch === "." || ch === "0" ? 0 : parseInt(ch, 10);
    return { given: v !== 0 && !Number.isNaN(v), value: Number.isNaN(v) ? 0 : v, notes: new Map(), color: null };
  });
}

function cloneBoard(board) {
  return board.map((cell) => ({ ...cell, notes: new Map(cell.notes) }));
}

function conflictSet(board) {
  const bad = new Set();
  for (const unit of ALL_UNITS) {
    const seen = new Map();
    for (const idx of unit) {
      const v = board[idx].value;
      if (!v) continue;
      if (seen.has(v)) { bad.add(idx); bad.add(seen.get(v)); }
      else seen.set(v, idx);
    }
  }
  return bad;
}

function autoCandidates(board, idx, style = "grid") {
  if (board[idx].value) return new Map();
  const used = new Set(PEERS[idx].map((p) => board[p].value).filter(Boolean));
  const cands = new Map();
  for (let d = 1; d <= 9; d++) if (!used.has(d)) cands.set(d, style);
  return cands;
}

const BLANK_PUZZLE = "0".repeat(81);

/* ============================================================
   STRATEGY ENGINE
   Reads the player's own notes (candidates) as ground truth —
   it never computes candidates itself except via the optional
   "Auto pencil marks" convenience action.
   ============================================================ */

function combinations(arr, k) {
  const res = [];
  const n = arr.length;
  const idxs = Array.from({ length: k }, (_, i) => i);
  if (k > n) return res;
  while (true) {
    res.push(idxs.map((i) => arr[i]));
    let i = k - 1;
    while (i >= 0 && idxs[i] === i + n - k) i--;
    if (i < 0) break;
    idxs[i]++;
    for (let j = i + 1; j < k; j++) idxs[j] = idxs[j - 1] + 1;
  }
  return res;
}

// A cell's notes are trusted as its complete candidate list as soon as it
// has ANY notes written in it — hand-typed or from Auto Pencil Marks alike.
// The one thing that's never trusted is a completely BLANK cell: zero
// notes means the cell simply hasn't been examined yet, not that it has
// zero candidates (impossible in a valid puzzle). Treating a blank cell
// as "reliably empty" would let absence-based techniques wrongly rule
// digits out everywhere the player hasn't pencil-marked at all.
// Every technique below that concludes something from the ABSENCE of a
// note (naked/hidden singles, locked candidates, fish, wings, coloring)
// needs this guard; techniques that only use the PRESENCE of a note
// (eliminations) don't.
function isReliable(cell) {
  return cell.notes.size > 0;
}

function sharedUnitName(a, b) {
  const [ra, ca] = rc(a), [rb, cb] = rc(b);
  if (ra === rb) return `Row ${ra + 1}`;
  if (ca === cb) return `Column ${ca + 1}`;
  return `Box ${Math.floor(ra / 3) * 3 + Math.floor(ca / 3) + 1}`;
}

// Detects notes that are provably wrong given a placed digit — a note for
// digit D on a cell whose peer (same row, column, or box) already has D
// placed. That peer relationship alone rules D out there, regardless of
// who wrote the note or when. This only checks notes against actual
// placed numbers (givens or entries) — notes are never checked against
// each other, since two candidates disagreeing is a completely normal
// part of working through a puzzle, not an error.
function findNoteConflicts(board) {
  const hits = [];

  for (let idx = 0; idx < 81; idx++) {
    const cell = board[idx];
    if (cell.value) continue;
    for (const d of cell.notes.keys()) {
      const placedPeer = PEERS[idx].find((p) => board[p].value === d);
      if (placedPeer === undefined) continue;
      hits.push({
        technique: "Note Conflict",
        digit: d,
        cause: [idx, placedPeer],
        eliminate: [{ idx, digit: d }],
        place: [],
        message: `${label(idx)} still has ${d} as a candidate, but ${label(placedPeer)} — which shares ${sharedUnitName(idx, placedPeer).toLowerCase()} with it — is already placed as ${d}. That candidate is impossible and should be removed from ${label(idx)}'s notes.`,
      });
    }
  }

  return hits;
}

// Cells implicated in a note conflict shouldn't be confidently presented
// as a solved Naked Single — we don't know which (if either) is actually
// correct until the contradiction is resolved.
function conflictedCells(board) {
  const s = new Set();
  findNoteConflicts(board).forEach((hit) => hit.cause.forEach((idx) => s.add(idx)));
  return s;
}

function findNakedSingles(board) {
  const hits = [];
  const conflicted = conflictedCells(board); // notes contradicted by a placed peer — surfaced separately as Note Conflict
  for (let idx = 0; idx < 81; idx++) {
    const cell = board[idx];
    if (cell.value || cell.notes.size !== 1 || !isReliable(cell) || conflicted.has(idx)) continue;
    const digit = [...cell.notes.keys()][0];
    // Silent ambiguity guard (not a "conflict" alert, just a correctness
    // check): if a peer independently shows this exact same lone digit,
    // at most one of them can actually be right, so neither should be
    // confidently declared solved until that resolves on its own.
    const ambiguousPeer = PEERS[idx].find((p) => !board[p].value && board[p].notes.size === 1 && board[p].notes.has(digit));
    if (ambiguousPeer !== undefined) continue;
    hits.push({
      technique: "Naked Single",
      digit,
      cause: [idx],
      eliminate: [],
      place: [{ idx, digit }],
      message: `${label(idx)} has only one candidate left in its notes: ${digit}. It can only be ${digit}.`,
    });
  }
  return hits;
}

function findHiddenSingles(board) {
  const hits = [];
  ALL_UNITS.forEach((unit, u) => {
    const { name } = UNIT_KIND[u];
    const emptyCells = unit.filter((idx) => !board[idx].value);
    for (let d = 1; d <= 9; d++) {
      const cells = emptyCells.filter((idx) => board[idx].notes.has(d));
      if (cells.length === 1) {
        const idx = cells[0];
        if (board[idx].notes.size === 1) continue; // already a naked single, don't duplicate
        // "d fits nowhere else in this unit" is only trustworthy if every
        // other empty cell's candidate list is a reliably complete one.
        const othersReliable = emptyCells.every((o) => o === idx || isReliable(board[o]));
        if (!othersReliable) continue;
        hits.push({
          technique: "Hidden Single",
          digit: d,
          cause: [idx],
          eliminate: [],
          place: [{ idx, digit: d }],
          message: `In ${name}, ${d} only appears as a candidate in ${label(idx)}'s notes. Even though that cell has other candidates too, ${d} must go there.`,
        });
      }
    }
  });
  return hits;
}

function findNakedSubsets(board, size) {
  const hits = [];
  ALL_UNITS.forEach((unit, u) => {
    const { name } = UNIT_KIND[u];
    // The combo cells' OWN candidate lists must be complete (we're relying
    // on "these cells allow only these digits"); the cells they eliminate
    // from don't need to be, since we're just stripping an already-written note.
    const cands = unit.filter((idx) => !board[idx].value && board[idx].notes.size >= 2 && board[idx].notes.size <= size && isReliable(board[idx]));
    for (const combo of combinations(cands, size)) {
      const union = new Set();
      combo.forEach((idx) => board[idx].notes.forEach((_style, d) => union.add(d)));
      if (union.size !== size) continue;

      // If some OTHER cell in the unit is also confined entirely within
      // this same digit set, that's more cells competing for the same
      // restricted digits than the unit has room for -- an impossible
      // position, meaning a note somewhere is missing a candidate, not a
      // valid pair/triple to act on. (This is exactly what would happen if
      // we blindly applied the elimination below: that extra cell would
      // lose every one of its candidates.)
      const overConstrained = unit.some((idx) => {
        if (combo.includes(idx) || board[idx].value) return false;
        const notes = [...board[idx].notes.keys()];
        return notes.length > 0 && notes.every((d) => union.has(d));
      });
      if (overConstrained) continue;

      const eliminate = [];
      unit.forEach((idx) => {
        if (combo.includes(idx) || board[idx].value) return;
        [...union].forEach((d) => { if (board[idx].notes.has(d)) eliminate.push({ idx, digit: d }); });
      });
      if (eliminate.length === 0) continue;
      hits.push({
        technique: size === 2 ? "Naked Pair" : "Naked Triple",
        digit: [...union],
        cause: combo,
        eliminate,
        place: [],
        message: `In ${name}, cells ${combo.map(label).join(" & ")} together only allow candidates {${[...union].join(",")}}. Those ${size} digits must occupy those ${size} cells, so {${[...union].join(",")}} can be removed from every other cell's notes in ${name.toLowerCase()}.`,
      });
    }
  });
  return hits;
}

function findPointingPairs(board) {
  const hits = [];
  BOX_UNITS.forEach((box, bIdx) => {
    // The confinement claim ("d only appears in these box cells") requires
    // trusting every empty cell in the box, not just the marked ones.
    const boxReliable = box.every((idx) => board[idx].value || isReliable(board[idx]));
    if (!boxReliable) return;
    for (let d = 1; d <= 9; d++) {
      const cells = box.filter((idx) => !board[idx].value && board[idx].notes.has(d));
      if (cells.length < 2 || cells.length > 3) continue;
      const rows = new Set(cells.map((idx) => rc(idx)[0]));
      const cols = new Set(cells.map((idx) => rc(idx)[1]));
      if (rows.size === 1) {
        const r = [...rows][0];
        const eliminate = ROW_UNITS[r].filter((idx) => !box.includes(idx) && !board[idx].value && board[idx].notes.has(d))
          .map((idx) => ({ idx, digit: d }));
        if (eliminate.length) hits.push({
          technique: "Pointing Pair/Triple", digit: d, cause: cells, eliminate, place: [],
          message: `In Box ${bIdx + 1}, candidate ${d} only appears in Row ${r + 1} (cells ${cells.map(label).join(", ")}). So ${d} can be removed from the rest of Row ${r + 1} outside this box.`,
        });
      }
      if (cols.size === 1) {
        const c = [...cols][0];
        const eliminate = COL_UNITS[c].filter((idx) => !box.includes(idx) && !board[idx].value && board[idx].notes.has(d))
          .map((idx) => ({ idx, digit: d }));
        if (eliminate.length) hits.push({
          technique: "Pointing Pair/Triple", digit: d, cause: cells, eliminate, place: [],
          message: `In Box ${bIdx + 1}, candidate ${d} only appears in Column ${c + 1} (cells ${cells.map(label).join(", ")}). So ${d} can be removed from the rest of Column ${c + 1} outside this box.`,
        });
      }
    }
  });
  return hits;
}

function findBoxLineReduction(board) {
  const hits = [];
  [...ROW_UNITS, ...COL_UNITS].forEach((unit) => {
    const isRow = unit === ROW_UNITS[rc(unit[0])[0]];
    // Same reasoning as pointing pairs, mirrored: trust the whole line, not
    // just the marked cells.
    const lineReliable = unit.every((idx) => board[idx].value || isReliable(board[idx]));
    if (!lineReliable) return;
    for (let d = 1; d <= 9; d++) {
      const cells = unit.filter((idx) => !board[idx].value && board[idx].notes.has(d));
      if (cells.length < 2 || cells.length > 3) continue;
      const boxes = new Set(cells.map((idx) => { const [r, c] = rc(idx); return Math.floor(r / 3) * 3 + Math.floor(c / 3); }));
      if (boxes.size !== 1) continue;
      const boxIdx = [...boxes][0];
      const eliminate = BOX_UNITS[boxIdx].filter((idx) => !unit.includes(idx) && !board[idx].value && board[idx].notes.has(d))
        .map((idx) => ({ idx, digit: d }));
      if (!eliminate.length) continue;
      const lineName = isRow ? `Row ${rc(cells[0])[0] + 1}` : `Column ${rc(cells[0])[1] + 1}`;
      hits.push({
        technique: "Box-Line Reduction", digit: d, cause: cells, eliminate, place: [],
        message: `In ${lineName}, candidate ${d} is confined to Box ${boxIdx + 1} (cells ${cells.map(label).join(", ")}). So ${d} can be removed from the rest of Box ${boxIdx + 1}.`,
      });
    }
  });
  return hits;
}

/* ---- Fish family: X-Wing (2), Swordfish (3), Jellyfish (4) ----
   For a digit d, if its candidate cells in n rows are confined to the
   same n columns (or vice versa), d can be eliminated from those
   columns/rows everywhere outside the pattern. */
function findFish(board, size) {
  const hits = [];
  const name = { 2: "X-Wing", 3: "Swordfish", 4: "Jellyfish" }[size];
  const reliableRow = ROW_UNITS.map((unit) => unit.every((idx) => board[idx].value || isReliable(board[idx])));
  const reliableCol = COL_UNITS.map((unit) => unit.every((idx) => board[idx].value || isReliable(board[idx])));

  for (let d = 1; d <= 9; d++) {
    // Rows confined to columns
    const rowCandCols = ROW_UNITS.map((unit) => unit.filter((idx) => !board[idx].value && board[idx].notes.has(d)).map((idx) => rc(idx)[1]));
    const candidateRows = [];
    for (let r = 0; r < 9; r++) if (reliableRow[r] && rowCandCols[r].length >= 2 && rowCandCols[r].length <= size) candidateRows.push(r);
    for (const combo of combinations(candidateRows, size)) {
      const colUnion = new Set();
      combo.forEach((r) => rowCandCols[r].forEach((c) => colUnion.add(c)));
      if (colUnion.size !== size) continue;
      const eliminate = [];
      colUnion.forEach((c) => {
        for (let r = 0; r < 9; r++) {
          if (combo.includes(r)) continue;
          const idx = at(r, c);
          if (!board[idx].value && board[idx].notes.has(d)) eliminate.push({ idx, digit: d });
        }
      });
      if (!eliminate.length) continue;
      const cause = [];
      combo.forEach((r) => rowCandCols[r].forEach((c) => { if (colUnion.has(c)) cause.push(at(r, c)); }));
      hits.push({
        technique: name, digit: d, cause, eliminate, place: [],
        message: `Candidate ${d} in ${size === 2 ? "rows" : "rows"} ${combo.map((r) => r + 1).join(", ")} only appears in columns ${[...colUnion].map((c) => c + 1).join(", ")} — a ${name}. So ${d} can be removed from the rest of those columns.`,
      });
    }
    // Columns confined to rows
    const colCandRows = COL_UNITS.map((unit) => unit.filter((idx) => !board[idx].value && board[idx].notes.has(d)).map((idx) => rc(idx)[0]));
    const candidateCols = [];
    for (let c = 0; c < 9; c++) if (reliableCol[c] && colCandRows[c].length >= 2 && colCandRows[c].length <= size) candidateCols.push(c);
    for (const combo of combinations(candidateCols, size)) {
      const rowUnion = new Set();
      combo.forEach((c) => colCandRows[c].forEach((r) => rowUnion.add(r)));
      if (rowUnion.size !== size) continue;
      const eliminate = [];
      rowUnion.forEach((r) => {
        for (let c = 0; c < 9; c++) {
          if (combo.includes(c)) continue;
          const idx = at(r, c);
          if (!board[idx].value && board[idx].notes.has(d)) eliminate.push({ idx, digit: d });
        }
      });
      if (!eliminate.length) continue;
      const cause = [];
      combo.forEach((c) => colCandRows[c].forEach((r) => { if (rowUnion.has(r)) cause.push(at(r, c)); }));
      hits.push({
        technique: name, digit: d, cause, eliminate, place: [],
        message: `Candidate ${d} in columns ${combo.map((c) => c + 1).join(", ")} only appears in rows ${[...rowUnion].map((r) => r + 1).join(", ")} — a ${name}. So ${d} can be removed from the rest of those rows.`,
      });
    }
  }
  return hits;
}

/* ---- XY-Wing (a.k.a. Y-Wing) ----
   Pivot cell with candidates {X,Y}; two "pincer" cells that each see
   the pivot, one with {X,Z} and one with {Y,Z}. Any cell that sees
   both pincers can't be Z, since whichever of X/Y the pivot turns out
   to be, one pincer forces Z into place. */
function findXYWing(board) {
  const hits = [];
  const bivalue = [];
  for (let i = 0; i < 81; i++) if (!board[i].value && board[i].notes.size === 2 && isReliable(board[i])) bivalue.push(i);
  const bivalueSet = new Set(bivalue);

  for (const pivot of bivalue) {
    const [x, y] = [...board[pivot].notes.keys()];
    const pincerCandidates = PEERS[pivot].filter((p) => bivalueSet.has(p));
    for (let ai = 0; ai < pincerCandidates.length; ai++) {
      const a = pincerCandidates[ai];
      const aCands = [...board[a].notes.keys()];
      const sharedA = aCands.filter((c) => c === x || c === y);
      if (sharedA.length !== 1) continue;
      const pivotDigitA = sharedA[0];
      const z = aCands.find((c) => c !== pivotDigitA);
      const otherPivotDigit = pivotDigitA === x ? y : x;
      for (let bi = 0; bi < pincerCandidates.length; bi++) {
        if (bi === ai) continue;
        const b = pincerCandidates[bi];
        if (b === a) continue;
        const bCands = [...board[b].notes.keys()];
        if (bCands.length !== 2 || !bCands.includes(otherPivotDigit) || !bCands.includes(z)) continue;
        const eliminate = [];
        for (let idx = 0; idx < 81; idx++) {
          if (idx === pivot || idx === a || idx === b) continue;
          if (board[idx].value || !board[idx].notes.has(z)) continue;
          if (PEERS[a].includes(idx) && PEERS[b].includes(idx)) eliminate.push({ idx, digit: z });
        }
        if (!eliminate.length) continue;
        hits.push({
          technique: "XY-Wing", digit: z, cause: [pivot, a, b], eliminate, place: [],
          message: `${label(pivot)} (candidates ${x},${y}) links to ${label(a)} (${pivotDigitA},${z}) and ${label(b)} (${otherPivotDigit},${z}) — an XY-Wing (also called a Y-Wing). Whichever of ${x}/${y} the pivot turns out to be, one pincer forces a ${z} — so any cell that sees both ${label(a)} and ${label(b)} can't be ${z}.`,
        });
      }
    }
  }
  return hits;
}

/* ---- Simple Coloring, run automatically for every digit ----
   Same logic as the manual colouring tool below, but built from the
   board's own conjugate pairs (strong links) instead of the player's
   painted colors — this is the automated "chain" technique. */
function buildConjugateGraph(board, d) {
  const adj = new Map();
  ALL_UNITS.forEach((unit) => {
    const unitReliable = unit.every((idx) => board[idx].value || isReliable(board[idx]));
    if (!unitReliable) return;
    const cells = unit.filter((idx) => !board[idx].value && board[idx].notes.has(d));
    if (cells.length === 2) {
      const [a, b] = cells;
      if (!adj.has(a)) adj.set(a, new Set());
      if (!adj.has(b)) adj.set(b, new Set());
      adj.get(a).add(b); adj.get(b).add(a);
    }
  });
  return adj;
}

function findAutoColoring(board) {
  const hits = [];
  for (let d = 1; d <= 9; d++) {
    const adj = buildConjugateGraph(board, d);
    const visited = new Set();
    for (const start of adj.keys()) {
      if (visited.has(start)) continue;
      const color = new Map([[start, 0]]);
      const queue = [start];
      visited.add(start);
      while (queue.length) {
        const cur = queue.shift();
        adj.get(cur).forEach((nb) => {
          if (!color.has(nb)) { color.set(nb, 1 - color.get(cur)); visited.add(nb); queue.push(nb); }
        });
      }
      if (color.size < 4) continue; // need a real chain, not just one conjugate pair

      const cellsByColor = [[], []];
      color.forEach((c, idx) => cellsByColor[c].push(idx));

      for (let c = 0; c < 2; c++) {
        let conflictMembers = null;
        for (const unit of ALL_UNITS) {
          const members = cellsByColor[c].filter((idx) => unit.includes(idx));
          if (members.length >= 2) { conflictMembers = members; break; }
        }
        if (!conflictMembers) continue;
        const eliminate = cellsByColor[c].filter((idx) => board[idx].notes.has(d)).map((idx) => ({ idx, digit: d }));
        if (!eliminate.length) continue;
        hits.push({
          technique: "Simple Colouring", digit: d, cause: cellsByColor[c], eliminate, place: [],
          message: `Tracing the chain of ${d}-conjugate pairs: ${conflictMembers.map(label).join(" & ")} land on the same colour but share a unit, so that colour can't be ${d}. Every cell in that colour loses candidate ${d}. (This is the same logic as the manual Colouring tool, run automatically here.)`,
        });
      }

      const eliminate = [];
      for (let idx = 0; idx < 81; idx++) {
        if (color.has(idx) || board[idx].value || !board[idx].notes.has(d)) continue;
        const seesA = PEERS[idx].some((p) => color.get(p) === 0);
        const seesB = PEERS[idx].some((p) => color.get(p) === 1);
        if (seesA && seesB) eliminate.push({ idx, digit: d });
      }
      if (eliminate.length) {
        hits.push({
          technique: "Simple Colouring", digit: d, cause: [...color.keys()], eliminate, place: [],
          message: `Tracing the chain of ${d}-conjugate pairs across ${color.size} cells: some cells see both colours of the chain, so they can't be ${d} regardless of which colour turns out true.`,
        });
      }
    }
  }
  return hits;
}

const TECHNIQUES = [
  { name: "Note Conflict", find: findNoteConflicts, level: 0 },
  { name: "Naked Single", find: findNakedSingles, level: 1 },
  { name: "Hidden Single", find: findHiddenSingles, level: 1 },
  { name: "Pointing Pair/Triple", find: findPointingPairs, level: 2 },
  { name: "Box-Line Reduction", find: findBoxLineReduction, level: 2 },
  { name: "Naked Pair", find: (b) => findNakedSubsets(b, 2), level: 2 },
  { name: "Naked Triple", find: (b) => findNakedSubsets(b, 3), level: 3 },
  { name: "X-Wing", find: (b) => findFish(b, 2), level: 4 },
  { name: "XY-Wing", find: findXYWing, level: 4 },
  { name: "Simple Colouring", find: findAutoColoring, level: 4 },
  { name: "Swordfish", find: (b) => findFish(b, 3), level: 5 },
  { name: "Jellyfish", find: (b) => findFish(b, 4), level: 6 },
];

// Teaching reference shown alongside the live match for each technique —
// what the pattern is, why it's called that, how to spot it yourself, and
// what to do once you've found one. This is general knowledge about the
// technique, independent of whatever specific instance is on the board
// right now (that's what the per-match `message` field is for).
const TECHNIQUE_INFO = {
  "Note Conflict": {
    whatIsIt: "Not a solving technique — a check for a candidate that's still marked on a cell even though a peer (same row, column, or box) already has that exact digit placed as a given or entry.",
    whyName: "It flags a contradiction between what's written in the notes and what's already confirmed on the board — a placed digit rules out that candidate everywhere else in its row, column, and box, no exceptions.",
    howToSpot: "Compare a cell's notes against its peers: is one of its candidates already sitting as a placed value somewhere in the same row, column, or box?",
    howToUse: "Remove that candidate from the cell's notes — it's stale, most likely left over from before the neighboring cell was filled in, and cleaning it up keeps the rest of the hint engine reliable. Notes are never checked against each other this way; only against actual placed numbers.",
  },
  "Naked Single": {
    whatIsIt: "A cell with only one candidate left in its notes, once everything already placed in its row, column, and box is accounted for.",
    whyName: `"Naked" because the answer is sitting there in plain sight in the notes — no cross-referencing other cells needed. "Single" because exactly one candidate remains.`,
    howToSpot: "Just look at the cell's own notes. If there's only one digit written down, that's it — no need to check any other cell.",
    howToUse: "Place that digit immediately, then remove it as a candidate from every peer in its row, column, and box, since a placed digit can't repeat anywhere else in those units.",
  },
  "Hidden Single": {
    whatIsIt: "A digit that can only fit in one cell within a row, column, or box — even though that cell still shows other candidates too.",
    whyName: `The placement is "hidden" because the cell itself doesn't look special — it's not down to one candidate. You only find it by checking, digit by digit, how many cells in a unit could still hold it.`,
    howToSpot: "Pick a unit and a digit. Count how many empty cells in that unit still have that digit as a candidate. If only one does, that cell must be it, regardless of what else is in its notes.",
    howToUse: "Place the digit in that cell. This is often more powerful than it looks, since clearing that cell's other candidates can cascade into further singles nearby.",
  },
  "Pointing Pair/Triple": {
    whatIsIt: "A digit whose only candidate cells within a box all sit in the same row or column of that box.",
    whyName: `The candidates "point" out of the box along that row or column — like an arrow showing you where the digit is forced to eventually land, and therefore where it can't be.`,
    howToSpot: "Look at one box at a time. For each digit, see where its candidates fall. If they're all confined to a single row or column within that box, you've found one.",
    howToUse: "The digit must end up somewhere in that row/column inside the box, so it can be removed as a candidate from the rest of that row/column outside the box. The box's own cells are untouched.",
  },
  "Box-Line Reduction": {
    whatIsIt: "The mirror image of a pointing pair: a digit whose only candidate cells within a row or column all happen to sit inside the same box.",
    whyName: `The row/column "locks" the digit into that one box — hence this and pointing pairs are together sometimes called "locked candidates."`,
    howToSpot: "Look along one row or column at a time. For each digit, see where its candidates fall. If they're all inside a single box, that's a box-line reduction.",
    howToUse: "Remove that digit as a candidate from the rest of that box (the cells outside the row/column keep their other candidates intact).",
  },
  "Naked Pair": {
    whatIsIt: "Two cells in the same unit whose notes, between them, only ever contain two possible digits — for example both cells show just {3,7}.",
    whyName: `"Naked" because it's visible directly from the candidates written down, no counting needed elsewhere. "Pair" for the two cells and two digits involved.`,
    howToSpot: "Scan a unit for two cells that share the exact same two candidates and nothing else.",
    howToUse: "Those two digits must occupy those two cells in some order, so remove both digits from every other cell's notes in that unit.",
  },
  "Naked Triple": {
    whatIsIt: "Three cells in a unit whose notes, combined, only ever add up to three digits total — the cells don't each need to show all three; e.g. {2,5}, {2,9}, and {5,9} together still qualify.",
    whyName: "Same idea as a naked pair, generalized to three cells and three digits.",
    howToSpot: "This one's trickier to spot than a pair, since no single cell needs to show all three digits. Look for any three cells in a unit whose combined candidate set is exactly three digits.",
    howToUse: "Remove those three digits from every other cell's notes in that unit.",
  },
  "X-Wing": {
    whatIsIt: "A digit whose candidates in two rows are confined to the exact same two columns (or the same pattern with rows and columns swapped), forming a rectangle of four cells.",
    whyName: "Draw lines connecting the four corner cells and they cross in the middle, forming an X shape.",
    howToSpot: "Pick a digit and scan every row for ones where it appears in only two cells. If two such rows land on the exact same two columns, that's an X-Wing.",
    howToUse: "The digit has to occupy two of those four corners (one per row, in a diagonal arrangement), so it can be eliminated from the rest of those two columns outside the two rows.",
  },
  "XY-Wing": {
    whatIsIt: `Three bivalue cells (each with exactly two candidates) forming a chain: a "pivot" with candidates {X,Y}, and two "pincers" that each see the pivot — one with {X,Z}, one with {Y,Z}.`,
    whyName: `Named for the pivot's two candidates, X and Y. It's also commonly called "Y-Wing" since the shape — one pivot branching to two pincers — looks like the letter Y.`,
    howToSpot: "Find a bivalue cell (the pivot). Check its peers for two more bivalue cells that each share exactly one candidate with the pivot (a different one each), and that also share a third digit (Z) with each other.",
    howToUse: "Whichever of X or Y the pivot turns out to be, one of the two pincers will be forced to Z. So any cell that sees BOTH pincers (not the pivot) can have Z removed from its notes.",
  },
  "Simple Colouring": {
    whatIsIt: `A chain built from "strong links" — pairs of cells that are the only two candidates for a digit within some unit. Following the chain and alternately labelling cells one of two colours reveals contradictions or eliminations.`,
    whyName: "Solvers historically traced these chains with two actual coloured pencils to keep track of which cells belonged to which side of the chain.",
    howToSpot: "For one digit at a time, find every unit where it has exactly two candidate cells (a conjugate pair) and link them together into chains.",
    howToUse: "Two rules: (1) if two cells of the same colour end up sharing a unit, that colour is impossible, so remove the digit from every cell of that colour; (2) if an unlinked cell sees cells of both colours, it can't be that digit either, since one colour or the other must be true.",
  },
  Swordfish: {
    whatIsIt: "The same idea as an X-Wing, one size up: a digit whose candidates across three rows are all confined to the same three columns (each row can have 2 or 3 of those cells, not necessarily all 3).",
    whyName: `Continues the "fish" naming tradition started by X-Wing — Sudoku solvers borrowed increasingly fish-themed names as the pattern gets bigger.`,
    howToSpot: "Harder to spot than an X-Wing since it spans more cells. Look for three rows where a digit's candidates all fall within the same three columns.",
    howToUse: "Eliminate the digit from the rest of those three columns, outside the three rows that form the pattern.",
  },
  Jellyfish: {
    whatIsIt: "The size-4 member of the fish family: a digit whose candidates across four rows are all confined to the same four columns.",
    whyName: "Simply the next fish name up the chain from X-Wing and Swordfish.",
    howToSpot: "Same logic as X-Wing/Swordfish, one size larger — genuinely rare to spot by eye, which is exactly where a tool like this one earns its keep.",
    howToUse: "Eliminate the digit from the rest of those four columns, outside the four rows that form the pattern.",
  },
};

/* ============================================================
   PUZZLE GENERATOR
   Mirrors sudoku.com's six-tier scale (Easy/Medium/Hard/Expert/
   Master/Extreme). Clue counts approximate published tiers; for
   Easy/Medium/Hard we additionally verify the puzzle is solvable
   using only the technique set above (same engine as the hint
   panel) so the *logic* required matches the label, not just the
   clue count. Expert/Master/Extreme are graded by clue count only
   for now — cracking them may need X-Wing/Swordfish/chains, which
   aren't implemented yet (see roadmap).
   ============================================================ */

function popcount(x) { let c = 0; while (x) { x &= x - 1; c++; } return c; }
// A small, fast, seedable PRNG (mulberry32) — deterministic: the same seed
// always produces the same sequence of "random" numbers, which is what
// makes seeded puzzle regeneration possible. Math.random() can't be seeded
// at all, so it's never used anywhere in the generation path below.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(arr, rng) {
  const rand = rng || Math.random;
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1));[a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function boxIndexOf(r, c) { return Math.floor(r / 3) * 3 + Math.floor(c / 3); }

// Counts solutions of a digit-grid (0..9 per cell) up to `limit`, using
// bitmask constraint propagation + MRV backtracking for speed.
function solveCount(grid, limit) {
  const g = [...grid];
  const rows = new Array(9).fill(0), cols = new Array(9).fill(0), boxes = new Array(9).fill(0);
  for (let i = 0; i < 81; i++) {
    const v = g[i];
    if (!v) continue;
    const [r, c] = rc(i), b = boxIndexOf(r, c), bit = 1 << (v - 1);
    rows[r] |= bit; cols[c] |= bit; boxes[b] |= bit;
  }
  let count = 0;
  function backtrack() {
    if (count >= limit) return;
    let best = -1, bestMask = 0, bestCount = 10;
    for (let i = 0; i < 81; i++) {
      if (g[i]) continue;
      const [r, c] = rc(i), b = boxIndexOf(r, c);
      const avail = (~(rows[r] | cols[c] | boxes[b])) & 0x1ff;
      const cnt = popcount(avail);
      if (cnt === 0) return;
      if (cnt < bestCount) { bestCount = cnt; best = i; bestMask = avail; if (cnt === 1) break; }
    }
    if (best === -1) { count++; return; }
    const [r, c] = rc(best), b = boxIndexOf(r, c);
    let mask = bestMask;
    while (mask) {
      const bit = mask & -mask; mask ^= bit;
      const d = Math.log2(bit) + 1;
      g[best] = d; rows[r] |= bit; cols[c] |= bit; boxes[b] |= bit;
      backtrack();
      g[best] = 0; rows[r] ^= bit; cols[c] ^= bit; boxes[b] ^= bit;
      if (count >= limit) return;
    }
  }
  backtrack();
  return count;
}

// Returns the completed grid for a puzzle (first solution found), or null
// if it has no valid solution at all. Used to get an authoritative
// reference solution for validation, distinct from just counting.
function solveGrid(grid) {
  const g = [...grid];
  const rows = new Array(9).fill(0), cols = new Array(9).fill(0), boxes = new Array(9).fill(0);
  for (let i = 0; i < 81; i++) {
    const v = g[i];
    if (!v) continue;
    const [r, c] = rc(i), b = boxIndexOf(r, c), bit = 1 << (v - 1);
    if (rows[r] & bit || cols[c] & bit || boxes[b] & bit) return null; // contradictory givens
    rows[r] |= bit; cols[c] |= bit; boxes[b] |= bit;
  }
  function fill() {
    let best = -1, bestMask = 0, bestCount = 10;
    for (let i = 0; i < 81; i++) {
      if (g[i]) continue;
      const [r, c] = rc(i), b = boxIndexOf(r, c);
      const avail = (~(rows[r] | cols[c] | boxes[b])) & 0x1ff;
      const cnt = popcount(avail);
      if (cnt === 0) return false;
      if (cnt < bestCount) { bestCount = cnt; best = i; bestMask = avail; if (cnt === 1) break; }
    }
    if (best === -1) return true;
    const [r, c] = rc(best), b = boxIndexOf(r, c);
    let mask = bestMask;
    while (mask) {
      const bit = mask & -mask; mask ^= bit;
      const d = Math.log2(bit) + 1;
      g[best] = d; rows[r] |= bit; cols[c] |= bit; boxes[b] |= bit;
      if (fill()) return true;
      g[best] = 0; rows[r] ^= bit; cols[c] ^= bit; boxes[b] ^= bit;
    }
    return false;
  }
  return fill() ? g : null;
}

// Randomised full-grid solve = a freshly shuffled, valid completed Sudoku.
function generateSolvedGrid(rng) {
  const g = new Array(81).fill(0);
  const rows = new Array(9).fill(0), cols = new Array(9).fill(0), boxes = new Array(9).fill(0);
  function fill() {
    let best = -1, bestMask = 0, bestCount = 10;
    for (let i = 0; i < 81; i++) {
      if (g[i]) continue;
      const [r, c] = rc(i), b = boxIndexOf(r, c);
      const avail = (~(rows[r] | cols[c] | boxes[b])) & 0x1ff;
      const cnt = popcount(avail);
      if (cnt === 0) return false;
      if (cnt < bestCount) { bestCount = cnt; best = i; bestMask = avail; if (cnt === 1) break; }
    }
    if (best === -1) return true;
    const [r, c] = rc(best), b = boxIndexOf(r, c);
    const digits = shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9], rng).filter((d) => bestMask & (1 << (d - 1)));
    for (const d of digits) {
      const bit = 1 << (d - 1);
      g[best] = d; rows[r] |= bit; cols[c] |= bit; boxes[b] |= bit;
      if (fill()) return true;
      g[best] = 0; rows[r] ^= bit; cols[c] ^= bit; boxes[b] ^= bit;
    }
    return false;
  }
  fill();
  return g;
}

// Removes cells from a solved grid one at a time, keeping the puzzle
// uniquely solvable at every step, until reaching (or approaching) the
// target clue count.
function digHoles(solved, targetClues, rng) {
  const puzzle = [...solved];
  const order = shuffle(Array.from({ length: 81 }, (_, i) => i), rng);
  let clues = 81;
  for (const pos of order) {
    if (clues <= targetClues) break;
    if (!puzzle[pos]) continue;
    const backup = puzzle[pos];
    puzzle[pos] = 0;
    if (solveCount(puzzle, 2) === 1) clues--;
    else puzzle[pos] = backup;
  }
  return { puzzle, clues };
}

// Re-runs the same TECHNIQUES engine that powers hints, but against a
// scratch board with computed (not player-written) candidates, to see
// how far pure logic gets and which techniques were required.
function assessDifficulty(digits) {
  const work = digits.map((v) => ({ value: v, notes: new Map() }));
  for (let i = 0; i < 81; i++) {
    if (work[i].value) continue;
    const used = new Set(PEERS[i].map((p) => work[p].value).filter(Boolean));
    for (let d = 1; d <= 9; d++) if (!used.has(d)) work[i].notes.set(d, "grid");
  }
  const usedTechniques = new Set();
  let progress = true;
  while (progress) {
    progress = false;
    for (let i = 0; i < 81; i++) {
      if (work[i].value) continue;
      PEERS[i].forEach((p) => { if (work[p].value) work[i].notes.delete(work[p].value); });
    }
    if (work.every((c) => c.value)) break;
    for (const t of TECHNIQUES) {
      const hits = t.find(work);
      if (hits.length) {
        const hit = hits[0];
        usedTechniques.add(t.name);
        hit.place.forEach(({ idx, digit }) => { work[idx].value = digit; work[idx].notes = new Map(); });
        hit.eliminate.forEach(({ idx, digit }) => work[idx].notes.delete(digit));
        progress = true;
        break;
      }
    }
  }
  return { solved: work.every((c) => c.value), usedTechniques: [...usedTechniques] };
}

const T_SINGLES = ["Naked Single", "Hidden Single"];
const T_LOCKED = ["Pointing Pair/Triple", "Box-Line Reduction", "Naked Pair"];
const T_SUBSETS = ["Naked Triple"];
const T_ADVANCED = ["X-Wing", "XY-Wing", "Simple Colouring"];
const T_SWORDFISH = ["Swordfish"];
const T_JELLYFISH = ["Jellyfish"];

const DIFFICULTY_LEVELS = [
  { id: "easy", label: "Easy", clues: 36, allowedTechniques: [...T_SINGLES], requireOneOf: null },
  { id: "medium", label: "Medium", clues: 32, allowedTechniques: [...T_SINGLES, ...T_LOCKED], requireOneOf: null },
  { id: "hard", label: "Hard", clues: 28, allowedTechniques: [...T_SINGLES, ...T_LOCKED, ...T_SUBSETS], requireOneOf: [...T_LOCKED, ...T_SUBSETS] },
  { id: "expert", label: "Expert", clues: 25, allowedTechniques: [...T_SINGLES, ...T_LOCKED, ...T_SUBSETS, ...T_ADVANCED], requireOneOf: T_ADVANCED },
  { id: "master", label: "Master", clues: 22, allowedTechniques: [...T_SINGLES, ...T_LOCKED, ...T_SUBSETS, ...T_ADVANCED, ...T_SWORDFISH], requireOneOf: [...T_ADVANCED, ...T_SWORDFISH] },
  { id: "extreme", label: "Extreme", clues: 18, allowedTechniques: [...T_SINGLES, ...T_LOCKED, ...T_SUBSETS, ...T_ADVANCED, ...T_SWORDFISH, ...T_JELLYFISH], requireOneOf: [...T_ADVANCED, ...T_SWORDFISH, ...T_JELLYFISH] },
];

function generatePuzzle(levelId, seed = null) {
  const level = DIFFICULTY_LEVELS.find((l) => l.id === levelId) || DIFFICULTY_LEVELS[0];
  const actualSeed = (seed === null || seed === undefined) ? Math.floor(Math.random() * 4294967296) : (seed >>> 0);
  const rng = mulberry32(actualSeed);
  const maxAttempts = 80;
  let fallback = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const solved = generateSolvedGrid(rng);
    const { puzzle, clues } = digHoles(solved, level.clues, rng);
    const { solved: fullySolved, usedTechniques } = assessDifficulty(puzzle);
    const withinAllowed = usedTechniques.every((t) => level.allowedTechniques.includes(t));
    const meetsFloor = !level.requireOneOf || usedTechniques.some((t) => level.requireOneOf.includes(t));
    if (fullySolved && withinAllowed && meetsFloor) return { puzzle, clues, level, fullySolved, techniques: usedTechniques, graded: true, solution: solved, seed: actualSeed };
    if (!fallback || Math.abs(clues - level.clues) < Math.abs(fallback.clues - level.clues)) {
      fallback = { puzzle, clues, level, fullySolved, techniques: usedTechniques, graded: false, solution: solved, seed: actualSeed };
    }
  }
  return fallback;
}

// Encodes a (difficulty, seed) pair as a short shareable code, and back.
function seedToId(levelId, seed) {
  return `${levelId.toUpperCase()}-${(seed >>> 0).toString(36).toUpperCase()}`;
}
function idToSeed(idStr) {
  const m = /^([A-Za-z]+)-([0-9A-Za-z]+)$/.exec((idStr || "").trim());
  if (!m) return null;
  const levelId = m[1].toLowerCase();
  const level = DIFFICULTY_LEVELS.find((l) => l.id === levelId);
  if (!level) return null;
  const seed = parseInt(m[2], 36);
  if (!Number.isFinite(seed) || seed < 0) return null;
  return { levelId, seed };
}

/* ============================================================
   TECHNIQUE EXAMPLE GENERATOR
   Builds a small random board and hunts (with the real finder
   functions, not a hand-authored fixture) for a genuine instance
   of whichever technique the player is currently learning about —
   so every example is verified-real, and regenerating gives a
   different variation rather than the same fixed illustration.
   ============================================================ */
function boardWithFullCandidates(digits) {
  const work = digits.map((v) => ({ value: v, notes: new Map() }));
  for (let i = 0; i < 81; i++) {
    if (work[i].value) continue;
    const used = new Set(PEERS[i].map((p) => work[p].value).filter(Boolean));
    for (let d = 1; d <= 9; d++) if (!used.has(d)) work[i].notes.set(d, "grid");
  }
  return work;
}

// Note Conflict can never occur in a freshly-computed candidate board (we
// always strip a placed digit from its peers' candidates) — it only
// arises from a stale hand-written note. So instead of searching for one,
// we build one directly: take a real generated board and deliberately
// leave one stale candidate behind on a peer of some placed cell.
function generateNoteConflictExample(maxAttempts = 25) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const solved = generateSolvedGrid(Math.random);
    const targetClues = 30 + Math.floor(Math.random() * 8);
    const { puzzle } = digHoles(solved, targetClues, Math.random);
    const work = boardWithFullCandidates(puzzle);
    const placedCells = shuffle(Array.from({ length: 81 }, (_, i) => i).filter((i) => work[i].value), Math.random);
    for (const pIdx of placedCells) {
      const digit = work[pIdx].value;
      const emptyPeers = PEERS[pIdx].filter((p) => !work[p].value);
      if (!emptyPeers.length) continue;
      const target = emptyPeers[Math.floor(Math.random() * emptyPeers.length)];
      work[target].notes.set(digit, "grid"); // deliberately stale
      const matches = findNoteConflicts(work);
      if (matches.length) {
        const match = matches.find((m) => m.cause.includes(target)) || matches[0];
        return { board: work, match };
      }
      work[target].notes.delete(digit);
    }
  }
  return null;
}

function generateExampleFor(techniqueName, maxAttempts = 60) {
  if (techniqueName === "Note Conflict") return generateNoteConflictExample();
  const technique = TECHNIQUES.find((t) => t.name === techniqueName);
  if (!technique) return null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const solved = generateSolvedGrid(Math.random);
    const targetClues = 20 + Math.floor(Math.random() * 16); // 20-35, wide net for variety
    const { puzzle } = digHoles(solved, targetClues, Math.random);
    const work = boardWithFullCandidates(puzzle);
    const matches = technique.find(work);
    if (matches.length) {
      const match = matches[Math.floor(Math.random() * matches.length)];
      return { board: work, match };
    }
  }
  return null;
}

/* ---- Simple Colouring analysis on user-painted colours ---- */
function analyzeColoring(board, digit, colorA, colorB) {
  const cellsA = [], cellsB = [];
  for (let i = 0; i < 81; i++) {
    if (board[i].color === colorA) cellsA.push(i);
    if (board[i].color === colorB) cellsB.push(i);
  }
  const findSameColorConflict = (cells) => {
    for (const unit of ALL_UNITS) {
      const members = cells.filter((idx) => unit.includes(idx));
      if (members.length >= 2) return members;
    }
    return null;
  };

  const conflictA = findSameColorConflict(cellsA);
  const conflictB = findSameColorConflict(cellsB);
  const eliminate = [];
  const notes = [];

  if (conflictA) {
    cellsA.forEach((idx) => { if (board[idx].notes.has(digit)) eliminate.push({ idx, digit }); });
    notes.push(`Color A cells ${conflictA.map(label).join(" & ")} share a unit — two ${digit}s of the same colour can't both be true, so every Colour A cell must NOT be ${digit}. All Colour A cells lose candidate ${digit}.`);
  }
  if (conflictB) {
    cellsB.forEach((idx) => { if (board[idx].notes.has(digit)) eliminate.push({ idx, digit }); });
    notes.push(`Color B cells ${conflictB.map(label).join(" & ")} share a unit — every Colour B cell must NOT be ${digit}. All Colour B cells lose candidate ${digit}.`);
  }

  // Rule: an uncolored cell that sees both a Colour A and a Colour B cell can't be the digit.
  if (!conflictA && !conflictB) {
    for (let idx = 0; idx < 81; idx++) {
      if (board[idx].color === colorA || board[idx].color === colorB) continue;
      if (board[idx].value || !board[idx].notes.has(digit)) continue;
      const seesA = PEERS[idx].some((p) => cellsA.includes(p));
      const seesB = PEERS[idx].some((p) => cellsB.includes(p));
      if (seesA && seesB) {
        eliminate.push({ idx, digit });
        notes.push(`${label(idx)} sees both a Colour A and a Colour B cell for ${digit} — whichever colour turns out true, ${digit} can't be here.`);
      }
    }
  }

  return { cellsA, cellsB, conflictA, conflictB, eliminate, notes };
}

/* ============================================================
   COLOR PALETTE (Tailwind default palette only)
   ============================================================ */
const PALETTE = [
  { id: "red", swatch: "bg-red-300" },
  { id: "orange", swatch: "bg-orange-300" },
  { id: "amber", swatch: "bg-amber-300" },
  { id: "lime", swatch: "bg-lime-300" },
  { id: "teal", swatch: "bg-teal-300" },
  { id: "sky", swatch: "bg-sky-300" },
  { id: "indigo", swatch: "bg-indigo-300" },
  { id: "purple", swatch: "bg-purple-300" },
  { id: "pink", swatch: "bg-pink-300" },
];
const SWATCH_BG = Object.fromEntries(PALETTE.map((p) => [p.id, p.swatch]));

// Each note remembers the visual style it was entered with (grid/list/bold)
// Each note remembers the visual style it was entered with (grid/list/bold),
// so a single cell can mix "grid" (positional corner) notes with "list"/"bold"
// (compact center) notes at once. Style is purely a layout choice — the hint
// engine trusts any non-empty note list equally, regardless of style.
function renderNotes(cell, elimDigits, colorElims, dark) {
  const noteClass = (n) => (elimDigits?.has(n) || colorElims?.has(n)) ? "text-rose-600 line-through decoration-2" : (dark ? "text-slate-400" : "text-slate-500");

  const gridEntries = new Map(); // digit -> style
  const compactDigits = [];
  cell.notes.forEach((style, n) => {
    if (style === "grid") gridEntries.set(n, style);
    else compactDigits.push({ n, style });
  });
  compactDigits.sort((a, b) => a.n - b.n);

  const gridLayer = (
    <div className="grid grid-cols-3 grid-rows-3 w-full h-full p-0.5">
      {Array.from({ length: 9 }, (_, i) => i + 1).map((n) => {
        const present = gridEntries.has(n);
        return (
          <div key={n} className={["flex items-center justify-center text-[8px] sm:text-[10px] leading-none", present ? noteClass(n) : "text-transparent"].join(" ")}>
            {present ? n : ""}
          </div>
        );
      })}
    </div>
  );

  const compactLayer = (
    <div className="w-full h-full flex flex-wrap items-center justify-center content-center gap-x-0.5 leading-none px-0.5">
      {compactDigits.map(({ n, style }) => (
        <span key={n} className={[style === "bold" ? "text-[11px] sm:text-sm font-medium" : "text-[8px] sm:text-[10px]", noteClass(n)].join(" ")}>{n}</span>
      ))}
    </div>
  );

  if (gridEntries.size && compactDigits.length) {
    // Both zones in use at once: split the cell so neither overwrites the other.
    return (
      <div className="w-full h-full flex flex-col">
        <div className="flex-[3] min-h-0">{gridLayer}</div>
        <div className={`flex-[2] min-h-0 border-t border-dotted ${dark ? "border-slate-700" : "border-slate-200"}`}>{compactLayer}</div>
      </div>
    );
  }
  if (gridEntries.size) return gridLayer;
  if (compactDigits.length) return compactLayer;
  return null;
}

// Compact, read-only board for illustrating a worked technique example —
// same highlight language as the real grid (amber = cause, rose strike =
// eliminated, emerald = placement) but no interactivity, no selection,
// no row/column highlighting: just the pattern itself.
function SampleGrid({ board, match, dark, T }) {
  const causeSet = new Set(match?.cause || []);
  const elimMap = new Map();
  (match?.eliminate || []).forEach(({ idx, digit }) => {
    if (!elimMap.has(idx)) elimMap.set(idx, new Set());
    elimMap.get(idx).add(digit);
  });
  const placeMap = new Map((match?.place || []).map((p) => [p.idx, p.digit]));

  return (
    <div className={`grid grid-cols-9 border-2 rounded overflow-hidden mx-auto ${T.gridOuter} ${T.cellBg}`} style={{ width: "100%", maxWidth: "230px" }}>
      {board.map((cell, idx) => {
        const [r, c] = rc(idx);
        const isCause = causeSet.has(idx);
        const elimDigits = elimMap.get(idx);
        const placeDigit = placeMap.get(idx);
        let ringClass = "";
        if (placeDigit) ringClass = "ring-2 ring-inset ring-emerald-500 z-10";
        else if (isCause) ringClass = "ring-2 ring-inset ring-amber-400 z-10";
        return (
          <div key={idx} className={[
            "relative aspect-square flex items-center justify-center border",
            T.gridLine,
            c % 3 === 2 && c !== 8 ? `border-r-2 ${T.gridBoxLineR}` : "",
            r % 3 === 2 && r !== 8 ? `border-b-2 ${T.gridBoxLineB}` : "",
            ringClass,
          ].join(" ")}>
            <div className="relative z-10 w-full h-full flex items-center justify-center">
              {cell.value ? (
                <span className={["text-[11px] font-semibold", T.givenText].join(" ")}>{cell.value}</span>
              ) : (
                renderNotes(cell, elimDigits, null, dark)
              )}
              {placeDigit && <span className="absolute bottom-0 right-0.5 text-[7px] font-bold text-emerald-600">→{placeDigit}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ============================================================
   MAIN COMPONENT
   ============================================================ */
// Computed once at module load, not per render, so the initial board and
// its reference solution are guaranteed to be the same puzzle.
const INITIAL_GEN = generatePuzzle("easy") || { puzzle: emptyBoard().map(() => 0), solution: null, seed: 0, level: DIFFICULTY_LEVELS[0] };

export default function SudokuTrainer() {
  const [theme, setTheme] = useState("dark"); // "dark" | "light"
  const dark = theme === "dark";
  // A small hand-rolled token system rather than Tailwind's dark: variant —
  // this sandbox's pre-built stylesheet doesn't reliably include dark:
  // variants for arbitrary utility combinations, so every themeable class
  // is resolved here in JS instead, once per render.
  const T = {
    page: dark ? "bg-slate-950 text-slate-100" : "bg-slate-50 text-slate-800",
    heading: dark ? "text-slate-50" : "text-slate-900",
    textSecondary: dark ? "text-slate-400" : "text-slate-500",
    card: dark ? "bg-slate-900 border-slate-700" : "bg-white border-slate-300",
    cardSubtle: dark ? "bg-slate-800 border-slate-700" : "bg-slate-50 border-slate-200",
    divider: dark ? "border-slate-800" : "border-slate-100",
    control: dark ? "bg-slate-900 border-slate-700 text-slate-100 hover:bg-slate-800" : "bg-white border-slate-300 hover:bg-slate-100",
    controlDisabled: dark ? "bg-slate-900 border-slate-800 text-slate-600" : "bg-white border-slate-200 text-slate-300",
    input: dark ? "bg-slate-800 border-slate-700 text-slate-100" : "bg-white border-slate-300 text-slate-900",
    textMain: dark ? "text-slate-100" : "text-slate-900",
    textDim: dark ? "text-slate-500" : "text-slate-400",
    inactiveTile: dark ? "bg-slate-800 border-slate-700 text-slate-400 hover:bg-slate-700" : "bg-slate-50 border-slate-200 text-slate-500 hover:bg-slate-100",
    selectedTile: dark ? "bg-slate-100 border-slate-100 text-slate-900" : "bg-slate-900 border-slate-900 text-white",
    gridOuter: dark ? "border-slate-100" : "border-slate-800",
    gridLine: dark ? "border-slate-700" : "border-slate-200",
    gridBoxLine: dark ? "border-slate-100" : "border-slate-800",
    gridBoxLineR: dark ? "border-r-slate-100" : "border-r-slate-800",
    gridBoxLineB: dark ? "border-b-slate-100" : "border-b-slate-800",
    sameValueBg: dark ? "bg-indigo-950" : "bg-indigo-100",
    rowColBg: dark ? "bg-slate-800" : "bg-slate-100",
    givenText: dark ? "text-slate-100" : "text-slate-900",
    userText: dark ? "text-teal-400" : "text-teal-700",
    cellBg: dark ? "bg-slate-900" : "bg-white",
    amberTile: dark ? "bg-amber-950 border-amber-800 text-amber-300 hover:bg-amber-900" : "bg-amber-50 border-amber-300 text-amber-800 hover:bg-amber-100",
    amberAccentText: dark ? "text-amber-400" : "text-amber-600",
    roseTile: dark ? "bg-rose-950 border-rose-800 text-rose-300 hover:bg-rose-900" : "bg-rose-50 border-rose-300 text-rose-800 hover:bg-rose-100",
    indigoBanner: dark ? "text-indigo-300 bg-indigo-950 border-indigo-800" : "text-indigo-600 bg-indigo-50 border-indigo-200",
    indigoToggleOn: dark ? "bg-indigo-500 border-indigo-500 text-white" : "bg-indigo-600 border-indigo-600 text-white",
  };
  const [board, setBoard] = useState(() =>
    INITIAL_GEN.puzzle.map((v) => ({ given: v !== 0, value: v, notes: new Map(), color: null }))
  );
  const [solution, setSolution] = useState(() => INITIAL_GEN.solution);
  const [history, setHistory] = useState([]);
  const [selected, setSelected] = useState(null);
  const [mode, setMode] = useState("value"); // value | notes | color
  const [activeColor, setActiveColor] = useState(PALETTE[0].id);
  const [selectedTechnique, setSelectedTechnique] = useState(null);
  const [example, setExample] = useState(null);
  const [exampleLoading, setExampleLoading] = useState(false);
  const [panelTab, setPanelTab] = useState("hints"); // "hints" | "coloring" | "setup"
  const [matchIdx, setMatchIdx] = useState(0);
  const [customStr, setCustomStr] = useState("");
  const [customError, setCustomError] = useState("");
  const [colorDigit, setColorDigit] = useState(1);
  const [colorA, setColorA] = useState(null);
  const [colorB, setColorB] = useState(null);
  const [colorResult, setColorResult] = useState(null);
  const [flagErrors, setFlagErrors] = useState(true);
  const [timedMode, setTimedMode] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [timerRunning, setTimerRunning] = useState(false);
  const [difficulty, setDifficulty] = useState("easy");
  const [generating, setGenerating] = useState(false);
  const [genInfo, setGenInfo] = useState(null);
  const [currentSeedId, setCurrentSeedId] = useState(() => seedToId(INITIAL_GEN.level.id, INITIAL_GEN.seed));
  const [seedInput, setSeedInput] = useState("");
  const [seedError, setSeedError] = useState("");
  const [seedCopied, setSeedCopied] = useState(false);
  const NOTE_STYLES = [
    { id: "grid", label: "Grid (3×3 corners)", short: "Grid" },
    { id: "bold", label: "Large compact", short: "Bold" },
  ];
  const [noteStyleIdx, setNoteStyleIdx] = useState(0);
  const noteStyle = NOTE_STYLES[noteStyleIdx].id;
  const cycleNoteStyle = () => setNoteStyleIdx((i) => (i + 1) % NOTE_STYLES.length);
  const containerRef = useRef(null);

  const [previewMode, setPreviewMode] = useState(false);
  const digitCounts = useMemo(() => {
    const counts = new Array(10).fill(0);
    board.forEach((cell) => { if (cell.value) counts[cell.value]++; });
    return counts;
  }, [board]);
  const conflicts = useMemo(() => conflictSet(board), [board]); // fallback when no unique solution is known
  const isComplete = useMemo(() => {
    if (board.some((c) => !c.value)) return false;
    if (solution) return board.every((c, idx) => c.value === solution[idx]);
    return conflicts.size === 0;
  }, [board, solution, conflicts]);
  const paused = timedMode && !timerRunning && !isComplete;

  useEffect(() => {
    if (!timedMode || !timerRunning) return;
    if (isComplete) { setTimerRunning(false); return; }
    const id = setInterval(() => setElapsedSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [timedMode, timerRunning, isComplete]);
  // Recomputed every time the board changes: every technique's current
  // matches, so the panel can show live counts without the player having
  // to manually search each one.
  // In Preview mode, detection runs against the TRUE full candidate set
  // (as if every empty cell had complete notes) instead of your actual
  // notes — so every pattern that genuinely exists in the puzzle surfaces,
  // regardless of difficulty or how much you've pencil-marked. Off by
  // default, since the whole point of this app is reading YOUR notes, not
  // a hidden solver — Preview is an explicit, separate "show me everything"
  // mode for browsing/learning, not the default hint behaviour.
  const allTechniqueMatches = useMemo(() => {
    let detectionBoard = board;
    if (previewMode) {
      detectionBoard = board.map((cell, idx) => {
        if (cell.value) return cell;
        const used = new Set(PEERS[idx].map((p) => board[p].value).filter(Boolean));
        const notes = new Map();
        for (let d = 1; d <= 9; d++) if (!used.has(d)) notes.set(d, "grid");
        return { ...cell, notes };
      });
    }
    const raw = TECHNIQUES.map((t) => ({ name: t.name, level: t.level, matches: t.find(detectionBoard) }));
    if (!solution) return raw;
    // Ground-truth safety net. A logically sound deduction against accurate
    // notes can never eliminate the digit that's actually correct for a
    // cell, or place a digit that isn't. If a hit does either, that's proof
    // the underlying NOTES have drifted from truth somewhere upstream (a
    // stale or missing candidate) rather than the technique being unsound —
    // but regardless of cause, it must never be shown or applied as if it
    // were valid.
    return raw.map((entry) => ({
      ...entry,
      matches: entry.matches.filter((hit) => {
        const badElim = hit.eliminate.some(({ idx, digit }) => solution[idx] === digit);
        const badPlace = hit.place.some(({ idx, digit }) => solution[idx] !== digit);
        return !badElim && !badPlace;
      }),
    }));
  }, [board, previewMode, solution]);
  const selectedEntry = allTechniqueMatches.find((e) => e.name === selectedTechnique) || null;
  const selectedMatches = selectedEntry ? selectedEntry.matches : [];
  const safeIdx = selectedMatches.length ? Math.min(matchIdx, selectedMatches.length - 1) : 0;
  const currentMatch = selectedMatches[safeIdx] || null;
  const usedColors = useMemo(() => {
    const s = new Set();
    board.forEach((c) => { if (c.color) s.add(c.color); });
    return [...s];
  }, [board]);

  const pushHistory = useCallback((b) => setHistory((h) => [...h, cloneBoard(b)]), []);

  const commit = useCallback((mutator) => {
    setBoard((prev) => {
      pushHistory(prev);
      const next = cloneBoard(prev);
      mutator(next);
      return next;
    });
    setMatchIdx(0);
  }, [pushHistory]);

  const undo = () => {
    setHistory((h) => {
      if (!h.length) return h;
      const last = h[h.length - 1];
      setBoard(last);
      return h.slice(0, -1);
    });
    setMatchIdx(0);
  };

  const toggleTimedMode = () => {
    setTimedMode((v) => {
      const next = !v;
      setElapsedSeconds(0);
      setTimerRunning(next); // turning on starts fresh; turning off just stops
      return next;
    });
  };
  const toggleTimerRunning = () => setTimerRunning((r) => !r);

  const loadNewPuzzle = (str) => {
    const cells = loadPuzzle(str);
    const digits = cells.map((c) => c.value);
    setBoard(cells);
    const count = solveCount(digits, 2);
    setSolution(count === 1 ? solveGrid(digits) : null);
    setHistory([]);
    setSelected(null);
    setSelectedTechnique(null);
    setMatchIdx(0);
    setColorResult(null);
    setGenInfo(null);
    setCurrentSeedId(null);
    setElapsedSeconds(0);
    setTimerRunning(timedMode);
  };

  const loadDigits = (digits, solutionDigits = null) => {
    setBoard(digits.map((v) => ({ given: v !== 0, value: v, notes: new Map(), color: null })));
    setSolution(solutionDigits);
    setHistory([]);
    setSelected(null);
    setSelectedTechnique(null);
    setMatchIdx(0);
    setColorResult(null);
    setElapsedSeconds(0);
    setTimerRunning(timedMode);
  };

  const handleGenerate = (levelId = difficulty, seed = null) => {
    setGenerating(true);
    // defer so the "Generating…" state actually paints before the
    // (synchronous, potentially ~second-long for high tiers) search runs
    setTimeout(() => {
      const result = generatePuzzle(levelId, seed);
      if (result) {
        loadDigits(result.puzzle, result.solution);
        setGenInfo(result);
        setCurrentSeedId(seedToId(result.level.id, result.seed));
      }
      setGenerating(false);
    }, 30);
  };

  const loadSeed = () => {
    const parsed = idToSeed(seedInput);
    if (!parsed) { setSeedError("Couldn't read that seed ID — expected a format like EXPERT-K2F8X1."); return; }
    setSeedError("");
    setDifficulty(parsed.levelId);
    handleGenerate(parsed.levelId, parsed.seed);
  };

  const applyCustom = () => {
    const clean = customStr.trim();
    if (!/^[0-9.]{81}$/.test(clean)) {
      setCustomError("Puzzle string must be exactly 81 characters, using 0 or . for blanks.");
      return;
    }
    const digits = clean.split("").map((ch) => (ch === "." || ch === "0" ? 0 : parseInt(ch, 10)));
    const count = solveCount(digits, 2);
    if (count === 0) {
      setCustomError("This puzzle has no valid solution — double-check the digits.");
      return;
    }
    setCustomError(count >= 2 ? "Loaded, but this puzzle has multiple solutions, so invalid-placement flagging will fall back to basic row/column/box duplicate checks instead of the true solution." : "");
    loadNewPuzzle(clean);
  };

  const handleDigit = (d) => {
    if (selected === null) return;
    if (digitCounts[d] >= 9) return; // already placed everywhere it can go
    const cell = board[selected];
    if (cell.given) return;
    if (mode === "value") {
      commit((next) => {
        next[selected].value = d;
        next[selected].notes = new Map();
        // convenience: strike this digit from peers' notes
        PEERS[selected].forEach((p) => next[p].notes.delete(d));
      });
    } else if (mode === "notes") {
      if (cell.value) return;
      commit((next) => {
        const s = next[selected].notes;
        // toggle off if present (regardless of which style it was entered with);
        // otherwise add it tagged with whichever input style is currently active
        if (s.has(d)) s.delete(d); else s.set(d, noteStyle);
      });
    }
  };

  const handleErase = () => {
    if (selected === null) return;
    const cell = board[selected];
    if (cell.given) return;
    commit((next) => {
      if (mode === "color") next[selected].color = null;
      else { next[selected].value = 0; next[selected].notes = new Map(); }
    });
  };

  const handleCellClick = (idx) => {
    setSelected(idx);
    if (mode === "color" && !board[idx].given) {
      commit((next) => {
        next[idx].color = next[idx].color === activeColor ? null : activeColor;
      });
    }
  };

  const handleAutoNotes = () => {
    commit((next) => {
      for (let i = 0; i < 81; i++) {
        if (!next[i].value && next[i].notes.size === 0) next[i].notes = autoCandidates(next, i, noteStyle);
      }
    });
  };

  const clearAllColors = () => {
    commit((next) => next.forEach((c) => { c.color = null; }));
    setColorResult(null);
  };

  const getHint = () => {
    const easiest = allTechniqueMatches.find((e) => e.matches.length);
    setSelectedTechnique(easiest ? easiest.name : null);
    setMatchIdx(0);
    setPanelTab("hints");
  };

  const selectTechnique = (name) => {
    setSelectedTechnique(name);
    setMatchIdx(0);
  };

  const regenerateExample = useCallback((name) => {
    if (!name) { setExample(null); return; }
    setExampleLoading(true);
    setTimeout(() => {
      setExample(generateExampleFor(name));
      setExampleLoading(false);
    }, 10);
  }, []);

  useEffect(() => {
    regenerateExample(selectedTechnique);
  }, [selectedTechnique, regenerateExample]);

  const stepMatch = (delta) => {
    if (!selectedMatches.length) return;
    setMatchIdx((safeIdx + delta + selectedMatches.length) % selectedMatches.length);
  };

  const applyHint = () => {
    if (!currentMatch) return;
    commit((next) => {
      currentMatch.place.forEach(({ idx, digit }) => {
        next[idx].value = digit;
        next[idx].notes = new Map();
        PEERS[idx].forEach((p) => next[p].notes.delete(digit));
      });
      currentMatch.eliminate.forEach(({ idx, digit }) => next[idx].notes.delete(digit));
    });
  };

  const runColorAnalysis = () => {
    if (!colorA || !colorB || colorA === colorB) { setColorResult({ error: "Pick two different colors that are in use on the board." }); return; }
    setColorResult(analyzeColoring(board, colorDigit, colorA, colorB));
  };

  const applyColorElims = () => {
    if (!colorResult || !colorResult.eliminate.length) return;
    commit((next) => colorResult.eliminate.forEach(({ idx, digit }) => next[idx].notes.delete(digit)));
    setColorResult(null);
  };

  useEffect(() => {
    const handler = (e) => {
      const tag = e.target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return; // don't hijack typing elsewhere

      const key = e.key.toLowerCase();
      if (key === "e") { setMode("value"); return; }
      if (key === "n") { if (mode === "notes") cycleNoteStyle(); else setMode("notes"); return; }
      if (key === "c") { setMode("color"); return; }

      if (paused) return; // board's hidden — don't let keyboard input silently edit it

      if (selected === null) return;
      if (e.key >= "1" && e.key <= "9") handleDigit(parseInt(e.key, 10));
      else if (e.key === "Backspace" || e.key === "Delete" || e.key === "0") handleErase();
      else if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
        e.preventDefault();
        const [r, c] = rc(selected);
        let nr = r, nc = c;
        if (e.key === "ArrowUp") nr = (r + 8) % 9;
        if (e.key === "ArrowDown") nr = (r + 1) % 9;
        if (e.key === "ArrowLeft") nc = (c + 8) % 9;
        if (e.key === "ArrowRight") nc = (c + 1) % 9;
        setSelected(at(nr, nc));
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selected, board, mode, activeColor, noteStyleIdx, paused]);

  const selRC = selected !== null ? rc(selected) : null;
  const selValue = selected !== null ? board[selected].value : 0;
  const sameValueCells = useMemo(() => {
    if (!selValue) return new Set();
    const s = new Set();
    board.forEach((cell, idx) => { if (cell.value === selValue) s.add(idx); });
    return s;
  }, [board, selValue]);

  const hintCause = new Set(currentMatch?.cause || []);
  const hintEliminate = new Map();
  (currentMatch?.eliminate || []).forEach(({ idx, digit }) => {
    if (!hintEliminate.has(idx)) hintEliminate.set(idx, new Set());
    hintEliminate.get(idx).add(digit);
  });
  const hintPlace = new Map((currentMatch?.place || []).map((p) => [p.idx, p.digit]));

  const colorElimSet = new Map();
  (colorResult?.eliminate || []).forEach(({ idx, digit }) => {
    if (!colorElimSet.has(idx)) colorElimSet.set(idx, new Set());
    colorElimSet.get(idx).add(digit);
  });

  return (
    <div className={`min-h-screen font-sans ${T.page}`}>
      <div className="max-w-5xl mx-auto p-4">
        <header className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h1 className={`text-2xl sm:text-3xl font-bold tracking-tight ${T.heading}`}>Sudoku Trainer</h1>
            <p className={`text-sm mt-1 ${T.textSecondary}`}>Enter your own notes and colors — the hint engine reasons from what <em>you've</em> marked, not a hidden solver.</p>
          </div>
          <button
            onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
            className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded border shrink-0 ${T.control}`}
          >
            {dark ? <Sun size={14} /> : <Moon size={14} />} {dark ? "Light" : "Dark"}
          </button>
        </header>

        {/* Toolbar */}
        <div className="flex flex-wrap gap-2 mb-4 items-center">
          <select
            className={`text-sm border rounded px-2 py-1.5 ${T.input}`}
            value={difficulty}
            onChange={(e) => setDifficulty(e.target.value)}
          >
            {DIFFICULTY_LEVELS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>

          <button
            onClick={() => handleGenerate()}
            disabled={generating || paused}
            className={`flex items-center gap-1.5 text-sm px-3 py-1.5 rounded border disabled:opacity-50 ${T.control}`}
          >
            <Shuffle size={14} /> {generating ? "Generating…" : "New puzzle"}
          </button>

          <button onClick={handleAutoNotes} disabled={paused} className={`flex items-center gap-1.5 text-sm px-3 py-1.5 rounded border disabled:opacity-40 ${T.control}`}>
            <Shuffle size={14} /> Auto pencil marks
          </button>

          <button
            onClick={() => setFlagErrors((v) => !v)}
            className={`flex items-center gap-1.5 text-sm px-3 py-1.5 rounded border ${flagErrors ? (dark ? "bg-rose-950 border-rose-800 text-rose-300" : "bg-rose-50 border-rose-300 text-rose-700") : T.control}`}
            title="When on, any placed digit that doesn't match this puzzle's actual solution is highlighted in red — not just ones that duplicate another cell. Falls back to row/column/box duplicate checks if the puzzle's solution isn't known (e.g. a custom puzzle with multiple solutions)."
          >
            Flag errors: {flagErrors ? "On" : "Off"}
          </button>

          <div className="flex-1" />

          <button
            onClick={toggleTimedMode}
            className={`flex items-center gap-1.5 text-sm px-3 py-1.5 rounded border ${timedMode ? T.indigoToggleOn : T.control}`}
            title="When on, a timer tracks how long you take. You can pause it — the puzzle hides itself while paused so you can't keep working while the clock's stopped. Stops automatically when solved, restarts automatically on a new puzzle."
          >
            <Timer size={14} /> Timed mode: {timedMode ? "On" : "Off"}
          </button>

          {timedMode && (
            <div className={`flex items-center gap-1.5 text-sm px-3 py-1.5 rounded border font-mono ${T.card}`}>
              <span className={isComplete ? "text-emerald-500 font-semibold" : T.textMain}>{formatTime(elapsedSeconds)}</span>
              <button
                onClick={toggleTimerRunning}
                disabled={isComplete}
                title={isComplete ? "Solved — timer stopped automatically." : timerRunning ? "Pause (hides the puzzle)" : "Resume"}
                className={`p-1 rounded disabled:opacity-40 ${dark ? "hover:bg-slate-800" : "hover:bg-slate-100"}`}
              >
                {timerRunning ? <Pause size={14} /> : <Play size={14} />}
              </button>
            </div>
          )}
        </div>

        {genInfo && (
          <p className={`text-xs -mt-3 mb-4 ${T.textSecondary}`}>
            {genInfo.level.label}: {genInfo.clues} givens.{" "}
            {genInfo.techniques.length
              ? `Solvable with ${genInfo.techniques.join(", ")}.`
              : "Fully given or trivially solved."}
            {!genInfo.graded && " (Closest match found in the attempt budget — it didn't cleanly hit this tier's technique profile.)"}
            {!genInfo.fullySolved && " This puzzle isn't fully crackable with the techniques currently in the hint engine — you may need to guess-and-check on the last few cells."}
          </p>
        )}

        {currentSeedId && (
          <p className={`text-xs -mt-3 mb-4 ${T.textDim}`}>
            Seed: <span className={`font-mono ${T.textSecondary}`}>{currentSeedId}</span> — share this to give someone the exact same puzzle (see Setup tab).
          </p>
        )}

        {paused ? (
          <div className={`border rounded-lg p-10 flex flex-col items-center justify-center text-center gap-3 ${T.card}`} style={{ minHeight: "420px" }}>
            <Pause size={32} className={T.textDim} />
            <div>
              <p className={`font-semibold ${T.textMain}`}>Puzzle paused</p>
              <p className={`text-sm mt-1 ${T.textSecondary}`}>The board's hidden while paused, so you can't keep solving with the clock stopped.</p>
            </div>
            <p className={`font-mono text-2xl ${T.textMain}`}>{formatTime(elapsedSeconds)}</p>
            <button
              onClick={toggleTimerRunning}
              className="flex items-center gap-1.5 text-sm px-4 py-2 rounded bg-emerald-600 text-white hover:bg-emerald-700"
            >
              <Play size={14} /> Resume
            </button>
          </div>
        ) : (
        <>
        <div className="flex flex-col sm:flex-row sm:flex-wrap gap-6">
          {/* Grid */}
          <div className="flex-shrink-0 mx-auto sm:mx-0" style={{ width: "min(92vw, 460px)" }} ref={containerRef}>
            <div className={`grid grid-cols-9 border-2 rounded overflow-hidden touch-manipulation select-none ${T.gridOuter} ${T.cellBg}`}>
              {board.map((cell, idx) => {
                const [r, c] = rc(idx);
                const isSelected = selected === idx;
                const isConflict = flagErrors && cell.value !== 0 && (
                  solution ? cell.value !== solution[idx] : conflicts.has(idx)
                );
                const isCause = hintCause.has(idx);
                const elimDigits = hintEliminate.get(idx);
                const placeDigit = hintPlace.get(idx);
                const colorElims = colorElimSet.get(idx);
                const isColA = colorResult && cell.color === colorA;
                const isColB = colorResult && cell.color === colorB;

                const inSelLine = selRC && !isSelected && (r === selRC[0] || c === selRC[1]);
                const isSameValue = !isSelected && sameValueCells.has(idx) && cell.value !== 0;
                let bgClass = "";
                if (!cell.color) {
                  if (isSameValue) bgClass = T.sameValueBg;
                  else if (inSelLine) bgClass = T.rowColBg;
                }

                let ringClass = "";
                if (placeDigit) ringClass = "ring-2 ring-inset ring-emerald-500 z-10";
                else if (isCause) ringClass = "ring-2 ring-inset ring-amber-400 z-10";
                else if (isSelected) ringClass = "ring-2 ring-inset ring-indigo-500 z-10";

                return (
                  <button
                    key={idx}
                    onClick={() => handleCellClick(idx)}
                    className={[
                      "relative aspect-square flex items-center justify-center border",
                      T.gridLine,
                      bgClass,
                      c % 3 === 2 && c !== 8 ? `border-r-2 ${T.gridBoxLineR}` : "",
                      r % 3 === 2 && r !== 8 ? `border-b-2 ${T.gridBoxLineB}` : "",
                      ringClass,
                    ].join(" ")}
                  >
                    {cell.color && <div className={`absolute inset-0.5 rounded-sm ${SWATCH_BG[cell.color]}`} />}
                    {(isColA || isColB) && (
                      <div className={`absolute inset-0.5 rounded-sm ring-2 ring-inset ${isColA ? (dark ? "ring-slate-50" : "ring-slate-900") : "ring-slate-500"}`} />
                    )}
                    <div className="relative z-10 w-full h-full flex items-center justify-center">
                      {cell.value ? (
                        <span className={[
                          "text-lg sm:text-2xl font-semibold",
                          isConflict ? "text-rose-600" : (cell.given ? T.givenText : T.userText),
                        ].join(" ")}>{cell.value}</span>
                      ) : (
                        renderNotes(cell, elimDigits, colorElims, dark)
                      )}
                      {placeDigit && (
                        <span className="absolute bottom-0 right-0.5 text-[9px] font-bold text-emerald-600">→{placeDigit}</span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Input pad — calculator-style, sits beside the grid */}
          <div className={`mx-auto sm:mx-0 w-full shrink-0 border rounded-lg p-3 space-y-3 ${T.card}`} style={{ maxWidth: "272px" }}>
            {/* Mode tabs */}
            <div className="flex gap-1">
              {[
                { id: "value", icon: Hash, label: "Enter", key: "E" },
                { id: "notes", icon: Pencil, label: mode === "notes" ? `Notes: ${NOTE_STYLES[noteStyleIdx].short}` : "Notes", key: "N" },
                { id: "color", icon: Palette, label: "Colour", key: "C" },
              ].map(({ id, icon: Icon, label: l, key }) => (
                <button
                  key={id}
                  onClick={() => { if (id === "notes" && mode === "notes") cycleNoteStyle(); else setMode(id); }}
                  title={id === "notes" ? `Press N to switch here — press again to cycle the style new marks are entered in (existing marks keep whatever style they were written with).` : `Press ${key} to switch here.`}
                  className={`flex-1 flex flex-col items-center justify-center gap-0.5 text-[11px] py-2 rounded border ${mode === id ? T.selectedTile : T.control}`}>
                  <Icon size={14} /> {l}
                </button>
              ))}
            </div>
            <p className={`text-[10px] leading-snug -mt-2 ${T.textDim}`}>
              <span className="font-mono">E</span> Enter · <span className="font-mono">N</span> Notes · <span className="font-mono">C</span> Colour
              {mode === "notes" && " — press N again to cycle style"}
            </p>

            {/* Action row: frequent per-move actions, kept close to the number pad rather than scattered in the top toolbar */}
            <div className={`flex items-center justify-between border-t border-b py-2 ${T.divider}`}>
              <button onClick={undo} disabled={!history.length} title="Undo" className={`flex flex-col items-center gap-0.5 text-[10px] disabled:opacity-30 ${T.textSecondary}`}>
                <Undo2 size={18} /> Undo
              </button>
              <button onClick={handleErase} title="Erase" className={`flex flex-col items-center gap-0.5 text-[10px] ${T.textSecondary}`}>
                <Eraser size={18} /> Erase
              </button>
              <button onClick={getHint} title="Get hint" className={`flex flex-col items-center gap-0.5 text-[10px] ${dark ? "text-amber-400" : "text-amber-600"}`}>
                <Lightbulb size={18} /> Hint
              </button>
            </div>

            {mode !== "color" ? (
              <div className="flex items-center justify-between px-0.5">
                {Array.from({ length: 9 }, (_, i) => i + 1).map((d) => {
                  const isComplete = digitCounts[d] >= 9;
                  return (
                    <button
                      key={d}
                      onClick={() => !isComplete && handleDigit(d)}
                      disabled={isComplete}
                      title={isComplete ? `${d} is already placed in all 9 cells` : undefined}
                      className={[
                        "text-xl font-medium py-1",
                        isComplete ? `${T.textDim} cursor-not-allowed` : (dark ? "text-sky-400" : "text-sky-600"),
                      ].join(" ")}
                    >
                      {d}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="space-y-2">
                <div className="grid grid-cols-5 gap-1.5">
                  {PALETTE.map((p) => (
                    <button key={p.id} onClick={() => setActiveColor(p.id)}
                      className={`h-9 rounded ${p.swatch} border-2 ${activeColor === p.id ? (dark ? "border-slate-100" : "border-slate-900") : "border-transparent"}`} />
                  ))}
                </div>
                <button onClick={clearAllColors} className={`w-full py-1.5 rounded border text-xs ${T.control} ${dark ? "hover:bg-rose-950" : "hover:bg-rose-50"}`}>
                  Clear all colours
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Tabbed panel: Hints / Coloring / Setup — full width, below the grid + pad row */}
        <div className="mt-6">
          <div className={`border rounded-lg overflow-hidden ${T.card}`}>
              <div className={`flex border-b ${dark ? "border-slate-700" : "border-slate-200"}`}>
                {[
                  { id: "hints", label: "Hints", icon: Lightbulb },
                  { id: "coloring", label: "Colouring", icon: Palette },
                  { id: "setup", label: "Setup", icon: Settings },
                ].map(({ id, label, icon: Icon }) => (
                  <button
                    key={id}
                    onClick={() => setPanelTab(id)}
                    className={`flex-1 flex items-center justify-center gap-1.5 text-sm py-2 ${panelTab === id ? T.selectedTile : `${T.card} ${T.textSecondary} ${dark ? "hover:bg-slate-800" : "hover:bg-slate-50"}`}`}
                  >
                    <Icon size={14} /> {label}
                  </button>
                ))}
              </div>

              <div className="p-3 space-y-3">
                {panelTab === "hints" && (
                  <>
                    <div className="flex items-center justify-end gap-1.5">
                      <button
                        onClick={() => setPreviewMode((v) => !v)}
                        title="Off: only counts what's actually in your notes. On: shows every pattern that genuinely exists in the puzzle right now, computed from the true candidates, regardless of what you've pencil-marked or which difficulty you picked — good for browsing techniques, not for tracking your own solving progress."
                        className={`text-xs px-2 py-1 rounded border ${previewMode ? T.indigoToggleOn : T.control}`}
                      >
                        Preview: {previewMode ? "On" : "Off"}
                      </button>
                      <button onClick={getHint} className={`text-sm px-3 py-1 rounded ${dark ? "bg-slate-100 text-slate-900 hover:bg-white" : "bg-slate-900 text-white hover:bg-slate-700"}`}>Get hint</button>
                    </div>
                    {previewMode && (
                      <p className={`text-xs border rounded px-2 py-1.5 ${T.indigoBanner}`}>
                        Preview mode is on: counts below reflect every pattern that exists in the full solved candidate space, not just what's in your notes. Great for seeing a technique in action on any puzzle — but "Apply" is disabled here, since these matches may reference candidates you haven't actually written down.
                      </p>
                    )}

                    <div className="space-y-1.5">
                      <p className={`text-xs ${T.textSecondary}`}>Every technique, live — a highlighted count means it currently applies somewhere on the board. Tap any technique to learn it, whether or not it's active right now.</p>
                      <div className="grid grid-cols-2 gap-1.5">
                        {allTechniqueMatches.map(({ name, matches }) => {
                          const active = matches.length > 0;
                          const isSelected = selectedTechnique === name;
                          const isWarning = name === "Note Conflict";
                          return (
                            <button
                              key={name}
                              onClick={() => selectTechnique(name)}
                              className={[
                                "flex items-center justify-between gap-1 text-xs px-2 py-1.5 rounded border text-left",
                                isSelected ? (isWarning ? (dark ? "bg-rose-600 border-rose-600 text-white" : "bg-rose-600 border-rose-600 text-white") : T.selectedTile) :
                                active ? (isWarning ? T.roseTile : T.amberTile) :
                                T.inactiveTile,
                              ].join(" ")}
                            >
                              <span className="truncate">{name}</span>
                              <span className={["shrink-0 font-semibold", isSelected ? (dark && !isWarning ? "text-slate-900" : "text-white") : active ? (isWarning ? "text-rose-500" : T.amberAccentText) : T.textDim].join(" ")}>
                                {matches.length || "–"}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {selectedTechnique ? (
                      <div className={`text-sm space-y-2.5 border-t pt-2 ${T.divider}`}>
                        <div className="flex items-center justify-between">
                          <div className={`font-medium ${T.textMain}`}>{selectedTechnique}</div>
                          {selectedMatches.length > 1 && (
                            <div className={`flex items-center gap-1 text-xs ${T.textSecondary}`}>
                              <span>{safeIdx + 1} of {selectedMatches.length}</span>
                              <button onClick={() => stepMatch(-1)} className={`px-1.5 py-0.5 rounded border ${T.control}`}>‹</button>
                              <button onClick={() => stepMatch(1)} className={`px-1.5 py-0.5 rounded border ${T.control}`}>›</button>
                            </div>
                          )}
                        </div>

                        {TECHNIQUE_INFO[selectedTechnique] && (
                          <dl className={`space-y-1.5 text-xs border rounded p-2 ${T.cardSubtle}`}>
                            <div><dt className={`font-semibold ${T.textSecondary}`}>What it is</dt><dd className={T.textSecondary}>{TECHNIQUE_INFO[selectedTechnique].whatIsIt}</dd></div>
                            <div><dt className={`font-semibold ${T.textSecondary}`}>Why this name</dt><dd className={T.textSecondary}>{TECHNIQUE_INFO[selectedTechnique].whyName}</dd></div>
                            <div><dt className={`font-semibold ${T.textSecondary}`}>How to spot it</dt><dd className={T.textSecondary}>{TECHNIQUE_INFO[selectedTechnique].howToSpot}</dd></div>
                            <div><dt className={`font-semibold ${T.textSecondary}`}>How to use it</dt><dd className={T.textSecondary}>{TECHNIQUE_INFO[selectedTechnique].howToUse}</dd></div>
                          </dl>
                        )}

                        <div className={`border rounded-lg p-3 ${T.cardSubtle}`}>
                          <div className="flex items-center justify-between mb-2">
                            <p className={`text-xs font-semibold ${T.textSecondary}`}>Worked example</p>
                            <button
                              onClick={() => regenerateExample(selectedTechnique)}
                              disabled={exampleLoading}
                              title="Generate a different random board showing this same technique"
                              className={`flex items-center gap-1 text-xs px-2 py-1 rounded border disabled:opacity-50 ${T.control}`}
                            >
                              <Shuffle size={12} /> New example
                            </button>
                          </div>
                          {exampleLoading ? (
                            <p className={`text-xs text-center py-8 ${T.textDim}`}>Generating an example…</p>
                          ) : example ? (
                            <div className="space-y-2">
                              <SampleGrid board={example.board} match={example.match} dark={dark} T={T} />
                              <p className={`text-xs ${T.textSecondary}`}>{example.match.message}</p>
                            </div>
                          ) : (
                            <p className={`text-xs ${T.textDim}`}>Couldn't find an example this time — small boards don't always contain every pattern. Try "New example" again.</p>
                          )}
                        </div>

                        {currentMatch ? (
                          <div className="space-y-2">
                            <p className={T.textSecondary}><span className={`font-semibold ${T.textMain}`}>{previewMode ? "In this puzzle's full candidates: " : "On this board right now: "}</span>{currentMatch.message}</p>
                            <button
                              onClick={applyHint}
                              disabled={previewMode}
                              title={previewMode ? "Turn off Preview mode to apply this step to your actual notes." : undefined}
                              className="text-xs px-2.5 py-1 rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40 disabled:hover:bg-emerald-600"
                            >
                              Apply this step
                            </button>
                          </div>
                        ) : (
                          <p className={`text-xs ${T.textDim}`}>No {selectedTechnique} pattern is currently on the board — that's normal, not every technique shows up in every position. The explanation above still applies whenever one does appear.</p>
                        )}
                      </div>
                    ) : (
                      <p className={`text-xs border-t pt-2 ${T.textDim} ${T.divider}`}>
                        No hint selected. Click "Get hint" for the easiest next step, or tap any technique above to learn it.
                        {" "}Every technique reads directly from whatever you've written in your notes — hand-typed or from Auto pencil marks, it's all treated as your true candidate list, so keep your notes accurate as you go.
                      </p>
                    )}
                  </>
                )}

                {panelTab === "coloring" && (
                  <>
                    <p className={`text-xs ${T.textSecondary}`}>Paint two chains of candidate cells with different colours (Colour mode), then check them here for Simple Colouring logic. (The Hints tab also runs this automatically from strong links — use this panel to test your own manually-built chains.)</p>
                    <div className="flex flex-wrap gap-2 items-center text-sm">
                      <label className={`flex items-center gap-1 ${T.textMain}`}>Digit
                        <select value={colorDigit} onChange={(e) => setColorDigit(parseInt(e.target.value, 10))} className={`border rounded px-1.5 py-1 ml-1 ${T.input}`}>
                          {Array.from({ length: 9 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}</option>)}
                        </select>
                      </label>
                      <select value={colorA || ""} onChange={(e) => setColorA(e.target.value || null)} className={`border rounded px-1.5 py-1 ${T.input}`}>
                        <option value="">Colour A…</option>
                        {usedColors.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                      <select value={colorB || ""} onChange={(e) => setColorB(e.target.value || null)} className={`border rounded px-1.5 py-1 ${T.input}`}>
                        <option value="">Colour B…</option>
                        {usedColors.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                      <button onClick={runColorAnalysis} className={`text-sm px-3 py-1 rounded ${dark ? "bg-slate-100 text-slate-900 hover:bg-white" : "bg-slate-900 text-white hover:bg-slate-700"}`}>Analyse</button>
                    </div>
                    {colorResult && (
                      <div className="text-sm space-y-1.5 pt-1">
                        {colorResult.error && <p className="text-rose-500">{colorResult.error}</p>}
                        {colorResult.notes?.map((n, i) => <p key={i} className={T.textSecondary}>{n}</p>)}
                        {colorResult.notes?.length === 0 && <p className={`text-xs ${T.textDim}`}>No contradiction or elimination found with this pairing yet — try extending the chain.</p>}
                        {colorResult.eliminate?.length > 0 && (
                          <button onClick={applyColorElims} className="text-xs px-2.5 py-1 rounded bg-emerald-600 text-white hover:bg-emerald-700">Apply eliminations</button>
                        )}
                      </div>
                    )}
                  </>
                )}

                {panelTab === "setup" && (
                  <>
                    <div className={`border-b pb-3 ${T.divider}`}>
                      <p className={`text-xs font-semibold ${T.textSecondary}`}>Puzzle seed</p>
                      <p className={`text-xs mt-1 mb-2 ${T.textDim}`}>Every generated puzzle has a seed ID. Share it with someone else running this app and they'll get the exact same puzzle, givens and all.</p>
                      {currentSeedId ? (
                        <div className="flex items-center gap-2 mb-3">
                          <code className={`text-sm font-mono px-2 py-1 rounded border flex-1 ${T.input}`}>{currentSeedId}</code>
                          <button
                            onClick={async () => {
                              try { await navigator.clipboard.writeText(currentSeedId); setSeedCopied(true); setTimeout(() => setSeedCopied(false), 1500); }
                              catch { setSeedCopied(false); }
                            }}
                            className={`text-xs px-2.5 py-1.5 rounded border ${T.control}`}
                          >
                            {seedCopied ? "Copied!" : "Copy"}
                          </button>
                        </div>
                      ) : (
                        <p className={`text-xs mb-3 ${T.textDim}`}>No seed for the current board — blank grids and custom puzzles aren't seeded.</p>
                      )}
                      <div className="flex items-center gap-2">
                        <input
                          value={seedInput}
                          onChange={(e) => setSeedInput(e.target.value)}
                          placeholder="e.g. EXPERT-K2F8X1"
                          className={`text-sm font-mono px-2 py-1.5 rounded border flex-1 ${T.input}`}
                        />
                        <button onClick={loadSeed} disabled={generating} className={`text-xs px-2.5 py-1.5 rounded border disabled:opacity-50 ${T.control}`}>
                          Load seed
                        </button>
                      </div>
                      {seedError && <p className="text-xs text-rose-500 mt-1.5">{seedError}</p>}
                    </div>
                    <div className={`border-b pb-3 ${T.divider}`}>
                      <p className={`text-xs font-semibold ${T.textSecondary}`}>Blank grid</p>
                      <p className={`text-xs mt-1 mb-2 ${T.textDim}`}>Clears the board to 81 empty cells — no given digits at all. Useful for manually building your own puzzle from scratch, or as a scratchpad for practising a technique without a real puzzle behind it.</p>
                      <button
                        onClick={() => loadNewPuzzle(BLANK_PUZZLE)}
                        className={`text-sm px-3 py-1.5 rounded border ${T.control}`}
                      >
                        Load blank grid
                      </button>
                    </div>
                    <p className={`text-xs font-semibold ${T.textSecondary}`}>Load a custom puzzle</p>
                    <textarea
                      value={customStr}
                      onChange={(e) => setCustomStr(e.target.value)}
                      placeholder="81 characters, left-to-right top-to-bottom, 0 or . for blanks"
                      className={`w-full text-xs font-mono border rounded p-2 h-16 ${T.input}`}
                    />
                    {customError && <p className="text-xs text-rose-500">{customError}</p>}
                    <button onClick={applyCustom} className={`text-sm px-3 py-1 rounded ${dark ? "bg-slate-100 text-slate-900 hover:bg-white" : "bg-slate-900 text-white hover:bg-slate-700"}`}>Load</button>
                  </>
                )}
              </div>
            </div>
          </div>
        </>
        )}
      </div>
    </div>
  );
}
