# Utility Soft data format (web)

The web app keeps its data in one folder. Every file in it is encrypted except
`utility-soft.json`. Without the password or the recovery code, nobody can read
anything there, not even client names. It replaces the desktop (Java) layout.
That layout can still be read (*Move to the new format*, *Compare*) and written
(*Export for the desktop version*).

```
<folder>/
  utility-soft.json              format, version, and the data key locked by the password and by the recovery code
  settings.dat                   letterhead, tabs, drop-down lists, auto-backup folder
  years/
    06-07/
      k3j9x0q2ma.dat             one client in one year
    07-08/
      k3j9x0q2ma.dat             the same client the next year (same id)
  open/<hash>.lock               a client open on a computer right now
  journal/<time>-<id>.dat        a change of several files, while it is being made
  history/<path>/<time>.dat      earlier versions of each client file and of the settings
  bin/<time>-<id>.dat            deleted clients and bills, kept 30 days
  extras/<id>.dat                files of the desktop data folder the app does not use
  backups/<date time>/           automatic daily backups
  logs/<month> <computer>.dat    problems, for support
```

## Encryption

- **One data key encrypts every file.** It is a random 256-bit AES-GCM key.
- **The key is stored only locked**, in `utility-soft.json`, in two ways:
  - by the password, through PBKDF2-SHA256 with 600,000 rounds;
  - by the recovery code (24 characters, 120 random bits).
- **Changing the password re-locks the key only.** Nothing else is re-encrypted,
  and old backups still open with the old password or the recovery code.
- **The recovery code is shown once**, as a QR code, with steps to save it on a
  phone (Google Keep). The app does not go on until a part of it is typed back.
  Until then, `utility-soft.json` says `recoverySaved: false` and the app asks
  again. Utility ▸ *New recovery code* makes a new one; it needs the password,
  and the old code stops working only once the new one is saved.
- **Each encrypted file** is `USW1` + a 12-byte IV + the AES-GCM ciphertext and
  tag. The file's path inside the folder is authenticated with it, so files
  cannot be swapped or changed unnoticed: a changed file is reported as damaged.
- **File names reveal nothing.** Clients are files named by a random id.
  Open-client files are named by a keyed hash of year and name. Kept desktop
  files are blobs whose real paths are in the encrypted settings.
- **The app locks itself after 15 minutes without use**, and asks for the
  password again.
- **What is not encrypted:** an export for the desktop version, because the Java
  program cannot read encrypted files. The desktop folder a copy was made from is
  not encrypted either. The app says so and suggests a USB stick or deleting it.

## Why it is shaped like this

- **One file per client and year.** A client's name, S.No., Bill No. and all its
  bills change together and can be read in one go. A file is replaced in one step:
  the browser writes a temporary copy and swaps it in.
- **A client keeps its id from year to year, and so does a bill.** Earlier years
  are found by id, not by name. A client or bill renamed this year still shows
  last year's amounts, and its new bills start from last year's rows. Each year
  keeps its own name, S.No. and Bill No., so old index sheets stay as they were
  printed.
- **Changes of several files are safe.** Adding or removing a client renumbers
  the others. Such a change first writes the journal, then the files. If the
  computer stops half way, the next opening (by any computer) finishes it. Files
  changed again since then are left as they are, because that change is newer.
- **Earlier versions.** Before a client file or the settings change, the previous
  version is kept: at most one every 10 minutes while editing, always before a
  delete, 30 per file. They give *Earlier versions of the bill*, and a way back
  for a damaged file. Routine S.No. renumbering keeps no versions.
- **The bin.** Deleted clients and bills, and clients replaced by *Copy clients
  to another year*, are kept for 30 days and can be put back.
- **Conflicts are caught.** The editor remembers each bill as it read it. A save
  that finds the bill changed on another computer stops and asks which version
  to keep. The other one stays as an earlier version.
- **Open clients name the computer.** An open-client file says which computer
  (named in Utility) and since when. It is renewed every minute, and is ignored
  after 5 minutes without renewal, so a computer that stopped does not block
  anyone. Each lock is its own file, so two computers never write the same one.
- **Cheap to check for changes.** Client files are read again only when their
  size or modification time changes, so the list can be refreshed often.
- **Amounts are whole numbers.** `amount` is a number, or `null` when empty.
  Amounts the desktop version stored that are not plain whole numbers (`12a`,
  `007`) are kept exactly in `raw`. The editor marks them, and they do not count
  in totals, as in the desktop version.
- **Years are written out.** Bill rows, drop-down entries and the index title are
  shown and typed with the year written out, such as "Assessment Year 26-27".
  They are stored with `##` in its place, so that in other years they show that
  year. Nobody has to type `##`.
