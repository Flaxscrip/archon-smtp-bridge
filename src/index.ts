#!/usr/bin/env node
/**
 * SMTP-to-DMail Bridge v0.3.0
 * 
 * Bidirectional email bridge:
 * - Inbound: SMTP → DMail (external emails to Archon users)
 * - Outbound: DMail → SMTP (replies back to external senders)
 * 
 * With SQLite tracking for reliability and conversation threading.
 */

import dotenv from 'dotenv';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

// Load .env and override existing env vars
const envConfig = dotenv.config();
if (envConfig.parsed) {
    Object.assign(process.env, envConfig.parsed);
}

import { createSMTPServer, startSMTPServer, type EmailMessage } from './smtp-server.js';
import { NameResolver } from './name-resolver.js';
import { DMailSender } from './dmail-sender.js';
import { ReplyPoller, type ParsedReply } from './reply-poller.js';
import { OutboundSender } from './outbound-sender.js';
import { initDatabase, type DbWrapper } from './db/schema.js';
import { MessageStore } from './db/messages.js';

// Configuration
const config = {
    smtp: {
        port: parseInt(process.env.SMTP_PORT || '2525', 10),
        domain: process.env.SMTP_DOMAIN || 'archon.social',
    },
    archon: {
        socialApi: process.env.ARCHON_SOCIAL_API || 'https://archon.social',
        gatekeeperUrl: process.env.GATEKEEPER_URL || 'https://archon.technology/api/v1',
    },
    wallet: {
        path: process.env.WALLET_PATH || 'wallet.json',
        dir: process.env.WALLET_DIR || './data',
        passphrase: process.env.ARCHON_PASSPHRASE,
    },
    db: {
        path: process.env.DB_PATH || './data/bridge.db',
    },
    outbound: {
        enabled: process.env.SMTP_OUT_ENABLED !== 'false',
        host: process.env.SMTP_OUT_HOST || 'localhost',
        port: parseInt(process.env.SMTP_OUT_PORT || '25', 10),
        user: process.env.SMTP_OUT_USER,
        pass: process.env.SMTP_OUT_PASS,
        secure: process.env.SMTP_OUT_SECURE === 'true',
        fromEmail: process.env.SMTP_OUT_FROM || `bridge@${process.env.SMTP_DOMAIN || 'archon.social'}`,
        fromName: process.env.SMTP_OUT_NAME || 'Archon Bridge',
    },
    poller: {
        enabled: process.env.REPLY_POLLER_ENABLED !== 'false',
        intervalMs: parseInt(process.env.REPLY_POLL_INTERVAL_MS || '60000', 10),
    },
    limits: {
        maxEmailSize: parseInt(process.env.MAX_EMAIL_SIZE_BYTES || '10485760', 10),
        maxRetries: parseInt(process.env.MAX_RETRIES || '3', 10),
    },
};

// Global services
let resolver: NameResolver;
let dmailSender: DMailSender;
let messageStore: MessageStore;
let dbWrapper: DbWrapper;
let replyPoller: ReplyPoller | null = null;
let outboundSender: OutboundSender | null = null;
let dryRunMode = false;

/**
 * Generate a message ID if none provided
 */
function generateMessageId(email: EmailMessage): string {
    if (email.messageId) return email.messageId;
    const hash = Buffer.from(`${email.from}:${email.date.toISOString()}:${email.subject}`)
        .toString('base64')
        .slice(0, 20);
    return `<bridge-${hash}@${config.smtp.domain}>`;
}

/**
 * Handle incoming SMTP email
 */
async function handleEmail(email: EmailMessage): Promise<void> {
    const messageId = generateMessageId(email);
    
    console.log(`\n${'='.repeat(60)}`);
    console.log(`[Bridge] Processing inbound email`);
    console.log(`[Bridge]   From: ${email.from}`);
    console.log(`[Bridge]   To: ${email.to.join(', ')}`);
    console.log(`[Bridge]   Subject: ${email.subject}`);
    console.log(`[Bridge]   Message-ID: ${messageId}`);

    // Process each recipient separately
    for (const recipient of email.to) {
        await processInbound(email, recipient, messageId);
    }
    
    console.log(`${'='.repeat(60)}\n`);
}

/**
 * Process inbound email for a single recipient
 */
