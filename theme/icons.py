#!/usr/bin/env python3
"""Convierte iconos de Papirus a pixel-art de forma algorítmica (sin IA).

Método, por icono:
  1. se rasteriza el SVG a 8 píxeles por celda;
  2. cada celda de la rejilla toma su color DOMINANTE (no el promedio, que
     enturbia los bordes) y es opaca si está cubierta al menos a la mitad;
  3. la paleta del icono se reduce por corte de mediana (determinista);
  4. en la versión grande se añade un contorno de una celda.

Salen dos tamaños: rejilla 16 con contorno (96 px, para 29 px o más) y
rejilla 12 sin contorno (24 px, para paneles y listas).

    icons.py            apps instaladas + tipos de archivo + dispositivos
    icons.py --all      todas las apps de Papirus (~3700, tarda unos minutos)

Escribe en theme/auto-icons/; `theme.py install` lo incorpora al tema.
Requiere python3-pyqt6 (para leer SVG) y python3-pil.
"""
import os
import re
import shutil
import sys
from collections import Counter
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
from PIL import Image                                    # noqa: E402
from PyQt6.QtCore import QSize                           # noqa: E402
from PyQt6.QtGui import QGuiApplication, QImage, QImageReader   # noqa: E402

HERE = Path(__file__).resolve().parent
OUT = HERE / "auto-icons"
SRC = Path("/usr/share/icons/Papirus/64x64")
TOKENS = HERE.parent / "web/assets/styles/tokens.css"
CELL = 8                       # píxeles de muestra por celda
VARIANTS = {"96x96": (16, 6, 8, True), "24x24": (12, 2, 6, False)}   # rejilla, escala, colores, contorno
PLACES = ["user-trash", "user-trash-full", "network-server", "user-bookmarks", "start-here"]
DESKTOP_DIRS = ["/usr/share/applications", "~/.local/share/applications",
                "/var/lib/flatpak/exports/share/applications", "~/.local/share/flatpak/exports/share/applications"]


def outline_color():
    m = re.search(r"--cat-brown:\s*(#[0-9a-fA-F]{6})", TOKENS.read_text())
    c = m.group(1)
    return tuple(int(c[i:i + 2], 16) for i in (1, 3, 5)) + (255,)


def render(path, px):
    reader = QImageReader(str(path))
    reader.setScaledSize(QSize(px, px))
    img = reader.read()
    if img.isNull():
        return None
    img = img.convertToFormat(QImage.Format.Format_RGBA8888)
    data = bytes(img.constBits().asarray(px * px * 4))
    return Image.frombuffer("RGBA", (px, px), data, "raw", "RGBA", 0, 1).copy()


def pixelate(src, grid, colors, outline):
    px = src.load()
    cells = Image.new("RGBA", (grid, grid))
    for gy in range(grid):
        for gx in range(grid):
            seen, alpha = Counter(), 0
            for y in range(gy * CELL, gy * CELL + CELL):
                for x in range(gx * CELL, gx * CELL + CELL):
                    r, g, b, a = px[x, y]
                    alpha += a
                    if a > 127:
                        seen[(r >> 3, g >> 3, b >> 3)] += 1
            if seen and alpha >= CELL * CELL * 255 / 2:
                r, g, b = seen.most_common(1)[0][0]
                cells.putpixel((gx, gy), ((r << 3) | 4, (g << 3) | 4, (b << 3) | 4, 255))
    flat = cells.convert("RGB").quantize(colors, method=Image.Quantize.MEDIANCUT,
                                         dither=Image.Dither.NONE).convert("RGB")
    out = Image.new("RGBA", (grid, grid))
    solid = [[cells.getpixel((x, y))[3] > 0 for x in range(grid)] for y in range(grid)]
    for y in range(grid):
        for x in range(grid):
            if solid[y][x]:
                out.putpixel((x, y), flat.getpixel((x, y)) + (255,))
            elif outline and any(0 <= x + dx < grid and 0 <= y + dy < grid and solid[y + dy][x + dx]
                                 for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))):
                out.putpixel((x, y), outline)
    return out


def installed_app_icons():
    names = set()
    for d in DESKTOP_DIRS:
        for f in Path(os.path.expanduser(d)).glob("*.desktop"):
            try:
                m = re.search(r"^Icon=(.+)$", f.read_text(errors="ignore"), re.M)
            except OSError:
                continue
            if m and "/" not in m.group(1):
                names.add(m.group(1).strip())
    return names


def wanted(all_apps):
    """Devuelve [(contexto, nombre)] de todo lo que hay que tener."""
    jobs = []
    apps = SRC / "apps"
    if all_apps:
        jobs += [("apps", p.stem) for p in apps.glob("*.svg")]
    else:
        jobs += [("apps", n) for n in installed_app_icons() if (apps / f"{n}.svg").exists()]
    for ctx in ("mimetypes", "devices"):
        jobs += [(ctx, p.stem) for p in (SRC / ctx).glob("*.svg")]
    jobs += [("places", n) for n in PLACES if (SRC / "places" / f"{n}.svg").exists()]
    return sorted(set(jobs))


def main():
    all_apps = "--all" in sys.argv
    app = QGuiApplication(sys.argv)          # noqa: F841  (hace falta para leer SVG)
    edge = outline_color()
    if OUT.exists():
        shutil.rmtree(OUT)
    jobs = wanted(all_apps)
    done, links, failed = {}, 0, 0
    for i, (ctx, name) in enumerate(jobs, 1):
        svg = SRC / ctx / f"{name}.svg"
        real = svg.resolve()
        # Un alias dentro del mismo contexto se enlaza en vez de duplicarse.
        target = real.stem if real.parent == svg.parent.resolve() else name
        if (ctx, target) not in done:
            src = render(real, 16 * CELL)
            small = render(real, 12 * CELL)
            if src is None or small is None:
                failed += 1
                continue
            for folder, (grid, scale, colors, with_edge) in VARIANTS.items():
                art = pixelate(src if grid == 16 else small, grid, colors, edge if with_edge else None)
                dest = OUT / folder / ctx
                dest.mkdir(parents=True, exist_ok=True)
                art.resize((grid * scale, grid * scale), Image.NEAREST).save(dest / f"{target}.png", optimize=True)
            done[(ctx, target)] = True
        if target != name:
            for folder in VARIANTS:
                link = OUT / folder / ctx / f"{name}.png"
                if not link.exists():
                    link.symlink_to(f"{target}.png")
            links += 1
        if i % 200 == 0:
            print(f"  {i}/{len(jobs)}", flush=True)
    print(f"{len(done)} iconos convertidos, {links} alias, {failed} sin convertir → {OUT}")


if __name__ == "__main__":
    main()
