# Bases for VS Code

A workbench for the metadata of the Markdown and YAML files in a workspace,
modelled on [Obsidian Bases](https://help.obsidian.md/bases). A `.base` file
describes views — filters, columns, sort — and opens as a live table of every
matching file. Build the views in the table itself, as in Obsidian; edit a
cell, or select many rows and set, remove or rename a property in all of them
at once.

## Using it

- **Create a base:** run *Bases: New Base* from the Command Palette, or
  right-click a folder in the Explorer. A new base is one table that lists
  every file by name. Any `*.base` file opens in the table.
- **Views:** the view name at the top left opens the view menu: pick a view,
  the settings icon configures one (layout, name, duplicate, delete; the
  arrow goes back to the list), *Add view*
  adds a table. Arrow keys and Enter work in the menu, Escape closes it.
- **Results:** click the result count next to the view name. *Limit* shows
  at most that many files, *Reset limit* shows all again. *Copy to
  clipboard* copies the view's rows and columns (all pages, tab-separated:
  they paste into a spreadsheet as cells); *Export CSV* saves them as a
  `.csv` file.
- **Layouts:** in the view settings, *Layout* shows a view as a **Table**,
  **Cards** (one card per file), a **List**, or a **Kanban** board. A board
  groups its cards by one property (*Group by*), one lane per value; drag a
  card to another lane to change that value in its file. Drag a lane by its
  header to move it; the order is kept in the view (`groupBy.order`). Cards and list
  items have a checkbox for selecting, as the rows of the table do.
- **Properties:** choose the columns, drag them into order, and add formulas
  (a name and an expression; the formula becomes a column).
- **Filter:** *This view* filters one view, *All views* the whole base. A
  filter is a property, an operator (is, contains, is empty, >, has tag, is
  in folder, …) and a value; groups combine filters with *all*, *any* or
  *none*. The **<>** icon turns a filter into an expression for anything the
  operators do not cover. A filter without its value does not filter yet.
- **Sort:** add sort rules in the *Sort* menu, or click a column header
  (ascending, descending, off).
- **Menus:** *Sort*, *Filter* and *Properties* open as small windows under
  their toolbar buttons, as in Obsidian. A click outside, the × at the top
  right, Escape, or the button again closes one.
- **Search and pages:** the search icon in the toolbar shows the search box
  (hidden at first); it searches the cells of the current view. Escape or
  the icon again hides it and ends the search. The table shows 50 rows per page (`bases.pageSize`); the pager below
  changes page and page size.
- **Edit a value:** click a cell. The editor fits the column: a checkbox
  toggles with one click, numbers get a number field, dates a date picker,
  lists their items as chips (Enter or comma adds one, × or Backspace
  removes one), and text suggests the values the column already has. Enter
  saves and moves down, Tab moves right (Shift-Tab left), Escape cancels.
  Clearing a value removes the property. A column's type comes from the
  values most of its files hold; `tags`, `aliases` and `cssclasses` are
  always lists.
- **Edit many files at once:** tick rows, then change a cell in one of
  them: a short question asks whether the new value goes to every selected
  file or only to this one. That answer is the only one asked for.
- **Or with the bulk bar:** tick rows (Shift-click for a range; the header box
  ticks the page, then *Select all* every matching file), then fill in
  *property* and *value* in the bar above the table and choose *Set*,
  *Remove* or *Rename*. With more than one file you are asked first
  (`bases.confirmBulkEdits`); *Show Changes* opens the diff of every file.
- **Open a file:** click its name.
- **New note:** *+ New* at the top right asks for a name, creates the note
  and opens it. It goes into `bases.newNoteFolder` (relative to the
  workspace folder; empty, the default, is the workspace folder itself), or
  into the folder the view filters on with *is in folder*. Values the
  view's filters require (*is*, *has tag*, in "all of" groups) are filled
  in, so the note shows in the view.
- **Edit the YAML:** the source icon at the top right of the editor (as for
  Markdown) or Cmd/Ctrl+Shift+V. The same
  icon and keys in the YAML go back to the table.
  Everything the menus change is written to the `.base` file, in the order
  Obsidian uses, and only the lines that change are rewritten.

### What counts as a record

| File | Properties |
|---|---|
| `*.md`, `*.markdown` | the YAML frontmatter; a file without one has none, and setting a property creates it |
| `*.yml`, `*.yaml` | the top-level keys of the file; multi-document files and files whose top level is not a mapping are listed but read-only |

### How an edit reaches the files

The files are the truth; the table only shows them. An edit — one cell or a
thousand rows — changes the files first, and the index then reads them again
and every open base updates.

- Edits run one after another, each on the text the one before left, so
  quick edits to one file all land.
