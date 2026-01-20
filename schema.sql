-- FeedPulse Database Schema
-- D1 uses SQLite syntax

CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL CHECK (source IN ('twitter', 'discord', 'github', 'support')),
    content TEXT NOT NULL,
    sentiment TEXT NOT NULL CHECK (sentiment IN ('positive', 'negative', 'neutral')),
    category TEXT NOT NULL CHECK (category IN ('bug', 'feature', 'praise', 'complaint')),
    priority INTEGER NOT NULL CHECK (priority >= 1 AND priority <= 5),
    created_at TEXT DEFAULT (datetime('now')),
    themes TEXT DEFAULT '[]',
    addressed INTEGER DEFAULT 0,
    addressed_at TEXT DEFAULT NULL
);

-- Index for common queries
CREATE INDEX IF NOT EXISTS idx_feedback_source ON feedback(source);
CREATE INDEX IF NOT EXISTS idx_feedback_sentiment ON feedback(sentiment);
CREATE INDEX IF NOT EXISTS idx_feedback_category ON feedback(category);
CREATE INDEX IF NOT EXISTS idx_feedback_priority ON feedback(priority);
CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback(created_at);
