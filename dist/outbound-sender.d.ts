/**
 * Outbound SMTP Sender - delivers DMail replies via email
 */
import type { ParsedReply } from './reply-poller.js';
import type { MessageStore } from './db/messages.js';
export interface OutboundSenderOptions {
    smtpHost: string;
    smtpPort: number;
    smtpUser?: string;
    smtpPass?: string;
    smtpSecure?: boolean;
    fromEmail: string;
    fromName?: string;
    messageStore: MessageStore;
}
export declare class OutboundSender {
    private transporter;
    private fromEmail;
    private fromName;
    private messageStore;
    private initialized;
    constructor(options: OutboundSenderOptions);
    /**
     * Verify SMTP connection
     */
    initialize(): Promise<void>;
    /**
     * Send a reply via SMTP
     */
    sendReply(reply: ParsedReply): Promise<string>;
    /**
     * Build email body with footer
     */
    private buildEmailBody;
    /**
     * Process pending outbound messages
     */
    processPending(): Promise<number>;
    /**
     * Close the transporter
     */
    close(): void;
}
//# sourceMappingURL=outbound-sender.d.ts.map