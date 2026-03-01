/**
 * Tests for PostgresDriver utilities — placeholder translation, etc.
 * These tests don't require a running PostgreSQL instance.
 */
import { describe, it, expect } from 'vitest';
import { translatePlaceholders } from '../src/db/index.js';

describe('translatePlaceholders', () => {
  it('replaces single ? with $1', () => {
    expect(translatePlaceholders('SELECT * FROM bots WHERE id = ?'))
      .toBe('SELECT * FROM bots WHERE id = $1');
  });

  it('replaces multiple ? with sequential $N', () => {
    expect(translatePlaceholders('INSERT INTO orgs (id, name) VALUES (?, ?)'))
      .toBe('INSERT INTO orgs (id, name) VALUES ($1, $2)');
  });

  it('handles complex query with many placeholders', () => {
    const sql = 'UPDATE threads SET status = ?, close_reason = ?, updated_at = ? WHERE id = ? AND revision = ?';
    expect(translatePlaceholders(sql))
      .toBe('UPDATE threads SET status = $1, close_reason = $2, updated_at = $3 WHERE id = $4 AND revision = $5');
  });

  it('does not replace ? inside single-quoted strings', () => {
    expect(translatePlaceholders("SELECT * FROM bots WHERE name = '?what' AND id = ?"))
      .toBe("SELECT * FROM bots WHERE name = '?what' AND id = $1");
  });

  it('handles escaped single quotes in strings', () => {
    expect(translatePlaceholders("SELECT * FROM t WHERE name = 'it''s?' AND id = ?"))
      .toBe("SELECT * FROM t WHERE name = 'it''s?' AND id = $1");
  });

  it('handles CHECK constraints with IN clause (no replacement)', () => {
    const sql = "CHECK(status IN ('active', 'blocked', 'closed'))";
    expect(translatePlaceholders(sql))
      .toBe("CHECK(status IN ('active', 'blocked', 'closed'))");
  });

  it('handles query with no placeholders', () => {
    expect(translatePlaceholders('SELECT 1')).toBe('SELECT 1');
  });

  it('handles DELETE with subquery', () => {
    const sql = 'DELETE FROM events WHERE id IN (SELECT id FROM events WHERE created_at < ? LIMIT ?)';
    expect(translatePlaceholders(sql))
      .toBe('DELETE FROM events WHERE id IN (SELECT id FROM events WHERE created_at < $1 LIMIT $2)');
  });

  it('handles multiline SQL', () => {
    const sql = `
      SELECT * FROM threads
      WHERE org_id = ? AND status = ?
      ORDER BY created_at DESC
      LIMIT ?
    `;
    const result = translatePlaceholders(sql);
    expect(result).toContain('org_id = $1');
    expect(result).toContain('status = $2');
    expect(result).toContain('LIMIT $3');
  });

  // Corpus test: all rowid-based cleanup query patterns from db.ts
  it('handles batched delete pattern (bot_tokens)', () => {
    const sql = 'DELETE FROM bot_tokens WHERE id IN (SELECT id FROM bot_tokens WHERE expires_at IS NOT NULL AND expires_at < ? LIMIT ?)';
    expect(translatePlaceholders(sql))
      .toBe('DELETE FROM bot_tokens WHERE id IN (SELECT id FROM bot_tokens WHERE expires_at IS NOT NULL AND expires_at < $1 LIMIT $2)');
  });

  it('handles batched delete with JOIN (messages)', () => {
    const sql = `DELETE FROM messages WHERE id IN (
      SELECT messages.id FROM messages
      JOIN channels ON channels.id = messages.channel_id
      WHERE channels.org_id = ? AND messages.created_at < ?
      LIMIT ?
    )`;
    const result = translatePlaceholders(sql);
    expect(result).toContain('channels.org_id = $1');
    expect(result).toContain('messages.created_at < $2');
    expect(result).toContain('LIMIT $3');
  });

  it('handles UPDATE with subquery (auto-close threads)', () => {
    const sql = `UPDATE threads SET status = 'closed', close_reason = 'timeout', updated_at = ?, last_activity_at = ?, revision = revision + 1
      WHERE id IN (
        SELECT id FROM threads
        WHERE org_id = ? AND last_activity_at < ? AND status NOT IN ('resolved', 'closed')
        LIMIT ?
      )`;
    const result = translatePlaceholders(sql);
    expect(result).toContain('updated_at = $1');
    expect(result).toContain('last_activity_at = $2');
    expect(result).toContain('org_id = $3');
    expect(result).toContain('last_activity_at < $4');
    expect(result).toContain('LIMIT $5');
    // Verify string literals are not touched
    expect(result).toContain("'closed'");
    expect(result).toContain("'timeout'");
    expect(result).toContain("'resolved'");
  });

  it('handles ON CONFLICT upsert with arithmetic', () => {
    const sql = `INSERT INTO webhook_status (bot_id, last_failure, consecutive_failures, degraded)
      VALUES (?, ?, 0, 0)
      ON CONFLICT(bot_id) DO UPDATE SET
        last_failure = ?,
        consecutive_failures = consecutive_failures + 1,
        degraded = CASE WHEN consecutive_failures + 1 >= 10 THEN 1 ELSE degraded END`;
    const result = translatePlaceholders(sql);
    expect(result).toContain('VALUES ($1, $2, 0, 0)');
    expect(result).toContain('last_failure = $3');
  });
});
