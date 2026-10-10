"""Prepare raw assets and PNG/TGA descriptors for CI; never compile or pack."""
import argparse
import pathlib
import re
import shutil

ROOT = pathlib.Path(__file__).resolve().parents[1]


def prepare(content, game):
    # Keep the descriptor identical to the maintainer's existing local builder.
    builder = (ROOT / "tools/build_mod.ps1").read_text(encoding="utf-8-sig")
    match = re.search(r'function Get-AutoVtexBody\([^\n]+\)\s*\{\s*return @"\n([\s\S]*?)\n"@', builder)
    if not match:
        raise ValueError("Local builder's texture descriptor changed; update CI preparation")
    for file in list(content.rglob("*")):
        if not file.is_file():
            continue
        relative = file.relative_to(content)
        if file.suffix.lower() == ".vtex":
            body = file.read_text(encoding="utf-8-sig")
            body = re.sub(r'("m_algorithm"\s+"string"\s+)"[^"]*"', r'\1""', body)
            file.write_text(body, encoding="utf-8")
        if file.suffix.lower() in (".png", ".tga"):
            descriptor = file.with_suffix(".vtex")
            if not descriptor.exists():
                descriptor.write_text(match[1].replace("$RelFileName", relative.as_posix()) + "\n", encoding="utf-8")
        if file.suffix.lower() in (".ttf", ".vxml_c", ".vcss_c", ".vjs_c", ".vsndevts_c",
                                   ".vsnd_c", ".vtex_c", ".vdata_c", ".vsvg_c", ".vpcf_c",
                                   ".vmdl_c", ".vmat_c"):
            target = game / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(file, target)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--content", required=True, type=pathlib.Path)
    parser.add_argument("--game", required=True, type=pathlib.Path)
    args = parser.parse_args()
    prepare(args.content, args.game)


if __name__ == "__main__":
    main()
