#!/usr/bin/env python3
"""narella-deps-export: write a `narella-deps/v1` document (deps.json) for one build context.

Answers, deterministically and from lockfiles alone, the question a vulnerability scanner
cannot: *is this package a direct dependency, and if not, which direct dependency pulls it
in, and through what chain?* The format is specified in `docs/narella-deps.md`.

    narella-deps-export --context platform --repo narella-io/narella --commit <sha> > deps.json

Properties:
  * stdlib only, Python >= 3.11 (tomllib), no network, no subprocesses;
  * deterministic: sorted keys, sorted packages, no timestamps — the same inputs give
    byte-identical output, so a deps.json can be diffed, cached and content-addressed;
  * never guesses: a context with no supported lockfile exits 3 and writes nothing,
    because an empty package list would read as "no dependencies", which is a lie.

Supported inputs (all looked up directly in --context):
  uv.lock (+ pyproject.toml)     -> pypi
  package-lock.json v2/v3        -> npm
  pnpm-lock.yaml v9              -> npm
  go.mod (+ go.sum)              -> golang
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tomllib
from collections import deque
from dataclasses import dataclass, field

VERSION = "1.0.0"
SCHEMA = "narella-deps/v1"

MAX_PATHS = 3
MAX_HOPS = 8  # edges; a path therefore holds at most MAX_HOPS + 1 package names
# Bound on how many equally-short paths are enumerated before the best MAX_PATHS are
# picked. Keeps a pathological diamond-heavy graph linear instead of exponential; the
# choice inside the bound is still deterministic (predecessors are walked in sorted order).
_ENUM_CAP = 64

EXIT_OK = 0
EXIT_PARSE = 4
EXIT_NO_LOCKFILE = 3


class ExportError(Exception):
    """A lockfile we recognise but cannot read faithfully. Never papered over."""


# --------------------------------------------------------------------------------------
# The ecosystem-neutral graph and the classification every parser shares
# --------------------------------------------------------------------------------------

Key = tuple[str, str]  # (name, version) — one package as a scanner sees it


@dataclass
class Graph:
    """Package-level dependency graph of one lockfile.

    `prod_edges` are the edges a production install follows; `all_edges` additionally
    holds edges only a dev/optional install would activate (uv extras requested from a
    dev group). For ecosystems where that distinction does not exist both are the same
    dict. Roots are DIRECT dependencies — our own code (workspace members, importers) is
    never a node.
    """

    prod_edges: dict[Key, set[Key]] = field(default_factory=dict)
    all_edges: dict[Key, set[Key]] = field(default_factory=dict)
    prod_roots: set[Key] = field(default_factory=set)
    dev_roots: set[Key] = field(default_factory=set)
    nodes: set[Key] = field(default_factory=set)

    def add_node(self, k: Key) -> None:
        self.nodes.add(k)

    def add_edge(self, a: Key, b: Key, *, prod: bool = True) -> None:
        if a == b:
            return
        self.nodes.update((a, b))
        self.all_edges.setdefault(a, set()).add(b)
        if prod:
            self.prod_edges.setdefault(a, set()).add(b)


def _bfs(edges: dict[Key, set[Key]], sources: set[Key]) -> tuple[dict[Key, int], dict[Key, list[Key]]]:
    """Multi-source BFS. Returns (distance in hops, sorted shortest-path predecessors)."""
    dist: dict[Key, int] = {}
    preds: dict[Key, list[Key]] = {}
    q: deque[Key] = deque()
    for s in sorted(sources):
        dist[s] = 0
        q.append(s)
    while q:
        cur = q.popleft()
        for nxt in sorted(edges.get(cur, ())):
            if nxt not in dist:
                dist[nxt] = dist[cur] + 1
                preds[nxt] = [cur]
                q.append(nxt)
            elif dist[nxt] == dist[cur] + 1:
                preds[nxt].append(cur)
    for v in preds.values():
        v.sort()
    return dist, preds


def shortest_paths(target: Key, dist: dict[Key, int], preds: dict[Key, list[Key]]) -> list[list[str]]:
    """Up to MAX_PATHS shortest root-to-target chains of package NAMES, at most MAX_HOPS
    hops each, ordered by length then lexicographically. [] when unreachable or too deep."""
    if target not in dist or dist[target] > MAX_HOPS:
        return []
    found: list[list[Key]] = []

    def walk(node: Key, suffix: list[Key]) -> None:
        if len(found) >= _ENUM_CAP:
            return
        chain = [node] + suffix
        if dist[node] == 0:
            found.append(chain)
            return
        for p in preds.get(node, ()):
            walk(p, chain)

    walk(target, [])
    named: set[tuple[str, ...]] = {tuple(k[0] for k in chain) for chain in found}
    ordered = sorted(named, key=lambda t: (len(t), t))
    return [list(t) for t in ordered[:MAX_PATHS]]


def classify(g: Graph) -> list[dict]:
    """Turn a Graph into the sorted `packages` list of the format."""
    prod_dist, prod_preds = _bfs(g.prod_edges, g.prod_roots)
    any_roots = g.prod_roots | g.dev_roots
    all_dist, all_preds = _bfs(g.all_edges, any_roots)
    out = []
    for k in sorted(g.nodes):
        if k not in all_dist:
            continue  # in the lockfile but reachable from nothing we build: not installed
        dev = k not in prod_dist
        if dev:
            paths = shortest_paths(k, all_dist, all_preds)
        else:
            paths = shortest_paths(k, prod_dist, prod_preds)
        out.append(
            {
                "name": k[0],
                "version": k[1],
                "direct": k in any_roots,
                "dev": dev,
                "paths": paths,
            }
        )
    return out


# --------------------------------------------------------------------------------------
# pypi: uv.lock + pyproject.toml
# --------------------------------------------------------------------------------------

_LOCAL_SOURCES = ("editable", "virtual")


def pep503(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def parse_uv(lock_text: str) -> Graph:
    """uv.lock -> Graph.

    Roots: every workspace member (source editable/virtual) is OUR code; its
    `dependencies` are direct prod deps, its `dev-dependencies` (dependency groups) and
    `optional-dependencies` (project extras) are direct dev deps. Extras requested on a
    dependency (`{ name = "celery", extra = ["redis"] }`) activate that package's
    `optional-dependencies.<extra>` — only when actually requested, and on the prod side
    only when requested from the prod side.
    """
    try:
        lock = tomllib.loads(lock_text)
    except tomllib.TOMLDecodeError as e:
        raise ExportError(f"uv.lock: {e}") from e
    pkgs = lock.get("package", [])
    by_name: dict[str, list[dict]] = {}
    for p in pkgs:
        by_name.setdefault(pep503(p["name"]), []).append(p)

    def is_local(p: dict) -> bool:
        return any(s in p.get("source", {}) for s in _LOCAL_SOURCES)

    def resolve(spec: dict) -> dict | None:
        cands = by_name.get(pep503(spec["name"]), [])
        if "version" in spec:
            cands = [c for c in cands if c.get("version") == spec["version"]]
        if len(cands) == 1:
            return cands[0]
        if not cands:
            return None
        # uv writes `version` on a dependency exactly when the name is ambiguous, so
        # reaching here means the lock is not what uv emits. Say so rather than guess.
        raise ExportError(f"uv.lock: ambiguous dependency {spec!r}")

    def key(p: dict) -> Key:
        return (pep503(p["name"]), str(p.get("version", "")))

    g = Graph()
    locals_ = [p for p in pkgs if is_local(p)]

    def closure(seed: list[tuple[dict, dict]], prod: bool) -> None:
        """Walk (from_pkg|None, dep_spec) activating extras; add edges into g."""
        seen: set[tuple[Key, str | None]] = set()
        work: deque[tuple[dict | None, dict]] = deque(seed)
        while work:
            parent, spec = work.popleft()
            child = resolve(spec)
            if child is None or is_local(child):
                continue
            ck = key(child)
            g.add_node(ck)
            if parent is not None:
                g.add_edge(key(parent), ck, prod=prod)
            for extra in [None, *spec.get("extra", [])]:
                if (ck, extra) in seen:
                    continue
                seen.add((ck, extra))
                deps = child.get("dependencies", []) if extra is None else child.get("optional-dependencies", {}).get(extra, [])
                for d in deps:
                    work.append((child, d))

    prod_seed: list[tuple[dict | None, dict]] = []
    dev_seed: list[tuple[dict | None, dict]] = []
    for lp in locals_:
        for d in lp.get("dependencies", []):
            prod_seed.append((None, d))
            r = resolve(d)
            if r is not None and not is_local(r):
                g.prod_roots.add(key(r))
        for group in (lp.get("dev-dependencies", {}), lp.get("optional-dependencies", {})):
            for deps in group.values():
                for d in deps:
                    dev_seed.append((None, d))
                    r = resolve(d)
                    if r is not None and not is_local(r):
                        g.dev_roots.add(key(r))
    closure(prod_seed, prod=True)
    closure(prod_seed + dev_seed, prod=False)
    return g


def pyproject_direct(pyproject_text: str) -> set[str]:
    """PEP 503 names in [project].dependencies (PEP 508 strings)."""
    data = tomllib.loads(pyproject_text)
    out = set()
    for req in data.get("project", {}).get("dependencies", []):
        m = re.match(r"\s*([A-Za-z0-9][A-Za-z0-9._-]*)", req)
        if m:
            out.add(pep503(m.group(1)))
    return out


# --------------------------------------------------------------------------------------
# npm: package-lock.json v2/v3
# --------------------------------------------------------------------------------------

_NPM_PROD_FIELDS = ("dependencies", "optionalDependencies", "peerDependencies")


def _npm_parent(loc: str) -> str | None:
    if loc == "":
        return None
    if "/node_modules/" in loc:
        return loc.rsplit("/node_modules/", 1)[0]
    if loc.startswith("node_modules/"):
        return ""
    return os.path.dirname(loc)


def parse_npm_lock(text: str, importers: list[str] | None = None) -> Graph:
    """package-lock.json (lockfileVersion 2 or 3) -> Graph.

    Importers are the root (`""`) and workspace packages (keys outside node_modules).
    Their `dependencies`/`optionalDependencies`/`peerDependencies` are direct prod deps,
    `devDependencies` direct dev deps. A dependency resolves the way Node does: the
    nearest `node_modules/<name>` walking up from the requiring package's location.
    """
    try:
        lock = json.loads(text)
    except json.JSONDecodeError as e:
        raise ExportError(f"package-lock.json: {e}") from e
    if lock.get("lockfileVersion") not in (2, 3):
        raise ExportError(f"package-lock.json: lockfileVersion {lock.get('lockfileVersion')!r} unsupported (need 2 or 3)")
    pkgs: dict[str, dict] = lock.get("packages", {})

    def name_of(loc: str, entry: dict) -> str:
        return entry.get("name") or loc.rsplit("node_modules/", 1)[-1]

    def resolve(from_loc: str, dep: str) -> str | None:
        cur: str | None = from_loc
        while cur is not None:
            cand = f"{cur}/node_modules/{dep}" if cur else f"node_modules/{dep}"
            if cand in pkgs:
                entry = pkgs[cand]
                if entry.get("link"):
                    return entry.get("resolved")  # a workspace: our code
                return cand
            cur = _npm_parent(cur)
        return None

    def is_importer(loc: str) -> bool:
        return loc == "" or ("node_modules/" not in loc and not loc.startswith("node_modules"))

    all_importers = sorted(loc for loc in pkgs if is_importer(loc))
    chosen = set(all_importers if not importers else _expand_npm_importers(pkgs, importers, resolve, is_importer))

    g = Graph()

    def key(loc: str) -> Key:
        e = pkgs[loc]
        return (name_of(loc, e), str(e.get("version", "")))

    for loc in sorted(pkgs):
        if is_importer(loc) or pkgs[loc].get("link"):
            continue
        g.add_node(key(loc))
        e = pkgs[loc]
        for f in _NPM_PROD_FIELDS:
            for dep in sorted(e.get(f, {})):
                tgt = resolve(loc, dep)
                if tgt is None or is_importer(tgt):
                    continue
                g.add_edge(key(loc), key(tgt))
    for imp in sorted(chosen):
        e = pkgs.get(imp, {})
        for f in (*_NPM_PROD_FIELDS, "devDependencies"):
            for dep in sorted(e.get(f, {})):
                tgt = resolve(imp, dep)
                if tgt is None or is_importer(tgt):
                    continue
                (g.dev_roots if f == "devDependencies" else g.prod_roots).add(key(tgt))
    return g


def _expand_npm_importers(pkgs, importers, resolve, is_importer) -> set[str]:
    """Selected importers plus the workspaces they depend on (prod deps only)."""
    out: set[str] = set()
    work = deque(i.strip("/") if i not in (".", "") else "" for i in importers)
    while work:
        imp = work.popleft()
        if imp in out:
            continue
        if imp not in pkgs:
            raise ExportError(f"package-lock.json: importer {imp!r} not in lockfile")
        out.add(imp)
        for f in _NPM_PROD_FIELDS:
            for dep in pkgs[imp].get(f, {}):
                tgt = resolve(imp, dep)
                if tgt is not None and is_importer(tgt):
                    work.append(tgt)
    return out


# --------------------------------------------------------------------------------------
# npm: pnpm-lock.yaml v9, via a minimal YAML subset reader
# --------------------------------------------------------------------------------------
#
# WHY A SUBSET READER AND NOT A VENDORED YAML LIBRARY. The exporter must be stdlib-only
# (it runs in a throwaway build stage and in CI with no pip), and the only pure-Python
# YAML implementation worth vendoring is PyYAML's ~5k lines. pnpm writes its lockfile
# through one serializer with one style: block mappings, two-space indent, block
# sequences of scalars, single-line flow collections (`{integrity: ...}`, `[x64]`) and
# single- or double-quoted scalars, and the odd `|-` block scalar (a `deprecated:` notice).
# That subset is ~80 lines to read. Anything outside it (anchors, tags, multi-line flow,
# mappings inside sequences) RAISES rather than misparsing, so a future
# pnpm that changes style fails loudly here instead of producing a wrong graph.


def _yaml_scalar(s: str):
    s = s.strip()
    if not s:
        return None
    if s[0] == "'":
        if not s.endswith("'") or len(s) < 2:
            raise ExportError(f"pnpm-lock.yaml: unterminated quoted scalar {s!r}")
        return s[1:-1].replace("''", "'")
    if s[0] == '"':
        try:
            return json.loads(s)
        except json.JSONDecodeError as e:
            raise ExportError(f"pnpm-lock.yaml: bad double-quoted scalar {s!r}") from e
    if s[0] in "{[":
        if s[-1] not in "}]":
            raise ExportError(f"pnpm-lock.yaml: multi-line flow collection unsupported: {s[:60]!r}")
        return s  # opaque: no field the exporter reads is a flow collection
    if s[0] in "&*!|>":
        raise ExportError(f"pnpm-lock.yaml: unsupported YAML construct {s[:40]!r}")
    return s


def _split_key(body: str) -> tuple[str, str | None]:
    """'key: value' / 'key:' with optionally quoted key -> (key, rest-or-None)."""
    if body[0] in "'\"":
        q = body[0]
        i = 1
        while i < len(body):
            if body[i] == q:
                if q == "'" and i + 1 < len(body) and body[i + 1] == "'":
                    i += 2
                    continue
                break
            if q == '"' and body[i] == "\\":
                i += 1
            i += 1
        k = _yaml_scalar(body[: i + 1])
        rest = body[i + 1 :]
        if not rest.startswith(":"):
            raise ExportError(f"pnpm-lock.yaml: expected ':' after key in {body[:80]!r}")
        rest = rest[1:]
    else:
        m = re.match(r"(.*?):(?:\s|$)", body)
        if not m:
            raise ExportError(f"pnpm-lock.yaml: cannot read line {body[:80]!r}")
        k = m.group(1)
        rest = body[m.end() :]
    rest = rest.strip()
    return k, (rest if rest else None)


def parse_yaml_subset(text: str):
    """Block-style YAML (the pnpm-lock dialect) -> nested dict/list/str."""
    root: dict = {}
    # stack of (indent, container)
    stack: list[tuple[int, object]] = [(0, root)]
    pending: tuple[int, dict, str] | None = None  # a 'key:' awaiting its block
    # A block scalar (`deprecated: |-` and the indented text under it) is kept as an
    # opaque string: the exporter reads no such field, it only has to step over it.
    block: tuple[int, dict, str, list[str]] | None = None
    for lineno, raw in enumerate(text.splitlines(), 1):
        if block is not None:
            b_indent, b_parent, b_key, b_lines = block
            if not raw.strip() or len(raw) - len(raw.lstrip(" ")) > b_indent:
                b_lines.append(raw.strip())
                continue
            b_parent[b_key] = "\n".join(b_lines).strip()
            block = None
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        if "\t" in raw[: len(raw) - len(raw.lstrip())]:
            raise ExportError(f"pnpm-lock.yaml:{lineno}: tab indentation")
        indent = len(raw) - len(raw.lstrip(" "))
        body = raw.strip()
        if pending is not None:
            p_indent, p_parent, p_key = pending
            pending = None
            if indent > p_indent:
                container: object = [] if body.startswith("- ") or body == "-" else {}
                p_parent[p_key] = container
                stack.append((indent, container))
            else:
                p_parent[p_key] = None
        while stack and indent < stack[-1][0]:
            stack.pop()
        if not stack or indent != stack[-1][0]:
            raise ExportError(f"pnpm-lock.yaml:{lineno}: unexpected indentation")
        container = stack[-1][1]
        if body.startswith("- ") or body == "-":
            if not isinstance(container, list):
                raise ExportError(f"pnpm-lock.yaml:{lineno}: sequence item inside a mapping")
            item = body[2:].strip()
            if re.match(r"^('[^']*'|\"[^\"]*\"|[^'\"{\[][^:]*):(\s|$)", item):
                raise ExportError(f"pnpm-lock.yaml:{lineno}: mapping inside a sequence unsupported")
            container.append(_yaml_scalar(item))
            continue
        if not isinstance(container, dict):
            raise ExportError(f"pnpm-lock.yaml:{lineno}: mapping entry inside a sequence")
        k, rest = _split_key(body)
        if rest is None:
            container[k] = None
            pending = (indent, container, k)
        elif re.fullmatch(r"[|>][+-]?", rest):
            block = (indent, container, k, [])
        else:
            container[k] = _yaml_scalar(rest)
    if block is not None:
        block[1][block[2]] = "\n".join(block[3]).strip()
    return root


def _pnpm_split(key: str) -> Key:
    """'@scope/name@1.2.3(peer@1)' -> ('@scope/name', '1.2.3')."""
    base = key.split("(", 1)[0]
    at = base.rfind("@")
    if at <= 0:
        raise ExportError(f"pnpm-lock.yaml: cannot split package key {key!r}")
    return base[:at], base[at + 1 :]


_ALIAS = re.compile(r"^(@?[^@()\s]+)@(\S+)$")


def _pnpm_target(dep_name: str, ref: str) -> str | None:
    """A dependency reference -> snapshot key, or None for a workspace link."""
    if ref.startswith("link:"):
        return None
    if not ref[:1].isdigit() and _ALIAS.match(ref):
        return ref  # npm alias: `string-width-cjs: string-width@4.2.3`
    return f"{dep_name}@{ref}"


def parse_pnpm_lock(text: str, importers: list[str] | None = None) -> Graph:
    """pnpm-lock.yaml v9 -> Graph.

    `importers` -> direct deps (dependencies/optionalDependencies prod,
    devDependencies dev); `snapshots` -> the graph. With `importers` given, only those
    importers and the workspace packages they `link:` to (prod side) are roots — the
    view of one deployable app in a monorepo.
    """
    doc = parse_yaml_subset(text)
    ver = str(doc.get("lockfileVersion", ""))
    if not ver.startswith("9"):
        raise ExportError(f"pnpm-lock.yaml: lockfileVersion {ver!r} unsupported (need 9.x)")
    # An importer with no dependencies is written as a flow `{}` (kept opaque): empty.
    imps: dict = {k: (v if isinstance(v, dict) else {}) for k, v in (doc.get("importers") or {}).items()}
    snaps: dict = doc.get("snapshots") or {}

    def link_target(imp: str, ref: str) -> str:
        return os.path.normpath(os.path.join(imp, ref[len("link:") :])).replace(os.sep, "/")

    if importers:
        chosen: set[str] = set()
        work = deque(os.path.normpath(i).replace(os.sep, "/") for i in importers)
        while work:
            imp = work.popleft()
            if imp in chosen:
                continue
            if imp not in imps:
                raise ExportError(f"pnpm-lock.yaml: importer {imp!r} not in lockfile")
            chosen.add(imp)
            for f in ("dependencies", "optionalDependencies"):
                for spec in (imps[imp].get(f) or {}).values():
                    ref = spec.get("version", "") if isinstance(spec, dict) else ""
                    if ref.startswith("link:"):
                        work.append(link_target(imp, ref))
    else:
        chosen = set(imps)

    g = Graph()
    for skey in sorted(snaps):
        sk = _pnpm_split(skey)
        g.add_node(sk)
        body = snaps[skey] or {}
        if not isinstance(body, dict):
            continue
        for f in ("dependencies", "optionalDependencies"):
            for dep, ref in sorted((body.get(f) or {}).items()):
                tgt = _pnpm_target(dep, str(ref))
                if tgt is None:
                    continue
                if tgt not in snaps:
                    raise ExportError(f"pnpm-lock.yaml: {skey} -> {tgt} has no snapshot")
                g.add_edge(sk, _pnpm_split(tgt))
    for imp in sorted(chosen):
        for f in ("dependencies", "optionalDependencies", "devDependencies"):
            for dep, spec in sorted((imps[imp].get(f) or {}).items()):
                ref = str(spec.get("version", "")) if isinstance(spec, dict) else ""
                tgt = _pnpm_target(dep, ref) if ref else None
                if tgt is None:
                    continue
                if tgt not in snaps:
                    raise ExportError(f"pnpm-lock.yaml: importer {imp} -> {tgt} has no snapshot")
                (g.dev_roots if f == "devDependencies" else g.prod_roots).add(_pnpm_split(tgt))
    return g


# --------------------------------------------------------------------------------------
# golang: go.mod (+ go.sum)
# --------------------------------------------------------------------------------------
#
# go.sum is a set of content hashes, not a graph: it records WHICH modules were
# verified, never who required whom. The graph lives in each dependency's own go.mod,
# which only `go mod graph` (network or module cache) can read. So, offline, Go output is
# honest-but-shallow: `direct` is exact (go.mod without `// indirect`), a direct module's
# path is itself, and an indirect module's `paths` is EMPTY — "transitive, chain unknown",
# never an invented chain. go.sum entries absent from go.mod are not listed: since Go 1.17
# go.mod names every module the build needs, and go.sum also keeps hashes of modules that
# were only consulted.


def parse_go_mod(text: str) -> list[dict]:
    reqs: list[tuple[str, str, bool]] = []
    in_block = False
    for raw in text.splitlines():
        line = raw.strip()
        if in_block:
            if line.startswith(")"):
                in_block = False
                continue
            body = line
        elif line.startswith("require ("):
            in_block = True
            continue
        elif line.startswith("require "):
            body = line[len("require ") :]
        else:
            continue
        if not body or body.startswith("//"):
            continue
        indirect = bool(re.search(r"//\s*indirect\b", body))
        parts = body.split("//", 1)[0].split()
        if len(parts) < 2:
            raise ExportError(f"go.mod: cannot read require line {raw!r}")
        reqs.append((parts[0], parts[1], indirect))
    pkgs = []
    for name, ver, indirect in sorted(set(reqs)):
        pkgs.append(
            {
                "name": name,
                "version": ver,
                "direct": not indirect,
                "dev": False,
                "paths": [] if indirect else [[name]],
            }
        )
    return pkgs


# --------------------------------------------------------------------------------------
# Context discovery and rendering
# --------------------------------------------------------------------------------------


def _read(path: str) -> str:
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def _rel(context_name: str, fname: str) -> str:
    return fname if context_name in ("", ".") else f"{context_name.rstrip('/')}/{fname}"


def export(context: str, context_name: str, importers: list[str] | None = None) -> list[dict]:
    """Every non-empty ecosystem found in `context`, sorted. [] when nothing is supported
    or every supported lockfile installs nothing."""
    ecos: list[dict] = []

    def have(f: str) -> bool:
        return os.path.isfile(os.path.join(context, f))

    if have("uv.lock"):
        g = parse_uv(_read(os.path.join(context, "uv.lock")))
        if have("pyproject.toml"):
            # The contract's definition of "direct" is the pyproject's own list; the lock
            # already encodes it, and this keeps the two from silently disagreeing.
            declared = pyproject_direct(_read(os.path.join(context, "pyproject.toml")))
            missing = sorted(declared - {k[0] for k in g.prod_roots})
            if missing:
                raise ExportError(f"uv.lock is stale: pyproject dependencies not in lock root: {missing}")
        ecos.append(
            {
                "ecosystem": "pypi",
                "manifest": _rel(context_name, "pyproject.toml") if have("pyproject.toml") else None,
                "lockfile": _rel(context_name, "uv.lock"),
                "packages": classify(g),
            }
        )
    if have("package-lock.json"):
        g = parse_npm_lock(_read(os.path.join(context, "package-lock.json")), importers)
        ecos.append(
            {
                "ecosystem": "npm",
                "manifest": _rel(context_name, "package.json") if have("package.json") else None,
                "lockfile": _rel(context_name, "package-lock.json"),
                "packages": classify(g),
            }
        )
    if have("pnpm-lock.yaml"):
        g = parse_pnpm_lock(_read(os.path.join(context, "pnpm-lock.yaml")), importers)
        ecos.append(
            {
                "ecosystem": "npm",
                "manifest": _rel(context_name, "package.json") if have("package.json") else None,
                "lockfile": _rel(context_name, "pnpm-lock.yaml"),
                "packages": classify(g),
            }
        )
    if have("go.mod"):
        ecos.append(
            {
                "ecosystem": "golang",
                "manifest": _rel(context_name, "go.mod"),
                "lockfile": _rel(context_name, "go.sum") if have("go.sum") else None,
                "packages": parse_go_mod(_read(os.path.join(context, "go.mod"))),
            }
        )
    # A lockfile whose importers install nothing (e.g. a repo-root package-lock.json that
    # only pins tooling for workspaces outside this context) contributes no ecosystem: an
    # empty `packages` list would read as "this image has no dependencies".
    ecos = [e for e in ecos if e["packages"]]
    ecos.sort(key=lambda e: (e["ecosystem"], e["lockfile"] or ""))
    return ecos


def render(ecosystems: list[dict], repo: str | None, commit: str | None, context_name: str) -> str:
    doc = {
        "schema": SCHEMA,
        "generated_by": f"narella-deps-export {VERSION}",
        "source": {"repo": repo or None, "commit": commit or None, "context": context_name},
        "ecosystems": ecosystems,
    }
    return json.dumps(doc, sort_keys=True, indent=2, ensure_ascii=False) + "\n"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="narella-deps-export", description=__doc__.split("\n\n")[0])
    ap.add_argument("--context", required=True, help="directory holding the lockfile(s)")
    ap.add_argument(
        "--context-name",
        help="repo-relative name of the context, used in source.context and manifest/lockfile "
        "paths (default: --context as given). Needed when the files were copied elsewhere, "
        "e.g. into a build stage.",
    )
    ap.add_argument("--repo", help="repository slug, e.g. narella-io/narella")
    ap.add_argument("--commit", help="commit the inputs came from; empty = unknown (null)")
    ap.add_argument(
        "--importer",
        action="append",
        help="npm/pnpm workspaces only: restrict direct deps to this importer (repeatable) "
        "and the workspace packages it links to. Default: every importer.",
    )
    ap.add_argument("--output", help="write here (only on success) instead of stdout")
    args = ap.parse_args(argv)

    name = args.context_name if args.context_name is not None else os.path.normpath(args.context)
    name = name.replace(os.sep, "/").strip("/") or "."
    try:
        ecos = export(args.context, name, args.importer)
    except (ExportError, OSError, tomllib.TOMLDecodeError, KeyError) as e:
        print(f"narella-deps-export: {e}", file=sys.stderr)
        return EXIT_PARSE
    if not ecos:
        print(
            f"narella-deps-export: no supported lockfile with packages in {args.context!r} "
            "(uv.lock, package-lock.json, pnpm-lock.yaml, go.mod); writing nothing — "
            "provenance for this context is UNKNOWN",
            file=sys.stderr,
        )
        return EXIT_NO_LOCKFILE
    out = render(ecos, args.repo, args.commit, name)
    if args.output:
        tmp = args.output + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(out)
        os.replace(tmp, args.output)
    else:
        sys.stdout.write(out)
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
