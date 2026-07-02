/**
 * The SQLite database filename. App-OWNED (sync drops this once, ifAbsent;
 * bootstrap fills the slug). One file per app, kept in the default Documents
 * location so it rides OS auto-backup (canon § Backup & restore Layer 1).
 */

export const DB_NAME = 'grocery-list.db';
