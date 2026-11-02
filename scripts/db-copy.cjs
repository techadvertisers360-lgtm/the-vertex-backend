#!/usr/bin/env node
/* eslint-disable */
/**
 * Back up the production database, restore it somewhere else, and prove nothing changed (D-086).
 *
 *   node scripts/db-copy.cjs check-live                       read-only: binlog format, row counts, money totals
 *   node scripts/db-copy.cjs backup                           read-only dump to secrets/backups/
 *   node scripts/db-copy.cjs restore <file> <target>          load a dump into the target (empty database only)
 *   node scripts/db-copy.cjs make-staging <target>            stop a staging copy reaching real people
 *   node scripts/db-copy.cjs migrate <target>                 prisma migrate deploy on the target
 *   node scripts/db-copy.cjs snapshot <target|live> <name>    write counts and totals to secrets/snapshots/<name>.json
 *   node scripts/db-copy.cjs compare <nameA> <nameB>          exit 1 if anything that must not change did
 *
 * <target> is a file in secrets/ holding DATABASE_URL="..." (e.g. staging.env), or local:<database>.
 * Production's URL is read only from secrets/aiven-production.env. Every write command refuses that database, whatever
 * it is told, and `migrate-live` exists only for the final deploy, after a typed confirmation of the host name.
 * Passwords go to the MySQL tools through the environment and are never printed.
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const BACKEND = path.resolve(__dirname, '..');
const SECRETS = process.env.DB_COPY_SECRETS || path.join(BACKEND, 'secrets');
const MYSQL_BIN = process.env.MYSQL_BIN || 'C:/Program Files/MySQL/MySQL Server 8.0/bin';
const LIVE_FILE = process.env.DB_COPY_LIVE_FILE || path.join(SECRETS, 'aiven-production.env');
const LOCAL_PORT = process.env.DB_COPY_LOCAL_PORT || '33077';
const CA = path.join(SECRETS, 'aiven-ca.pem');

function die(message) {
  console.error(`\nSTOPPED: ${message}\n`);
  process.exit(1);
}

function urlFromFile(file) {
  if (!fs.existsSync(file)) die(`${path.basename(file)} not found in secrets/.`);
  const m = fs.readFileSync(file, 'utf8').match(/^DATABASE_URL="?([^"\r\n]+)"?/m);
  if (!m) die(`${path.basename(file)} has no DATABASE_URL line.`);
  return m[1];
}

function parse(url) {
  const u = new URL(url);
  return { host: u.hostname, port: u.port || '3306', user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: u.pathname.slice(1), url, remote: !['127.0.0.1', 'localhost'].includes(u.hostname) };
}

const live = () => parse(urlFromFile(LIVE_FILE));

function target(name) {
  if (!name) die('Say which database, e.g. staging.env or local:rehearsal.');
  if (name === 'live') die('This command never writes to the live database.');
  const db = name.startsWith('local:') ? parse(`mysql://root@127.0.0.1:${LOCAL_PORT}/${name.slice(6)}`) : parse(urlFromFile(path.join(SECRETS, name)));
  const l = live();
  if (db.host.toLowerCase() === l.host.toLowerCase() && db.database === l.database && db.port === l.port) die('That is the LIVE database. Nothing was changed.');
  return db;
}

function clientArgs(db) {
  const args = [`--host=${db.host}`, `--port=${db.port}`, `--user=${db.user}`];
  if (db.remote) args.push('--ssl-mode=REQUIRED');
  return args;
}
const clientEnv = (db) => ({ ...process.env, MYSQL_PWD: db.password });

function query(db, sql) {
  const r = spawnSync(path.join(MYSQL_BIN, 'mysql'), ['--no-defaults', ...clientArgs(db), '--batch', '--skip-column-names', db.database, '-e', sql], { env: clientEnv(db), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) die(`Database query failed: ${(r.stderr || '').replace(/password[^\s]*/gi, '***').split('\n').filter((l) => !l.includes('Using a password')).join(' ').slice(0, 300)}`);
  return r.stdout.replace(/\r/g, '').trim();
}

/** Figures that must be identical before and after a migration. Only columns that exist on both sides. */
function snapshot(db) {
  const tables = query(db, `SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' AND table_name NOT IN ('_prisma_migrations') ORDER BY table_name`).split('\n').filter(Boolean);
  const counts = {};
  for (const t of tables) counts[t] = Number(query(db, `SELECT COUNT(*) FROM \`${t}\``));
  const money = {
    invoices: query(db, `SELECT COUNT(*), COALESCE(SUM(subtotalPaisa),0), COALESCE(SUM(discountPaisa),0), COALESCE(SUM(totalPaisa),0), COALESCE(SUM(paidPaisa),0), COALESCE(SUM(balancePaisa),0) FROM invoices`),
    invoicesByStatus: query(db, `SELECT status, COUNT(*), COALESCE(SUM(totalPaisa),0) FROM invoices GROUP BY status ORDER BY status`),
    invoiceLines: query(db, `SELECT COUNT(*), COALESCE(SUM(lineTotalPaisa),0) FROM invoice_lines`),
    payments: query(db, `SELECT method, COUNT(*), COALESCE(SUM(amountPaisa),0) FROM payments GROUP BY method ORDER BY method`),
    ledger: query(db, `SELECT account, COUNT(*), COALESCE(SUM(amountPaisa),0) FROM ledger_entries GROUP BY account ORDER BY account`),
    cashClosings: query(db, `SELECT COUNT(*), COALESCE(SUM(expectedCashPaisa),0), COALESCE(SUM(countedCashPaisa),0), COALESCE(SUM(variancePaisa),0), COALESCE(SUM(totalCollectedPaisa),0) FROM cash_closings`),
    supplierPayments: query(db, `SELECT COUNT(*), COALESCE(SUM(amountPaisa),0) FROM supplier_payments`),
    stockLedger: query(db, `SELECT COUNT(*), COALESCE(SUM(quantity),0) FROM stock_transactions`),
  };
  const fingerprints = {
    invoices: query(db, `SELECT COALESCE(MD5(GROUP_CONCAT(id, number, status, totalPaisa, paidPaisa, balancePaisa, discountPaisa, updatedAt ORDER BY id SEPARATOR '|')), 'none') FROM (SELECT * FROM invoices) x`),
    payments: query(db, `SELECT COALESCE(MD5(GROUP_CONCAT(id, receiptNo, amountPaisa, method, receivedAt ORDER BY id SEPARATOR '|')), 'none') FROM payments`),
    cashClosings: query(db, `SELECT COALESCE(MD5(GROUP_CONCAT(id, date, expectedCashPaisa, countedCashPaisa, variancePaisa ORDER BY id SEPARATOR '|')), 'none') FROM cash_closings`),
  };
  /** Invoices whose receipts do not match what the invoice says: the old double-payment bug would show here. */
  const mismatches = query(db, `SELECT i.number, i.paidPaisa, COALESCE(SUM(p.amountPaisa),0) FROM invoices i LEFT JOIN payments p ON p.invoiceId = i.id GROUP BY i.id, i.number, i.paidPaisa HAVING i.paidPaisa <> COALESCE(SUM(p.amountPaisa),0) ORDER BY i.number`).split('\n').filter(Boolean);
  const overpaid = query(db, `SELECT number, totalPaisa, paidPaisa, balancePaisa FROM invoices WHERE balancePaisa < 0 OR paidPaisa > totalPaisa ORDER BY number`).split('\n').filter(Boolean);
  const negativeStock = query(db, `SELECT i.name, SUM(t.quantity) FROM stock_transactions t JOIN stock_items i ON i.id = t.itemId GROUP BY i.id, i.name HAVING SUM(t.quantity) < 0 ORDER BY i.name`).split('\n').filter(Boolean);
  return { takenAt: new Date().toISOString(), host: db.host, database: db.database, counts, money, fingerprints, problems: { mismatches, overpaid, negativeStock } };
}

