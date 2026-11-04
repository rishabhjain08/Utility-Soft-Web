# Utility Soft data format (web)

The web app keeps its data in one folder of plain JSON files. It replaces the
desktop (Java) layout. That layout can still be read (*Move to the new format*,
*Compare*) and written (*Export for the desktop version*). The web app can also
still work directly on desktop files if you choose to.

```
<folder>/
  utility-soft.json              settings
  years/
    06-07/
      k3j9x0q2ma.json            one client in one year
      …
    07-08/
      k3j9x0q2ma.json            the same client the next year (same id)
  open/
    07-08 MOHAN.lock             a client open on a computer right now
  desktop-extras/                files of the desktop data folder the app does not use, kept as they were
    bills/06-07/MOHAN/letter.doc
```

## Why it is shaped like this

- **One file per client and year.** The client list of a year reads one small
  file per client; the desktop layout needed a folder per client plus two files
  for S.No. and Bill No., and a file per bill. A client's bills are saved
  together, so one save cannot leave it half-written. A file is replaced in one
  step: the browser writes a temporary copy and swaps it in.
- **A client keeps its id from year to year.** Earlier years are found by id,
  not by name. A client renamed this year still shows last year's amounts, and
  its new bills start from last year's rows. In the desktop layout this link was
  lost on renaming. Each year keeps its own name, S.No. and Bill No., as before,
  so old index sheets stay as they were printed.
- **Groups are explicit.** A bill is a list of groups, and each group is a list
  of rows. The desktop version marked a new group with a `New Name` row (written
  `New Name,New`, `New Name,` or `New Name,0`).
- **No workarounds for the desktop version.** The trailing spaces that stop the
  Java program from failing on some bills (`protectForJava`) are not stored.
  They are added again on export.
- **A real password hash.** The password is stored as PBKDF2-SHA256 (100,000
  rounds, random salt), not shifted characters. The bills themselves are plain
  JSON, readable in any text editor.
- **The same rules for names and text as the desktop layout.** For example, no
  `\ / : * ? " < > |` in names, and no `%` in the letterhead. This is why every
  web folder can be exported back without losing anything.
- **Open clients are one file each.** Two computers opening different clients
  never write the same file. In the desktop layout they shared
  `activelocation.txt`.
- **A version number.** `format` and `version` in `utility-soft.json` let a later
  app upgrade old folders. They also let an older app refuse a newer folder
  instead of misreading it.

## utility-soft.json

```json
{
  "format": "utility-soft",
  "version": 1,
  "password": { "kdf": "PBKDF2-SHA256", "iterations": 100000, "salt": "…", "hash": "…" },
  "letterhead": {
    "firmName": ["For JAIN & CO.", "Chartered Accountants"],
    "firmAddress": ["12, Gandhi Road", "New Delhi"],
    "indexTitles": ["INDEX OF BILLS ##", "", ""]
  },
  "billTypes": [{ "folder": "Audit", "tab": "Audit" }, { "folder": "Vat", "tab": "Vat" }],
  "dropdowns": [{ "tab": "Audit", "items": ["Fee for Tax Audit for the Assessment Year ##", "Expenses"] }],
  "autoBackup": "D:\\Backups",
  "desktop": { "impinfoExtra": [], "extras": ["bills/06-07/MOHAN/letter.doc"] },
  "migratedFrom": { "at": "2026-11-03T18:30:00.000Z", "folder": "Utility Soft", "data": "Utility Soft\\data" }
}
```

- `letterhead` is `null` until it is filled in; the first run asks for it.
- `billTypes`: `tab` is the title shown; `folder` is the folder name in the
  desktop layout, which bills refer to as their `type`.
- `dropdowns` are the lines of the desktop `ddown.txt`. `##` stands for the year.
- `desktop` holds what only the desktop version uses, so that exporting gives it
  back: `impinfo.txt` lines after the letterhead, and the paths of the files in
  `desktop-extras`.

## years/&lt;YY-YY&gt;/&lt;id&gt;.json

```json
{
  "id": "k3j9x0q2ma",
  "name": "MOHAN",
  "serial": "1A",
  "billNo": "12-14",
  "bills": [
    {
      "type": "Vat",
      "name": "VAT AUDIT",
      "groups": [
        { "rows": [{ "text": "Fee for VAT Audit for the Assessment Year ##", "amount": "700" }, { "text": "Expenses", "amount": "50" }] },
        { "rows": [{ "text": "Fee for IT Return", "amount": "1200" }] }
      ]
    }
  ]
}
```

- A year exists when its folder exists, even if it is empty.
- `serial`, `billNo` and `amount` are text, kept exactly as entered, so nothing
  is lost from the desktop data. For example, `5A` is a valid S.No., and
  amounts the desktop version stored are kept even when they are not numbers.
- `##` in a row's text stands for the bill's own year. When a bill is carried
  forward, it shows the new year.

## Moving from the desktop layout (migration)

*Open Utility Soft folder* on a desktop folder, then the password, then *Make a
copy in the new format*. It is also under Utility ▸ *Move to the new format*.

- The copy always goes into a new or empty folder, never inside the desktop
  program or data folder. The desktop folders are opened read-only: any attempt
  to write there fails (`readOnly` in `src/core/fs.ts`). The tests check that
  every file and modified time is unchanged afterwards.
- These become the format above: clients, S.No., Bill No., bills, letterhead,
  tabs (including tabs lost from `impinfo.txt`, recovered from the folders),
  drop-down lists, the auto-backup folder and the password.
- Every other file or folder in the data folder is copied byte for byte into
  `desktop-extras`. This includes notes, scans, the Java program's temporary
  `1q2m.txt`, and folders of tabs that no longer exist.
- `activelocation.txt` is not copied, because it only lists clients open at the
  time. If any are open, the app warns first.
- `utility-soft.json` is written last, so a copy that stopped half way cannot be
  opened.

## Verification

After a migration or an export, the app compares the two folders and lists
every difference. The same check is available any time as Utility ▸ *Compare
with a desktop folder*, for example to see what was entered in the desktop
version after moving.

- The desktop side is read the way the web app reads desktop files, and the web
  side the way it reads its own. So the check compares what each one shows.
- It compares:
  - the password (by its hash), tabs, letterhead, drop-down lists and auto-backup folder;
  - every year;
  - every client, with its S.No. and Bill No.;
  - every bill, row by row.
- Two things do not count as differences:
  - trailing spaces on a row's text;
  - how a new group is marked. The report says how many rows this applies to.
- Every file of the desktop data folder that is not one of the above must be
  in `desktop-extras` with the same bytes. Every file there must still be in
  the desktop folder.

## Export for the desktop version

Utility ▸ *Export for the desktop version* writes a complete desktop program
folder into a new folder:

- `pass.txt`, `impinfo.txt`, `ddown.txt`, `backupto.txt` and an empty `loaddatafrom.txt`;
- `data\activelocation.txt` (empty);
- `data\bills\<year>\<client>\…`, with the kept files put back where they were.

- Rows the Java program could not open get their trailing spaces back.
- Kept files whose client was deleted or renamed go into `Other files` next to
  `data`, so that no stray client folder appears.
- The export is then compared with the web data like a migration.
- To run the desktop version on it, copy `billing.jar` and its `lib` folder into
  the export.

The real Java program is tested on such exports by `compat/check_web_to_java.py`.
