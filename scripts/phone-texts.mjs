#!/usr/bin/env node
// Read text messages from Phone Link's local database, read-only.
//
// Usage: phone-link-texts <command> [options]
//   contacts NAME [NAME ...]                    Contacts whose name or nickname contains each NAME.
//   threads [--since DATE] [--with NAME ...]    Conversations newest first, with participants.
//                                               --with keeps threads that include every NAME.
//   read THREAD_ID [--since DATE] [--grep RE]   Messages in one conversation, oldest first.
//   span                                        Dates of the oldest and newest message held.
//
// DATE is YYYY-MM-DD in local time. Each run reads a private copy of the database
// in a temporary folder and deletes it before exiting, including on failure. The
// live files are only copied, never opened as a database, and nothing is ever
// written or sent. Needs Node.js 22.13 or later for the built-in SQLite module.

import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const HELP = `phone-link-texts: read the paired phone's texts from Phone Link's local database, read-only.

Commands:
  contacts NAME [NAME ...]                    Contacts whose name or nickname contains each NAME.
  threads [--since DATE] [--with NAME ...]    Conversations newest first, with participants.
                                              --with keeps threads that include every NAME.
  read THREAD_ID [--since DATE] [--grep RE]   Messages in one conversation, oldest first.
  span                                        Dates of the oldest and newest message held.

DATE is YYYY-MM-DD in local time. RE is a case-insensitive regular expression.
Each run reads a private copy of the database and deletes it before exiting.
Nothing is ever written or sent.`;

const PACKAGE = join(process.env.LOCALAPPDATA ?? "", "Packages", "Microsoft.YourPhone_8wekyb3d8bbwe");
// Windows file times count 100-nanosecond ticks from 1601-01-01 UTC.
const EPOCH_OFFSET_MS = 11644473600000n;
const SENT = 2n;
const UNSENT = new Set([3n, 4n, 5n, 6n]); // Android: 3 draft, 4 outbox, 5 failed, 6 queued

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
    throw new Failure(`this script needs Node.js 22.13 or later for its built-in SQLite module. This is Node.js ${process.versions.node}.`);
  } finally {
    process.emitWarning = emit;
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
  return { phone, contacts };
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

function toFileTime(day) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day ?? "");
  const local = match && new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (!local || local.getMonth() !== Number(match[2]) - 1 || local.getDate() !== Number(match[3])) {
    throw new Failure(`--since must be a date like 2025-01-31, not "${day}"`);
  }
  return (BigInt(local.getTime()) + EPOCH_OFFSET_MS) * 10000n;
}

function fmt(date) {
  if (!date) return "no date";
  const pad = (n) => String(n).padStart(2, "0");
  const day = date.toLocaleDateString("en-US", { weekday: "short" });
  const hours = date.getHours() % 12 || 12;
  const half = date.getHours() < 12 ? "AM" : "PM";
  return `${day} ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(hours)}:${pad(date.getMinutes())}${half}`;
}

function participants(phone, book) {
  const out = new Map();
  for (const { thread_id, normalized_address } of rows(phone, "select thread_id, normalized_address from participant")) {
    const list = out.get(thread_id) ?? [];
    list.push(book.get(digits(normalized_address)) ?? normalized_address);
    out.set(thread_id, list);
  }
  return out;
}

function sender(type, from, book) {
  if (type === SENT) return "me";
  if (UNSENT.has(type)) return "me (not sent)";
  return book.get(digits(from)) ?? (from || "unknown");
}

function cmdContacts({ contacts }, { positionals }) {
  if (!contacts) throw new Failure("contacts.db is missing, so names cannot be resolved.");
  if (!positionals.length) throw new Failure("contacts needs at least one NAME.");
  const all = rows(contacts, "select display_name, nickname from contact");
  for (const query of positionals) {
    const q = query.toLowerCase();
    const hits = all
      .filter(({ display_name: dn, nickname: nn }) => (dn ?? "").toLowerCase().includes(q) || (nn ?? "").toLowerCase().includes(q))
      .map(({ display_name: dn, nickname: nn }) => (dn && nn ? `${dn} (${nn})` : dn || nn));
    console.log(`${query}: ${hits.length ? hits.join(", ") : "no match"}`);
  }
}