function printSummary(s) {
  const [count, , , total, paid, balance] = s.money.invoices.split('\t');
  const rs = (p) => `Rs ${(Number(p) / 100).toLocaleString('en-PK')}`;
  console.log(`  Invoices: ${count} · total ${rs(total)} · paid ${rs(paid)} · balance ${rs(balance)}`);
  console.log(`  Payments: ${s.counts.payments} · Cash closings: ${s.counts.cash_closings} · Patients: ${s.counts.patients}`);
  console.log(`  Invoices whose receipts do not match: ${s.problems.mismatches.length}`);
  for (const m of s.problems.mismatches) console.log(`    ${m.replace(/\t/g, ' | ')}   (number | paid on invoice | sum of receipts)`);
  console.log(`  Overpaid invoices: ${s.problems.overpaid.length}`);
  for (const m of s.problems.overpaid) console.log(`    ${m.replace(/\t/g, ' | ')}   (number | total | paid | balance)`);
  console.log(`  Products with negative stock: ${s.problems.negativeStock.length}`);
  for (const m of s.problems.negativeStock) console.log(`    ${m.replace(/\t/g, ' | ')}`);
}

function saveSnapshot(s, name) {
  const dir = path.join(SECRETS, 'snapshots');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(s, null, 2));
  console.log(`Saved snapshot "${name}".`);
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').slice(0, 13);

