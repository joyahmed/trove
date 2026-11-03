# Install Trove on Linux

Trove for Linux is free. It comes in two forms: a `.deb` package for Ubuntu and Debian, and an AppImage that runs on most other desktops. Pick one.

## Install the .deb (Ubuntu, Debian)

1. Download `Trove_<version>_amd64.deb` from the releases page.
2. Open a terminal in the folder where it was saved and run:

   ```
   sudo apt install ./Trove_<version>_amd64.deb
   ```

   Keep the `./` in front of the name. It tells apt to use the file you downloaded. apt also fetches the few libraries Trove needs (the GTK and WebKit libraries, and the tray icon library).

3. Open Trove from your applications menu.

## Use the AppImage (any distribution)

1. Download `Trove_<version>_amd64.AppImage` from the releases page.
2. Make it runnable, then start it:

   ```
   chmod +x Trove_<version>_amd64.AppImage
   ./Trove_<version>_amd64.AppImage
   ```

   You can also right-click the file, open **Properties**, and tick "Allow executing file as program", then double-click it.

3. If it will not start and the message mentions FUSE or `libfuse.so.2`, install the FUSE 2 library (on Ubuntu 22.04 and Debian: `sudo apt install libfuse2`; on Ubuntu 24.04 and newer: `sudo apt install libfuse2t64`). Or skip the library and run it unpacked:

   ```
   APPIMAGE_EXTRACT_AND_RUN=1 ./Trove_<version>_amd64.AppImage
   ```

The AppImage does not add Trove to your applications menu. Keep the file somewhere you can find it, such as `~/Applications`.

## Updates

Trove does not update itself on Linux yet. To update, download the new `.deb` (or AppImage) and install it the same way as before. A new `.deb` replaces the old one and keeps your settings.

## Open Trove from anywhere

Trove has a Spotlight search window. On Linux it opens with **Ctrl+Alt+Space**. This is not the same as on Windows and Mac (Alt+Space), because GNOME already uses Alt+Space for the window menu and would swallow it.

If another program already holds Ctrl+Alt+Space, Trove tells you once when it starts. You can pick a different shortcut in Settings.

## Use Trove as your default file manager (optional)

In Settings, turn on **Use as default file manager**. Trove then opens when another program asks to show a folder. Turn it off again and your previous file manager comes back. Trove saves the old choice first and puts exactly that back.

## Where Trove keeps its things

- Settings and your open windows: `~/.config/com.joyahmed.trove`
- Search index, icon cache and logs: `~/.local/share/com.joyahmed.trove`

## Uninstall

- **.deb:** `sudo apt remove trove`
- **AppImage:** delete the file.
- Optional: to remove saved settings and the cache too, delete the two folders above.
- If you turned on "default file manager", turn it off in Settings first.
