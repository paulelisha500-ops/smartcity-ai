"""
Publish the hosted edition to its Hugging Face Space.

    cd frontend && npm run build:static && cd ..
    python scripts/deploy_space.py            # the site
    python scripts/deploy_space.py --data     # the site and the data set

The Space holds two things with different lifetimes:

* the **site** — the static export in frontend/out. Rebuilt from source on
  every push, so CI publishes it and removes files a new build no longer has;
* the **data set** under data/ — written by scripts/snapshot_static.py from a
  database with the network ingested. CI has no such database, so it never
  touches data/; publish it from a machine that has just taken a snapshot.

Authentication is whatever `huggingface_hub` finds: the HF_TOKEN environment
variable (CI) or a cached `hf auth login`.
"""
from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path

from huggingface_hub import CommitOperationAdd, CommitOperationDelete, HfApi
from huggingface_hub.errors import EntryNotFoundError
from huggingface_hub.hf_api import RepoFile

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "frontend" / "out"
DATA = ROOT / "frontend" / "public" / "data"
CARD = ROOT / "deploy" / "space" / "README.md"
SPACE = os.environ.get("HF_SPACE", "Elisha622/smartcity-ai")

# The data set is a few thousand small files, published as ordinary git files:
# the Space serves those directly, whereas an LFS object is served through an
# uncached redirect to the CDN — an extra round trip on every map tile. The
# contents of an ordinary file travel inside the commit request, so the upload
# is split into commits of bounded size.
BATCH_BYTES = 8 * 1024 * 1024
BATCH_FILES = 400


def site_files() -> dict[str, Path]:
    """Everything in the export except the data set, keyed by repo path."""
    files = {
        path.relative_to(OUT).as_posix(): path
        for path in OUT.rglob("*")
        if path.is_file() and path.relative_to(OUT).parts[0] != "data"
    }
    files["README.md"] = CARD
    return files


def git_blob_sha(payload: bytes) -> str:
    """The id git gives a file with these contents — what the Hub reports back."""
    return hashlib.sha1(b"blob %d\0" % len(payload) + payload).hexdigest()


def publish_data(api: HfApi) -> None:
    """Upload what changed under data/, and remove what the snapshot no longer has."""
    local = {f"data/{p.relative_to(DATA).as_posix()}": p for p in DATA.rglob("*") if p.is_file()}

    remote: dict[str, set[str]] = {}
    try:
        for entry in api.list_repo_tree(SPACE, repo_type="space", path_in_repo="data", recursive=True):
            if isinstance(entry, RepoFile):
                # Ordinary files report their git blob id; LFS files, the sha256
                # of the content. Accept either so an earlier LFS upload is
                # replaced rather than mistaken for current.
                remote[entry.path] = {entry.blob_id} if not entry.lfs else {f"lfs:{entry.lfs.sha256}"}
    except EntryNotFoundError:
        pass

    def unchanged(name: str, path: Path) -> bool:
        payload = path.read_bytes()
        return git_blob_sha(payload) in remote.get(name, set())

    changed = [name for name, path in local.items() if not unchanged(name, path)]
    stale = [name for name in remote if name not in local]

    batches: list[list[str]] = [[]]
    size = 0
    for name in changed:
        weight = local[name].stat().st_size
        if batches[-1] and (size + weight > BATCH_BYTES or len(batches[-1]) >= BATCH_FILES):
            batches.append([])
            size = 0
        batches[-1].append(name)
        size += weight

    for i, batch in enumerate(batches, start=1):
        operations: list = [
            CommitOperationAdd(path_in_repo=name, path_or_fileobj=str(local[name])) for name in batch
        ]
        if i == 1:
            operations += [CommitOperationDelete(path_in_repo=name) for name in stale]
        if not operations:
            continue
        api.create_commit(
            repo_id=SPACE, repo_type="space", operations=operations,
            commit_message=f"Publish data set ({i}/{len(batches)})",
        )
        print(f"  data set {i}/{len(batches)}: {len(batch)} files")
    print(
        f"published data set ({len(changed)} changed, {len(stale)} removed, "
        f"{len(local) - len(changed)} unchanged)"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--data", action="store_true", help="also publish the data set")
    args = parser.parse_args()

    if not (OUT / "index.html").exists():
        raise SystemExit("frontend/out is missing — run `npm run build:static` in frontend/ first.")

    api = HfApi()
    api.create_repo(SPACE, repo_type="space", space_sdk="static", exist_ok=True)

    if args.data:
        if not (DATA / "manifest.json.gz").exists():
            raise SystemExit("frontend/public/data is missing — run scripts/snapshot_static.py first.")
        publish_data(api)

    local = site_files()
    stale = [
        path for path in api.list_repo_files(SPACE, repo_type="space")
        if path not in local and not path.startswith("data/")
    ]
    api.create_commit(
        repo_id=SPACE, repo_type="space",
        commit_message=f"Publish site ({os.environ.get('GITHUB_SHA', 'local')[:7]})",
        operations=[
            *(CommitOperationAdd(path_in_repo=name, path_or_fileobj=str(path)) for name, path in local.items()),
            *(CommitOperationDelete(path_in_repo=path) for path in stale),
        ],
    )
    print(f"published site ({len(local)} files, {len(stale)} stale removed)")
    print(f"https://huggingface.co/spaces/{SPACE}")


if __name__ == "__main__":
    main()
