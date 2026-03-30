/**
 * Outbound SMTP Sender - delivers DMail replies via email
 */

import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type { ParsedReply } from './reply-poller.js';
import type { MessageStore } from './db/messages.js';

export interface OutboundSenderOptions {
    // SMTP configuration
    smtpHost: string;
    smtpPort: number;
    smtpUser?: string;
    smtpPass?: string;
    smtpSecure?: boolean;     // true for 465, false for other ports
    
    // Sender identity
    fromEmail: string;        // e.g., "noreply@archon.social"
    fromName?: string;        // e.g., "Archon Bridge"
    
    // Tracking
    messageStore: MessageStore;
}

export class OutboundSender {
    private transporter: Transporter;
    private fromEmail: string;
    private fromName: string;
    private messageStore: MessageStore;
    private initialized = false;

    constructor(options: OutboundSenderOptions) {
        this.fromEmail = options.fromEmail;
        this.fromName = options.fromName || 'Archon Bridge';
        this.messageStore = options.messageStore;
        
        // Create nodemailer transporter
        this.transporter = nodemailer.createTransport({
            host: options.smtpHost,
            port: options.smtpPort,
            secure: options.smtpSecure ?? (options.smtpPort === 465),
            auth: options.smtpUser ? {
                user: options.smtpUser,
                pass: options.smtpPass
            } : undefined,
            // For local/dev testing without auth
            ignoreTLS: !options.smtpUser,
        });
    }

    /**
     * Verify SMTP connection
     */
    async initialize(): Promise<void> {
        if (this.initialized) return;
        
        try {
            await this.transporter.verify();
            console.log('[Outbound] SMTP connection verified');
            this.initialized = true;
        } catch (error) {
            console.error('[Outbound] SMTP connection failed:', error);
            throw error;
        }
    }

    /**
     * Send a reply via SMTP
     */
    async sendReply(reply: ParsedReply): Promise<string> {
        // Create tracking record
        const record = this.messageStore.createOutbound({
            dmailCid: reply.dmailCid,
            archonDid: reply.fromDid,
            archonName: reply.fromName,
            externalEmail: reply.toEmail,
            subject: reply.subject,
            bodyPreview: reply.body,
            replyToId: reply.originalMessageId || undefined,
            threadId: reply.threadId || undefined
        });
        
        try {
            // Build email
            const senderDisplay = reply.fromName 
                ? `${reply.fromName} via Archon <${this.fromEmail}>`
                : `Archon User <${this.fromEmail}>`;
            
            // Build body with metadata
            const body = this.buildEmailBody(reply);
            
            // Send email
            const info = await this.transporter.sendMail({
                from: senderDisplay,
                to: reply.toEmail,
                subject: reply.subject,
                text: body,
                headers: {
                    'X-Archon-Bridge': 'true',
                    'X-Archon-DID': reply.fromDid,
                    'X-Archon-DMail': reply.dmailCid,
                },
                // Add Reply-To so responses come back to the bridge
                replyTo: `${reply.fromName || 'user'}@archon.social`
            });
            
            console.log(`[Outbound] Sent email to ${reply.toEmail}`);
            console.log(`[Outbound]   Message-ID: ${info.messageId}`);
            console.log(`[Outbound]   From: ${reply.fromDid}`);
            
            // Update tracking
            this.messageStore.markSmtpSent(record.id, info.messageId);
            
            return info.messageId;
            
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            console.error(`[Outbound] Failed to send to ${reply.toEmail}:`, errMsg);
            
            this.messageStore.markFailed(record.id, errMsg);
            throw error;
        }
    }

    /**
     * Build email body with footer
     */
    private buildEmailBody(reply: ParsedReply): string {
        const parts: string[] = [];
        
        // Main content
        parts.push(reply.body);
        
        // Footer
        parts.push('');
        parts.push('---');
        parts.push(`📬 Sent via Archon DMail Bridge`);
        parts.push(`From: ${reply.fromName || 'Archon User'} (${reply.fromDid})`);
        parts.push(`DMail: ${reply.dmailCid}`);
        parts.push('');
        parts.push('To reply, simply respond to this email.');
        
        return parts.join('\n');
    }

    /**
     * Process pending outbound messages
     */
    async processPending(): Promise<number> {
        const pending = this.messageStore.getPendingOutbound(10);
        let sent = 0;
        
        for (const msg of pending) {
            // This would need the full DMail content, which we'd need to fetch
            // For now, outbound messages are created by the reply poller with full content
            console.log(`[Outbound] Pending message ${msg.id} - needs content`);
        }
        
        return sent;
    }

    /**
     * Close the transporter
     */
    close(): void {
        this.transporter.close();
    }
}
