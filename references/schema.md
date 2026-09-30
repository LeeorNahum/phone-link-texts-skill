# Phone Link Database Schema

Read this before writing SQL for the script's `query` command, such as a search across every conversation, a count, or a filter by sender. `query` runs against the script's own private copy, read-only, with the contacts database attached as `contacts`, and deletes the copy afterwards, so there is no reason to copy the files by hand. The privacy rules in the skill apply to every query.

- The databases live under `%LOCALAPPDATA%\Packages\Microsoft.YourPhone_8wekyb3d8bbwe\LocalCache\Indexed\<device>\System\Database\`, one folder per pairing, and a re-paired phone can leave an old folder behind: `phone.db` for messages, `contacts.db` for names.
- Both run in WAL mode, so the newest rows sit in the `-wal` file beside each database and `phone.db` itself can lag by hours. Copy the `-wal` with the database, and compare the `-wal` modification time when picking the newest phone. The `-shm` file is a rebuildable cache and is not copied.
- `conversation` holds one row per thread, keyed by `thread_id`, including many empty ones with no participants. `participant` maps `thread_id` to addresses.
- Plain SMS is in `message`, keyed to a thread by `thread_id`, with the text in `body`. Everything else, including most one-to-one texts and all group texts, is in `mms`, also keyed by `thread_id`, with text in `mms_part` rows joined on `message_id` whose `content_type` is `text/plain`. `application/smil` parts are layout, not content.
- `type` follows Android: 1 received, 2 sent by the phone's owner, 3 to 6 drafts and unsent states.
- Timestamps are Windows file times: 100-nanosecond units since 1601-01-01 UTC. `query` prints them as strings, because they exceed JavaScript's safe integer range. `timestamp / 10000 - 11644473600000` in SQL turns one into Unix milliseconds, and `datetime(timestamp / 10000000 - 11644473600, 'unixepoch', 'localtime')` into a local date and time.
- `rcs_chat`, `rcs_conversation`, and `rcs_filetransfer` exist and may be empty. RCS threads appear to use their own ids, mapped through `conversation_attribute.rcs_thread_id` and `rcs_conversation.fallback_id`, which is unverified while the tables are empty. The script does not read them and only warns when `rcs_chat` has rows.
- `contact` holds `display_name` and `nickname`. `phonenumber` maps `contact_id` to numbers, and a few numbers belong to more than one contact.
- Addresses are stored in mixed formats. Match a participant or sender to a contact on the trailing ten digits, and expect short codes and alphanumeric sender ids that match nothing.
