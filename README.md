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
- **Views:** the tabs switch views; **+** adds one, **⋯** renames it, sets a
  result limit, duplicates or deletes it.
- **Properties:** choose the columns, drag them into order, and add formulas
  (a name and an expression; the formula becomes a column).
- **Filter:** *This view* filters one view, *All views* the whole base. A
  filter is a property, an operator (is, contains, is empty, >, has tag, is
  in folder, …) and a value; groups combine filters with *all*, *any* or
  *none*. **</>** turns a filter into an expression for anything the
  operators do not cover. A filter without its value does not filter yet.
- **Sort:** add sort rules in the *Sort* menu, or click a column header
  (ascending, descending, off).
- **Search and pages:** the search box searches the cells of the current
  view. The table shows 50 rows per page (`bases.pageSize`); the pager below
  changes page and page size.
- **Edit one value:** double-click a cell, type, press Enter. Input is read as
  YAML: `3` is a number, `true` a boolean, `[a, b]` a list. An empty cell
  removes the property.
- **Edit many files:** tick rows (Shift-click for a range; the header box
  ticks the page, then *Select all* every matching file), then fill in
  *property* and *value* in the bar above the table and choose *Set*,
  *Remove* or *Rename*. With more than one file, VS Code's Refactor Preview
  shows every change before it is applied (`bases.confirmBulkEdits`). The
  whole edit is one undo step.
- **Open a file:** click its name.
- **Edit the YAML:** *YAML* in the toolbar, or *Bases: Open Base as Text*.
  Everything the menus change is written to the `.base` file, in the order
  Obsidian uses, and only the lines that change are rewritten.

### What counts as a record

| File | Properties |
|---|---|
| `*.md`, `*.markdown` | the YAML frontmatter; a file without one has none, and setting a property creates it |
| `*.yml`, `*.yaml` | the top-level keys of the file; multi-document files and files whose top level is not a mapping are listed but read-only |

Edits only rewrite the lines they change: comments, key order, quoting and
indentation elsewhere stay as they were. A file that already holds unsaved
changes in an editor is edited but not saved.

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

## Settings

| Setting | Default | |
|---|---|---|
| `bases.include` | `**/*.{md,markdown,yml,yaml}` | files a base indexes |
| `bases.exclude` | `**/node_modules/**`, `**/.git/**` | excluded on top of `files.exclude` |
| `bases.confirmBulkEdits` | `true` | Refactor Preview for edits to more than one file |
| `bases.pageSize` | `50` | rows per page |

## Development

```sh
npm install
npm run check              # typecheck, unit tests, build
npm run test:integration   # runs the suite in a downloaded VS Code
```

Press F5 to start an Extension Development Host on the `sample/` workspace.

| Path | |
|---|---|
| `src/core/` | everything that does not need VS Code: expression language, record parsing, the writer, view computation, edits to the base, the filter editor's model — unit-tested in `test/` |
| `src/host/` | the workspace index, the custom editor and the edit path |
| `webview/` | the table UI; it holds no data and talks to the host through `src/protocol.ts` |
| `test/integration/` | runs inside VS Code against a scratch copy of `sample/` |

## License

MIT
