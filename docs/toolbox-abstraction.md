# Toolbox abstraction: ToolboxContent and ToolboxWorkspace

This document gives the design decisions for the two interfaces that supply the dependencies of a main HOCON file to
the build. It also gives the update policy for the source listing.

The text agrees with ASD-STE100 where possible.
Code names and file names are in code format.

## 1. The build

The build is the process that changes one main HOCON file into a site that a browser can run. The main HOCON file
defines one agent network. The build has these steps:

1. **Resolve.** Parse the main HOCON file. Follow its `include` lines and replace its `${...}` substitutions.
   `resolve_hocon` in `nsdeploy/resolve.py` does this step.
2. **Plan.** Expand the references to other agent networks, for example `/industry/retail`. Classify each tool.
   Find the Python module of each coded tool. `build_plan` in `nsdeploy/resolve.py` does this step.
3. **Generate.** Write the site files from the plan. `generate_site` in `nsdeploy/generate.py` does this step.

These commands and modules start a build:

- `python -m nsdeploy` (`nsdeploy/__main__.py`), with or without `--static-bundle`.
- `nsdeploy link` (`nsdeploy/linker.py`).
- The Cailville commands (`nsdeploy/cailville.py`).
- The deployment service (`nsdeploy_service/bundler.py`).

Steps 1 and 2 need files that are not in the main HOCON file. The two interfaces in this document supply these
files. Step 3 needs no file from them. A served site also gives the import root (section 6) to each MCP host
process.

## 2. Scope

The main HOCON file has dependencies in an external toolbox. A dependency can be one of three types:

- A HOCON file that the network includes, for example `registries/aaosa.hocon`.
- The toolbox catalogue, `toolbox/toolbox_info.hocon`. It maps a tool name to a Python class.
- The Python module of a coded tool, for example `coded_tools/web_fetch.py`.

The interfaces are not specific to one repository. They operate with each git repository that holds these
dependencies, and with a local checkout of such a repository. nsdeploy has a default repository (`DEFAULT_REPO` in
`nsdeploy/studio.py`), but the interfaces do not use its name or its layout. A network that has no dependencies can
also use no toolbox.

The Toolbox abstraction isolates the build from the location of the dependencies. The build does not know
if they come from a local checkout, a GitHub repository, or no toolbox.

## 3. Terms

- **Toolbox**: one source of dependencies, in one location, at one revision. Usually, it is a git repository or a
  local checkout of one.
- **Logical path**: the path that a network or a build asks for, for example `toolbox/toolbox_info.hocon`.
- **Source path**: the path where the toolbox keeps the file. It can be different from the logical path, for example
  `<package>/toolbox/toolbox_info.hocon`.
- **Listing**: the list of all source paths in a toolbox.
- **Mirror**: a local directory. It holds a copy of each file that a build asked for, at its logical path.
- **Include base**: the directory that pyhocon uses to find included files.
- **Import root**: the directory that Python uses to import coded tools.

## 4. Structure

```text
resolve.py, __main__.py, linker.py, cailville.py, nsdeploy_service/bundler.py
        |
        v
ToolboxWorkspace  (interface)      <- MirrorWorkspace
        |
        v
ToolboxContent    (interface)      <- LocalContent | EmptyContent | GithubContent
```

- `ToolboxContent` is the pluggable side. Each storage type has one implementation.
- `ToolboxWorkspace` is the consumer side. The build calls only this interface.
- `MirrorWorkspace` is the one workspace implementation. It operates on any `ToolboxContent`.
- `Studio` (`nsdeploy/studio.py`) is the factory. `Studio.local(path)` and `Studio.github(repo, ref)` return a
  `ToolboxWorkspace`.
- `ToolboxLayout` holds the logical names that nsdeploy expects: `coded_tools`, `toolbox/toolbox_info.hocon` and
  `registries`.

A new storage type, for example an archive, needs one new `ToolboxContent`. It needs no change to the workspace or
to the build.

## 5. ToolboxContent

### 5.1 Methods

- `identity()`: a short name for build output, for example `github:owner/repo@main`. It contains no credential.
- `revision()`: an opaque version, for example a tree sha or a commit id. It is empty when the source cannot tell.
- `list_paths()`: all source paths, as one flat list.
- `read(path)`: the bytes of one file. It returns `None` when the file does not exist. It raises `OSError` for all
  other failures.

### 5.2 Decisions

- **No directory operations.** The interface has no `listdir`, `stat` or `walk`. Resolution needs only a flat list.
  A source that is not a file system can supply a flat list at a low cost.
- **Read only.** nsdeploy does not change a toolbox.
- **One revision.** The interface has no history.
- **No local path.** A source can have no files on disk. Only the workspace writes to disk.
- **Bytes, not text.** The source does not decide the encoding. The workspace decodes. An image or a font in a future
  toolbox needs no interface change.
