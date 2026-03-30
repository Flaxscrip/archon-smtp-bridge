/**
 * Outbound SMTP Sender - sends DMail replies to external email addresses
 */

import { createTransport, Transporter } from 'nodemailer';

export interface OutboundMessage {
    to: string;           // External email address
    from: string;         // Bridge email address (e.g., bridge@archon.social)
    subject: string;
    body: string;
    inReplyTo?: string;   // Original Message-ID for threading
    references?: string;  // References header for threading
}

export interface OutboundSenderOptions {
    bridgeEmail: string;  // e.g., "bridge@archon.social"
    signature?: string;
}

const DEFAULT_SIGNATURE = `
---
Sent via Archon SMTP Bridge
https://archon.social`;

export class OutboundSender {
    private bridgeEmail: string;
    private signature: string;

    constructor(options: OutboundSenderOptions) {
        this.bridgeEmail = options.bridgeEmail;
        this.signature = options.signature || DEFAULT_SIGNATURE;
    }

    /**
     * Send an email to an external address via SMTP
     * Uses direct SMTP connection to recipient's MX server
     */
    async send(message: OutboundMessage): Promise<boolean> {
        try {
            // Extract domain from recipient
            const domain = message.to.split('@')[1];
            if (!domain) {
                console.error(`[Outbound] Invalid recipient address: ${message.to}`);
                return false;
            }

            // Create transporter for direct delivery
            // In production, you'd resolve MX records and connect directly
            // For now, we'll use a simple direct transport
            const transporter = createTransport({
                direct: true,
                name: 'archon.social'
            });

            // Build email with signature
            const bodyWithSignature = message.body + this.signature;

            const mailOptions = {
                from: this.bridgeEmail,
                to: message.to,
                subject: message.subject,
                text: bodyWithSignature,
                headers: {} as Record<string, string>
            };

            // Add threading headers if this is a reply
            if (message.inReplyTo) {
                mailOptions.headers['In-Reply-To'] = message.inReplyTo;
            }
            if (message.references) {
                mailOptions.headers['References'] = message.references;
            }

            console.log(`[Outbound] Sending email to ${message.to}`);
            console.log(`[Outbound] Subject: ${message.subject}`);

            const info = await transporter.sendMail(mailOptions);
            console.log(`[Outbound] Sent: ${info.messageId}`);
            
            return true;

        } catch (error) {
            console.error(`[Outbound] Failed to send:`, error);
            return false;
        }
    }
}
