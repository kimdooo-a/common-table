import { test } from "node:test";
import assert from "node:assert/strict";
import { assemble, audit, groupScore, toPercentiles, travelPenalty } from "./fairness.ts";

const ids = ["a", "b", "c"];
// Mina adores "a", Leo hates it; "b" is fine for both; "c" is Leo's favourite.
const raw = {
  Mina: new Map([["a", 0.95], ["b", 0.8], ["c", 0.6]]),
  Leo: new Map([["a", 0.5], ["b", 0.82], ["c", 0.9]]),
};

test("percentiles are per person and within the pool", () => {
  const pct = toPercentiles(raw, ids);
  assert.equal(pct.Mina.get("a"), 1);
  assert.equal(pct.Mina.get("c"), 0);
  assert.equal(pct.Leo.get("c"), 1);
  assert.equal(pct.Leo.get("a"), 0);
});

test("least-misery prefers the place everyone likes", () => {
  const pct = toPercentiles(raw, ids);
  assert.ok(groupScore(pct, "b") > groupScore(pct, "a"));
  assert.ok(groupScore(pct, "b") > groupScore(pct, "c"));
});

test("unscored places count as a poor fit, not as missing", () => {
  const pct = toPercentiles({ Mina: new Map([["a", 0.9]]), Leo: new Map([["a", 0.9], ["b", 0.8]]) }, ["a", "b"]);
  assert.equal(pct.Mina.get("b"), 0);
});

test("the ledger hands the next stop to whoever was served least", () => {
  const pool = ids.map((id) => ({ id, name: id }));
  const pct1 = toPercentiles({ Mina: new Map([["a", 0.9], ["b", 0.1], ["c", 0.2]]), Leo: new Map([["a", 0.6], ["b", 0.2], ["c", 0.1]]) }, ids);
  const pct2 = toPercentiles({ Mina: new Map([["d", 0.9], ["e", 0.5], ["f", 0.1]]), Leo: new Map([["d", 0.1], ["e", 0.5], ["f", 0.9]]) }, ["d", "e", "f"]);
  const picks = assemble(
    [
      { key: "s1", pool, pct: pct1 },
      { key: "s2", pool: ["d", "e", "f"].map((id) => ({ id, name: id })), pct: pct2 },
    ],
    ["Mina", "Leo"],
  );
  assert.equal(picks.length, 2);
  assert.equal(picks[0].candidate.id, "a");
  const r = audit(picks, ["Mina", "Leo"]);
  assert.ok(r.evenness > 0.4);
});

test("no place is used twice", () => {
  const pool = [{ id: "x", name: "x" }, { id: "y", name: "y" }];
  const pct = toPercentiles({ A: new Map([["x", 0.9], ["y", 0.1]]), B: new Map([["x", 0.9], ["y", 0.1]]) }, ["x", "y"]);
  const picks = assemble([{ key: "1", pool, pct }, { key: "2", pool, pct }], ["A", "B"]);
  assert.notEqual(picks[0].candidate.id, picks[1].candidate.id);
});

test("short hops are free, long hops cost up to 0.3", () => {
  assert.equal(travelPenalty(1), 0);
  assert.ok(travelPenalty(10) > 0);
  assert.equal(travelPenalty(100), 0.3);
});