- **Absent and failed are different.** `read` returns `None` for a file that does not exist. It raises for a fault,
  for example a rate limit or a server error. The build reports an absent file as a missing include. It reports a
  fault as an error.

### 5.3 Implementations

`LocalContent` reads a checkout in place:

- It copies nothing. An edit in the checkout is visible to the next `read`.
- It does not list hidden directories, `venv`, `.venv`, `node_modules` or `__pycache__`.
- It refuses a path or a symbolic link that goes out of the checkout.
- `revision()` reads `.git/HEAD` directly. It does not start a `git` process.

`GithubContent` reads one repository at one ref:

- The listing comes from the git trees API. This API has a rate limit: 60 requests per hour without a token.
- A file comes from `raw.githubusercontent.com`. This endpoint is not part of the API allowance.
- It memoizes the listing for the life of the object. It has no disk cache. Each build makes a new object, so each
  build makes one listing request.
- It does not read a token from the environment. The caller gives the token. A toolbox is read in processes that
  run uploaded code, and these processes must not get a credential.
- It percent-encodes the repository, the ref and the path, but not `/`. Thus `a#b.hocon` and `release#1` are
  correct requests.

`EmptyContent` holds no files. A self-contained network uses it.

## 6. ToolboxWorkspace

### 6.1 Methods

- `identity()`: the identity of the content source.
- `resolve(logical_path)`: the source path for a logical path, or `None`.
- `read_text(logical_path)`: the file as text, with no disk write.
- `materialize(logical_path)`: copy the file into the mirror at its logical path, and return the local path.
- `ensure_coded_tool(module_file)`: make one coded tool importable.
- `include_base()`: the directory for pyhocon.
- `import_root()`: the directory for `sys.path`.

### 6.2 Why a workspace writes to disk

Two libraries read paths, not content:

- **pyhocon** reads `include` lines from the file system. It has no include hook. Thus each included file must be
  on disk before the parse starts. `materialize` puts it there.
- **The Python import system** reads modules from directories on `sys.path`. A coded tool is imported in the build
  process and in each MCP host process. Thus each module must be a file.

A path also crosses a process boundary. The service resolves a network in its process. Each deployment process
resolves again. Each MCP host gets the import root on its command line.

### 6.3 Decisions

- **Two directories, two methods.** `include_base` and `import_root` have different causes. Separate methods keep
  each cause visible. An implementation can give two different directories.
- **Logical path in the mirror.** An included file names its neighbours by logical path. Thus pyhocon must find
  each file at its logical path, not at its source path.
- **`read_text` for parsed files.** A file that is parsed, not included or imported, does not need a disk copy.
- **Package marker.** `ensure_coded_tool` writes `coded_tools/__init__.py`, also when the tool is absent. An empty
  package does no damage. A module with no package cannot be imported.
- **No warm-up method.** A workspace loads the listing on first use. Each build makes a new workspace, and builds
  share nothing except the mirror. A warm-up in one process thus cannot help a build in a different process.

### 6.4 MirrorWorkspace

Resolution rules, in this sequence:

1. An exact match of the logical path.
2. The shortest source path that ends with `/` and the logical path.
3. The shortest source path with the same file name.

The shortest path wins because the least nested copy is the primary copy. A deeper copy, for example a vendored one,
does not replace it.

Mirror rules:

- **A dropped file is removed.** When the toolbox does not hold a file, `materialize` removes the mirror copy. An old
  copy cannot satisfy an include that the toolbox dropped.
- **A directory is never removed.** A directory at the logical path holds the copies of other files.
- **No write for equal bytes.** When the mirror copy has the same bytes, `materialize` does not write. A pre-filled
  mirror on a read-only file system thus continues to operate.
- **Containment.** A logical path comes from the include lines of a network, so it is input. A path that goes out of
  the mirror, for example with `..`, gets `None`.
- **Atomic writes.** Each write goes to a temporary file with a unique name, then `os.replace`. Builds that run at the
  same time never read a partial file.
- **Offline fallback.** When the source cannot be read, and the mirror has a copy, `materialize` uses the copy and
  logs a warning. Only a source failure starts this fallback. A write failure in the mirror continues to raise.
- **One failed listing per build.** After the listing fails, the workspace keeps the failure and fails each later
  lookup immediately. An offline build thus waits for one timeout, not one timeout for each include. The next build
  makes a new workspace, which asks the source again.

## 7. Why a source listing

The listing is necessary because of names, not because of transfer. A network asks for logical paths. The toolbox
does not keep all files at these paths. The listing tells where each file is, for each layout, in one request.

