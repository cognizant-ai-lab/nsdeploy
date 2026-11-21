# Toolbox seam: ToolboxContent and ToolboxWorkspace

This document gives the design decisions for the two interfaces that supply the dependencies of a main HOCON file to
the build. It also gives the update policy for the source listing.

The text agrees with ASD-STE100 where possible. Code names and file names are in code format.

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

The seam isolates the build from the location of the dependencies. The build does not know if they come from a local
checkout, a GitHub repository, or no toolbox.

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
ToolboxContent    (interface)      <- LocalContent | EmptyContent | CachedContent(GithubContent)
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
- `refresh()`: discard memoized data. The default does nothing. `CachedContent` calls it on the wrapped source when
  the cached listing expires.

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
- **`refresh` has a default.** A source that memoizes nothing is correct without an override.

### 5.3 Implementations

`LocalContent` reads a checkout in place:

- It copies nothing. An edit in the checkout is visible to the next `read`.
- It does not list hidden directories, `venv`, `.venv`, `node_modules` or `__pycache__`.
- It refuses a path or a symbolic link that goes out of the checkout.
- `revision()` reads `.git/HEAD` directly. It does not start a `git` process.

`GithubContent` reads one repository at one ref:

- The listing comes from the git trees API. This API has a rate limit: 60 requests per hour without a token.
- A file comes from `raw.githubusercontent.com`. This endpoint is not part of the API allowance.
- It memoizes the listing for the life of the object. It has no disk cache. A disk cache coordinates many readers,
  and one adapter cannot see them. `CachedContent` does this work.
- It does not read a token from the environment. The caller gives the token. A toolbox is read in processes that
  run uploaded code, and these processes must not get a credential.
- It percent-encodes the repository, the ref and the path, but not `/`. Thus `a#b.hocon` and `release#1` are
  correct requests.

`EmptyContent` holds no files. A self-contained network uses it.

`CachedContent` wraps a source and keeps its answers on disk. Section 8 gives its policy.

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
- **No warm-up method.** A workspace loads the listing on first use. Each build makes a new workspace, so the
  memory of a workspace never lives longer than one build. The shared disk cache and its lock (section 8) prevent a
  listing request for each build. A separate warm-up method is thus not necessary.

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

`resolve` in `MirrorWorkspace` finds each source path from the listing. This behaviour is older than the seam. The
old `GithubStudio` also read the git tree and matched by suffix.

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

### 7.3 Where the complexity comes from

The listing request uses the GitHub API, which has a rate limit. The disk cache, the time to live, the lock, the
retry delay and the offline fallback all exist because of this limit. A file read uses the content endpoint and has
none of this cost.

A local checkout has no such cost. `LocalContent` makes its listing with one walk of the directory tree, and does not
use `CachedContent`.

## 8. Listing update policy

`CachedContent` applies this policy. `Studio.github` wraps `GithubContent` in `CachedContent`. `Studio.local` does not
use `CachedContent`.

### 8.1 Goals

1. A repeated build makes no request to the source.
2. A build sees a file that was added to the toolbox, within a known time.
3. Many builds that start at the same time make one listing request.
4. A source that cannot be reached does not stop a build that has a cached listing.
5. A failed cache never stops a build that the source can supply.

### 8.2 Listing record

The listing is one JSON file, `listing.json`. It contains:

- `identity`: the source that wrote it.
- `revision`: the revision of the source at that time.
- `written`: the time when the source gave this list.
- `retry_after`: the time until which readers use this list after it expires. The value 0 means no retry delay.
- `paths`: the source paths.

The age comes from `written` in the file, not from the file modification time. The paths and their age thus come
from one read. Another process can replace the file between two reads, and this does not cause an incorrect age.

A listing with a different `identity` is ignored. Two sources that use one directory by error thus cause a slow
build, not incorrect files.

### 8.3 Decision sequence

For each process, the listing is loaded one time:

1. If the process has the listing in memory, use it.
2. Read `listing.json`. The listing is usable if all these conditions are true:
   - It exists, and its `identity` agrees.
   - Its age is less than the time to live (`DEFAULT_TTL_SECONDS`, 3600 s), or the current time is before
     `retry_after`.
3. If the listing is usable, use it.
4. If not, get the lock `listing.lock`. Then read `listing.json` again. Another process can have refreshed it during
   the wait. If it is now usable, use it.
