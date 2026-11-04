# Utility Soft (web)

The billing program **Utility Soft**, rebuilt as a web app for Google Chrome (or Microsoft
Edge). It keeps its data in its own folder, encrypted with your password
([the format](docs/data-format.md)). Your existing desktop (Java) data is moved there once,
as a checked copy; the desktop folder itself is not changed. Everything can be exported back
for the desktop version at any time.

## Install

Copy the **`Utility Soft`** folder from this repository anywhere on the computer
(Desktop, a USB stick…). That is the whole installation: no installer, no internet connection
needed.

To start, double-click **`Start Utility Soft.cmd`** in that folder. It always opens the app in
Google Chrome. Opening `Utility Soft.html` with Chrome or Edge works too. To update, copy the
folder again.

### Moving from the desktop version

Click **Open Utility Soft folder…**, choose the Java program folder (the one with
`billing.jar`, `pass.txt` and `impinfo.txt`), allow Chrome to edit files, and enter the
password. Then **Make a copy in the new format…**:

1. Choose where the copy goes (an empty folder, or a new *Utility Soft Data* folder inside the
   one you choose). It cannot go inside the desktop folder.
2. The app copies everything and checks every bill, client and setting against the desktop
   folder, which is only read. The report lists what was checked.
3. **Save the recovery code** (below).

From then on, use the web app on the copy. Bills entered in the desktop version afterwards are
not in it; Utility ▸ *Compare with a desktop folder* lists them. The desktop folder is not
encrypted, so once the copy is checked, move it to a USB stick or delete it.

### Starting from nothing

Click **Start a new Utility Soft…** and choose where to keep the files (Documents, D:\, …).
If that folder is empty it is used as it is; otherwise the app creates a new folder inside it
(named *Utility Soft Files* unless you type another name). Choose a password, save the
recovery code, and fill in your letterhead.

After that the app offers **Continue with “…”** and only asks for the password.

## Password, recovery code and privacy

- **Everything is encrypted** with a key locked by your password: client names, bills,
  settings, backups, even the problem log. Without the password (or the recovery code) the
  files cannot be read, by anyone using the computer.
- **The recovery code** is the only way in if the password is forgotten. Nobody can get it
  back for you. The app shows it once as a QR code, with steps beside it: scan it with the
  phone's camera and an email with the code opens, ready to send to yourself. Your mailbox
  keeps it, so it survives losing the phone. The app does not go on until you type back a
  part of the code from that email. On the password screen, *Forgot the password?*
  takes the code and lets you choose a new password. Utility ▸ *New recovery code* makes a
  new one; the old one stops working.
- **Locks itself after 15 minutes** without use, so a computer left on does not show the bills.
- **Exports for the desktop version are not encrypted**, because Java cannot read encrypted
  files. The app warns, and suggests a USB stick.
- The browser itself stores only which folders you chose, this computer's name and one
  preference. It stores no bills or passwords.

## Safety of the data

- **Backups every day:** inside the data folder, each checked file by file. The app keeps
  the last 7 days, 4 weeks and 12 months. Utility ▸ *Backups* lists them; each can be
  compared with the data now, and restored. A restore backs up the current data first, so it
  can be undone. *Back up now* copies to a folder of your choice (a USB stick); the backup on
  exit goes to a chosen folder, as in the desktop version.
- **Backups in Google Drive:** in Utility ▸ *Backups*, a copy of each backup can go to your Google
  Drive, encrypted, once a day with one click. Restore from there, or from the start screen
  on a new or lost computer. It works when Utility Soft is opened from its web address,
  https://rishabhjain08.github.io/Utility-Soft-Web/, with your own Google Cloud project, which is
  not part of the app (typed in once per computer, see [docs/google-drive-setup.md](docs/google-drive-setup.md)).
- **Deleted clients and bills** stay in a bin for 30 days (Utility ▸ *Deleted clients and
  bills*). This includes clients replaced by *Copy clients to another year*.
- **Undo and redo** in the bill editor (Ctrl+Z, Ctrl+Y), and **earlier versions of a bill**
  (Bill utility), kept every 10 minutes of work.
- **No half-done changes:** if the computer stops while, say, adding a client renumbers the
  others, the next opening finishes the change.
