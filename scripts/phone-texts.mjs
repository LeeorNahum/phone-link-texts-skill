#!/usr/bin/env node
// Read text messages from Phone Link's local database, read-only.
// Run with --help for the commands. Each run reads a private copy of the
// database in a temporary folder and deletes it before exiting. The live
// files are only copied, never opened as a database, and nothing is ever
// written or sent. Needs Node.js 22.13 or later for the built-in SQLite module.

import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const HELP = `phone-link-texts: read the paired phone's texts from Phone Link's local database, read-only.

Commands:
  contacts NAME [NAME ...]         Contacts whose name or nickname contains each NAME.
  threads [--with NAME ...]        Conversations newest first, with participants.
                                   --with keeps threads that include every NAME. A NAME
                                   with digits also matches the end of a phone number.
  read THREAD_ID [--grep REGEX]    Messages in one conversation, oldest first.
  span                             Dates of the oldest and newest message held.
  query SQL                        Run one SELECT, WITH, or VALUES statement against
                                   the copy. The contacts database is attached as
                                   "contacts". Anything that writes is refused.

Options:
  --since DATE      threads, read: on or after this local date (YYYY-MM-DD).
  --until DATE      threads, read: on or before this local date.
  --grep REGEX      read: only messages matching this case-insensitive pattern.
  --json            contacts, threads, read, span: one JSON object per line.
                    query always prints JSON.

Each run reads a private copy of the database and deletes it before exiting.
Nothing is ever written or sent. The schema for query is in the skill's
references/schema.md.`;

const PACKAGE = join(process.env.LOCALAPPDATA ?? "", "Packages", "Microsoft.YourPhone_8wekyb3d8bbwe");
const TMP_PREFIX = "phone-texts-";
// A copy older than this belongs to a run that was killed before it could clean up.
const STALE_COPY_MS = 60 * 60 * 1000;
// Windows file times count 100-nanosecond ticks from 1601-01-01 UTC.
const EPOCH_OFFSET_MS = 11644473600000n;
const SENT = 2n;
const UNSENT = new Set([3n, 4n, 5n, 6n]); // Android: 3 draft, 4 outbox, 5 failed, 6 queued

// Which options and how many positionals each command accepts.
const COMMAND_SHAPE = {
  contacts: { options: ["json"], positionals: "some" },
  threads: { options: ["since", "until", "with", "json"], positionals: "none" },
  read: { options: ["since", "until", "grep", "json"], positionals: "one" },
  span: { options: ["json"], positionals: "none" },
  query: { options: [], positionals: "one" },
};

class Failure extends Error {}

async function loadSqlite() {
  // node:sqlite prints an experimental-feature warning on first import. It is noise to a reader of this output.
  const emit = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    const type = typeof rest[0] === "string" ? rest[0] : rest[0]?.type;
    if (type === "ExperimentalWarning" && String(warning).includes("SQLite")) return;
    return emit.call(process, warning, ...rest);
  };
  try {
    return (await import("node:sqlite")).DatabaseSync;
  } catch {
    throw new Failure(`this script needs Node's built-in SQLite module without a flag: Node.js 22.13 or later in the 22 line, or 23.4 or later. This is Node.js ${process.versions.node}.`);
  } finally {
    process.emitWarning = emit;
  }
}

function sweepStaleCopies() {
  const now = Date.now();
  for (const entry of readdirSync(tmpdir())) {
    if (!entry.startsWith(TMP_PREFIX)) continue;
    const path = join(tmpdir(), entry);
    try {
      if (now - statSync(path).mtimeMs > STALE_COPY_MS) rmSync(path, { recursive: true, force: true });
    } catch {
      // Another run may be removing it at the same moment.
    }
  }
}

