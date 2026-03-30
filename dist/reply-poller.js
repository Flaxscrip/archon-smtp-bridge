/**
 * Reply Poller - monitors bridge DID's inbox for replies
 *
 * When a DMail recipient wants to reply to a bridged email,
 * they send a DMail to the bridge DID with the reply token in subject.
 */
export class ReplyPoller {
    keymaster;
    messageStore;
    bridgeDid;
    bridgeName;
    intervalMs;
    onReply;
    timer = null;
    running = false;
    processedDmails = new Set();
    constructor(options) {
        this.keymaster = options.keymaster;
        this.messageStore = options.messageStore;
        this.bridgeDid = options.bridgeDid;
        this.bridgeName = options.bridgeName;
        this.intervalMs = options.intervalMs || 60000;
        this.onReply = options.onReply;
    }
    /**
     * Start polling for replies
     */
    start() {
        if (this.timer)
            return;
        console.log(`[Poller] Starting reply poller (interval: ${this.intervalMs}ms)`);
        // Initial poll
        this.poll().catch(err => console.error('[Poller] Initial poll error:', err));
        // Schedule recurring polls
        this.timer = setInterval(() => {
            this.poll().catch(err => console.error('[Poller] Poll error:', err));
        }, this.intervalMs);
    }
    /**
     * Stop polling
     */
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        console.log('[Poller] Stopped');
    }
    /**
     * Poll for new replies
     */
    async poll() {
        if (this.running) {
            console.log('[Poller] Already running, skipping');
            return 0;
        }
        this.running = true;
        let processed = 0;
        try {
            // Refresh inbox to get new dmails
            try {
                await this.keymaster.refreshNotices();
            }
            catch (refreshErr) {
                console.log('[Poller] Could not refresh notices:', refreshErr instanceof Error ? refreshErr.message : String(refreshErr).slice(0, 100));
                // Continue anyway - we can still check existing dmails
            }
            // List all dmails (returns Record<dmailDid, DmailItem>)
            let dmailMap;
            try {
                dmailMap = await this.keymaster.listDmail();
            }
            catch (listErr) {
                console.error('[Poller] Could not list dmails:', listErr instanceof Error ? listErr.message : String(listErr).slice(0, 100));
                return 0;
            }
            for (const [dmailDid, dmail] of Object.entries(dmailMap)) {
                // Skip already processed (in-memory cache)
                if (this.processedDmails.has(dmailDid))
                    continue;
                // Skip if already seen (persistent DB check)
                if (this.messageStore.isDmailSeen(dmailDid)) {
                    this.processedDmails.add(dmailDid);
                    continue;
                }
                // Skip if already in our database as a processed message
                const existing = this.messageStore.getByDmailCid(dmailDid);
                if (existing) {
                    this.messageStore.markDmailSeen(dmailDid, false);
                    this.processedDmails.add(dmailDid);
                    continue;
                }
                // Try to process as a reply
                const reply = await this.parseDmailAsReply(dmailDid);
                if (reply) {
                    console.log(`[Poller] Found reply from ${reply.fromDid} to ${reply.toEmail}`);
                    try {
                        await this.onReply(reply);
                        processed++;
                        this.messageStore.markDmailSeen(dmailDid, true); // Mark as reply
                    }
                    catch (err) {
                        console.error(`[Poller] Error handling reply:`, err);
                    }
                }
                else {
                    // Not a reply, mark as seen so we don't check again
                    this.messageStore.markDmailSeen(dmailDid, false);
                }
                this.processedDmails.add(dmailDid);
            }
        }
        catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            // Truncate HTML error responses
            if (errMsg.includes('<html>')) {
                console.error('[Poller] Error during poll: Gatekeeper unavailable (503)');
            }
            else {
                console.error('[Poller] Error during poll:', errMsg.slice(0, 200));
            }
        }
        finally {
            this.running = false;
        }
        if (processed > 0) {
            console.log(`[Poller] Processed ${processed} replies`);
        }
        return processed;
    }
    /**
     * Parse a DMail to see if it's a reply to a bridged message
     * Checks DID properties first, then falls back to body/subject parsing
     */
    async parseDmailAsReply(dmailCid) {
        try {
            // Get DMail content
            let dmail;
            try {
                dmail = await this.keymaster.getDmailMessage(dmailCid);
            }
            catch (getDmailErr) {
                const errMsg = getDmailErr instanceof Error ? getDmailErr.message : String(getDmailErr);
                if (errMsg.includes('503') || errMsg.includes('<html>')) {
                    console.log(`[Poller] Skipping ${dmailCid.slice(-12)} - gatekeeper unavailable`);
                }
                else {
                    console.error(`[Poller] Error getting DMail ${dmailCid.slice(-12)}:`, errMsg.slice(0, 100));
                }
                return null;
            }
            if (!dmail)
                return null;
            // Check if it's addressed to the bridge
            const toUs = dmail.to.includes(this.bridgeDid) ||
                dmail.to.includes(this.bridgeName);
            if (!toUs)
                return null;
            let originalMessage = null;
            let toEmail = null;
            let threadId = null;
            let replyToken = null;
            // METHOD 1: Check DID properties for bridge metadata
            try {
                const resolved = await this.keymaster.resolveDID(dmailCid, { confirm: false });
                const data = resolved?.didDocumentData || {};
                if (data['bridge:reply-token']) {
                    replyToken = data['bridge:reply-token'];
                    originalMessage = this.messageStore.getByReplyToken(replyToken);
                    if (originalMessage) {
                        toEmail = originalMessage.external_email;
                        threadId = originalMessage.thread_id;
                        console.log(`[Poller] Found reply via DID properties: token=${replyToken} → ${toEmail}`);
                    }
                }
                // Also check if original-sender is directly specified
                if (!toEmail && data['bridge:original-sender']) {
                    toEmail = data['bridge:original-sender'];
                    threadId = data['bridge:thread-id'] || null;
                    console.log(`[Poller] Found reply via DID properties: direct sender → ${toEmail}`);
                }
            }
            catch (e) {
                // Properties not available, continue to fallback
            }
            // METHOD 2: Fallback to subject/body parsing for token
            if (!toEmail) {
                const tokenMatch = dmail.subject?.match(/\[?REPLY[:\-]?\s*([A-Za-z0-9_-]{6,12})\]?/i) ||
                    dmail.body?.match(/\[?REPLY[:\-]?\s*([A-Za-z0-9_-]{6,12})\]?/i);
                if (tokenMatch) {
                    replyToken = tokenMatch[1];
                    originalMessage = this.messageStore.getByReplyToken(replyToken);
                    if (originalMessage) {
                        toEmail = originalMessage.external_email;
                        threadId = originalMessage.thread_id;
                        console.log(`[Poller] Found reply via body parsing: token=${replyToken} → ${toEmail}`);
                    }
                }
            }
            // METHOD 3: Smart matching by sender DID + subject
            if (!toEmail && dmail.from) {
                const senderDid = dmail.from;
                const subject = dmail.subject || '';
                // Try to match by subject
                originalMessage = this.messageStore.findByRecipientAndSubject(senderDid, subject);
                if (originalMessage) {
                    toEmail = originalMessage.external_email;
                    threadId = originalMessage.thread_id;
                    console.log(`[Poller] Found reply via subject match: "${subject}" → ${toEmail}`);
                }
                else {
                    // Fallback: most recent message to this sender
                    originalMessage = this.messageStore.findRecentByRecipient(senderDid);
                    if (originalMessage) {
                        toEmail = originalMessage.external_email;
                        threadId = originalMessage.thread_id;
                        console.log(`[Poller] Found reply via recent conversation: ${senderDid} → ${toEmail}`);
                    }
                }
            }
            // If still no match, skip
            if (!toEmail) {
                console.log(`[Poller] DMail ${dmailCid} has no reply routing info, skipping`);
                return null;
            }
            // Get sender info
            const fromDid = dmail.from || 'unknown';
            let fromName = null;
            // Try to resolve sender name
            try {
                const resolved = await this.keymaster.resolveDID(fromDid);
                fromName = resolved?.didDocumentData?.name || null;
            }
            catch (e) {
                // Can't resolve, that's fine
            }
            // Clean up subject (remove reply token if present)
            let subject = dmail.subject || '(no subject)';
            subject = subject.replace(/\s*\[?REPLY[:\-]?\s*[A-Za-z0-9_-]{6,12}\]?\s*/gi, '').trim();
            if (!subject.toLowerCase().startsWith('re:')) {
                subject = `Re: ${subject}`;
            }
            // Clean up body (remove reply token if present)
            let body = dmail.body || '';
            body = body.replace(/\[?REPLY[:\-]?\s*[A-Za-z0-9_-]{6,12}\]?\s*/gi, '').trim();
            return {
                dmailCid,
                fromDid,
                fromName,
                toEmail,
                subject,
                body,
                originalMessageId: originalMessage?.id || null,
                threadId
            };
        }
        catch (error) {
            console.error(`[Poller] Error parsing DMail ${dmailCid}:`, error);
            return null;
        }
    }
}
//# sourceMappingURL=reply-poller.js.map