- **The same rules for names and text as the desktop layout.** For example, no
  `\ / : * ? " < > |` in names, and no `%` in the letterhead. This is why every
  folder can be exported back without losing anything.
- **A version number.** A folder from a newer app is refused rather than misread.

## Contents (after decryption)

`settings.dat`:

```json
{
  "letterhead": { "firmName": ["For JAIN & CO."], "firmAddress": ["12, Gandhi Road"], "indexTitles": ["INDEX OF BILLS ##", "", ""] },
  "billTypes": [{ "folder": "Audit", "tab": "Audit" }],
  "dropdowns": [{ "tab": "Audit", "items": ["Fee for Tax Audit for the Assessment Year ##", "Expenses"] }],
  "autoBackup": "Backups",
  "desktop": { "impinfoExtra": [], "extras": ["bills/06-07/MOHAN/letter.doc"], "files": [{ "path": "bills/06-07/MOHAN/letter.doc", "blob": "q8…" }] },
  "migratedFrom": { "at": "2026-11-04T10:00:00.000Z", "folder": "Utility Soft", "data": "Utility Soft\\data" }
}
```

`years/<YY-YY>/<id>.dat`:

```json
{
  "v": 1, "id": "k3j9x0q2ma", "name": "MOHAN", "serial": "1A", "billNo": "12-14",
  "bills": [
    { "id": "b1x9…", "type": "Vat", "name": "VAT AUDIT",
      "groups": [
        { "rows": [{ "text": "Fee for VAT Audit for the Assessment Year ##", "amount": 700 }, { "text": "Expenses", "amount": 50 }] },
        { "rows": [{ "text": "Fee for IT Return", "amount": 1200 }] }
      ] }
  ]
}
```

- A year exists when its folder exists, even if empty.
- Groups are rows printed together with their own subtotal. The desktop version
  separates them with `New Name` rows.
- `##` stands for the bill's own year.

## Backups

A backup is a folder holding copies of the encrypted data files, plus
`utility-soft.json` and `backup.json`. The last lists a SHA-256 of every file,
so a damaged backup is noticed before it is used. A backup opens like the
original, with the password or the recovery code of its time.

- **Automatically:** one a day, inside the data folder, when the app is opened.
  It keeps the newest of each of the last 7 days, 4 weeks and 12 months.
- **When exiting:** into the chosen folder (as the desktop version does), with the
  same kind of thinning.
- **Back up now:** into any folder, such as a USB stick.
- **Restoring:** the app shows what differs, then backs up the current data
  first, so a restore can be undone. It keeps the password and this computer's
  auto-backup folder.

## Moving from the desktop layout (migration)

*Open Utility Soft folder* on a desktop folder, then the password, then *Make a
copy in the new format*.

- **Where the copy goes:** always into a new or empty folder, never inside the
  desktop program or data folder.
- **The desktop folders are only read.** Any attempt to write there fails
  (`readOnly` in `src/core/fs.ts`). Tests check that every file and modification
  time is unchanged afterwards. A desktop folder without `pass.txt` gets a
  password for the copy; nothing is written to the folder.
- **What carries over:** clients, S.No., Bill No., bills, letterhead, tabs
  (including tabs lost from `impinfo.txt`, recovered from the folders), drop-down
  lists, the auto-backup folder and the password.
- **Other files** in the data folder are kept byte for byte, encrypted.
- **Clients open in the desktop version:** the app warns first.
- **Written last:** `utility-soft.json`, so a copy that stopped half way cannot
  be opened.

## Verification

After a move or an export, the app compares the two and lists every difference.
Utility ▸ *Compare with a desktop folder* does the same at any time. Each backup
can also be compared with the data now.

- **How each side is read:** the desktop side the way the Java program reads it,
  the web side through the app. So what is compared is what each one shows.
- **What is compared:**
  - the password, tabs, letterhead, drop-down lists and auto-backup folder;
  - every year;
  - every client, with its S.No. and Bill No.;
  - every bill, row by row;
  - every other file, byte for byte.
- **Not counted as differences:**
  - trailing spaces on a row's text;
  - how a new group is marked.

  The report says how many rows this applies to.

## Export for the desktop version

Utility ▸ *Export for the desktop version* writes a complete desktop program
folder into a new folder:

- `pass.txt`, `impinfo.txt`, `ddown.txt`, `backupto.txt` and `loaddatafrom.txt`;
- `data\activelocation.txt` and `data\bills\…`;
- the kept files, back where they were.

- Rows the Java program could not open get their trailing spaces back.
- Kept files of a deleted or renamed client go into `Other files`.
- The export is then checked.
- To use it, copy `billing.jar` and its `lib` folder into it.
- The export is not encrypted.

The real Java program is tested on such exports by `compat/check_web_to_java.py`.