function newestDatabase() {
  const indexed = join(PACKAGE, "LocalCache", "Indexed");
  const dbs = existsSync(indexed)
    ? readdirSync(indexed)
        .map((device) => join(indexed, device, "System", "Database", "phone.db"))
        .filter((path) => existsSync(path))
    : [];
  if (!dbs.length) {
    throw new Failure("no Phone Link message database found. This script works only on the Windows computer where Phone Link is paired with the phone.");
  }
  const lastWrite = (path) => Math.max(...[path, `${path}-wal`].filter(existsSync).map((p) => statSync(p).mtimeMs));
  dbs.sort((a, b) => lastWrite(b) - lastWrite(a));
  return { src: dbs[0], count: dbs.length };
}

function snapshot(DatabaseSync, tmp, opened) {
  const { src, count } = newestDatabase();
  if (count > 1) console.error(`note: ${count} device folders found, reading the one updated most recently.`);
  const folder = join(src, "..");
  for (const name of ["phone.db", "contacts.db"]) {
    for (const suffix of ["", "-wal"]) {
      const path = join(folder, name + suffix);
      if (existsSync(path)) copyFileSync(path, join(tmp, name + suffix));
    }
  }
  const phone = new DatabaseSync(join(tmp, "phone.db"));
  opened.push(phone);
  phone.prepare("select 1 from conversation limit 1").get();
  let contacts = null;
  if (existsSync(join(tmp, "contacts.db"))) {
    contacts = new DatabaseSync(join(tmp, "contacts.db"));
    opened.push(contacts);
  }
  return { phone, contacts, tmp };
}

// Timestamps and message types come back as BigInt, because file times exceed JavaScript's safe integer range.
function rows(db, sql, ...params) {
  const statement = db.prepare(sql);
  statement.setReadBigInts(true);
  return statement.all(...params);
}

const digits = (address) => String(address ?? "").replace(/\D/g, "").slice(-10);

function nameBook(contacts) {
  const book = new Map();
  if (!contacts) return book;
  const names = new Map(rows(contacts, "select contact_id, display_name from contact").map((r) => [r.contact_id, r.display_name]));
  for (const { contact_id, phone_number } of rows(contacts, "select contact_id, phone_number from phonenumber")) {
    const key = digits(phone_number);
    const name = names.get(contact_id) || phone_number;
    if (!key) continue;
    const existing = book.get(key);
    if (!existing) book.set(key, name);
    else if (!existing.split(" / ").includes(name)) book.set(key, `${existing} / ${name}`);
  }
  return book;
}

function toDate(fileTime) {
  if (!fileTime) return null;
  return new Date(Number(BigInt(fileTime) / 10000n - EPOCH_OFFSET_MS));
}

// Local midnight at the start of the named day, plus dayOffset days, as a file time.
// Stepping by calendar day rather than by 24 hours keeps daylight-saving days whole.
function toFileTime(flag, day, dayOffset = 0) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day ?? "");
  const [year, month, date] = match ? match.slice(1).map(Number) : [];
  const local = match && year >= 1900 ? new Date(year, month - 1, date) : null;
  if (!local || local.getMonth() !== month - 1 || local.getDate() !== date) {
    throw new Failure(`--${flag} must be a date like 2025-01-31, not "${day}"`);
  }
  const start = new Date(year, month - 1, date + dayOffset);
  return (BigInt(start.getTime()) + EPOCH_OFFSET_MS) * 10000n;
}

function dateRange(values) {
  const since = values.since ? toFileTime("since", values.since) : 0n;
  // --until includes the whole named day: it ends at the next day's local midnight.
  const until = values.until ? toFileTime("until", values.until, 1) : 2n ** 62n;
  if (since >= until) throw new Failure("--since must be on or before --until.");
  return { since, until };
}

function fmt(date) {
  if (!date) return "no date";
  const pad = (n) => String(n).padStart(2, "0");
  const day = date.toLocaleDateString("en-US", { weekday: "short" });
  const hours = date.getHours() % 12 || 12;
  const half = date.getHours() < 12 ? "AM" : "PM";
  return `${day} ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(hours)}:${pad(date.getMinutes())}${half}`;
}

