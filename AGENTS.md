# AGENTS.md

Rules for editing the **phone-link-texts** skill. User-facing guidance lives in `SKILL.md`. `README.md` is the human skim layer.

## File roles

| File | Role |
| --- | --- |
| `SKILL.md` | When the skill applies, both run routes, the command table, privacy rules, and gotchas that change how output is read |
| `scripts/phone-texts.mjs` | The only executable: copies the database, runs one read command, deletes the copy |
| `references/schema.md` | Map of the database for agents that query it directly, and the record of what the script relies on |
| `package.json` | Exposes the script as a `bin` so `npx github:` runs it without an install |
| `README.md` | Short human summary |

## Design notes

- The description keeps a locality boundary: the skill applies only to an agent on the computer that holds Phone Link's files. A description that lets a cloud or remote agent load it wastes that agent's context on a file it cannot reach.
- The script is a shortcut for common reads, never the limit of the skill. Anything it does not cover stays reachable through the schema reference.
- The script stays read-only. It only copies the live files and never opens them as a database or writes them, never gains a way to send, and deletes the copy on every exit path, including failures. A leaked copy would leave the user's texts in a temporary folder.
- The script has no dependencies. It uses Node's built-in `node:sqlite` and `node:util` `parseArgs`, which is why it needs Node.js 22.13 or later. It silences only the SQLite experimental-feature warning.
- Timestamps and message types are read as BigInt, because Windows file times exceed JavaScript's safe integer range.

## Editing

- Keep the skill agnostic: no real names, phone numbers, thread ids, device ids, or project references in any file.
- Bump `metadata.version` by the release-versioning skill's rules for skills, and keep `package.json` on the same number.
- When Phone Link changes its schema, verify against a fresh copy and update `references/schema.md` and the script together.
- Quote frontmatter string values and keep bullets capitalized and parallel.
- Use no em dashes and no prose-joining semicolons.

## Before finishing

- `node --check scripts/phone-texts.mjs` passes, `--help` prints, and each command runs against a real database.
- Every failure path prints one `error:` line, exits 1, and leaves no `phone-texts-*` folder in the temporary directory.
- The skill-forge validator passes.
- `SKILL.md`, `README.md`, and `package.json` agree on the run routes, the Node version, and the version number.
