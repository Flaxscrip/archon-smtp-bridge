/**
 * SQLite Database Schema for SMTP-DMail Bridge
 * Using sql.js (pure JavaScript, no native deps)
 * 
 * Tracks bidirectional messaging:
 * - Inbound: SMTP → DMail
 * - Outbound: DMail → SMTP (replies)
 */

import initSqlJs, { type Database } from 'sql.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { randomBytes } from 'crypto';

export interface MessageRecord {
    id: number;
    direction: 'inbound' | 'outbound';
    message_id: string;           // SMTP Message-ID or DMail DID
    received_at: string;          // ISO timestamp
    
    // Parties
    external_email: string;       // The SMTP party (sender for inbound, recipient for outbound)
    archon_did: string;           // The Archon party (recipient for inbound, sender for outbound)
    archon_name: string | null;   // Resolved name (e.g., "genitrix")
    
    // Content
    subject: string;
    body_preview: string;         // First 500 chars
    
    // DMail tracking
    dmail_cid: string | null;     // DMail asset DID
    notice_cid: string | null;    // Notice DID
    
    // Threading
    thread_id: string | null;     // Groups related messages
    reply_to_id: number | null;   // FK to parent message
    reply_token: string | null;   // Unique token for reply matching
    
    // Status
    status: MessageStatus;
    error: string | null;
    retry_count: number;
    updated_at: string;
}

export type MessageStatus = 
    | 'received'    // Email/DMail received, not yet processed
    | 'resolved'    // Recipient resolved
    | 'sent'        // DMail created and sent / SMTP sent
    | 'delivered'   // Confirmed delivered
    | 'failed'      // Failed (check error field)
    | 'rejected';   // Permanently rejected

export interface ThreadRecord {
    id: number;
    thread_id: string;            // UUID for the thread
    external_email: string;       // The SMTP party
    archon_did: string;           // The Archon party
    archon_name: string | null;
    created_at: string;
    last_activity: string;
    message_count: number;
}

export interface DbWrapper {
    db: Database;
    dbPath: string;
    save(): void;
    close(): void;
}

/**
 * Generate a short reply token (8 chars, URL-safe)
 */
export function generateReplyToken(): string {
    return randomBytes(6).toString('base64url').slice(0, 8);
}

/**
 * Generate a thread ID (UUID-like)
 */
export function generateThreadId(): string {
    return randomBytes(16).toString('hex');
}

export async function initDatabase(dbPath: string = './data/bridge.db'): Promise<DbWrapper> {
    // Ensure directory exists
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
    
    // Initialize SQL.js
    const SQL = await initSqlJs();
    
    // Load existing database or create new
    let db: Database;
    if (existsSync(dbPath)) {
        const buffer = readFileSync(dbPath);
        db = new SQL.Database(buffer);
        console.log('[DB] Loaded existing database from', dbPath);
    } else {
        db = new SQL.Database();
        console.log('[DB] Created new database');
    }
    
    // Create/upgrade messages table
    db.run(`
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            direction TEXT NOT NULL DEFAULT 'inbound',
            message_id TEXT UNIQUE NOT NULL,
            received_at TEXT NOT NULL,
            
            external_email TEXT NOT NULL,
            archon_did TEXT,
            archon_name TEXT,
            
            subject TEXT NOT NULL,
            body_preview TEXT,
            
            dmail_cid TEXT,
            notice_cid TEXT,
            
            thread_id TEXT,
            reply_to_id INTEGER,
            reply_token TEXT UNIQUE,
            
            status TEXT NOT NULL DEFAULT 'received',
            error TEXT,
            retry_count INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL,
            
            FOREIGN KEY (reply_to_id) REFERENCES messages(id)
        )
    `);
    
    // Create threads table
    db.run(`
        CREATE TABLE IF NOT EXISTS threads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            thread_id TEXT UNIQUE NOT NULL,
            external_email TEXT NOT NULL,
            archon_did TEXT NOT NULL,
            archon_name TEXT,
            created_at TEXT NOT NULL,
            last_activity TEXT NOT NULL,
            message_count INTEGER NOT NULL DEFAULT 0
        )
    `);
    
    // Create indexes
    db.run(`CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_messages_direction ON messages(direction)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_messages_reply_token ON messages(reply_token)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_messages_dmail_cid ON messages(dmail_cid)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_messages_received ON messages(received_at)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_threads_external ON threads(external_email)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_threads_archon ON threads(archon_did)`);
    
    // Migration: add new columns if they don't exist
    // Using a helper to safely add columns
    const safeAddColumn = (table: string, column: string, type: string, defaultVal?: string) => {
        try {
            const def = defaultVal ? ` DEFAULT ${defaultVal}` : '';
            db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}${def}`);
        } catch (e) { 
            // Column already exists, ignore
        }
    };
    
    safeAddColumn('messages', 'direction', 'TEXT', "'inbound'");
    safeAddColumn('messages', 'external_email', 'TEXT');
    safeAddColumn('messages', 'archon_did', 'TEXT');
    safeAddColumn('messages', 'archon_name', 'TEXT');
    safeAddColumn('messages', 'thread_id', 'TEXT');
    safeAddColumn('messages', 'reply_to_id', 'INTEGER');
    safeAddColumn('messages', 'reply_token', 'TEXT');
    
    // Migrate old data if columns exist
    try {
        // Check if old columns exist before migrating
        const tableInfo = db.exec("PRAGMA table_info(messages)");
        const columns = tableInfo[0]?.values.map(row => row[1]) || [];
        
        if (columns.includes('from_email') && columns.includes('external_email')) {
            db.run(`UPDATE messages SET external_email = from_email WHERE external_email IS NULL`);
        }
        if (columns.includes('to_did') && columns.includes('archon_did')) {
            db.run(`UPDATE messages SET archon_did = to_did WHERE archon_did IS NULL`);
        }
    } catch (e) {
        console.log('[DB] Migration note:', e);
    }
    
    // Save function
    const save = () => {
        const data = db.export();
        const buffer = Buffer.from(data);
        writeFileSync(dbPath, buffer);
    };
    
    // Save immediately to persist schema
    save();
    
    console.log('[DB] Database initialized at', dbPath);
    
    return {
        db,
        dbPath,
        save,
        close: () => {
            save();
            db.close();
        }
    };
}
