/**
 * DMail Sender - creates and sends DMails via Keymaster
 */

import Keymaster from '@didcid/keymaster';
import { GatekeeperClient } from '@didcid/gatekeeper';
import WalletJson from '@didcid/keymaster/wallet/json';
import CipherNode from '@didcid/cipher/node';
import type { DmailMessage } from '@didcid/keymaster/types';
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

export class DMailSender {
    private keymaster: Keymaster | null = null;
    private options: DMailSenderOptions;
    private bridgeDid: string | null = null;
    private bridgeName: string | null = null;
    private initialized = false;
    private messageStore?: MessageStore;

    constructor(options: DMailSenderOptions) {
        this.options = options;
        this.messageStore = options.messageStore;
    }

    /**
     * Initialize the Keymaster connection
     */
    async initialize(): Promise<void> {
        if (this.initialized) return;

        const { gatekeeperUrl, passphrase, walletPath, walletDir } = this.options;

        if (!passphrase) {
            throw new Error('ARCHON_PASSPHRASE is required');
        }

        // Connect to Gatekeeper
        const gatekeeper = new GatekeeperClient();
        await gatekeeper.connect({
            url: gatekeeperUrl,
            waitUntilReady: true,
            intervalSeconds: 5,
            chatty: false,
        });
        console.log(`[DMail] Connected to Gatekeeper at ${gatekeeperUrl}`);

        // Initialize wallet
        const walletFile = walletPath || 'wallet.json';
        const walletDirectory = walletDir || './data';
        const wallet = new WalletJson(walletFile, walletDirectory);
        
        // Initialize cipher
        const cipher = new CipherNode();

        // Create Keymaster instance
        this.keymaster = new Keymaster({
            gatekeeper,
            wallet,
            cipher,
            passphrase,
        });

        // Load existing wallet
        await this.keymaster.loadWallet();

        // Get current DID
        const currentId = await this.keymaster.getCurrentId();
        if (currentId) {
            const idInfo = await this.keymaster.fetchIdInfo(currentId);
            this.bridgeDid = idInfo.did;
            this.bridgeName = currentId;
            console.log(`[DMail] Using identity: ${currentId}`);
            console.log(`[DMail] Bridge DID: ${this.bridgeDid}`);
        } else {
            throw new Error('No identity in wallet. Create one with: keymaster create-id smtp-bridge');
        }

        this.initialized = true;
    }

    getBridgeDid(): string | null {
        return this.bridgeDid;
    }

    getBridgeName(): string | null {
        return this.bridgeName;
    }

    getKeymaster(): Keymaster | null {
        return this.keymaster;
    }

    isInitialized(): boolean {
        return this.initialized;
    }

    /**
     * Convert an email to DMail format
     * @param replyToken - Token for reply matching
     * @param useProperties - If true, omit reply instructions from body (stored in DID properties instead)
     */
    emailToDMail(email: EmailMessage, recipientDids: string[], replyToken?: string, useProperties = false): DMailContent {
        const bodyParts: string[] = [];
        
        bodyParts.push(email.text || '(no text content)');
        
        // Metadata footer
        bodyParts.push('');
        bodyParts.push('---');
        bodyParts.push(`📧 Received via SMTP Bridge`);
        bodyParts.push(`From: ${email.from}`);
        bodyParts.push(`Date: ${email.date.toISOString()}`);
        if (email.messageId) {
            bodyParts.push(`Message-ID: ${email.messageId}`);
        }
        
        // Reply instructions (only if not using properties)
        if (replyToken && this.bridgeName && !useProperties) {
            bodyParts.push('');
            bodyParts.push(`💬 To reply: Send DMail to "${this.bridgeName}" with [REPLY:${replyToken}] in subject`);
        }

        return {
            to: recipientDids,
            cc: [],
            subject: `[Email] ${email.subject}`,
            body: bodyParts.join('\n')
        };
    }

