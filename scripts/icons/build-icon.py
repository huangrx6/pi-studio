"""Rebuild desktop, menu-bar and website brand assets from assets/pi-mark.svg.

Run: python3 scripts/icons/build-icon.py
Requires Pillow, CairoSVG and its native Cairo library.
"""

from shutil import copyfile

from pi_mark import ASSETS, SOURCE, write_app_icons, write_tray_icons


if __name__ == "__main__":
    write_app_icons()
    write_tray_icons()
    copyfile(SOURCE, ASSETS.parent / "website" / "assets" / SOURCE.name)