- **Two computers:** a client open on another computer says which one (Utility ▸ *This
  computer's name*) and since when. If both save the same bill, the second is asked which
  version to keep. An open-client mark from a computer that stopped lapses after 5 minutes.
- **A damaged file** is set aside with a warning in the client list, and its last good
  version can be put back.
- Utility ▸ *Problem log* lists what went wrong, on every computer, to send to whoever helps you.

## Beyond the desktop version

- **Payments:** under each bill, *Money received…* and *Agreed a lower amount…* (when a client
  negotiates the fee down: type the amount agreed for the whole bill). The bill itself and its
  printout stay as they are. The client list shows what each client was billed and what is
  due. **Payments** (Alt+P) lists every bill of a year, or of all years, with totals for
  billed, received, reduced and due. You can filter it to due or paid bills, search it,
  sort it, and open a bill from it.
- **Client details** (all optional): PAN, GSTIN, address, phone, email, in *Modify*. They are
  kept once per client, the same in every year, and PAN and GSTIN show at the top of the
  client's bills.
- **Bill No.:** *Add new* fills in the next free number (after the highest one used this
  year; in a new year, after the year before's). You can change it, or clear it. A Bill No.
  used by two clients is marked in the list, and *Modify* says who else has it. A client with
  several bills can have a range, such as 145-147.
- **One-click PDF** of a bill (*PDF* in the bill window), saved in Downloads, or *Share…*
  straight to WhatsApp, email and so on, where Windows offers it.
- **Search all years** (Ctrl+Shift+F): client names, bill names and any text in a bill, in
  every year; Enter opens it.
- **Tabs** (Utility ▸ *Tabs*): add, rename, reorder or hide bill types. A hidden tab still
  shows for a client that has bills in it.
- **Amounts with Indian commas** while typing (1,25,000); a bill row's text can be added to
  the drop-down list from its ⋯ menu; **?** lists every keyboard shortcut.

## Features (Java ▸ web)

| Java program | Web app |
| --- | --- |
| Password window, *Change* | Password screen (*Forgot the password?* with the recovery code); Utility ▸ *Change password* |
| Registration steps 2–3 (bill text, index-sheet title) | *Your letterhead* on first run; Utility ▸ *Letterhead* any time; both with a live preview of a sample bill and index sheet |
| Main list: year box, S.No./Name/Bill No., Add New, Modify, Delete, OK, Utility, Exit | Same, plus ‹ › year buttons, quick search box, multi-select (Ctrl/Shift-click) |
| Bill No. typed in the list | Double-click the Bill No. cell |
| Quick search by typing | Start typing anywhere in the list |
| Late entry (S.No. like 5A) | *Add new* and *Modify* show both outcomes for the name typed: the alphabetical S.No. (and whose numbers it shifts) or a lettered one that changes nobody else, for when the year's index sheet or bills are already printed |
| Bill window: type tabs, bill tabs, Field with drop-down, Amount, last 3 years with totals | Same; drop-down suggestions while typing (Ctrl+Space for all); earlier years stay linked when a client or bill is renamed |
| `##` for the year in bills and lists | Write the year as it is (“Assessment Year 26-27”): other years show their own |
| Insert Row, Delete Row, Move Up/Down | Drag rows by their ⋮⋮ handle; each row's ⋯ menu inserts or deletes; click row numbers to select several (Ctrl/Shift) |
| New Name (rows for another person, printed with their own subtotal) | *+ Add group*, or ⋯ ▸ *Start a new group from this row*: each group is shown as its own block with its subtotal, as printed |
| New Bill, Print, Done, year box | Same, plus undo/redo |
| Bill Utility: delete, rename, print the bills | *Bill utility…*, plus earlier versions of the bill |
| “Update bill to next year?” on Done | Same question |
| “File is already open on a computer” | Says which computer and since when; can *Open anyway* |
| Utility: Copy Data, Add Next Year, Print the Bills, Print the Menu, BackUp Data, Auto BackUp to, Add New Tab, Edit Drop Down List, Exit | Utility dialog with the same items (“Print the Menu” is *Print the index sheet*) |
| Load Data (data folder elsewhere) | Not needed: the data folder is the one opened (on a shared drive too) |
| Auto-backup question on exit (`dd.MM.yyyy+h.m.sAM` folders) | Same, same folder names; plus daily checked backups, compare and restore |
| — | Utility ▸ *Export for the desktop version*: a checked copy in the desktop layout, ready for `billing.jar` |
| — | Utility ▸ *Compare with a desktop folder*: every difference between desktop data and the web data |
| Print preview and printing (each bill twice per page) | Chrome's own print dialog, with its preview, printer choice and *Save as PDF* |
| List refreshes when another computer changes it | Same |

### Keyboard

Browsers reserve some of the Java program's shortcuts (Ctrl+N, Ctrl+Q, Ctrl+1…), so:

| Action | Keys |
| --- | --- |
| Open client | Enter / double-click |
| Add new client | Insert or Alt+N |
| Modify | F2 or Alt+M |
| Delete | Delete |
| Print bills of selected clients | Ctrl+P |
| Utility | Alt+U |
| Exit | Alt+Q |
| **Bill window:** undo / redo | Ctrl+Z / Ctrl+Y |
| Insert row / delete row (or the selected rows) | Ctrl+I / Ctrl+Delete |
| Move row (or the selected rows) up / down | Alt+↑ / Alt+↓ |
| Start a new group at the current row | Ctrl+B |
| New bill / Bill utility | Alt+N / Alt+U |
| Print this bill | Ctrl+P |
| Next year | Alt+→ |
| Done | Alt+← or Esc (Esc first leaves the cell you are typing in) |

## Compatibility with the desktop version

The move, the check and the export are described in [docs/data-format.md](docs/data-format.md).
An export keeps the Java program's format exactly:

- the shifted-character encoding of `pass.txt`, `impinfo.txt`, `backupto.txt`, `serialno.txt`,
  `billfromto.txt` and bill files;
- plain-text `ddown.txt`, `loaddatafrom.txt` and `activelocation.txt`;
- CRLF line endings, `##` for the year in bill rows;
- the folder layout `data/bills/<YY-YY>/<CLIENT>/<Type>/<BILL>.txt`.

S.No. renumbering, late entries and copying bills from the last three years follow the Java rules.

The `compat/` folder drives the original Java program to check this in both directions:

- **Web app to Java:** data changed in the web app and exported is opened, listed, edited and
  printed by Java.
- **Java to web app:** data written through the Java program's own windows is moved to the web
  format, and shows and prints the same.

### Bugs of the Java program that are fixed (not copied)

- Typing a Bill No. directly in the main list saved the client's S.No. as the bill no.
- Renaming a client split every bill row containing spaces into several rows.
- *New Name* rows were saved as `New Name,` so printed bills lost the per-person subtotals.
  Exports save them as `New Name,New`, which Java also prints with subtotals. Both forms are read.
- Deleting several clients at once renumbered the wrong clients; a client with an empty S.No.
  stopped the deletion.
- *Add New* for a client that existed last year replaced its new S.No. with last year's
  (duplicate numbers).
- *Cancel* or *Back* in the registration steps erased the bill-type line of `impinfo.txt`. Moving
  such a folder recovers the tabs from the folders on disk.
- *Add New Tab* crashed after creating the folders, so the tab never appeared.
- Amount in words: “Ninteen”, “Fourty”, “Eigthy”, “Ninty” misspelt; negative amounts printed as
  `-,200/-`; very large totals crashed. Rows without an amount printed a stray `/-`.
- *Copy Data* always took bills from the three years before the *To* year, whatever *From* was.
- Closing the “names being copied” window with × closed the whole program.
- Starting the program cleared every “already open” lock, including other computers' locks.
- A missing `backupto.txt`, data folder or backup folder crashed the program; a backup into an
  existing folder exited it.
- A Tab character or other control characters in any text corrupted the files.
- A wrong password was ignored silently.
- *Modify* with *Late entry* still moved every client after the old place down by one. Keeping
  the other numbers now keeps all of them; a client renamed without moving keeps its own S.No.
- Renaming a client or a bill cut it off from its earlier years (no amounts alongside, new bills
  starting empty). Now earlier years stay linked.

### Protecting the Java program from a crash in its own code

The Java program fails to open a bill when one of its rows matches (same text, ignoring case)
a row in the previous three years' copies of that bill whose only amount is blank or not a
number. This happens in ordinary use, for example when a person's name is typed without an
amount and the bill is carried into the next year.

The Java program can't be changed, so an export adds one or more trailing spaces to the text of
any row that would trip it. Java compares the text exactly, so the rows no longer match.
Trailing spaces are invisible on screen and on both versions' printouts, and moving data back
to the web format drops them again. Amounts are exported without a leading `+`, which older
Java runtimes cannot read.

## Development

```
npm install
npm run dev          # development server
npm run build        # builds and updates "Utility Soft/Utility Soft.html" (commit it)
npm run publish-pages  # publishes the build to the web address (gh-pages branch)
npm test             # unit tests (Node, real folders), including 40 generated round trips
SCALE=1 npx vitest run tests/scale.test.ts   # timings with 2,000 clients over 10 years
npx playwright test  # end-to-end customer journeys in Chrome
```

End-to-end tests replace Chrome's folder picker with folders on disk (`e2e/fs-shim.ts`), so
the Java checks can open the results; one test uses Chrome's real folder handles.

Java compatibility checks (Linux, needs `Xvfb`, a JDK 8 and the Java sources checked out next to
this repo as `../Utility-Soft`):

```
compat/build-java.sh
npx playwright test e2e/compat-build.spec.ts e2e/compat-repair.spec.ts && python3 compat/check_web_to_java.py
python3 compat/build_java_data.py && npx playwright test e2e/compat-read.spec.ts
```
