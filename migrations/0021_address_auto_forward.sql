-- Optional auto-forward target per address. When set, every new inbound email
-- on that address is also re-sent to this address, in the same shape as the
-- manual forward (Fwd: subject, forwarded-message block, attachments).
ALTER TABLE addresses ADD COLUMN forward_to TEXT;

-- One row per auto-forward attempt, unique per email: the INSERT OR IGNORE
-- that claims a forward is the idempotency guard for webhook retries, and the
-- status/error columns are what the thread view shows on the message.
CREATE TABLE auto_forwards (
	id TEXT PRIMARY KEY,
	email_id TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
	address_id TEXT REFERENCES addresses(id) ON DELETE SET NULL,
	target TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'skipped')),
	error TEXT,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_auto_forwards_email ON auto_forwards(email_id);