// JSON cannot hold BigInt or bytes: small integers become numbers, large ones strings, and a blob its size.
const jsonSafe = (value) =>
  JSON.stringify(value, (_, v) => {
    if (typeof v === "bigint") return v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= -BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : String(v);
    if (v instanceof Uint8Array) return `<${v.length} bytes>`;
    return v;
  });

function participants(phone, book) {
  const out = new Map();
  for (const { thread_id, normalized_address } of rows(phone, "select thread_id, normalized_address from participant")) {
    const list = out.get(thread_id) ?? [];
    list.push({ name: book.get(digits(normalized_address)) ?? normalized_address, digits: digits(normalized_address) });
    out.set(thread_id, list);
  }
  return out;
}

function sender(type, from, book) {
  if (type === SENT) return "me";
  if (UNSENT.has(type)) return "me (not sent)";
  return book.get(digits(from)) ?? (from || "unknown");
}

function cmdContacts({ contacts }, { values, positionals }) {
  if (!contacts) throw new Failure("contacts.db is missing, so names cannot be resolved.");
  const all = rows(contacts, "select display_name, nickname from contact");
  for (const query of positionals) {
    const q = query.toLowerCase();
    const hits = all
      .filter(({ display_name: dn, nickname: nn }) => (dn ?? "").toLowerCase().includes(q) || (nn ?? "").toLowerCase().includes(q))
      .map(({ display_name: dn, nickname: nn }) => (dn && nn ? `${dn} (${nn})` : dn || nn));
    if (values.json) console.log(jsonSafe({ query, matches: hits }));
    else console.log(`${query}: ${hits.length ? hits.join(", ") : "no match"}`);
  }
}

function cmdThreads({ phone, contacts }, { values }) {
  const book = nameBook(contacts);
  const people = participants(phone, book);
  const { since, until } = dateRange(values);
  const wanted = (values.with ?? []).map((w) => ({ text: w.toLowerCase(), digits: w.replace(/\D/g, "") }));
  const matches = (w, names) => names.some((n) => String(n.name).toLowerCase().includes(w.text) || (w.digits.length >= 4 && n.digits.endsWith(w.digits.slice(-10))));
  const list = rows(phone, "select thread_id, timestamp, msg_count from conversation where timestamp >= ? and timestamp < ? and msg_count > 0 order by timestamp desc", since, until);
  for (const { thread_id, timestamp, msg_count } of list) {
    const names = people.get(thread_id) ?? [];
    if (!names.length) continue;
    if (wanted.length && !wanted.every((w) => matches(w, names))) continue;
    const sorted = names.map((n) => String(n.name)).sort();
    if (values.json) console.log(jsonSafe({ thread: thread_id, last: toDate(timestamp)?.toISOString(), messages: msg_count, participants: sorted }));
    else console.log(`${thread_id}\t${fmt(toDate(timestamp))}\t${msg_count} msgs\t${names.length} people\t${sorted.join(", ")}`);
  }
}

