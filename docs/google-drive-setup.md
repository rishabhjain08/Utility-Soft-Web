# Setting up Google Drive backups

Google allows its sign-in only from a web address, so Utility Soft is also
published at **https://rishabhjain08.github.io/Utility-Soft-Web/**. The app at
that address is the same: it still keeps the data in the folder you choose on
your computer, and works offline once opened. Only the backups go to Drive,
encrypted.

This is done once, by the owner of the repository and of a Google account.

## 1. Switch on the web address (GitHub Pages)

1. Open https://github.com/rishabhjain08/Utility-Soft-Web/settings/pages
2. Under **Build and deployment**:
   - Source: **Deploy from a branch**.
   - Branch: **gh-pages**, folder **/ (root)**.
   - Save.
3. After a minute, https://rishabhjain08.github.io/Utility-Soft-Web/ opens Utility Soft.

## 2. Let the app use Google Drive (Google Cloud)

1. Open https://console.cloud.google.com/ with your Google account. At the top, choose **Select a
   project ▸ New project**, name it `Utility Soft`, and **Create**.
2. **APIs & Services ▸ Library**: search for **Google Drive API**, open it, and **Enable** it.
3. **Google Auth Platform ▸ Branding** (on older screens, *OAuth consent screen*):
   - App name: `Utility Soft`.
   - User support email: your email.
   - Developer contact: your email.
   - Save.
4. **Audience**: User type **External**. Then **Publish app** ▸ **Confirm**. The app asks only
   for the "drive.file" permission, which needs no review by Google.
5. **Data access** (or *Scopes*): **Add or remove scopes**, tick
   `.../auth/drive.file` ("See, edit, create and delete only the specific Google Drive files
   you use with this app"), and **Update**, then **Save**.
6. **Clients** (or *Credentials ▸ Create credentials ▸ OAuth client ID*):
   - Application type: **Web application**.
   - Name: `Utility Soft`.
   - Authorized JavaScript origins: **Add URI** `https://rishabhjain08.github.io`.
   - **Create**.
7. Copy the **Client ID**. It ends with `.apps.googleusercontent.com` and is not a secret.

## 3. Put the Client ID in the app

Set `GOOGLE_CLIENT_ID` in `src/app/google.ts` to the Client ID, then publish:

```
npm run publish-pages
```

Then open https://rishabhjain08.github.io/Utility-Soft-Web/. In **Utility ▸ Backups ▸ Google
Drive**, *Back up to Google Drive now* opens a Google window the first time, to allow
Utility Soft. The backups go to a **Utility Soft backups** folder in your Drive.

## Using it

- **Every day:** tick *Every day*. Once a day the app offers *Back up now* at the top of the client
  list, and asks again when exiting. It's one click, because the Google window needs a click to
  open.
- **Restore:** in *Utility ▸ Backups ▸ Google Drive*, choose *Show the backups in Google Drive*,
  then *Compare or restore* on one of them.
- **A new or lost computer:** open the web address, click **Restore from Google Drive…** on the
  start screen, choose the backup and an empty folder, then enter the password of that time, or use
  the recovery code.
- **Which backups are kept:** the last 7 days, 4 weeks and 12 months of each set of data; older
  ones are removed from Drive.
- **Privacy:** the files are encrypted before they leave the computer, so Google cannot read them.
  The app can see only the files it made in Drive.
