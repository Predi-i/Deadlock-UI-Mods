"""Create a single embedded VPK and verify every resource before publication."""
import argparse
from binascii import crc32
from pathlib import Path
import tempfile


def verify_contents(archive, directory):
    expected = {p.relative_to(directory).as_posix(): p
                for p in directory.rglob("*") if p.is_file()}
    paths = list(archive)
    if not expected or len(paths) != len(set(paths)) or set(paths) != set(expected):
        raise ValueError("Package resource paths differ from the fresh build")
    for name, path in expected.items():
        metadata = archive.get_file_meta(name)
        if metadata["archive_index"] != 0x7fff:
            raise ValueError(f"Resource uses an external VPK volume: {name}")
        with archive[name] as resource:
            packed = resource.read()
        if crc32(packed) & 0xffffffff != metadata["crc32"]:
            raise ValueError(f"Resource CRC mismatch: {name}")
        if packed != path.read_bytes():
            raise ValueError(f"Packed resource differs from compiler output: {name}")
    return len(expected)


def pack(directory, output):
    import vpk
    directory = directory.resolve()
    output = output.resolve()
    if not directory.is_dir() or not any(p.is_file() for p in directory.rglob("*")):
        raise ValueError(f"Compiled resource directory is missing or empty: {directory}")
    if output.is_relative_to(directory):
        raise ValueError("Package output must be outside the resource directory")
    if output.exists():
        raise ValueError(f"Refusing to reuse an existing package: {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    # Verification failures leave no publishable package. The temporary tree is
    # outside the input directory so its own files cannot enter the archive.
    with tempfile.TemporaryDirectory(prefix="vpk-check-", dir=output.parent) as temporary:
        candidate = Path(temporary) / output.name
        vpk.new(str(directory)).save(str(candidate))
        archive = vpk.open(str(candidate))
        if archive.version != 2 or not archive.verify():
            raise ValueError("VPK v2 directory/data checksum verification failed")
        count = verify_contents(archive, directory)
        candidate.replace(output)
    return count


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    count = pack(args.directory, args.output)
    print(f"Verified {count} embedded resources byte for byte and by CRC: {args.output}")


if __name__ == "__main__":
    main()
