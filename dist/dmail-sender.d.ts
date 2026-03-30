/**
 * DMail Sender - creates and sends DMails via Keymaster
 */
import Keymaster from '@didcid/keymaster';
import type { EmailMessage } from './smtp-server.js';
import type { MessageStore } from './db/messages.js';
import type { MessageRecord } from './db/schema.js';
export interface DMailSenderOptions {
    walletPath?: string;
    walletDir?: string;
    passphrase?: string;
    gatekeeperUrl: string;
    messageStore?: MessageStore;
}
export interface DMailContent {
    to: string[];
    cc: string[];
    subject: string;
    body: string;
}
export declare class DMailSender {
    private keymaster;
    private options;
    private bridgeDid;
    private bridgeName;
    private initialized;
    private messageStore?;
    constructor(options: DMailSenderOptions);
    /**
     * Initialize the Keymaster connection
     */
    initialize(): Promise<void>;
    getBridgeDid(): string | null;
    getBridgeName(): string | null;
    getKeymaster(): Keymaster | null;
    isInitialized(): boolean;
    /**
     * Convert an email to DMail format
     * @param replyToken - Token for reply matching
     * @param useProperties - If true, omit reply instructions from body (stored in DID properties instead)
     */
    emailToDMail(email: EmailMessage, recipientDids: string[], replyToken?: string, useProperties?: boolean): DMailContent;
    /**
     * Set bridge metadata as DID properties on the DMail
     * Uses mergeData to add properties without replacing existing data
     */
    setBridgeProperties(dmailDid: string, metadata: {
        replyToken: string;
        originalSender: string;
        threadId?: string;
        bridgeDid: string;
    }): Promise<boolean>;
    /**
     * Send a DMail to recipients
     */
    sendDMail(content: DMailContent): Promise<{
        dmailDid: string;
        noticeDid: string;
    }>;
    /**
     * Process an email with full tracking
     * @param replyToken - Token for reply matching
     * @param threadId - Thread ID for conversation grouping
     */
    processEmail(email: EmailMessage, recipientDids: string[], record?: MessageRecord, replyToken?: string, threadId?: string): Promise<{
        dmailDid: string;
        noticeDid: string;
    } | null>;
}
//# sourceMappingURL=dmail-sender.d.ts.map