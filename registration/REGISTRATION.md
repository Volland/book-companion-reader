# Registering Book Companion Reader in the Obsidian community directory

Everything in this repository is ready. These steps need your accounts, so they're yours to do.

## 0. Already checked
- The id `book-companion-reader` and the name **Book Companion Reader** are not taken in `community-plugins.json` (checked 2026-11-14 against 10,385 plugins).
- `manifest.json`: id has no "obsidian", the description is under 250 characters, ends with a period and doesn't say "Obsidian" or "This plugin", `isDesktopOnly: false`, `minAppVersion` 1.5.0, author and authorUrl set.
- `LICENSE` (MIT) and `README.md` (features, install, **Disclosures** for network use, accounts, local programs and files) are in the repo root.
- Settings use section headings (`setHeading`), with no top-level plugin-name heading. Command names don't repeat the plugin name. No default hotkeys. Background note edits use `vault.process`.
- `.github/workflows/release.yml` builds, self-tests and attaches `main.js`, `manifest.json` and `styles.css` to a release whose tag equals the manifest version (no `v`).

## 1. Publish the repository
Create `Volland/book-companion-reader` (public) on GitHub and push this folder's `main` branch to it. In **Settings → Pages**, set *Source: GitHub Actions* so `website/` is served at `https://volland.github.io/book-companion-reader/`.

## 2. Make the first release
Push a tag named `0.1.0` (the same as `manifest.json`). The **Release plugin** workflow creates release `0.1.0` with the three files. Check it on the Releases page.

## 3. Submit
As of 2026, Obsidian takes new plugins through its web directory (your Typed Graph README describes the same flow), and `community-plugins.json` in `obsidianmd/obsidian-releases` mirrors that directory:

1. Sign in at <https://community.obsidian.md> with your Obsidian account and link your GitHub account (it proves you own the repo).
2. Add the plugin from `Volland/book-companion-reader`. The directory reads `README.md`, `LICENSE` and the root `manifest.json`, and installs from the release tagged with the manifest version.
3. An automated review runs. To fix anything it reports, update the repo, run `npm run version:bump -- 0.1.1`, commit, and push the new tag.

## 4. If a pull request is ever asked for instead
Your fork **Volland/obsidian-releases** exists. On 2026-11-14 it was 541 commits behind `obsidianmd/obsidian-releases`, so sync it first (the *Sync fork* button on GitHub). Then add the entry from `community-plugins-entry.json` at the **end** of `community-plugins.json` on a new branch (e.g. `add-book-companion-reader`), and open the PR with the text in `PULL_REQUEST.md`.
