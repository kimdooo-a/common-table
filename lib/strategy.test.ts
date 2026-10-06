import { test } from "node:test";
import assert from "node:assert/strict";
import { rankSlots } from "./strategy.ts";

test("music-leaning groups get a music nightcap", () => {
  const s = rankSlots("evening", ["indie rock", "melancholy"]);
  assert.equal(s[2].ranked[0].option.label, "jazz / live music bar");
});

test("art-leaning groups start at a gallery; art+film tips it to a museum", () => {
  assert.equal(rankSlots("evening", ["surrealism"])[0].ranked[0].option.label, "art gallery");
  assert.equal(rankSlots("evening", ["surrealism", "anime"])[0].ranked[0].option.label, "museum");
});

test("without cues the template default order is kept", () => {
  const s = rankSlots("date", []);
  assert.equal(s[1].ranked[0].option.label, "jazz / live music bar");
  assert.equal(s[0].ranked[0].option.label, "restaurant");
});
