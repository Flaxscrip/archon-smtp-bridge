/**
 * Reply Poller - monitors bridge DMail inbox for replies to forwarded emails
 */

import Keymaster from '@didcid/keymaster';
import type { DmailMessage } from '@didcid/keymaster/types';
import { OutboundSender, OutboundMessage } from './outbound-sender.js';

// Bridge-specific DMail properties
export interface BridgeMetadata {
    'bridge:type': 'smtp-inbound';
    'bridge:originalSender': string;
    'bridge:originalMessageId'?: string;
    'bridge:smtpServer'?: string;
    'bridge:receivedAt': string;
}

export interface ReplyPollerOptions {
    keymaster: Keymaster;
    outboundSender: OutboundSender;
    pollIntervalMs?: number;
    bridgeDomain: string;
}

export class ReplyPoller {
    private keymaster: Keymaster;
    private outboundSender: OutboundSender;
    private pollIntervalMs: number;
    private bridgeDomain: string;
    private running = false;
    private pollTimer?: NodeJS.Timeout;

    constructor(options: ReplyPollerOptions) {
        this.keymaster = options.keymaster;
        this.outboundSender = options.outboundSender;
        this.pollIntervalMs = options.pollIntervalMs || 60000; // Default: 1 minute
        this.bridgeDomain = options.bridgeDomain;
    }

    /**
     * Start polling for replies
     */
    start(): void {
        if (this.running) return;
        
        this.running = true;
        console.log(`[ReplyPoller] Starting (interval: ${this.pollIntervalMs}ms)`);
        
        // Initial poll
        this.poll().catch(err => console.error('[ReplyPoller] Initial poll error:', err));
        
        // Schedule recurring polls
        this.pollTimer = setInterval(() => {
            this.poll().catch(err => console.error('[ReplyPoller] Poll error:', err));
        }, this.pollIntervalMs);
    }

    /**
     * Stop polling
     */
    stop(): void {
        if (!this.running) return;
        
        this.running = false;
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = undefined;
        }
        console.log('[ReplyPoller] Stopped');
    }

    /**
     * Poll for new replies
     */
    async poll(): Promise<void> {
        console.log('[ReplyPoller] Checking for replies...');
        
        try {
            // Refresh DMail inbox
            await this.keymaster.refreshDmail();
            
            // List unread DMails
            const dmails = await this.keymaster.listDmail();
            
            if (!dmails || dmails.length === 0) {
                console.log('[ReplyPoller] No DMails in inbox');
                return;
            }

            console.log(`[ReplyPoller] Found ${dmails.length} DMail(s)`);

            for (const dmailDid of dmails) {
                await this.processDmail(dmailDid);
            }

        } catch (error) {
            console.error('[ReplyPoller] Error during poll:', error);
        }
    }

    /**
     * Process a single DMail to check if it's a reply to a bridged message
     */
    private async processDmail(dmailDid: string): Promise<void> {
        try {
            // Get the DMail content
            const dmail = await this.keymaster.getDmailMessage(dmailDid);
            if (!dmail) {
                console.log(`[ReplyPoller] Could not read DMail: ${dmailDid}`);
                return;
            }

            // Check if this DMail has a reference (is a reply)
            if (!dmail.reference) {
                // Not a reply, ignore (regular DMail to bridge)
                console.log(`[ReplyPoller] Ignoring non-reply DMail: ${dmailDid}`);
                return;
            }

            // Get the referenced DMail to check if it's a bridged message
            const originalDid = dmail.reference;
            const bridgeMetadata = await this.getBridgeMetadata(originalDid);

            if (!bridgeMetadata) {
                // Referenced message is not a bridged email, ignore
                console.log(`[ReplyPoller] Referenced message is not bridged: ${originalDid}`);
                return;
            }

            // This is a reply to a bridged email - forward it!
            console.log(`[ReplyPoller] Found reply to bridged email`);
            console.log(`[ReplyPoller]   Original sender: ${bridgeMetadata['bridge:originalSender']}`);

            await this.forwardReply(dmail, bridgeMetadata, dmailDid);

        } catch (error) {
            console.error(`[ReplyPoller] Error processing DMail ${dmailDid}:`, error);
        }
    }

    /**
     * Get bridge metadata from a DMail's properties
     */
    private async getBridgeMetadata(dmailDid: string): Promise<BridgeMetadata | null> {
        try {
            const bridgeType = await this.keymaster.getProperty(dmailDid, 'bridge:type');
            
            if (bridgeType !== 'smtp-inbound') {
                return null;
            }

            const originalSender = await this.keymaster.getProperty(dmailDid, 'bridge:originalSender');
            const originalMessageId = await this.keymaster.getProperty(dmailDid, 'bridge:originalMessageId');
            const smtpServer = await this.keymaster.getProperty(dmailDid, 'bridge:smtpServer');
            const receivedAt = await this.keymaster.getProperty(dmailDid, 'bridge:receivedAt');

            return {
                'bridge:type': 'smtp-inbound',
                'bridge:originalSender': originalSender as string,
                'bridge:originalMessageId': originalMessageId as string | undefined,
                'bridge:smtpServer': smtpServer as string | undefined,
                'bridge:receivedAt': receivedAt as string
            };

        } catch (error) {
            return null;
        }
    }

    /**
     * Forward a reply to the original external sender
     */
    private async forwardReply(
        dmail: DmailMessage,
        bridgeMetadata: BridgeMetadata,
        dmailDid: string
    ): Promise<void> {
        const outboundMessage: OutboundMessage = {
            to: bridgeMetadata['bridge:originalSender'],
            from: `noreply@${this.bridgeDomain}`,
            subject: dmail.subject.startsWith('Re:') ? dmail.subject : `Re: ${dmail.subject}`,
            body: dmail.body,
            inReplyTo: bridgeMetadata['bridge:originalMessageId'],
            references: bridgeMetadata['bridge:originalMessageId']
        };

        const success = await this.outboundSender.send(outboundMessage);

        if (success) {
            console.log(`[ReplyPoller] Successfully forwarded reply to ${bridgeMetadata['bridge:originalSender']}`);
            
            // Mark as processed and archive
            await this.archiveDmail(dmailDid);
        } else {
            console.error(`[ReplyPoller] Failed to forward reply`);
        }
    }

    /**
     * Archive a processed DMail
     */
    private async archiveDmail(dmailDid: string): Promise<void> {
        try {
            // Tag as archived
            await this.keymaster.fileDmail(dmailDid, 'archived,bridge:processed');
            console.log(`[ReplyPoller] Archived DMail: ${dmailDid}`);
        } catch (error) {
            console.error(`[ReplyPoller] Failed to archive DMail:`, error);
        }
    }
}
