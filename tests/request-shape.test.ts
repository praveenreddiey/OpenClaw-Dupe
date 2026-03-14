import test from "node:test";
import assert from "node:assert/strict";
import {
  getNumericRefinementInstruction,
  isShortNumericRefinement,
} from "../src/request-shape.js";

test("isShortNumericRefinement detects short numeric constraint follow-ups", () => {
  assert.equal(isShortNumericRefinement("2000"), true);
  assert.equal(isShortNumericRefinement("under 2000"), true);
  assert.equal(isShortNumericRefinement("\u20B92000"), true);
  assert.equal(isShortNumericRefinement("2 adults"), true);
  assert.equal(isShortNumericRefinement("best restaurants in mumbai"), false);
  assert.equal(isShortNumericRefinement("best 10 thrillers on imdb"), false);
});

test("getNumericRefinementInstruction is emitted only for short numeric follow-ups", () => {
  assert.match(
    getNumericRefinementInstruction("2000"),
    /Preserve every digit exactly as written/i,
  );
  assert.equal(getNumericRefinementInstruction("best places to visit in rajasthan"), "");
});
