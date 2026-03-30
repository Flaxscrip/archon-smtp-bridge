/**
 * Message tracking operations for sql.js
 * Supports bidirectional messaging with thread tracking
 */
import type { MessageRecord, MessageStatus, ThreadRecord, DbWrapper } from './schema.js';
export declare class MessageStore {
    private db;
    private wrapper;
    private saveDebounce;
    constructor(wrapper: DbWrapper);
    private scheduleSave;
    flush(): void;
    /**
     * Record an inbound email (SMTP → DMail)
     */
    createInbound(data: {
        messageId: string;
        externalEmail: string;
        archonName: string;
        subject: string;
        bodyPreview: string;
    }): MessageRecord;
    /**
     * Mark inbound message as resolved (DID found)
     */
    markResolved(id: number, archonDid: string): void;
    /**
     * Mark inbound message as delivered (DMail sent)
     */
    markDelivered(id: number, data: {
        dmailCid: string;
        noticeCid: string;
    }): void;
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
    }): MessageRecord;
    /**
     * Mark outbound message as sent via SMTP
     */
    markSmtpSent(id: number, smtpMessageId: string): void;
    /**
     * Find original inbound message by reply token
     */
    getByReplyToken(token: string): MessageRecord | undefined;
    /**
     * Find the most recent inbound message for a thread
     * Used when reply doesn't include explicit token
     */
    getLastInboundForThread(threadId: string): MessageRecord | undefined;
    /**
     * Find thread by external email and archon name
     */
    findThread(externalEmail: string, archonName: string | null): ThreadRecord | undefined;
    /**
     * Find or create a thread for a conversation pair
     */
    findOrCreateThread(externalEmail: string, archonName: string | null): string;
    /**
     * Update thread activity timestamp and count
     */
    updateThreadActivity(threadId: string): void;
    updateStatus(id: number, status: MessageStatus, error?: string): void;
    markFailed(id: number, error: string): void;
    markRejected(id: number, reason: string): void;
    incrementRetry(id: number): void;
    private queryAll;
    getById(id: number): MessageRecord | undefined;
    getByMessageId(messageId: string): MessageRecord | undefined;
    getByDmailCid(dmailCid: string): MessageRecord | undefined;
    getByStatus(status: MessageStatus, limit?: number): MessageRecord[];
    getRecent(limit?: number): MessageRecord[];
    getRetryable(maxRetries?: number, limit?: number): MessageRecord[];
    /**
     * Get pending outbound messages (replies to send via SMTP)
     */
    getPendingOutbound(limit?: number): MessageRecord[];
    getStats(): Record<string, number>;
}
//# sourceMappingURL=messages.d.ts.map