    /**
     * Set bridge metadata as DID properties on the DMail
     * Uses mergeData to add properties without replacing existing data
     */
    async setBridgeProperties(dmailDid: string, metadata: {
        replyToken: string;
        originalSender: string;
        threadId?: string;
        bridgeDid: string;
    }): Promise<boolean> {
        if (!this.keymaster) return false;
        
        try {
            const data: Record<string, unknown> = {
                'bridge:reply-token': metadata.replyToken,
                'bridge:original-sender': metadata.originalSender,
                'bridge:did': metadata.bridgeDid,
            };
            
            if (metadata.threadId) {
                data['bridge:thread-id'] = metadata.threadId;
            }
            
            await this.keymaster.mergeData(dmailDid, data);
            console.log(`[DMail] Set bridge properties on ${dmailDid}`);
            return true;
        } catch (error) {
            console.log(`[DMail] Could not set properties (asset properties may not be enabled):`, 
                error instanceof Error ? error.message : String(error));
            return false;
        }
    }

    /**
     * Send a DMail to recipients
     */
    async sendDMail(content: DMailContent): Promise<{ dmailDid: string; noticeDid: string }> {
        if (!this.keymaster || !this.initialized) {
            throw new Error('DMailSender not initialized');
        }
        
        const message: DmailMessage = {
            to: content.to,
            cc: content.cc,
            subject: content.subject,
            body: content.body
        };
        
        console.log(`[DMail] Creating DMail to: ${content.to.join(', ')}`);
        console.log(`[DMail] Subject: ${content.subject}`);
        
        // Create the DMail asset
        const dmailDid = await this.keymaster.createDmail(message);
        console.log(`[DMail] Created DMail: ${dmailDid}`);
        
        // Send the DMail (creates notice)
        const noticeDid = await this.keymaster.sendDmail(dmailDid);
        
        if (!noticeDid) {
            throw new Error('sendDmail returned null');
        }
        
        console.log(`[DMail] Sent notice: ${noticeDid}`);
        
        return { dmailDid, noticeDid };
    }

    /**
     * Process an email with full tracking
     * @param replyToken - Token for reply matching
     * @param threadId - Thread ID for conversation grouping
     */
    async processEmail(
        email: EmailMessage, 
        recipientDids: string[],
        record?: MessageRecord,
        replyToken?: string,
        threadId?: string
    ): Promise<{ dmailDid: string; noticeDid: string } | null> {
        if (recipientDids.length === 0) {
            console.log('[DMail] No valid recipients, skipping');
            if (record && this.messageStore) {
                this.messageStore.markRejected(record.id, 'No valid recipients');
            }
            return null;
        }

        // First, create DMail without reply instructions in body
        // We'll try to set them as properties instead
        const dmailContent = this.emailToDMail(email, recipientDids, replyToken, true);
        
        try {
            const result = await this.sendDMail(dmailContent);
            
            // Try to set bridge properties on the DMail DID
            let propertiesSet = false;
            if (replyToken && this.bridgeDid) {
                propertiesSet = await this.setBridgeProperties(result.dmailDid, {
                    replyToken,
                    originalSender: email.from,
                    threadId,
                    bridgeDid: this.bridgeDid
                });
            }
            
            // If properties failed, we need to update the DMail body with fallback instructions
            if (!propertiesSet && replyToken && this.bridgeName) {
                console.log('[DMail] Falling back to body-based reply token');
                // Update the DMail with reply instructions in body
                const fallbackContent = this.emailToDMail(email, recipientDids, replyToken, false);
                try {
                    await this.keymaster?.updateDmail(result.dmailDid, {
                        to: fallbackContent.to,
                        cc: fallbackContent.cc,
                        subject: fallbackContent.subject,
                        body: fallbackContent.body
                    });
                } catch (updateErr) {
                    console.log('[DMail] Could not update DMail body, reply token in properties only');
                }
            }
            
            // Update tracking record
            if (record && this.messageStore) {
                this.messageStore.markDelivered(record.id, {
                    dmailCid: result.dmailDid,
                    noticeCid: result.noticeDid
                });
            }
            
            console.log(`[DMail] ✅ Successfully bridged email`);
            console.log(`[DMail]   From: ${email.from}`);
            console.log(`[DMail]   To: ${recipientDids.join(', ')}`);
            console.log(`[DMail]   DMail: ${result.dmailDid}`);
            console.log(`[DMail]   Properties: ${propertiesSet ? 'YES' : 'NO (fallback to body)'}`);
            
            return result;
            
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            console.error('[DMail] Failed to send DMail:', errMsg);
            
            if (record && this.messageStore) {
                this.messageStore.markFailed(record.id, errMsg);
            }
            
            throw error;
        }
    }
}
