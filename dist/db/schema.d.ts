/**
 * SQLite Database Schema for SMTP-DMail Bridge
 * Using sql.js (pure JavaScript, no native deps)
 *
 * Tracks bidirectional messaging:
 * - Inbound: SMTP → DMail
 * - Outbound: DMail → SMTP (replies)
 */
import { type Database } from 'sql.js';
export interface MessageRecord {
    id: number;
    direction: 'inbound' | 'outbound';
    message_id: string;
    received_at: string;
    external_email: string;
    archon_did: string;
    archon_name: string | null;
    subject: string;
    body_preview: string;
    dmail_cid: string | null;
    notice_cid: string | null;
    thread_id: string | null;
    reply_to_id: number | null;
    reply_token: string | null;
    status: MessageStatus;
    error: string | null;
    retry_count: number;
    updated_at: string;
}
export type MessageStatus = 'received' | 'resolved' | 'sent' | 'delivered' | 'failed' | 'rejected';
export interface ThreadRecord {
    id: number;
    thread_id: string;
    external_email: string;
    archon_did: string;
    archon_name: string | null;
    created_at: string;
    last_activity: string;
    message_count: number;
}
export interface DbWrapper {
    db: Database;
    dbPath: string;
    save(): void;
    close(): void;
}
/**
 * Generate a short reply token (8 chars, URL-safe)
 */
export declare function generateReplyToken(): string;
/**
 * Generate a thread ID (UUID-like)
 */
export declare function generateThreadId(): string;
export declare function initDatabase(dbPath?: string): Promise<DbWrapper>;
//# sourceMappingURL=schema.d.ts.map