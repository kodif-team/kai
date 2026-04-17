import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";

import { checkRateLimit, initAuditDb, recordRateLimit } from "../dist/audit.js";

test("rate limit can enforce frequency without blocking zero-cost local lookup on daily budget", () => {
  const dbPath = join(tmpdir(), `kai-audit-${Date.now()}.db`);
  const db = initAuditDb(dbPath);
  try {
    recordRateLimit(db, "alice", "owner/repo", "haiku", 1);

    assert.equal(checkRateLimit(db, "alice", "owner/repo").allowed, false);
    assert.deepEqual(
      checkRateLimit(db, "alice", "owner/repo", { includeCostBudget: false }),
      { allowed: true },
    );
  } finally {
    db.close();
    rmSync(dbPath, { force: true });
  }
});

test("frequency limits still apply when cost budget is skipped", () => {
  const dbPath = join(tmpdir(), `kai-audit-${Date.now()}.db`);
  const db = initAuditDb(dbPath);
  try {
    for (let i = 0; i < 20; i++) {
      recordRateLimit(db, "alice", "owner/repo", "local-repo-lookup", 0);
    }

    const result = checkRateLimit(db, "alice", "owner/repo", { includeCostBudget: false });
    assert.equal(result.allowed, false);
    assert.match(result.reason ?? "", /sender rate limit/);
  } finally {
    db.close();
    rmSync(dbPath, { force: true });
  }
});
