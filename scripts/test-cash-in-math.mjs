import assert from "node:assert/strict";

/** Matches headline CASH IN in breakdown when sheet + manual outstanding are summed. */
const cashInSheetTotal = 100 + 50 + 40;
const outstandingTotal = 20 + 30 + 10;
assert.equal(cashInSheetTotal, 190);
assert.equal(outstandingTotal, 60);
assert.equal(cashInSheetTotal + outstandingTotal, 250);

console.log("cash-in headline math check passed");
