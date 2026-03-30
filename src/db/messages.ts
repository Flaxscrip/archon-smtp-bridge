/**
 * Message tracking operations for sql.js
 * Supports bidirectional messaging with thread tracking
 */

import type { Database } from 'sql.js';
import type { MessageRecord, MessageStatus, ThreadRecord, DbWrapper } from './schema.js';
import { generateReplyToken, generateThreadId } from './schema.js';

export class MessageStore {
    private db: Database;
    private wrapper: DbWrapper;
    private saveDebounce: ReturnType<typeof setTimeout> | null = null;

    constructor(wrapper: DbWrapper) {
        this.wrapper = wrapper;
        this.db = wrapper.db;
    }

    private scheduleSave(): void {
        if (this.saveDebounce) return;
        this.saveDebounce = setTimeout(() => {
            this.wrapper.save();
            this.saveDebounce = null;
        }, 1000);
    }

    flush(): void {
        if (this.saveDebounce) {
            clearTimeout(this.saveDebounce);
            this.saveDebounce = null;
        }
        this.wrapper.save();
    }

    // ─────────────────────────────────────────────────────────────
    // INBOUND: SMTP → DMail
    // ─────────────────────────────────────────────────────────────

    /**
     * Record an inbound email (SMTP → DMail)
     */
    createInbound(data: {
        messageId: string;
        externalEmail: string;
        archonName: string;
        subject: string;
        bodyPreview: string;
    }): MessageRecord {
        const now = new Date().toISOString();
        const replyToken = generateReplyToken();
        
        // Check for duplicate
        const existing = this.getByMessageId(data.messageId);
        if (existing) {
            console.log(`[DB] Duplicate message-id: ${data.messageId}`);
            return existing;
        }
        
        // Find or create thread
        const threadId = this.findOrCreateThread(data.externalEmail, data.archonName);
        
        this.db.run(`
            INSERT INTO messages (
                direction, message_id, received_at, external_email, archon_name,
                subject, body_preview, thread_id, reply_token, status, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            'inbound',
            data.messageId,
            now,
            data.externalEmail,
            data.archonName,
            data.subject,
            data.bodyPreview.slice(0, 500),
            threadId,
            replyToken,
            'received',
            now
        ]);
        
        const result = this.db.exec(`SELECT last_insert_rowid() as id`);
        const id = result[0]?.values[0]?.[0] as number;
        
        this.updateThreadActivity(threadId);
        this.scheduleSave();
        return this.getById(id)!;
    }

    /**
     * Mark inbound message as resolved (DID found)
     */
    markResolved(id: number, archonDid: string): void {
        this.db.run(`
            UPDATE messages SET archon_did = ?, status = 'resolved', updated_at = ?
            WHERE id = ?
        `, [archonDid, new Date().toISOString(), id]);
        this.scheduleSave();
    }

    /**
     * Mark inbound message as delivered (DMail sent)
     */
    markDelivered(id: number, data: {
        dmailCid: string;
        noticeCid: string;
    }): void {
        this.db.run(`
            UPDATE messages SET dmail_cid = ?, notice_cid = ?, status = 'sent', updated_at = ?
            WHERE id = ?
        `, [data.dmailCid, data.noticeCid, new Date().toISOString(), id]);
        this.scheduleSave();
    }

    // ─────────────────────────────────────────────────────────────
    // OUTBOUND: DMail → SMTP (replies)
    // ─────────────────────────────────────────────────────────────

    /**
     * Record an outbound reply (DMail → SMTP)
     */
    createOutbound(data: {
        dmailCid: string;
        archonDid: string;
        archonName: string | null;
        externalEmail: string;
        subject: string;
        bodyPreview: string;
        replyToId?: number;
        threadId?: string;
    }): MessageRecord {
        const now = new Date().toISOString();
        
        // Check for duplicate (by DMail CID)
        const existing = this.getByDmailCid(data.dmailCid);
        if (existing) {
            console.log(`[DB] Duplicate dmail_cid: ${data.dmailCid}`);
            return existing;
        }
        
        // Use provided thread or find/create one
        const threadId = data.threadId || this.findOrCreateThread(data.externalEmail, data.archonName);
        
        this.db.run(`
            INSERT INTO messages (
                direction, message_id, received_at, external_email, archon_did, archon_name,
                subject, body_preview, dmail_cid, thread_id, reply_to_id, status, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            'outbound',
            data.dmailCid,  // Use DMail CID as message_id for outbound
            now,
            data.externalEmail,
            data.archonDid,
            data.archonName,
            data.subject,
            data.bodyPreview.slice(0, 500),
            data.dmailCid,
            threadId,
            data.replyToId || null,
            'received',
            now
        ]);
        
        const result = this.db.exec(`SELECT last_insert_rowid() as id`);
        const id = result[0]?.values[0]?.[0] as number;
        
        this.updateThreadActivity(threadId);
        this.scheduleSave();
        return this.getById(id)!;
    }

