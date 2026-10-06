# Page File Downloader

Page File Downloader is a dependency-free Manifest V3 Chrome extension that scans a chosen webpage for linked and embedded resources, filters and selects the results, and runs bulk downloads through a persistent background queue.

The toolbar icon opens a dedicated, resizable extension window. It does not use a toolbar-attached popup. A synchronized side-panel layout is available as an alternate interface.

## Install

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select this project directory.
5. Pin **Page File Downloader** if desired.
6. Open a regular `http`, `https`, or allowed `file` page and click the toolbar icon.

For local `file://` test pages, enable **Allow access to file URLs** on the extension details page. No compilation, package install, or web server is required.

## Operation

- Click the toolbar icon on a page. Chrome opens or focuses one standalone app window and uses the clicked page as the target.
- Choose another open tab from the target selector. Chrome asks for optional access only for that site because `activeTab` covers only the page where the toolbar was clicked.
- Select **Scan page**. The scanner inspects the page content currently loaded into the DOM.
- To scan only part of a page, select that part (for example a list of attachments) before scanning. Only links and resources inside the selection are reported, and the summary notes that the scan was limited. Clear the selection and rescan to scan the whole page. This can be turned off in the settings.
- **Save as** in the results toolbar chooses how downloaded files are named: the page-supplied filename, or the link text. Link-text names are sanitized for use as filenames and keep the extension of the page-supplied filename; items without link text keep their page-supplied name.
- Use plain-text, wildcard, or regular-expression filters. Commas and semicolons separate patterns; a leading `!` excludes matches.
- Select visible results or all discovered results. Hidden selections remain selected.
- Choose **Download selected**. The service worker owns the queue, so downloads continue if the app window or side panel closes.
- Use the activity button to retry failures, cancel waiting items, or clear finished history.

Keyboard shortcuts inside the app:

- `/`: focus search.
- `Ctrl/Cmd+A`: select visible results when the result area has focus.
- `Ctrl/Cmd+Enter`: download selected files.
- `Ctrl/Cmd+R`: rescan when the result area has focus.
- `Escape`: close a drawer.

## Architecture

- `background.js` is the authoritative owner of the target tab, scan snapshot, selections, standalone-window lifecycle, and download queue.
- `content-script.js` is injected only when scanning. It treats page content as untrusted, resolves relative URLs against `document.baseURI`, and never evaluates page scripts.
- `app.html` and `app.js` implement the standalone desktop interface.
- `sidepanel.html` loads the same app layout and controller, with `sidepanel.css` adapting the table into narrow cards.
- `shared/` contains URL/type inference, sanitization, filtering, settings validation, messages, and display helpers.
- `chrome.storage.session` preserves the scan and queue through UI closure and service-worker suspension. `chrome.storage.local` stores settings, presets, and window geometry.

Scan IDs prevent stale scan responses from replacing a newer scan. Normalized URLs are deduplicated with a `Map`; fragments and only well-known tracking parameters are optionally ignored. Authorization and other potentially meaningful query parameters are retained.

The background queue limits concurrent calls to `chrome.downloads.download()`, listens to `chrome.downloads.onChanged`, reconciles active items after worker restart, and prevents the same resource from being added twice while it is active. Chrome's `conflictAction: "uniquify"` keeps different resources with the same filename.

## Permissions

- `activeTab` and `scripting`: scan the page where the user invokes the toolbar action.
- `tabs` and `windows`: list/select browser tabs, focus the target, and manage one dedicated app window.
- `downloads`: start and track downloads.
- `storage`: preserve settings, state, geometry, presets, and queue state.
- `sidePanel`: provide the optional side-panel interface.
- `contextMenus`: provide window and side-panel commands.
- Optional `http`, `https`, and `file` host access is requested per site only when the user explicitly chooses another tab.

The extension includes no remote code and does not attempt to bypass authentication, paywalls, access controls, DRM, anti-bot systems, CORS, or Chrome restricted-page rules.

## Discovery coverage

The scanner checks links and `download` attributes; image, responsive `srcset`, source, video, audio, track, embed, object, and eligible iframe URLs; inline CSS backgrounds; common metadata; common lazy-loading/data attributes; visible direct file URLs; and bounded JSON/JSON-LD values.

Data URLs are summarized rather than displayed in full and are size-limited. Blob URLs are page-context-bound and are deliberately marked unsupported when they cannot be safely queued beyond the page lifetime. Basic scanning does not require metadata requests.

## Limitations

- Chrome blocks injection into internal pages, the Chrome Web Store, and other protected surfaces.
- The scan sees only content currently loaded in the page. Load or scroll infinite pages before rescanning.
- Cross-origin iframe contents are not inspected; a recognizable file URL used by the iframe itself can be found.
- `blob:` resources are reported but not falsely offered as persistent downloads.
- Server-generated downloads without a recognizable filename, type, or explicit download marker may not be inferred.
- File sizes are normally unknown until Chrome starts a download. Embedded data URL sizes are estimated.
- “Ask where to save” can produce one Chrome prompt per queued file and is inconvenient for large batches.

## Manual test plan

Open `test-pages/index.html` after enabling file-URL access, or serve `test-pages/` from any local static server.

1. Toolbar icon opens a separate application window; no toolbar popup appears.
2. A second toolbar click focuses the same app window.
3. Move/resize, close, and reopen the window; verify usable geometry and state.
4. Verify the clicked webpage is the target and the extension never selects its own app page.
5. Refresh the tab list, choose another page, grant site access, switch to it, and scan it.
6. Close the target tab and verify a specific closed-tab state.
7. Navigate or reload the target and verify results become stale rather than being silently replaced.
8. Find the relative PDF, PNG, responsive `srcset` JPG files, lazy attributes, CSS image, media, metadata, visible URL, structured JSON, query-based XLSX, and data URL.
9. Verify the two PDF references merge when fragments are ignored, while different URLs sharing filenames remain separate.
10. Test plain search, `*.pdf`, `image_??.jpg`, multiple includes, exclusions such as `*.jpg,!small*`, and a regular expression.
11. Enter malformed regular-expression syntax and verify inline validation without a crash.
12. Select visible results, change filters, and verify the footer reports hidden selections.
13. Test select-all-discovered, invert-visible, row download, bulk download, deselect, sorting, pagination, and details.
14. Start more downloads than the configured concurrency. Close the app window and verify the Chrome downloads continue.
15. Reopen the app and verify queue status restoration, retry, cancel-waiting, and clear-finished controls.
16. Open the side panel and verify it shares target, scan, selection, and queue state with the standalone window.
17. Try `chrome://extensions` and verify the restricted-page explanation.
18. Add the dynamic test link, verify watch mode marks results stale, and manually rescan.
19. Test light/dark system themes, visible keyboard focus, screen-reader live announcements, the documented shortcuts, and reduced-motion preference.
20. Test thousands of generated page links and verify batched scanning, a 200-row render page, and responsive filtering.
21. Open `test-pages/selection.html`, select the attachment list, scan, and verify only the four attachment PDFs are found; switch **Save as** to **Link text** and verify names such as `2. melléklet a 24_2005. (XII. 23.) önkormányzati rendelethez.pdf`.

## Icon regeneration

The checked-in PNG icons are generated locally. To regenerate them on Windows:

```powershell
.\generate-icons.ps1
```
