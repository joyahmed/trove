//! Reduced motion that switches live on Linux (plan 15 E.6.6).
//!
//! GNOME's Settings → Accessibility → Reduce animation flips GTK's `gtk-enable-animations`.
//! WebKitGTK 2.52 picks the new value up for `matchMedia(...).matches` within a second, but it
//! fires no `change` event and does not re-apply `@media (prefers-reduced-motion: reduce)` CSS
//! until something else forces a style recalc (a window resize). So Trove listens to the GTK
//! setting itself, on the GTK main thread, and writes the answer onto the page as
//! `<html data-reduced-motion="reduce|no-preference">`. `app.css` keys its reduced-motion rules
//! on that attribute when it is present and on the media query when it is not — so Windows and
//! the Mac, where the attribute is never written, keep the plain `@media` rules unchanged.
//!
//! Until the first switch the attribute is absent and the media query (correct at page load)
//! decides; a window opened or reloaded later starts the same way.

/// The script that tells one page whether motion is reduced. Pure, so it is tested anywhere.
pub fn script(animations_enabled: bool) -> String {
    let value = if animations_enabled {
        "no-preference"
    } else {
        "reduce"
    };
    format!("document.documentElement.dataset.reducedMotion = '{value}';")
}

/// Hook `notify::gtk-enable-animations` once for the whole app. Must run on the GTK main thread
/// (tauri's `setup` does); every open Trove window gets the new value when it changes.
#[cfg(target_os = "linux")]
pub fn watch(app: &tauri::AppHandle) {
    use gtk::prelude::GtkSettingsExt;
    use tauri::Manager;

    let Some(settings) = gtk::Settings::default() else {
        log::warn!("reduced motion: no GtkSettings, the switch will need a resize");
        return;
    };
    let app = app.clone();
    settings.connect_gtk_enable_animations_notify(move |s| {
        let on = s.is_gtk_enable_animations();
        log::info!("reduced motion: gtk-enable-animations = {on}");
        let js = script(on);
        for (label, window) in app.webview_windows() {
            if let Err(e) = window.eval(&js) {
                log::warn!("reduced motion: could not tell {label}: {e}");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::script;

    #[test]
    fn animations_off_means_reduce() {
        assert_eq!(
            script(false),
            "document.documentElement.dataset.reducedMotion = 'reduce';"
        );
    }

    #[test]
    fn animations_on_means_no_preference() {
        assert_eq!(
            script(true),
            "document.documentElement.dataset.reducedMotion = 'no-preference';"
        );
    }
}