    /**
     * Mark outbound message as sent via SMTP
     */
    markSmtpSent(id: number, smtpMessageId: string): void {
        this.db.run(`
            UPDATE messages SET status = 'sent', updated_at = ?
            WHERE id = ?
        `, [new Date().toISOString(), id]);
        this.scheduleSave();
    }

    // ─────────────────────────────────────────────────────────────
    // REPLY MATCHING
    // ─────────────────────────────────────────────────────────────

    /**
     * Find original inbound message by reply token
     */
    getByReplyToken(token: string): MessageRecord | undefined {
        const results = this.queryAll(
            'SELECT * FROM messages WHERE reply_token = ? AND direction = ?',
            [token, 'inbound']
        );
        return results[0];
    }

    /**
     * Find the most recent inbound message for a thread
     * Used when reply doesn't include explicit token
     */
    getLastInboundForThread(threadId: string): MessageRecord | undefined {
        const results = this.queryAll(`
            SELECT * FROM messages 
            WHERE thread_id = ? AND direction = 'inbound' AND status = 'sent'
            ORDER BY received_at DESC LIMIT 1
        `, [threadId]);
        return results[0];
    }

    /**
     * Find inbound message by recipient DID and subject match
     * Used for smart reply matching without explicit token
     */
    findByRecipientAndSubject(archonDid: string, subject: string): MessageRecord | undefined {
        // Normalize subject: remove Re:, Fwd:, [Email] prefix
        const normalizedSubject = subject
            .replace(/^(re|fwd|fw):\s*/gi, '')
            .replace(/^\[email\]\s*/gi, '')
            .trim()
            .toLowerCase();
        
        // Find recent inbound messages to this DID
        const results = this.queryAll(`
            SELECT * FROM messages 
            WHERE archon_did = ? AND direction = 'inbound' AND status = 'sent'
            ORDER BY received_at DESC LIMIT 20
        `, [archonDid]);
        
        // Match by normalized subject
        for (const msg of results) {
            const msgSubject = (msg.subject || '')
                .replace(/^(re|fwd|fw):\s*/gi, '')
                .replace(/^\[email\]\s*/gi, '')
                .trim()
                .toLowerCase();
            
            if (msgSubject === normalizedSubject) {
                return msg;
            }
        }
        
        return undefined;
    }

    /**
     * Find most recent inbound message to a specific DID
     * Fallback when subject doesn't match
     */
    findRecentByRecipient(archonDid: string): MessageRecord | undefined {
        const results = this.queryAll(`
            SELECT * FROM messages 
            WHERE archon_did = ? AND direction = 'inbound' AND status = 'sent'
            ORDER BY received_at DESC LIMIT 1
        `, [archonDid]);
        return results[0];
    }

    /**
     * Find thread by external email and archon name
     */
    findThread(externalEmail: string, archonName: string | null): ThreadRecord | undefined {
        const results = this.db.exec(`
            SELECT * FROM threads 
            WHERE external_email = ? AND (archon_name = ? OR (archon_name IS NULL AND ? IS NULL))
            LIMIT 1
        `, [externalEmail, archonName, archonName]);
        
        if (!results[0]?.values[0]) return undefined;
        
        const columns = results[0].columns;
        const row = results[0].values[0];
        const record: any = {};
        columns.forEach((col, i) => { record[col] = row[i]; });
        return record as ThreadRecord;
    }