function cmdRead({ phone, contacts }, { values, positionals }) {
  if (!/^\d+$/.test(positionals[0])) throw new Failure("read needs a THREAD_ID from the threads command.");
  const thread = BigInt(positionals[0]);
  const { since, until } = dateRange(values);
  let pattern = null;
  if (values.grep) {
    try {
      pattern = new RegExp(values.grep, "i");
    } catch (err) {
      throw new Failure(`--grep is not a valid regular expression: ${err.message}`);
    }
  }
  if (!rows(phone, "select 1 from conversation where thread_id = ?", thread).length) {
    throw new Failure(`no conversation has id ${thread}. Ids are local to this computer: find it again with threads --with.`);
  }
  const book = nameBook(contacts);
  const messages = [];
  for (const m of rows(phone, "select timestamp, from_address, type, body from message where thread_id = ? and timestamp >= ? and timestamp < ?", thread, since, until)) {
    messages.push({ ts: m.timestamp, from: sender(m.type, m.from_address, book), text: m.body ?? "", attachments: [] });
  }
  for (const m of rows(phone, "select message_id, timestamp, from_address, type from mms where thread_id = ? and timestamp >= ? and timestamp < ?", thread, since, until)) {
    const parts = rows(phone, "select content_type, text from mms_part where message_id = ?", m.message_id);
    const text = parts.filter((p) => p.content_type === "text/plain" && p.text).map((p) => p.text).join(" ").trim();
    const attachments = parts.map((p) => p.content_type).filter((ct) => ct !== "text/plain" && ct !== "application/smil");
    messages.push({ ts: m.timestamp, from: sender(m.type, m.from_address, book), text, attachments });
  }
  messages.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  let shown = 0;
  for (const m of messages) {
    const label = [m.text, m.attachments.length ? `[${m.attachments.join(", ")}]` : ""].filter(Boolean).join(" ") || "[no text]";
    if (pattern && !pattern.test(label)) continue;
    shown += 1;
    if (values.json) console.log(jsonSafe({ time: toDate(m.ts)?.toISOString(), from: m.from, text: m.text, attachments: m.attachments }));
    // A line break inside a message becomes an indented continuation, so every message still starts on its own prefixed line.
    else console.log(`${fmt(toDate(m.ts))} | ${m.from}: ${label.replace(/\r?\n/g, "\n    ")}`);
  }
  if (!values.json) console.log(`${shown} of ${messages.length} messages shown`);
  const rcs = rows(phone, "select count(*) as n from rcs_chat")[0].n;
  if (rcs) console.error(`note: the database holds ${rcs} chat-feature (RCS) messages, which this script does not read.`);
}

function cmdSpan({ phone }, { values }) {
  let total = 0n;
  let low = null;
  let high = null;
  for (const table of ["message", "mms"]) {
    const r = rows(phone, `select count(*) as n, min(timestamp) as lo, max(timestamp) as hi from ${table} where timestamp > 0`)[0];
    total += r.n;
    if (r.n) {
      if (low === null || r.lo < low) low = r.lo;
      if (high === null || r.hi > high) high = r.hi;
    }
  }
  if (values.json) console.log(jsonSafe({ messages: total, oldest: toDate(low)?.toISOString() ?? null, newest: toDate(high)?.toISOString() ?? null }));
  else if (!total) console.log("no messages held");
  else console.log(`${total} messages held, from ${fmt(toDate(low))} to ${fmt(toDate(high))}`);
}

// The read-only connection refuses ordinary writes, but VACUUM INTO and ATTACH still work on one,
// and either would put the texts somewhere the cleanup never reaches. So the statement is checked
// by its text first: exactly one statement, starting with SELECT, WITH, or VALUES, and no keyword
// that writes, attaches, or changes settings anywhere outside quotes and comments.
const FORBIDDEN = /\b(insert|update|delete|create|drop|alter|attach|detach|vacuum|reindex|pragma|analyze|begin|commit|rollback|savepoint|release)\b|\breplace\s+into\b/i;

function checkReadOnly(sql) {
  let bare = "";
  for (let i = 0; i < sql.length; i += 1) {
    const c = sql[i];
    const close = { "'": "'", '"': '"', "`": "`", "[": "]" }[c];
    if (close) {
      const end = sql.indexOf(close, i + 1);
      if (end < 0) throw new Failure("the query has an unclosed quote.");
      bare += " ";
      i = end;
    } else if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      bare += " ";
      i = end < 0 ? sql.length : end;
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end < 0) throw new Failure("the query has an unclosed comment.");
      bare += " ";
      i = end + 1;
    } else {
      bare += c;
    }
  }
  const body = bare.trim().replace(/;\s*$/, "");
  if (!body) throw new Failure("query needs one SQL statement.");
  if (body.includes(";")) throw new Failure("query runs exactly one statement.");
  if (!/^(select|with|values)\b/i.test(body)) throw new Failure("query runs only a SELECT, WITH, or VALUES statement.");
  const bad = FORBIDDEN.exec(body);
  if (bad) throw new Failure(`query refuses "${bad[0].trim()}", because it could write or reach outside the private copy.`);
}

