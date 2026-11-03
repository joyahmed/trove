# Install Trove on a Mac

Trove for Mac is free. It is not yet signed with a paid Apple developer account, so macOS blocks it the first time you open it. This is expected. You allow it once in System Settings, and after that it opens like any other app.

The Mac app is not notarized yet. The first time it is blocked, open System Settings > Privacy & Security and click Open Anyway. (On macOS 14 and older, right-click Trove.app and choose Open also works.)

## Install

1. Download `Trove-<version>.dmg` from the releases page.
2. Open the downloaded file. A window shows the Trove icon and an Applications folder.
3. Drag **Trove** onto **Applications**. If you already have an older Trove there, quit Trove first, then choose **Replace**.

## Open it the first time

4. Open **Trove** from Applications. macOS shows a message like "Apple could not verify 'Trove' is free of malware that may harm your Mac or compromise your privacy." Click **Done**. Do not click **Move to Trash**.

5. Open **System Settings** and choose **Privacy & Security**.
6. Scroll down to the **Security** section. You will see "Trove was blocked to protect your Mac." Click **Open Anyway**. The Open Anyway button shows only for a while after the blocked attempt. If it is gone, try opening Trove again first.

7. Confirm by clicking **Open Anyway** again, then enter your Mac password (or use Touch ID).

Trove now opens, and from then on it opens normally. Each time you install a new version, repeat steps 4 to 7 once.

Note: on macOS 15 (Sequoia) and newer, the older trick of right-clicking an app and choosing Open no longer gets past this. Use the steps above.

## Terminal alternative (optional)

If you are comfortable with Terminal, you can skip steps 5 to 7. Run this once after copying Trove to Applications:

```
xattr -dr com.apple.quarantine /Applications/Trove.app
```

This removes the "downloaded from the internet" mark that macOS put on the app, so it no longer blocks it. It is optional and only affects Trove.

## What Trove asks for

macOS may show these questions as you use Trove. Click **Allow** or **OK** to let Trove work fully:

- **Documents, Desktop and Downloads folders:** so Trove can show the files in them.
- **Network drives and USB sticks or external drives:** so Trove can show the files on them.
- **Control Finder (Automation):** so Move to Trash and Put Back work the same as in Finder. It is asked the first time you delete a file.
- **Full Disk Access:** needed only to show the Trash. If Trove's Trash view says it needs access, open System Settings, then Privacy & Security, then Full Disk Access, and switch Trove on. Without it everything else still works.

After you install a new version, macOS may ask these questions again.

You can change any of these later in System Settings, under Privacy & Security.

## Uninstall

1. Quit Trove.
2. Drag **Trove** from Applications to the Trash.
3. Optional: to remove its saved settings and search index too, delete the folder `~/Library/Application Support/com.joyahmed.trove` (in Finder, choose Go, then Go to Folder, and paste that path).