async function processInbound(email: EmailMessage, recipient: string, messageId: string): Promise<void> {
    // Extract name from email address
    const name = resolver.extractName(recipient, config.smtp.domain);
    
    if (!name) {
        console.log(`[Bridge] Invalid recipient format: ${recipient}`);
        return;
    }
    
    // Create tracking record (generates reply token)
    const record = messageStore.createInbound({
        messageId: `${messageId}:${recipient}`,
        externalEmail: email.from,
        archonName: name,
        subject: email.subject,
        bodyPreview: email.text || ''
    });
    
    // Check for duplicate
    if (record.status !== 'received') {
        console.log(`[Bridge] Duplicate detected for ${recipient}, skipping`);
        return;
    }
    
    // Resolve recipient to DID
    const did = await resolver.resolve(name);
    
    if (!did) {
        console.log(`[Bridge] Could not resolve: ${name}`);
        messageStore.markRejected(record.id, `Name not found: ${name}`);
        return;
    }
    
    console.log(`[Bridge] Resolved ${name} → ${did}`);
    messageStore.markResolved(record.id, did);
    
    // Check dry-run mode
    if (dryRunMode) {
        console.log(`[Bridge] DRY-RUN: Would send DMail to ${did}`);
        messageStore.updateStatus(record.id, 'sent', 'Dry-run mode');
        return;
    }
    
    // Send as DMail (include reply token and thread ID for threading)
    try {
        const result = await dmailSender.processEmail(
            email, 
            [did], 
            record,
            record.reply_token || undefined,
            record.thread_id || undefined
        );
        
        if (result) {
            messageStore.markDelivered(record.id, {
                dmailCid: result.dmailDid,
                noticeCid: result.noticeDid
            });
        }
    } catch (error) {
        // Error logged in processEmail
    }
}

/**
 * Handle outbound reply (DMail → SMTP)
 */
async function handleReply(reply: ParsedReply): Promise<void> {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`[Bridge] Processing outbound reply`);
    console.log(`[Bridge]   From: ${reply.fromName || reply.fromDid}`);
    console.log(`[Bridge]   To: ${reply.toEmail}`);
    console.log(`[Bridge]   Subject: ${reply.subject}`);
    
    if (!outboundSender) {
        console.log(`[Bridge] Outbound SMTP not configured, cannot send reply`);
        return;
    }
    
    try {
        const msgId = await outboundSender.sendReply(reply);
        console.log(`[Bridge] ✅ Reply sent: ${msgId}`);
    } catch (error) {
        console.error(`[Bridge] Failed to send reply:`, error);
    }
    
    console.log(`${'='.repeat(60)}\n`);
}

/**
 * Retry failed messages
 */
async function retryFailed(): Promise<number> {
    const retryable = messageStore.getRetryable(config.limits.maxRetries, 10);
    if (retryable.length === 0) return 0;
    
    console.log(`[Bridge] Retrying ${retryable.length} failed messages...`);
    let successCount = 0;
    
    for (const record of retryable) {
        if (record.direction === 'inbound') {
            // Retry inbound
            messageStore.incrementRetry(record.id);
            
            const name = record.archon_name;
            if (!name) continue;
            
            const did = await resolver.resolve(name);
            if (!did) continue;
            
            const email: EmailMessage = {
                from: record.external_email,
                to: [`${name}@${config.smtp.domain}`],
                subject: record.subject,
                text: record.body_preview || '',
                date: new Date(record.received_at),
                messageId: record.message_id,
                headers: {}
            };
            
            try {
                await dmailSender.processEmail(email, [did], record, record.reply_token || undefined);
                successCount++;
            } catch (error) {
                // Already handled
            }
        }
        // Outbound retries would be handled by outboundSender
    }
    
    return successCount;
}

/**
 * Print statistics
 */
