# Knowledge Garden

[![Knowledge Garden preview](docs/preview.png)](https://git.marcuschiu.com/var-log/)

Turn your [Obsidian](https://obsidian.md) vault into an interactive, space‑themed
static website — a pannable graph of your notes that opens each one in a dockable,
tabbed reading panel with full Obsidian‑flavored Markdown support.

It's a **static site**: no server, framework, or database. Build once, then open the
folder anywhere.

---

## Quick start

```bash
# 1. put your Obsidian notes in vault/ (replacing the sample vault)
# 2. (optional) edit config.yml — site title, brand, giscus
# 3. build
node build.js

# 4. view — open the file directly...
open index.html              # macOS   (use `xdg-open` on Linux, `start` on Windows)

# ...or serve it locally
python3 -m http.server 8000  # then visit http://localhost:8000
```

---

## 1. Add your vault

Put your Obsidian notes in the `vault/` folder, replacing the sample `var-log` vault.

The layout is: **every note is a `Title.md` file, and that note's children live in a
sibling `Title/` folder of the same name.**

```
vault/
  My Garden.md          ← your top‑level (root) note
  My Garden/            ← its children
    Topic A.md
    Topic A/            ← Topic A's children
      Subtopic.md
    Topic B.md
```

There must be exactly **one** top‑level `.md` note (your root). Each note may start with
optional frontmatter:

```yaml
---
created: 2024-01-01
modified: 2024-06-01
group: sys          # colors the node by domain
tags: [systems]     # tag a note `private` to exclude it (and its whole subtree)
---
```

Wikilinks (`[[Note Title]]`), embeds (`![[Note#Heading]]`), images
(`![[Note/pic.png|400]]`), callouts, LaTeX, and tables all work — see
[Markdown support](#markdown-support).

## 2. Personalize (optional)

Edit `config.yml` to set the site title, header wordmark, subtitle, and giscus
comments. These are the only personal values baked into the site; `node build.js`
injects them into `index.html` for you.

To turn things off: set `giscus.enabled` to `false` to hide the comments section
(it's off by default), and leave `signature.trigger` empty to disable the hidden
credit easter egg.

## 3. Build

You need [Node.js](https://nodejs.org) (any recent version). From the project folder:

```bash
node build.js
```

This walks `vault/`, skips `private` notes, writes everything the site needs into
`build/`, and injects `config.yml` into `index.html`. Re‑run it whenever you change
your notes or config.

## 4. View it

Pick whichever fits:

**Open the file directly**
Double‑click `index.html`. It works straight off `file://` — no server needed.

**Host on GitHub Pages**
1. Push the whole project folder to a GitHub repo.
2. In the repo, go to **Settings → Pages** and set the source to your branch, `/ (root)`.
3. Your site is live at `https://<user>.github.io/<repo>/`.

**Host on your own web server**
Copy the project folder to your server's web root (Nginx, Apache, etc.) and serve it as
plain static files. No build step runs on the server.

> The note **data** always works offline. A few libraries (graph, Markdown, math, search)
> load from CDNs, so live graph/math rendering and full‑text search need a network
> connection; without one, search falls back to title‑only.

---

## Markdown support

Standard Markdown plus these Obsidian extensions, all working recursively (inside tables,
callouts, and tabs):

- **Wikilinks** — `[[Note Title]]`, aliased `[[Note Title||Display Text]]`.
- **Embeds / transclusion** — `![[Note#^block]]`, `![[Note#Heading]]`.
- **Images** — `![[Note Title/image.png|450]]` (width optional).
- **`dataview` lists** — `LIST FROM "" WHERE …`, `SORT modified DESC LIMIT n`, etc.
- **`merge-table`** — JSON tables with colspans, rowspans, nesting, and cell colors.
- **Callouts** — `> [!info]`, `> [!warning]`, … plus `[!expand]-`, `[!expand-ui]-`,
  `[!indent]`, and `[!tabs]` (with `=== Title` separators).
- **`excerpt`** blocks and `^excerpt` block references.
- **LaTeX math** — inline `$…$` and display `$$…$$` (KaTeX).
- **Standard links** — `[text](https://…)` open in a new tab.

---

## Using the site

- **Click a node** to open its article and center it; **drag** to reposition.
- **Search** (`/` to focus) — full‑text across titles, headings, tags, and bodies, with
  prefix + typo‑tolerant matching. `↑/↓` move, `Enter` opens, `Esc` clears.
- **Arrow keys** walk the tree: `↑` parent, `↓` first child, `←/→` siblings (your path is
  remembered).
- **Controls menu** — fit view, reset, toggle tree edges / wikilink edges.
- **Side panel** — tabbed and dockable (left / right / bottom / floating), with split
  view, drag‑to‑reorder tabs, per‑tab scroll memory, breadcrumb + parent/children/linked/
  backlinks navigation, and a full‑page reading mode.
- **Edges** — gold = parent↔child tree; cyan = wikilinks.

---

## Project layout

```
index.html                    The app (generated values injected by build.js)
config.yml                    Your site title, brand, and giscus settings
build.js                      Builds the site from your vault + config.yml
vault/                        Your Obsidian notes (source of truth)
build/system/garden-data.js   Generated graph metadata
build/system/search-data.js   Generated search corpus
build/<id>.js                 Generated per‑note bodies (lazy‑loaded)
build/<id>/                   Per‑note image assets
support.js                    App runtime (do not edit)
```
