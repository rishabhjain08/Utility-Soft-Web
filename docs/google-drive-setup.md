# Google Drive backups

## For whoever uses Utility Soft

The setup is guided inside the app: **Utility ▸ Google Drive… ▸ Set up Google Drive…**.
It's also under **Utility ▸ Backups ▸ Google Drive**, and on a new computer under
**Restore from Google Drive…** on the start screen.

- **Each step:** it opens the right Google Cloud page in a new tab, and gives the exact
  values to copy.
- **Your own project:** you make a Google Cloud project that is yours alone. Its *Client ID*
  is not part of Utility Soft. It is kept only in that browser, so it is typed in once per
  computer. Keep it with your recovery code.
- **Only your accounts:** the project stays in *Testing*, with only your own Google
  account(s) as test users, so Google refuses anyone else.
- **The smallest permission:** `drive.file`. Utility Soft sees only the files it makes in
  your Drive (its *Utility Soft backups* folder), never anything else. The backups are
  encrypted before they leave the computer.
- **Changing the project:** Utility ▸ Google Drive ▸ *Change the Google Cloud project…*.
  Google lets each project see only the files it made, so older backups are then restored by
  downloading them from drive.google.com and choosing *Restore from a backup file*. That
  option is in Utility ▸ Backups, or on the start screen on a new computer.

Google allows its sign-in only from a web address, not from a file on disk. So Drive works
when Utility Soft is opened from https://rishabhjain08.github.io/Utility-Soft-Web/ (or another
web address it is published at). The data still stays in the folder you choose on your
computer.

## For the owner of the repository: the web address

The web address is the `gh-pages` branch, published by `npm run publish-pages`. To switch it on
once:

1. Open https://github.com/rishabhjain08/Utility-Soft-Web/settings/pages
2. Under **Build and deployment**, set Source to **Deploy from a branch**, Branch to
   **gh-pages**, folder **/ (root)**, and **Save**.
3. After a minute, https://rishabhjain08.github.io/Utility-Soft-Web/ opens Utility Soft.

The published app has no Google project in it; each user brings their own, as above.
