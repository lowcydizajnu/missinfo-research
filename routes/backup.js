// ── Database backup (admin-only) ─────────────────────────────────────────────
// Streams a consistent snapshot of the entire SQLite database as a download, so
// the operator can keep off-server copies. Uses better-sqlite3's online backup
// (not a raw file copy) so the snapshot is consistent even while the app is
// serving and the WAL has uncommitted pages. This is the platform's only
// first-party backup path — there is no automatic backup, so a persistent
// volume + periodic manual download (or the host's own volume snapshots) is the
// safety net against data loss.
const express = require('express');
const jwt = require('jsonwebtoken');
const path = require('path');
const os = require('os');
const fs = require('fs');
const db = require('../db/database');

const router = express.Router();

function requireAdmin(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  let user;
  try { user = jwt.verify(token, process.env.JWT_SECRET); } catch { return res.status(401).json({ error: 'Invalid or expired token' }); }
  if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Wymagane konto administratora.' });
  req.user = user;
  next();
}

router.get('/database', requireAdmin, async (req, res) => {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const filename = `misinfo-research-backup-${stamp}.db`;
  // A per-request unique temp DIR (atomic via mkdtemp) rather than a stamped
  // filename: two downloads in the same wall-clock second from the same process
  // would otherwise resolve to the identical path and clobber each other's
  // in-progress snapshot. Clean up the whole dir when the response finishes.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'misinfo-backup-'));
  const tmp = path.join(dir, filename);
  const cleanup = () => fs.rm(dir, { recursive: true, force: true }, () => {});
  try {
    await db.backup(tmp); // consistent online snapshot, WAL included
    res.download(tmp, filename, (err) => {
      cleanup(); // best-effort cleanup regardless of outcome
      if (err && !res.headersSent) res.status(500).end();
    });
  } catch (e) {
    cleanup();
    console.error('[backup] failed:', e);
    if (!res.headersSent) res.status(500).json({ error: 'Nie udało się utworzyć kopii bazy.' });
  }
});

module.exports = router;