    /**
     * Find or create a thread for a conversation pair
     */
    findOrCreateThread(externalEmail: string, archonName: string | null): string {
        const existing = this.findThread(externalEmail, archonName);
        if (existing) return existing.thread_id;
        
        const threadId = generateThreadId();
        const now = new Date().toISOString();
        
        this.db.run(`
            INSERT INTO threads (thread_id, external_email, archon_did, archon_name, created_at, last_activity, message_count)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [threadId, externalEmail, '', archonName, now, now, 0]);
        
        return threadId;
    }

    /**
     * Update thread activity timestamp and count
     */
    updateThreadActivity(threadId: string): void {
        this.db.run(`
            UPDATE threads SET 
                last_activity = ?,
                message_count = (SELECT COUNT(*) FROM messages WHERE thread_id = ?)
            WHERE thread_id = ?
        `, [new Date().toISOString(), threadId, threadId]);
    }

    // ─────────────────────────────────────────────────────────────
    // COMMON OPERATIONS
    // ─────────────────────────────────────────────────────────────

    updateStatus(id: number, status: MessageStatus, error?: string): void {
        this.db.run(`
            UPDATE messages SET status = ?, error = ?, updated_at = ?
            WHERE id = ?
        `, [status, error || null, new Date().toISOString(), id]);
        this.scheduleSave();
    }

    markFailed(id: number, error: string): void {
        this.updateStatus(id, 'failed', error);
    }

    markRejected(id: number, reason: string): void {
        this.updateStatus(id, 'rejected', reason);
    }

    incrementRetry(id: number): void {
        this.db.run(`
            UPDATE messages SET retry_count = retry_count + 1, updated_at = ?
            WHERE id = ?
        `, [new Date().toISOString(), id]);
        this.scheduleSave();
    }

    private queryAll(sql: string, params: any[] = []): MessageRecord[] {
        const result = this.db.exec(sql, params);
        if (!result[0]) return [];
        
        const columns = result[0].columns;
        return result[0].values.map(row => {
            const record: any = {};
            columns.forEach((col, i) => { record[col] = row[i]; });
            return record as MessageRecord;
        });
    }

    getById(id: number): MessageRecord | undefined {
        const results = this.queryAll('SELECT * FROM messages WHERE id = ?', [id]);
        return results[0];
    }

    getByMessageId(messageId: string): MessageRecord | undefined {
        const results = this.queryAll('SELECT * FROM messages WHERE message_id = ?', [messageId]);
        return results[0];
    }

    getByDmailCid(dmailCid: string): MessageRecord | undefined {
        const results = this.queryAll('SELECT * FROM messages WHERE dmail_cid = ?', [dmailCid]);
        return results[0];
    }

    getByStatus(status: MessageStatus, limit: number = 100): MessageRecord[] {
        return this.queryAll(
            'SELECT * FROM messages WHERE status = ? ORDER BY received_at DESC LIMIT ?',
            [status, limit]
        );
    }

    getRecent(limit: number = 50): MessageRecord[] {
        return this.queryAll(
            'SELECT * FROM messages ORDER BY received_at DESC LIMIT ?',
            [limit]
        );
    }

    getRetryable(maxRetries: number = 3, limit: number = 10): MessageRecord[] {
        return this.queryAll(`
            SELECT * FROM messages 
            WHERE status = 'failed' AND retry_count < ? 
            ORDER BY updated_at ASC LIMIT ?
        `, [maxRetries, limit]);
    }

    /**
     * Get pending outbound messages (replies to send via SMTP)
     */
    getPendingOutbound(limit: number = 10): MessageRecord[] {
        return this.queryAll(`
            SELECT * FROM messages 
            WHERE direction = 'outbound' AND status IN ('received', 'resolved')
            ORDER BY received_at ASC LIMIT ?
        `, [limit]);
    }

    getStats(): Record<string, number> {
        const result: Record<string, number> = {};
        
        const statusResults = this.db.exec(`
            SELECT direction, status, COUNT(*) as count FROM messages GROUP BY direction, status
        `);
        
        if (statusResults[0]) {
            for (const row of statusResults[0].values) {
                const key = `${row[0]}_${row[1]}`;
                result[key] = row[2] as number;
            }
        }
        
        const totalResult = this.db.exec('SELECT COUNT(*) as count FROM messages');
        result.total = (totalResult[0]?.values[0]?.[0] as number) || 0;
        
        const threadResult = this.db.exec('SELECT COUNT(*) as count FROM threads');
        result.threads = (threadResult[0]?.values[0]?.[0] as number) || 0;
        
        return result;
    }
}
