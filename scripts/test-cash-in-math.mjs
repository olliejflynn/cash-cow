import assert from "node:assert/strict";

function splitOutstandingByPriority(totalOutstanding, mCashIn, lCashIn, bCashIn) {
  const eps = 1e-6;
  if (!Number.isFinite(totalOutstanding) || Math.abs(totalOutstanding) < eps) {
    return { outstandingL: 0, outstandingM: 0, outstandingB: 0, totalOutstanding: 0 };
  }

  if (totalOutstanding > 0) {
    if (Math.abs(bCashIn) < eps) {
      const cappedM = Math.min(totalOutstanding, Math.max(0, mCashIn));
      return {
        outstandingL: totalOutstanding - cappedM,
        outstandingM: cappedM,
        outstandingB: 0,
        totalOutstanding,
      };
    }
    const cappedM = Math.min(totalOutstanding, Math.max(0, mCashIn));
    const afterM = totalOutstanding - cappedM;
    const cappedL = Math.min(afterM, Math.max(0, lCashIn));
    return {
      outstandingL: cappedL,
      outstandingM: cappedM,
      outstandingB: afterM - cappedL,
      totalOutstanding,
    };
  }

  const remainingAbs = Math.abs(totalOutstanding);
  const mCap = Math.max(0, mCashIn);
  const lCap = Math.max(0, lCashIn);
  const mShare = Math.min(remainingAbs, mCap);
  const afterM = remainingAbs - mShare;
  const lShare = Math.min(afterM, lCap);
  return {
    outstandingL: -lShare,
    outstandingM: -mShare,
    outstandingB: -(afterM - lShare),
    totalOutstanding,
  };
}

function assertSplit(totalOutstanding, mCashIn, lCashIn, bCashIn, expected) {
  const got = splitOutstandingByPriority(totalOutstanding, mCashIn, lCashIn, bCashIn);
  assert.deepEqual(got, expected);
  assert.equal(
    got.outstandingL + got.outstandingM + got.outstandingB,
    got.totalOutstanding
  );
}

assertSplit(100, 30, 50, 0, {
  outstandingL: 70,
  outstandingM: 30,
  outstandingB: 0,
  totalOutstanding: 100,
});

assertSplit(100, 20, 40, 10, {
  outstandingL: 40,
  outstandingM: 20,
  outstandingB: 40,
  totalOutstanding: 100,
});

assertSplit(80, 0, 0, 50, {
  outstandingL: 0,
  outstandingM: 0,
  outstandingB: 80,
  totalOutstanding: 80,
});

assertSplit(-50, 10, 20, 15, {
  outstandingL: -20,
  outstandingM: -10,
  outstandingB: -20,
  totalOutstanding: -50,
});

const cashInSheetTotal = 100 + 50 + 40;
const outstandingTotal = 20 + 30 + 10;
assert.equal(cashInSheetTotal, 190);
assert.equal(outstandingTotal, 60);
assert.equal(cashInSheetTotal + outstandingTotal, 250);

console.log("cash-in math checks passed");