function backup() {
  const db = live();
  const dir = path.join(SECRETS, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `aiven-${stamp()}.sql.gz`);
  const raw = `${file}.tmp`;
  // --result-file rather than stdout: on Windows stdout turns line ends into CRLF, which breaks DELIMITER lines.
  const args = ['--no-defaults', ...clientArgs(db), '--single-transaction', '--quick', '--triggers', '--routines', '--hex-blob', '--no-tablespaces', '--set-gtid-purged=OFF', '--default-character-set=utf8mb4', `--result-file=${raw}`, db.database];
  const r = spawnSync(path.join(MYSQL_BIN, 'mysqldump'), args, { env: clientEnv(db), encoding: 'utf8' });
  if (r.status !== 0) {
    fs.rmSync(raw, { force: true });
    die(`Backup failed: ${(r.stderr || '').split('\n').filter((l) => !l.includes('Using a password')).join(' ').slice(0, 300)}`);
  }
  const sql = fs.readFileSync(raw);
  // A dump that stopped early has no completion line: this catches a cut-off file.
  if (!sql.subarray(-200).toString().includes('Dump completed')) {
    fs.rmSync(raw, { force: true });
    die('Backup file is incomplete. Run it again.');
  }
  fs.writeFileSync(file, zlib.gzipSync(sql));
  fs.rmSync(raw, { force: true });
  console.log(`Backup complete: ${file} (${(fs.statSync(file).size / 1_048_576).toFixed(1)} MB)`);
  return file;
}

