/**
 * Reply Poller - monitors bridge DID's inbox for replies
 *
 * When a DMail recipient wants to reply to a bridged email,
 * they send a DMail to the bridge DID with the reply token in subject.
 */
import type Keymaster from '@didcid/keymaster';
import type { MessageStore } from './db/messages.js';
export interface ReplyPollerOptions {
    keymaster: Keymaster;
    messageStore: MessageStore;
    bridgeDid: string;
    bridgeName: string;
    intervalMs?: number;
    onReply: (reply: ParsedReply) => Promise<void>;
}
export interface ParsedReply {
    dmailCid: string;
    fromDid: string;
    fromName: string | null;
    toEmail: string;
    subject: string;
    body: string;
    originalMessageId: number | null;
    threadId: string | null;
}
export declare class ReplyPoller {
    private keymaster;
    private messageStore;
    private bridgeDid;
    private bridgeName;
    private intervalMs;
    private onReply;
    private timer;
    private running;
    private processedDmails;
    constructor(options: ReplyPollerOptions);
    /**
     * Start polling for replies
     */
    start(): void;
    /**
     * Stop polling
     */
    stop(): void;
    /**
     * Poll for new replies
     */
    poll(): Promise<number>;
    /**
     * Parse a DMail to see if it's a reply to a bridged message
     * Checks DID properties first, then falls back to body/subject parsing
     */
    private parseDmailAsReply;
}
//# sourceMappingURL=reply-poller.d.ts.map