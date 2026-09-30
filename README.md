# Phone Link Texts Skill

An Agent Skill that lets an agent running on a Windows computer read the paired phone's text messages from Microsoft Phone Link's local database, read-only, without opening the app.

## How it works

Phone Link keeps a synced copy of the phone's recent messages in SQLite files on the computer. The skill's script copies those files to a temporary folder, reads the copy, resolves numbers to contact names, and deletes the copy before it exits. It never opens the live files as a database and never sends anything. The skill also maps the database, so an agent can query a copy directly for anything the script does not cover.

## Files

- `SKILL.md` covers when the skill applies, how to run the script, the privacy rules, and the gotchas.
- `scripts/phone-texts.mjs` lists contacts, conversations, messages, and the dates held.
- `references/schema.md` maps the database for direct queries.
- `package.json` exposes the script as a `bin`, so it runs from this repository without being installed.
- `AGENTS.md` is the maintenance contract for editing this skill.

## Running the script

Needs Phone Link paired with an Android phone, and Node.js 22.13 or later.

Without the skill on disk, straight from this repository:

```bash
npx --yes github:LeeorNahum/phone-link-texts-skill <command> [options]
```

With it on disk:

```bash
node <skill-root>/scripts/phone-texts.mjs <command> [options]
```

Run it with `--help` for the commands.

## Install

```bash
git submodule add https://github.com/LeeorNahum/phone-link-texts-skill.git .agents/skills/phone-link-texts
```