function printStats(): void {
    const stats = messageStore.getStats();
    console.log('\n[Bridge] Statistics:');
    console.log(`  Total messages: ${stats.total || 0}`);
    console.log(`  Threads: ${stats.threads || 0}`);
    console.log(`  Inbound sent: ${stats.inbound_sent || 0}`);
    console.log(`  Inbound failed: ${stats.inbound_failed || 0}`);
    console.log(`  Outbound sent: ${stats.outbound_sent || 0}`);
    console.log(`  Outbound failed: ${stats.outbound_failed || 0}`);
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║           SMTP-to-DMail Bridge v0.3.0                     ║
║                                                           ║
║  Bidirectional email bridge with conversation threading   ║
╚═══════════════════════════════════════════════════════════╝
`);

    // Ensure data directory exists
    const dataDir = dirname(config.db.path);
    if (!existsSync(dataDir)) {
        mkdirSync(dataDir, { recursive: true });
    }

    console.log('[Bridge] Configuration:');
    console.log(`  SMTP Port: ${config.smtp.port}`);
    console.log(`  Domain: ${config.smtp.domain}`);
    console.log(`  Gatekeeper: ${config.archon.gatekeeperUrl}`);
    console.log(`  Database: ${config.db.path}`);
    console.log(`  Reply Poller: ${config.poller.enabled ? `${config.poller.intervalMs}ms` : 'disabled'}`);
    console.log(`  Outbound SMTP: ${config.outbound.enabled ? config.outbound.host : 'disabled'}`);
    console.log('');

    // Initialize database
    dbWrapper = await initDatabase(config.db.path);
    messageStore = new MessageStore(dbWrapper);
    console.log('[Bridge] Message store initialized');

    // Initialize name resolver
    resolver = new NameResolver({
        apiUrl: config.archon.socialApi
    });
    console.log('[Bridge] Name resolver initialized');

    // Initialize DMail sender
    dmailSender = new DMailSender({
        walletPath: config.wallet.path,
        walletDir: config.wallet.dir,
        passphrase: config.wallet.passphrase,
        gatekeeperUrl: config.archon.gatekeeperUrl,
        messageStore: messageStore
    });
    
    try {
        await dmailSender.initialize();
        console.log(`[Bridge] DMail sender initialized`);
        console.log(`[Bridge]   Identity: ${dmailSender.getBridgeName()}`);
        console.log(`[Bridge]   DID: ${dmailSender.getBridgeDid()}`);
    } catch (error) {
        console.error('[Bridge] Failed to initialize DMail sender:', error);
        console.log('[Bridge] ⚠️  Running in DRY-RUN mode');
        dryRunMode = true;
    }

    // Initialize outbound sender (if configured)
    if (config.outbound.enabled && !dryRunMode) {
        try {
            outboundSender = new OutboundSender({
                smtpHost: config.outbound.host,
                smtpPort: config.outbound.port,
                smtpUser: config.outbound.user,
                smtpPass: config.outbound.pass,
                smtpSecure: config.outbound.secure,
                fromEmail: config.outbound.fromEmail,
                fromName: config.outbound.fromName,
                messageStore: messageStore
            });
            await outboundSender.initialize();
            console.log(`[Bridge] Outbound sender initialized (${config.outbound.host}:${config.outbound.port})`);
        } catch (error) {
            console.error('[Bridge] Outbound sender failed:', error);
            console.log('[Bridge] ⚠️  Reply-to-SMTP disabled');
            outboundSender = null;
        }
    }

    // Initialize reply poller (if configured and not dry-run)
    if (config.poller.enabled && !dryRunMode && dmailSender.getKeymaster()) {
        replyPoller = new ReplyPoller({
            keymaster: dmailSender.getKeymaster()!,
            messageStore: messageStore,
            bridgeDid: dmailSender.getBridgeDid()!,
            bridgeName: dmailSender.getBridgeName()!,
            intervalMs: config.poller.intervalMs,
            onReply: handleReply
        });
        replyPoller.start();
        console.log(`[Bridge] Reply poller started (${config.poller.intervalMs}ms interval)`);
    }

    // Print current stats
    printStats();

    // Create and start SMTP server
    const smtpServer = createSMTPServer({
        port: config.smtp.port,
        domain: config.smtp.domain,
        maxSize: config.limits.maxEmailSize,
        onEmail: handleEmail
    });

    await startSMTPServer(smtpServer, config.smtp.port);

    console.log('');
    console.log(`[Bridge] 📬 Ready to receive email at *@${config.smtp.domain}`);
    console.log(`[Bridge] Test: swaks --to user@${config.smtp.domain} --server localhost:${config.smtp.port}`);
    console.log(`[Bridge] Mode: ${dryRunMode ? 'DRY-RUN' : 'LIVE'}`);
    console.log('');

    // Periodic retry (every 5 minutes)
    const retryInterval = setInterval(async () => {
        try {
            const retried = await retryFailed();
            if (retried > 0) {
                console.log(`[Bridge] Retried ${retried} messages`);
            }
        } catch (error) {
            console.error('[Bridge] Retry error:', error);
        }
    }, 5 * 60 * 1000);

    // Periodic stats (every hour)
    const statsInterval = setInterval(printStats, 60 * 60 * 1000);

    // Graceful shutdown
    const shutdown = () => {
        console.log('\n[Bridge] Shutting down...');
        clearInterval(retryInterval);
        clearInterval(statsInterval);
        if (replyPoller) replyPoller.stop();
        if (outboundSender) outboundSender.close();
        messageStore.flush();
        smtpServer.close(() => {
            dbWrapper.close();
            console.log('[Bridge] Server closed');
            process.exit(0);
        });
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

// Run
main().catch((error) => {
    console.error('[Bridge] Fatal error:', error);
    process.exit(1);
});