5. If not, ask the source:
   - If a cached listing exists, it is expired. First call `refresh()` on the source. The memo of the source can be
     as old as the cached listing.
   - If the source answers, write the new listing with `written` set to now and `retry_after` set to 0.
   - If the source fails, and a cached listing exists, use the cached listing. Write it again with the same
     `written` and with `retry_after` set to now plus `RETRY_DELAY_SECONDS` (300 s). Log a warning.
   - If the source fails, and no cached listing exists, raise the error.
6. Release the lock.

### 8.4 Reasons for the values

- **Time to live: one hour.** A branch moves. A build must see a new file in a short time. One hour keeps the
  listing request infrequent in one work session.
- **Retry delay: five minutes.** Without it, each build that waits on the lock repeats the failed request. Each
  attempt can wait for the full timeout of the source (`TIMEOUT_SECONDS`, 30 s). Six builds can then wait for three
  minutes, although a usable listing exists.
- **Lock and second read.** Without them, each build in a burst sees the same expired listing and makes its own
  request. A burst can then use all of the rate limit.
- **No lock on Windows.** `fcntl` is not available. Without the lock, builds can make duplicate requests. The result
  stays correct.
- **No lock on a read-only cache.** The build logs a warning and continues. The cost is at most a duplicate request.

### 8.5 No forced refresh

The time to live is the only cause of a new listing. No command and no method makes a build ask for a new listing
earlier. A file that is added to the repository is thus visible to builds within one hour, not immediately. To see it
immediately, remove `listing.json` from the repository cache (section 9).

### 8.6 Files

- **Files do not expire.** Only the listing expires. A file that changed in place under the same path, on a branch
  that moved, is not read again. This is the cost of no request for each file in each build.
- **An absence is not cached.** A file that the source does not have is not recorded. A file that is added later is
  thus found by the next build.
- **Digest keys.** Each cached file is at `files/<sha256 of the source path>`. A path that changes from file to
  directory between revisions, for example `assets` and `assets/logo.png`, cannot collide. No path can go out of the
  cache directory.
- **Cache failures are not build failures.** A file that cannot be written to the cache is returned. A cached file
  that cannot be read is a miss, and the read goes to the source.
- **A new listing does not delete files.** A file that is not in the new listing cannot be resolved, so its cached
  copy is not used.

### 8.7 Stale listing and the mirror

An offline build that uses a stale listing removes a mirror copy that the listing does not name. The listing is the
newest record of the repository. Each mirror file was resolved from a listing of the same age or older. Thus a file
that the newest listing does not name was dropped, as far as the build can know.

## 9. Disk layout

All directories are under `~/.cache/nsdeploy/`:

```text
~/.cache/nsdeploy/
    local_<checkout name>_<sha12>/                 mirror of a local checkout
    <owner>_<repo>@<ref>_<sha12>/                  mirror of a GitHub repository at a ref
    .upstream/
        <owner>_<repo>@<ref>_<sha12>/              repository cache of that mirror
            listing.json
            listing.lock
            files/<sha256 of source path>
```

- **Mirror names are one path component.** Characters other than `A-Z a-z 0-9 . _ @ -` become `_`. A 12-character
  digest of the exact `repo@ref` follows. Thus `release/feature` does not put a mirror in the mirror of `release`. Refs
  that become equal after the change, for example `release/feature` and `release_feature`, stay different. The name
  is limited to 255 bytes.
- **The repository cache is out of the mirror.** The mirror is the include base. A network include can name each
  file in it. In `.upstream/`, a network can get to the cache only with `..`, and the workspace refuses `..`.
- **The cache has its own namespace.** No mirror name can be `.upstream`, because each mirror name contains `@` or
  starts with `local_`. A mirror for a ref with the name `main.upstream` thus cannot be the cache of `main`.
- **A downloaded file has two copies.** One copy is in the cache, with a key from the source path. One copy is in the
  mirror, at the logical path. Toolbox files are small. To keep one copy, the mirror must know which sources are safe
  to read from disk. That decision belongs to a content source, not to the workspace.

## 10. Known limits

- **No pinned revision.** The build does not record the toolbox revision, and does not pin to it. Builds are thus not
  reproducible.
- **Files on a moving branch can be old.** See section 8.6.
- **No forced refresh.** See section 8.5. A command-line option can add it. The option needs a `refresh()` override
  in `CachedContent` that skips the disk listing one time.
- **The alternative in section 7.2 is not implemented.** A fixed layout map with direct file reads would remove the
  listing cache. It would also put knowledge of one repository layout into nsdeploy. This change is possible in a
  separate pull request.
