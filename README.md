# Utility Soft (web)

The billing program **Utility Soft**, rebuilt as a web app for Google Chrome (or Microsoft
Edge). It keeps its data in its own folder of plain files ([the format](docs/data-format.md)).
Your existing desktop (Java) data is moved there once, by making a checked copy; the desktop
folder is not changed. Everything can be exported back for the desktop version at any time.
The web app can also still work directly on the desktop files, side by side with the Java program.

## Install

Copy the **`Utility Soft`** folder from this repository anywhere on the computer
(Desktop, inside the Java program folder, a USB stick…). That is the whole installation:
no installer, no internet connection needed.

To start, double-click **`Start Utility Soft.cmd`** in that folder. It always opens the app in
Google Chrome. Opening `Utility Soft.html` with Chrome or Edge works too. To update, copy the
folder again.

The first time, click **Open Utility Soft folder…** and choose the Java program folder (the
one with `billing.jar`, `pass.txt` and `impinfo.txt`), allow Chrome to edit files, then enter the
password. The app then offers to **move to the new format**:

- **Make a copy in the new format…** copies everything into a new folder you choose (an empty
  one, or a new *Utility Soft Data* folder inside it) and checks every bill, client and setting
  against the desktop folder, which is only read, never changed. The report lists what was
  checked. From then on, use the web app on the copy; bills entered in the desktop version
  afterwards are not in it (Utility ▸ *Compare with a desktop folder* lists them).
- **Keep using the desktop files** works on them directly, as before (and Utility ▸ *Move to the
  new format* is there for later).

After that the app offers **Continue with “…”** and only asks for the password.

Starting from nothing? Click **Start a new Utility Soft…** and choose where to keep the files
(Documents, D:\, …). If that folder is empty it is used as it is; otherwise the app creates a new
folder inside it (named *Utility Soft Files* unless you type another name). Then choose a password
and fill in your letterhead. To use the desktop (Java) version on it later, use Utility ▸ *Export
for the desktop version*.

## Password and stored files

- Nothing is shown before the password is entered. A copy keeps the desktop version's password.
  It can be changed on the password screen (*Change password*) or under Utility.
- In the web format the password is stored only as a hash (PBKDF2); bills and settings are plain
  JSON, readable with any text editor. See [the format](docs/data-format.md).

On the desktop files:

- The password is the Java version's, kept in `pass.txt`.
- Like the Java version, files are stored scrambled with its simple character-shift scheme:
  the password, letterhead and bill types (`impinfo.txt`), backup folder (`backupto.txt`),
  every bill, S.No. and Bill No. This keeps casual readers out; it is not strong encryption.
- As in the Java version, these are plain text: folder names (years, client names, bill and tab
  names), the drop-down lists (`ddown.txt`), the data location (`loaddatafrom.txt`) and the list
  of clients open right now (`activelocation.txt`).
- The browser itself stores only which folders you chose (and which desktop folders were copied
  where) and one preference (whether to ask for a backup on exit). It stores no bills or passwords.

### Where the data is

In the web format, all data is in the one folder you opened. On the desktop files:

- Data is read from `<program folder>\data` unless `loaddatafrom.txt` names another folder
  (Utility ▸ *Data location*). Browsers cannot see full folder paths. So when the data
  folder is outside the program folder, the app asks you to select it once and to type its
  full path, which the Java version needs.
- The same applies to the auto-backup folder (`backupto.txt`).

## Features (Java ▸ web)

| Java program | Web app |
| --- | --- |
| Password window, *Change* | Login screen, *Change password* (also in Utility) |
| Registration steps 2–3 (bill text, index-sheet title) | *Your letterhead* on first run; Utility ▸ *Letterhead* any time; both with a live preview of a sample bill and index sheet |
| Main list: year box, S.No./Name/Bill No., Add New, Modify, Delete, OK, Utility, Exit | Same, plus ‹ › year buttons, quick search box, multi-select (Ctrl/Shift-click) |
| Bill No. typed in the list | Double-click the Bill No. cell |
| Quick search by typing | Start typing anywhere in the list |
| Late entry (S.No. like 5A) | *Add new* and *Modify* show both outcomes for the name typed: the alphabetical S.No. (and whose numbers it shifts) or a lettered one that changes nobody else, for when the year's index sheet or bills are already printed |
| Bill window: type tabs, bill tabs, Field with drop-down, Amount, last 3 years with totals | Same; drop-down suggestions while typing (Ctrl+Space for all) |
| Insert Row, Delete Row, Move Up/Down | Drag rows by their ⋮⋮ handle; each row's ⋯ menu inserts or deletes; click row numbers to select several (Ctrl/Shift) |
| New Name (rows for another person, printed with their own subtotal) | *+ Add group*, or ⋯ ▸ *Start a new group from this row*: each group is shown as its own block with its subtotal, as printed. Saved as Java's `New Name` row |
| New Bill, Print, Done, year box | Same |
| Bill Utility: delete, rename, print the bills | *Bill utility…* |
| “Update bill to next year?” on Done | Same question |
| “File is already open on a computer” (`activelocation.txt`) | Same lock file; can *Open anyway* if a lock was left behind |
| Utility: Copy Data, Add Next Year, Print the Bills, Print the Menu, BackUp Data, Auto BackUp to, Load Data, Add New Tab, Edit Drop Down List, Exit | Utility dialog with the same items (“Print the Menu” is *Print the index sheet*) |
| Auto-backup question on exit (`dd.MM.yyyy+h.m.sAM` folders) | Same, same folder names; a web-format backup opens like the original |
| — | Utility ▸ *Move to the new format*: a checked copy in the web format (the desktop folder is not changed) |
| — | Utility ▸ *Export for the desktop version*: a checked copy in the desktop layout, ready for `billing.jar` |
| — | Utility ▸ *Compare with a desktop folder*: every difference between desktop data and the web data |
| Print preview and printing (each bill twice per page) | Chrome's own print dialog, with its preview, printer choice and *Save as PDF* |
| List refreshes when another computer changes it | Same, both ways (web ↔ Java) |

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
| **Bill window:** insert row / delete row (or the selected rows) | Ctrl+I / Ctrl+Delete |
| Move row (or the selected rows) up / down | Alt+↑ / Alt+↓ |
| Start a new group at the current row | Ctrl+B |
| New bill / Bill utility | Alt+N / Alt+U |
| Print this bill | Ctrl+P |
| Next year | Alt+→ |
| Done | Alt+← or Esc (Esc first leaves the cell you are typing in) |