- A file no editor holds is read, changed and written at once; just before
  writing, the extension checks that it has not changed since it was read,
  and computes the change again if it has. No formatter runs on it.
- A file open in an editor is changed in the editor, so its undo history
  keeps the edit, and then saved — unless it held unsaved changes before:
  those stay yours to save or discard.
- Only the lines that change are rewritten: comments, key order, quoting and
  indentation elsewhere stay as they were. A UTF-8 BOM is kept; a file that
  is not UTF-8 is left alone and reported.
- What was asked about is not what is applied: after you confirm, every
  change is computed again from the files as they are then.
- Files that cannot be edited (YAML errors, multi-document YAML, a rename
  onto an existing key) are reported; the others are changed.

Undo: Cmd+Z in the table undoes the last change to the `.base` file. A
property edit in a file that was open in an editor can be undone there; for
the others use Git.

## The .base format

```yaml
filters:                       # applies to every view
  and:
    - file.hasTag("project")
formulas:
  overdue: 'if(due && date(due) < today() && status != "done", "yes", "")'
properties:
  formula.overdue:
    displayName: Overdue
views:
  - type: table
    name: Open
    filters: 'status != "done"'
    order: [file.name, status, priority, formula.overdue]
    sort:
      - property: priority
        direction: DESC
    limit: 50
```

`filters` is an expression string or a tree of `and`, `or` and `not` lists.
`order` lists the columns; without it, a view shows the file name.

### Supported expressions

A subset of the Bases expression language. Anything else shows a warning
naming what is unsupported, rather than silently matching nothing.

- **Properties:** `status`, `note.status`, `note["due-date"]`, `formula.x`
- **File:** `file.name`, `file.basename`, `file.path`, `file.folder`,
  `file.ext`, `file.size`, `file.mtime`, `file.ctime`, `file.tags`,
  `file.hasTag(...)`, `file.inFolder(...)`, `file.hasProperty(...)`
- **Operators:** `== != < <= > >= && || ! + - * / %`, parentheses, list literals
- **Functions:** `if`, `now`, `today`, `date`, `number`, `list`, `min`, `max`
- **Methods:** `contains`, `containsAll`, `containsAny`, `startsWith`,
  `endsWith`, `lower`, `upper`, `trim`, `replace`, `split`, `slice`, `join`,
  `unique`, `sort`, `reverse`, `isEmpty`, `isTruthy`, `isType`, `toString`,
  `length`, `round`, `floor`, `ceil`, `abs`, `toFixed`, `format`, `year`,
  `month`, `day`
- **Dates:** `now() - "1 week"`, `date(due) < today()`

Not yet: links (`file.hasLink`, `link()`), inline `#tags` in the note body,
`groupBy`, summaries, card and list views.

## Large workspaces

The extension starts indexing as soon as a workspace with a `.base` file
opens. What parsing produced is cached per workspace: on the next start a
base shows the cached rows at once, and a scan in the background reads only
the files whose modification time or size changed. While a workspace is
indexed for the first time, the table fills in as files are read.

The *Bases* output channel logs how long indexing took and how many files
came from the cache; at log level *Debug* (*Developer: Set Log Level…*) it
also logs the time of every view.

Measured with 20,000 notes (`npm run test:perf`):

| | |
|---|---|
| first start, no cache | 1.0 s until the index is complete |
| later starts | rows after 61 ms; the check against the disk takes 0.1 s in the background |
| computing a view | 19 ms |
| setting a property in 2,000 files | 0.2 s |

To index less, narrow `bases.include` or add folders to `bases.exclude`.

## Settings

| Setting | Default | |
|---|---|---|
| `bases.include` | `**/*.{md,markdown,yml,yaml}` | files a base indexes |
| `bases.exclude` | `**/node_modules/**`, `**/.git/**` | excluded on top of `files.exclude` |
| `bases.confirmBulkEdits` | `true` | ask before an edit to more than one file, with a diff on request |
| `bases.pageSize` | `50` | rows per page |

## Development

```sh
npm install
npm run check              # typecheck, unit tests, build
npm run test:integration   # runs the suite in a downloaded VS Code
npm run test:perf          # indexes 20,000 generated notes, with and without the cache
```

Press F5 to start an Extension Development Host on the `sample/` workspace.

| Path | |
|---|---|
| `src/core/` | everything that does not need VS Code: expression language, record parsing, the writer, view computation, edits to the base, the filter editor's model, the index cache format — unit-tested in `test/` |
| `src/host/` | the workspace index, the custom editor and the edit path |
| `webview/` | the table UI; it holds no data and talks to the host through `src/protocol.ts` |
| `test/integration/` | runs inside VS Code against a scratch copy of `sample/` |

## License

MIT