### 7.1 Logical paths and source paths

A repository can keep its files in a layout of its own. For example, the default repository has this layout:

- `registries/aaosa.hocon` is at the root. The logical path and the source path are the same.
- `toolbox/toolbox_info.hocon` is at `<package>/toolbox/toolbox_info.hocon`.
- `coded_tools/web_fetch.py` is at `<package>/coded_tools/web_fetch.py`. The root `coded_tools/` directory holds
  other files.
- A coded tool is found by file name only. `_resolve_class` in `resolve.py` keeps only the last segment of the
  `class` value. The module can be in any directory.

`resolve` in `MirrorWorkspace` finds each source path from the listing. This behaviour is preserved from previous
implementation. The old `GithubStudio` also read the git tree and matched by suffix.

### 7.2 The alternative: one request for each file

A build can read files one at a time with no listing. Each request is
`raw.githubusercontent.com/<repo>/<ref>/<path>`. This alternative has three costs:

1. **Layout knowledge.** nsdeploy must know the layout of each repository, for example: `toolbox/` and
   `coded_tools/` are under `<package>/`, and `registries/` is at the root. Or it must try a list of candidate paths.
   When a repository moves files, the build fails without a clear cause.
2. **A miss costs requests.** A missing file is a normal case, for example an optional `config/llm_config.hocon`.
   Each miss costs one request for each candidate path. With a listing, a miss costs no request.
3. **No reliable absence.** With a listing, a file that is not in the listing does not exist. With candidate paths,
   "all candidates returned 404" can also mean "the file is in a new location".

### 7.3 The cost of the listing

The listing request uses the GitHub API, which has a rate limit (section 8.2). A file read uses the content endpoint
and does not count against this limit.

A local checkout has no such cost. `LocalContent` makes its listing with one walk of the directory tree.

## 8. Listing update policy

### 8.1 Rule

nsdeploy does not keep a listing between builds:

1. A content source asks for its listing one time, on first use. It keeps the listing in memory for its life.
2. Each build makes a new workspace and a new content source.
3. Thus each build gets a new listing from the source.

The mirror is the only data that stays on disk after a build. Only the listing resolves a path. A build uses a
mirror copy without the listing only when the source cannot be reached (section 8.3).

### 8.2 Results

- **Changes are visible to the next build.** A file that is added to, removed from or changed in the repository is
  visible to the next build. No time to live applies.
- **Files are read for each build.** `materialize` reads each file from the source. It writes the mirror copy only
  when the bytes are different (section 6.4).
- **One listing request for each GitHub build.** The git trees API has a rate limit of 60 requests per hour without a
  token. Thus nsdeploy can do approximately 60 GitHub builds per hour from one network address. Builds that start at
  the same time each make their own request.
- **File reads have no such limit.** A file comes from `raw.githubusercontent.com`, which is not part of the API
  allowance.

### 8.3 When the source cannot be reached

1. The listing request fails. The workspace keeps the failure for the rest of the build (section 6.4).
2. `materialize` uses a mirror copy that an earlier build left, and logs a warning.
3. A file that has no mirror copy stops the build with the error from the source.
4. No mirror copy is removed. Only a successful listing can show that the toolbox dropped a file.

Thus an offline build operates when an earlier build of the same network filled the mirror.

### 8.4 Local checkout

`LocalContent` applies the same rule. It walks the checkout one time for each build, and reads each file from the
checkout. An edit in the checkout is visible to the next build.

## 9. Disk layout

All directories are under `~/.cache/nsdeploy/`:

```text
~/.cache/nsdeploy/
    local_<checkout name>_<sha12>/                 mirror of a local checkout
    <owner>_<repo>@<ref>_<sha12>/                  mirror of a GitHub repository at a ref
```

- **Mirror names are one path component.** Characters other than `A-Z a-z 0-9 . _ @ -` become `_`. A 12-character
  digest of the exact `repo@ref` follows. Thus `release/feature` does not put a mirror in the mirror of `release`. Refs
  that become equal after the change, for example `release/feature` and `release_feature`, stay different. The name
  is limited to 255 bytes.
- **The mirror holds only logical paths.** It is the include base, so a network include can name each file in it.
  nsdeploy writes nothing else into a mirror.

## 10. Known limits

- **No pinned revision.** The build does not record the toolbox revision, and does not pin to it. Builds are thus not
  reproducible.
- **One listing request for each GitHub build.** See section 8.2. A token, or a disk cache shared between builds,
  can remove this limit.
- **The alternative in section 7.2 is not implemented.** A fixed layout map with direct file reads would remove the
  listing request. It would also put knowledge of one repository layout into nsdeploy. This change is possible in a
  separate pull request.