function restore(file, name) {
  const db = target(name);
  if (!file || !fs.existsSync(file)) die('Backup file not found.');
  const existing = Number(query(db, `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE()`));
  if (existing > 0) die(`Target already has ${existing} tables. A copy only goes into an empty database.`);
  // The dump names the live server's admin user as the owner of its triggers; the copy's own user owns them here.
  // The migrations stored each trigger with a trailing ";", which mysqldump keeps inside its version comment. The
  // plain mysql tool cannot load that, so a dump of this database must be restored through this command.
  const sql = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8').replace(/\/\*!50017 DEFINER=`[^`]+`@`[^`]+`\*\/ ?/g, '').replace(/DEFINER=`[^`]+`@`[^`]+` ?/g, '').replace(/;\s*\*\/;;/g, ' */;;');
  const r = spawnSync(path.join(MYSQL_BIN, 'mysql'), ['--no-defaults', ...clientArgs(db), '--default-character-set=utf8mb4', db.database], { env: clientEnv(db), input: sql, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) die(`Restore failed: ${(r.stderr || '').split('\n').filter((l) => !l.includes('Using a password')).join(' ').slice(0, 400)}`);
  console.log(`Restored into ${db.database} on ${db.host}.`);
}

/** Staging holds real people's numbers. Nothing queued may reach them, and no phone may get a test notification. */
function makeStaging(name) {
  const db = target(name);
  query(db, `TRUNCATE TABLE push_subscriptions`);
  query(db, `UPDATE message_outbox SET status = 'CANCELLED' WHERE status IN ('QUEUED', 'SENDING')`);
  query(db, `UPDATE jobs SET status = 'CANCELLED' WHERE status IN ('PENDING', 'RUNNING')`);
  query(db, `INSERT INTO settings (\`key\`, value, isPlaceholder, description, updatedAt) VALUES ('clinic.name', '"STAGING TEST: The Vertex Health"', 0, 'Staging copy', NOW(3)) ON DUPLICATE KEY UPDATE value = VALUES(value)`);
  console.log(`Staging safety applied to ${db.database}: phone subscriptions cleared, queued messages and jobs stopped, printouts marked STAGING.`);
}

function migrate(db) {
  const r = spawnSync('npx', ['prisma', 'migrate', 'deploy'], { cwd: BACKEND, shell: true, stdio: 'inherit', env: { ...process.env, DATABASE_URL: db.remote && fs.existsSync(CA) && !/sslcert=/.test(db.url) ? `${db.url}${db.url.includes('?') ? '&' : '?'}sslcert=${CA}&sslaccept=strict` : db.url } });
  if (r.status !== 0) die('Migration failed.');
}

/** The tables the migration adds are allowed to appear. Everything already there must match exactly. */
function compare(a, b) {
  const load = (n) => JSON.parse(fs.readFileSync(path.join(SECRETS, 'snapshots', `${n}.json`), 'utf8'));
  const A = load(a);
  const B = load(b);
  const diffs = [];
  for (const [t, n] of Object.entries(A.counts)) if (B.counts[t] !== n) diffs.push(`row count of ${t}: ${n} → ${B.counts[t]}`);
  for (const [k, v] of Object.entries(A.money)) if (B.money[k] !== v) diffs.push(`${k} totals:\n    before ${v.replace(/\n/g, ' ; ')}\n    after  ${String(B.money[k]).replace(/\n/g, ' ; ')}`);
  for (const [k, v] of Object.entries(A.fingerprints)) if (B.fingerprints[k] !== v) diffs.push(`${k} rows changed (fingerprint differs)`);
  const added = Object.keys(B.counts).filter((t) => !(t in A.counts));
  console.log(`Compared "${a}" with "${b}".`);
  printSummary(B);
  if (added.length) console.log(`  New tables: ${added.join(', ')}`);
  if (diffs.length) {
    console.log('\nDIFFERENT:');
    for (const d of diffs) console.log(`  ${d}`);
    process.exit(1);
  }
  console.log('\nIDENTICAL: every existing row count, money total and fingerprint matches.');
}

async function main() {
  const [cmd, x, y] = process.argv.slice(2);
  switch (cmd) {
    case 'check-live': {
      const db = live();
      const fmt = query(db, 'SELECT @@binlog_format, @@log_bin, @@version, @@transaction_isolation').split('\t');
      console.log(`Live database: binlog_format=${fmt[0]} log_bin=${fmt[1]} version=${fmt[2]} default isolation=${fmt[3]}`);
      console.log(fmt[1] === '0' || fmt[0] !== 'STATEMENT' ? 'Race fix is SAFE on this server: READ COMMITTED is allowed.' : 'Race fix is NOT safe: binlog_format is STATEMENT. Do not deploy it.');
      printSummary(snapshot(db));
      break;
    }
    case 'backup':
      backup();
      break;
    case 'restore':
      restore(x, y);
      break;
    case 'make-staging':
      makeStaging(x);
      break;
    case 'migrate':
      migrate(target(x));
      break;
    case 'snapshot': {
      const s = snapshot(x === 'live' ? live() : target(x));
      printSummary(s);
      saveSnapshot(s, y);
      break;
    }
    case 'compare':
      compare(x, y);
      break;
    case 'migrate-live': {
      const db = live();
      if (x !== db.host) die('Type the live host name after migrate-live to confirm.');
      migrate(db);
      break;
    }
    default:
      console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
  }
}

void main();