## Compatibility

The web format is described in [docs/data-format.md](docs/data-format.md): how it is moved from
the desktop layout, checked, and exported back.

On the desktop files (and in an export), all files keep the Java program's format: the shifted-character encoding of `pass.txt`,
`impinfo.txt`, `backupto.txt`, `serialno.txt`, `billfromto.txt` and bill files; plain-text
`ddown.txt`, `loaddatafrom.txt` and `activelocation.txt`; CRLF line endings; `##` for the
year in bill rows; and the same folder layout `data/bills/<YY-YY>/<CLIENT>/<Type>/<BILL>.txt`.
S.No. renumbering, late entries and copying bills from the last three years follow the Java
rules.

The `compat/` folder drives the original Java program to check this in both directions:
data written by the web app (on the desktop files, and in the web format then exported) is
opened, listed, edited and printed by Java, and data written through the Java program's own
windows is opened and printed by the web app, directly and after moving it to the web format.

### Bugs of the Java program that are fixed (not copied)

- Typing a Bill No. directly in the main list saved the client's S.No. as the bill no.
- Renaming a client split every bill row containing spaces into several rows.
- *New Name* rows were saved as `New Name,` so printed bills lost the per-person subtotals.
  They are now saved as `New Name,New`, which Java also prints with subtotals. Both forms are read.
- Deleting several clients at once renumbered the wrong clients; a client with an empty S.No.
  stopped the deletion.
- *Add New* for a client that existed last year replaced its new S.No. with last year's
  (duplicate numbers).
- *Cancel* or *Back* in the registration steps erased the bill-type line of `impinfo.txt`. Files
  already damaged this way are repaired from the folders on disk.
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
- Renaming a client cut it off from its earlier years (no amounts alongside, new bills starting
  empty). In the web format a client keeps its earlier years through renames.

### Protecting the Java program from a crash in its own code

The Java program fails to open a bill when one of its rows matches (same text, ignoring case)
a row in the previous three years' copies of that bill whose only amount is blank or not a
number. This happens in ordinary use, for example when a person's name is typed without an
amount and the bill is carried into the next year. It then also leaves the client marked
"already open" until Java restarts.

The Java program can't be changed, so the web app keeps the data clear of this:

- Whenever it saves, creates, renames or copies a bill, it checks that bill against the previous
  three years, and checks the next three years' copies against it. Any row that would trip the
  Java program gets one or more trailing spaces added to its text. Java compares the text
  exactly, so the rows no longer match. Trailing spaces are invisible on screen and on both
  versions' printouts, and the web app ignores them when matching years. In the Java window that
  row shows `--` instead of a blank in the previous-year column.
- Each time the web app opens, it checks every bill in the background and fixes any such data
  the Java program has written since (clients open on a computer are skipped). The same check
  is available as Utility ▸ *Check bills for the desktop version*.
- Amounts are saved without a leading `+`, which older Java runtimes cannot read.

## Development

```
npm install
npm run dev          # development server
npm run build        # builds and updates "Utility Soft/Utility Soft.html" (commit it)
npm test             # unit and workspace tests (Node, real folders)
npx playwright test  # end-to-end customer journeys in Chrome
```

End-to-end tests replace Chrome's folder picker with folders on disk (`e2e/fs-shim.ts`), so
the Java checks can open the results. The client, bill and Utility journeys run in both formats.
Two tests use Chrome's real folder handles (on the desktop files, and moving to the web format).

Java compatibility checks (Linux, needs `Xvfb`, a JDK 8 and the Java sources checked out next to
this repo as `../Utility-Soft`):

```
compat/build-java.sh
npx playwright test e2e/compat-build.spec.ts e2e/compat-repair.spec.ts
python3 compat/check_web_to_java.py                                             # on the desktop files
python3 compat/check_web_to_java.py .tmp/compat-export .tmp/compat-repair-export # web format, exported
python3 compat/build_java_data.py && npx playwright test e2e/compat-read.spec.ts
```