function cmdThreads({ phone, contacts }, { values }) {
  const book = nameBook(contacts);
  const people = participants(phone, book);
  const since = values.since ? toFileTime(values.since) : 0n;
  const wanted = (values.with ?? []).map((w) => w.toLowerCase());
  const list = rows(phone, "select thread_id, timestamp, msg_count from conversation where timestamp >= ? and msg_count > 0 order by timestamp desc", since);
  for (const { thread_id, timestamp, msg_count } of list) {
    const names = people.get(thread_id) ?? [];
    if (!names.length) continue;
    if (wanted.length && !wanted.every((w) => names.some((n) => String(n).toLowerCase().includes(w)))) continue;
    console.log(`${thread_id}\t${fmt(toDate(timestamp))}\t${msg_count} msgs\t${names.length} people\t${[...names].sort().join(", ")}`);
  }
}

function cmdRead({ phone, contacts }, { values, positionals }) {
  if (!/^\d+$/.test(positionals[0] ?? "")) throw new Failure("read needs a THREAD_ID from the threads command.");
  const thread = BigInt(positionals[0]);
  const since = values.since ? toFileTime(values.since) : 0n;
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
  for (const m of rows(phone, "select timestamp, from_address, type, body from message where thread_id = ? and timestamp >= ?", thread, since)) {
    messages.push([m.timestamp, sender(m.type, m.from_address, book), m.body ?? ""]);
  }
  for (const m of rows(phone, "select message_id, timestamp, from_address, type from mms where thread_id = ? and timestamp >= ?", thread, since)) {
    const parts = rows(phone, "select content_type, text from mms_part where message_id = ?", m.message_id);
    let text = parts.filter((p) => p.content_type === "text/plain" && p.text).map((p) => p.text).join(" ");
    const attached = parts.map((p) => p.content_type).filter((ct) => ct !== "text/plain" && ct !== "application/smil");
    if (attached.length) text += ` [${attached.join(", ")}]`;
    messages.push([m.timestamp, sender(m.type, m.from_address, book), text.trim() || "[no text]"]);
  }
  messages.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  let shown = 0;
  for (const [ts, who, text] of messages) {
    if (pattern && !pattern.test(text)) continue;
    shown += 1;
    console.log(`${fmt(toDate(ts))} | ${who}: ${text}`);
  }
  console.log(`${shown} of ${messages.length} messages shown`);
  const rcs = rows(phone, "select count(*) as n from rcs_chat")[0].n;
  if (rcs) console.error(`note: the database holds ${rcs} chat-feature (RCS) messages, which this script does not read.`);
}

function cmdSpan({ phone }) {
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
  if (!total) console.log("no messages held");
  else console.log(`${total} messages held, from ${fmt(toDate(low))} to ${fmt(toDate(high))}`);
}

const COMMANDS = { contacts: cmdContacts, threads: cmdThreads, read: cmdRead, span: cmdSpan };

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        since: { type: "string" },
        with: { type: "string", multiple: true },
        grep: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (err) {
    throw new Failure(`${err.message}\n\n${HELP}`);
  }
  const [command, ...positionals] = parsed.positionals;
  if (parsed.values.help || !command) {
    console.log(HELP);
    return;
  }
  const run = COMMANDS[command];
  if (!run) throw new Failure(`unknown command "${command}".\n\n${HELP}`);
  // --with takes one NAME per flag (--with A --with B), or several NAMEs after one flag for threads.
  const values = { ...parsed.values };
  if (command === "threads" && values.with && positionals.length) {
    values.with = [...values.with, ...positionals];
    positionals.length = 0;
  }
  const DatabaseSync = await loadSqlite();
  const tmp = mkdtempSync(join(tmpdir(), "phone-texts-"));
  const opened = [];
  try {
    const dbs = snapshot(DatabaseSync, tmp, opened);
    run(dbs, { values, positionals });
  } catch (err) {
    if (err instanceof Failure) throw err;
    if (err?.code === "ERR_SQLITE_ERROR") {
      throw new Failure(`the database copy is unreadable or its layout has changed (${err.message}). Retry once, since a copy taken mid-sync can be torn. If it fails again, the schema needs checking.`);
    }
    if (err?.code && /^E[A-Z]+$/.test(err.code)) {
      throw new Failure(`could not copy the database (${err.message}). Phone Link may be mid-sync: try again.`);
    }
    throw err;
  } finally {
    for (const db of opened) db.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err instanceof Failure ? `error: ${err.message}` : err);
  process.exitCode = 1;
});