function cmdQuery({ tmp }, { positionals }, DatabaseSync, opened) {
  checkReadOnly(positionals[0]);
  // A separate read-only connection, so a statement that tries to write fails instead of changing the copy.
  const db = new DatabaseSync(join(tmp, "phone.db"), { readOnly: true });
  opened.push(db);
  if (existsSync(join(tmp, "contacts.db"))) db.exec(`attach database '${join(tmp, "contacts.db").replace(/'/g, "''")}' as contacts`);
  for (const row of rows(db, positionals[0])) console.log(jsonSafe(row));
}

const COMMANDS = { contacts: cmdContacts, threads: cmdThreads, read: cmdRead, span: cmdSpan, query: cmdQuery };

function parse() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        since: { type: "string" },
        until: { type: "string" },
        with: { type: "string", multiple: true },
        grep: { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (err) {
    throw new Failure(`${err.message}. Run with --help for the commands.`);
  }
  const [command, ...positionals] = parsed.positionals;
  const values = { ...parsed.values };
  if (values.help || !command) return { help: true };
  const shape = COMMAND_SHAPE[command];
  if (!shape) throw new Failure(`unknown command "${command}". Run with --help for the commands.`);
  // --with takes several NAMEs after one flag, so for threads the trailing words belong to it.
  if (command === "threads" && values.with) {
    values.with = [...values.with, ...positionals];
    positionals.length = 0;
  }
  const extra = Object.keys(values).filter((key) => !shape.options.includes(key));
  if (extra.length) throw new Failure(`${command} does not take ${extra.map((k) => `--${k}`).join(", ")}.`);
  const count = positionals.length;
  if (shape.positionals === "none" && count) throw new Failure(`${command} takes no arguments, but got "${positionals.join(" ")}".${command === "threads" ? " To filter by people, use --with." : ""}`);
  if (shape.positionals === "one" && count !== 1) throw new Failure(`${command} takes exactly one argument${command === "query" ? ", the SQL statement in quotes" : ""}.`);
  if (shape.positionals === "some" && !count) throw new Failure(`${command} needs at least one NAME.`);
  return { command, values, positionals };
}

async function main() {
  const args = parse();
  if (args.help) {
    console.log(HELP);
    return;
  }
  const DatabaseSync = await loadSqlite();
  sweepStaleCopies();
  const opened = [];
  let tmp = null;
  try {
    tmp = mkdtempSync(join(tmpdir(), TMP_PREFIX));
    const dbs = snapshot(DatabaseSync, tmp, opened);
    COMMANDS[args.command](dbs, args, DatabaseSync, opened);
  } catch (err) {
    if (err instanceof Failure) throw err;
    if (err?.code === "ERR_SQLITE_ERROR") {
      if (args.command === "query") throw new Failure(`the query failed: ${err.message}`);
      throw new Failure(`the database copy is unreadable or its layout has changed (${err.message}). Retry once, since a copy taken mid-sync can be torn. If it fails again, the schema needs checking.`);
    }
    if (err?.code && /^E[A-Z]+$/.test(err.code)) {
      throw new Failure(`could not copy the database (${err.message}). Phone Link may be mid-sync: try again.`);
    }
    throw new Failure(`unexpected ${err?.name ?? "error"}: ${err?.message ?? err}`);
  } finally {
    for (const db of opened) {
      try {
        db.close();
      } catch {
        // Already closed.
      }
    }
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`error: ${err instanceof Failure ? err.message : err?.message ?? err}`);
  process.exitCode = 1;
});
