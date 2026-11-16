#!/usr/bin/env python3
"""Tema pixel-art para las ventanas: marcos de xfwm4 + tema y paleta de LXQt.

Los colores salen de web/assets/styles/tokens.css, igual que la escena.

    theme.py build     genera theme/out/ (no toca nada fuera del proyecto)
    theme.py install   build + copia a ~/.themes, ~/.local/share/lxqt/themes
                       y ~/.local/share/icons
                       (queda disponible, pero sin activar)
    theme.py apply     install + lo activa, guardando antes lo que había
    theme.py revert    restaura lo guardado por apply

Con --light (en build, install o apply) se genera la variante clara, con la
paleta de los carruseles de cover-creator-cli. Incluye también un tema de rofi.
"""
import os
import re
import shutil
import struct
import subprocess
import sys
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
BACKUP = HERE / "backup"
TOKENS = HERE.parent / "web/assets/styles/tokens.css"
LXQT_BASE = Path("/usr/share/lxqt/themes/light" if "--light" in sys.argv else "/usr/share/lxqt/themes/dark")

XFWM_NAME = "PixelDesk"
ICON_NAME = "PixelDesk"
ICON_PARENT = "Papirus" if "--light" in sys.argv else "Papirus-Dark"   # lo que no se convierte
LXQT_NAME = "pixel-desk"

HOME = Path.home()
CONFIG = Path(os.environ.get("XDG_CONFIG_HOME") or HOME / ".config")
DATA = Path(os.environ.get("XDG_DATA_HOME") or HOME / ".local/share")
XFWM_DEST = HOME / ".themes" / XFWM_NAME / "xfwm4"
LXQT_DEST = DATA / "lxqt/themes" / LXQT_NAME
ICON_DEST = DATA / "icons" / ICON_NAME
ROFI_DIR = CONFIG / "rofi"
ROFI_THEME = ROFI_DIR / "themes" / "pixel-desk.rasi"
ROFI_CONF = ROFI_DIR / "config.rasi"
LXQT_CONF = CONFIG / "lxqt/lxqt.conf"
PANEL_CONF = CONFIG / "lxqt/panel.conf"


def tokens():
    raw = dict(re.findall(r"(--[\w-]+):\s*([^;]+);", TOKENS.read_text()))

    def resolve(v):
        m = re.fullmatch(r"var\((--[\w-]+)\)", v.strip())
        return resolve(raw[m.group(1)]) if m else v.strip()

    return {k: resolve(v) for k, v in raw.items()}


T = tokens()
LIGHT = "--light" in sys.argv
PANEL, PANEL2, LINE = T["--panel"], T["--panel-2"], T["--line"]
INK, MUTED, ACCENT = T["--ink"], T["--muted"], T["--accent"]
GRAY, CHARCOAL, BAD, OK = T["--cat-gray"], T["--cat-charcoal"], T["--sem-bad"], T["--sem-ok"]
BLACK = "#000000"   # texto sobre el acento
if LIGHT:
    # Paleta clara de los carruseles (cover-creator-cli, tema light): fondo
    # blanco, tinta azul noche y el naranja de la marca un punto más vivo.
    LT = dict(re.findall(r"(--light-[\w-]+):\s*([^;]+);", (HERE.parent / "web/assets/styles/light.css").read_text()))
    PANEL, PANEL2, LINE = LT["--light-panel"], LT["--light-panel-2"], LT["--light-line"]
    INK, MUTED, ACCENT = LT["--light-ink"], LT["--light-muted"], LT["--light-accent"]
    CHARCOAL, GRAY = LT["--light-line"], LT["--light-muted"]
    BLACK = LT["--light-on-accent"]

# ── xfwm4 ────────────────────────────────────────────────────────────────────
U = 3            # un "píxel" del tema, en píxeles reales
TITLE_H = 8 * U  # 24 px
BTN_W = 8 * U

GLYPHS = {
    "close": ["10001", "01010", "00100", "01010", "10001"],
    "maximize": ["11111", "11111", "10001", "10001", "11111"],
    "maximize-toggled": ["00000", "01110", "01010", "01110", "00000"],
    "hide": ["00000", "00000", "00000", "00000", "11111"],
    "menu": ["11111", "00000", "11111", "00000", "11111"],
    "shade": ["00100", "01110", "11111", "00000", "11111"],
    "shade-toggled": ["11111", "00000", "11111", "01110", "00100"],
    "stick": ["00000", "00100", "01110", "00100", "00000"],
    "stick-toggled": ["01110", "11111", "11111", "11111", "01110"],
}


def xpm(name, rows, colors):
    """rows: lista de strings; colors: {caracter: '#rrggbb' | 'None'}."""
    used = {ch for r in rows for ch in r}
    head = [f"{len(rows[0])} {len(rows)} {len(used)} 1"]
    head += [f"{ch} c {colors[ch]}" for ch in sorted(used)]
    body = ",\n".join(f'"{line}"' for line in head + rows)
    ident = re.sub(r"\W", "_", name)
    return f"/* XPM */\nstatic char * {ident}_xpm[] = {{\n{body}\n}};\n"


def title_column(border):
    """Una columna del título: borde arriba, fondo, línea abajo."""
    return ["b"] * U + ["p"] * (TITLE_H - 2 * U) + ["b"] * U


def build_xfwm(dest):
    dest.mkdir(parents=True, exist_ok=True)
    states = {"active": ACCENT, "inactive": CHARCOAL}
    for state, border in states.items():
        col = {"b": border, "p": PANEL, ".": "None"}
        column = title_column(border)
        # Título: 5 tramos iguales, se repiten a lo ancho.
        for i in range(1, 6):
            rows = [ch * U for ch in column]
            (dest / f"title-{i}-{state}.xpm").write_text(xpm(f"title_{i}", rows, col))
        # Esquinas superiores: falta el píxel de la esquina (borde escalonado).
        corner = ["." * U] * U + ["b" * U] * (TITLE_H - U)
        for side in ("top-left", "top-right"):
            (dest / f"{side}-{state}.xpm").write_text(xpm(side, corner, col))
        for side in ("left", "right"):
            (dest / f"{side}-{state}.xpm").write_text(xpm(side, ["b" * U] * U, col))
        (dest / f"bottom-{state}.xpm").write_text(xpm("bottom", ["b" * U] * U, col))
        for side in ("bottom-left", "bottom-right"):
            (dest / f"{side}-{state}.xpm").write_text(xpm(side, ["." * U] * U, col))

    # Botones: glifo 5×5 centrado sobre la misma columna del título.
    def button(glyph, border, bg, fg):
        rows = []
        gx, gy = (BTN_W - 5 * U) // 2, U + (TITLE_H - 2 * U - 5 * U) // 2 + 1
        for y in range(TITLE_H):
            if y < U or y >= TITLE_H - U:
                rows.append("b" * BTN_W)
                continue
            line = ""
            for x in range(BTN_W):
                cx, cy = (x - gx) // U, (y - gy) // U
                on = 0 <= cx < 5 and 0 <= cy < 5 and x >= gx and y >= gy and glyph[cy][cx] == "1"
                line += "g" if on else "p"
            rows.append(line)
        return rows, {"b": border, "p": bg, "g": fg}

    for name, glyph in GLYPHS.items():
        hover_bg = BAD if name == "close" else ACCENT
        variants = {
            "active": (ACCENT, PANEL, INK),
            "inactive": (CHARCOAL, PANEL, GRAY),
            "prelight": (ACCENT, hover_bg, BLACK),
            "pressed": (ACCENT, PANEL2, hover_bg),
        }
        for state, (border, bg, fg) in variants.items():
            rows, col = button(glyph, border, bg, fg)
            (dest / f"{name}-{state}.xpm").write_text(xpm(f"{name}_{state}", rows, col))

    (dest / "themerc").write_text(
        "# PixelDesk — generado por pixel-desk/theme/theme.py (no editar a mano)\n"
        f"active_text_color={INK}\n"
        f"inactive_text_color={GRAY}\n"
        "title_shadow_active=false\n"
        "title_shadow_inactive=false\n"
        "full_width_title=true\n"
        "title_horizontal_offset=0\n"
        "title_vertical_offset_active=1\n"
        "title_vertical_offset_inactive=1\n"
        f"button_offset={U}\n"
        "button_spacing=0\n"
        "maximized_offset=0\n"
        "show_app_icon=false\n"
        "shadow_delta_height=0\n"
        "shadow_delta_width=0\n"
        "shadow_delta_x=0\n"
        "shadow_delta_y=0\n"
        "shadow_opacity=40\n"
    )


# ── LXQt ─────────────────────────────────────────────────────────────────────
PANEL_QSS = f"""

/* ══ pixel-desk ══ reglas añadidas sobre el tema "dark" de LXQt ══════════════ */
LXQtPanel #BackgroundWidget {{
    background: {PANEL};
    border-top: {U}px solid {ACCENT};
}}

Plugin > QWidget,
Plugin > QWidget > QWidget {{
    color: {INK};
}}

Plugin > QToolButton,
Plugin > QWidget > QToolButton,
Plugin > QWidget > QToolButton > QWidget > QToolButton,
LXQtPanelPlugin > QToolButton {{
    border: none;
    color: {INK};
}}

Plugin > QToolButton:hover,
Plugin > QWidget > QToolButton:hover,
LXQtPanelPlugin > QToolButton:hover {{
    border: none;
    background: {LINE};
}}

#TaskBar QToolButton {{
    border: none;
    border-bottom: {U}px solid transparent;
    background: transparent;
    color: {MUTED};
    padding: 0 {2 * U}px;
}}

#TaskBar QToolButton:hover {{
    border: none;
    border-bottom: {U}px solid {LINE};
    background: {PANEL2};
    color: {INK};
}}

#TaskBar QToolButton:on,
#TaskBar QToolButton:checked {{
    border: none;
    border-bottom: {U}px solid {ACCENT};
    background: {PANEL2};
    color: {INK};
}}

#TaskBar QToolButton[urgent="true"] {{
    border: none;
    border-bottom: {U}px solid {BAD};
    background: {PANEL2};
    color: {BAD};
}}

#DesktopSwitch QToolButton {{
    border: none;
    margin: 0;
    background: transparent;
    color: {MUTED};
}}

#DesktopSwitch QToolButton:hover {{
    border: none;
    background: {LINE};
    color: {INK};
}}

#DesktopSwitch QToolButton:on,
#DesktopSwitch QToolButton:checked {{
    border: none;
    background: {ACCENT};
    color: {BLACK};
}}

#DesktopSwitch QToolButton[urgent="true"] {{
    border: none;
    background: {BAD};
    color: {BLACK};
}}

QMenu {{
    background: {PANEL};
    border: {U}px solid {ACCENT};
    color: {INK};
    padding: {U}px;
}}

QMenu::item {{
    background: transparent;
    color: {INK};
    border: none;
}}

QMenu::item:selected {{
    background: {ACCENT};
    color: {BLACK};
    border: none;
}}

QMenu::separator {{
    height: {U}px;
    background: {LINE};
    margin: {U}px 0;
}}

QToolTip {{
    border: {U}px solid {ACCENT};
    background: {PANEL};
    color: {INK};
    padding: {U}px;
}}

#MainMenu {{
    qproperty-icon: url(mainmenu.png);
}}

#Clock,
#WorldClock,
#WorldClockContent {{
    color: {INK};
}}

VolumePopup,
#LXQtMountPopup,
#Backlight > SliderDialog {{
    background: {PANEL};
    border: {U}px solid {ACCENT};
}}

VolumePopup > QPushButton {{
    border: none;
    background: {PANEL2};
    color: {INK};
}}

VolumePopup > QSlider::handle:vertical {{
    background: {ACCENT};
}}
"""

NOTIFY_QSS = f"""

/* ══ pixel-desk ══ */
Notification {{
    color: {INK};
    border: {U}px solid {ACCENT};
    background: {PANEL};
}}

QLabel {{
    color: {INK};
}}
"""

RUNNER_QSS = f"""

/* ══ pixel-desk ══ */
#panel {{
    background: {PANEL};
    border: {U}px solid {ACCENT};
}}

#commandEd {{
    background: {PANEL2};
    color: {INK};
    border: none;
    selection-background-color: {ACCENT};
    selection-color: {BLACK};
}}

#commandList {{
    background: {PANEL};
    color: {INK};
    border: {U}px solid {ACCENT};
}}

#commandList::item:selected {{
    background: {ACCENT};
    color: {BLACK};
}}
"""


def menu_icon():
    """Icono del menú: el colibrí de LXQt (el que trae Debian) en 12×12 (2 px por celda a 24 px)."""
    art = [
        "............",
        "......OOO...",
        ".....OOBOOOO",
        "WW...OOOO...",
        "WWWW..OO....",
        ".WWWW.OOO...",
        "WWWWWWOOO...",
        "..WWWOOOO...",
        "....OOOO....",
        "...OOOO.....",
        "..OOO.......",
        "..O.........",
    ]
    colors = {"O": INK, "W": ACCENT, "B": T["--cat-brown"]}
    return png(art, colors, scale=8)     # 96×96: se reduce limpio a 24 o 48 px


def png(art, colors, scale):
    """PNG RGBA mínimo (solo stdlib). Un SVG de cuadritos deja costuras en Qt."""
    def rgba(ch):
        if ch == ".":
            return b"\0\0\0\0"
        c = colors[ch]
        return bytes(int(c[i:i + 2], 16) for i in (1, 3, 5)) + b"\xff"

    raw = b""
    for row in art:
        line = b"\0" + b"".join(rgba(ch) * scale for ch in row)
        raw += line * scale

    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    size = len(art[0]) * scale, len(art) * scale
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", *size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def build_lxqt(dest):
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(LXQT_BASE, dest)
    for qss in dest.glob("*.qss"):
        text = qss.read_text()
        text = re.sub(r"border-radius:\s*[^;]+;", "border-radius: 0px;", text)   # nada redondeado
        text = text.replace("url(mainmenu.svg)", "url(mainmenu.png)")
        extra = {"lxqt-panel.qss": PANEL_QSS, "lxqt-notificationd.qss": NOTIFY_QSS,
                 "lxqt-runner.qss": RUNNER_QSS}.get(qss.name, "")
        qss.write_text(text + extra)
    (dest / "mainmenu.svg").unlink(missing_ok=True)
    (dest / "mainmenu.png").write_bytes(menu_icon())
    (dest / "wallpaper.cfg").unlink(missing_ok=True)   # no imponer fondo
    (dest / "preview.png").unlink(missing_ok=True)


# ── iconos de carpeta ────────────────────────────────────────────────────────
FOLDER_16 = [
    "................",
    "................",
    ".BBBBBB.........",
    "BRRRRRRB........",
    "BRRRRRRRBBBBBBB.",
    "BRRRRRRRRRRRRRRB",
    "BBBBBBBBBBBBBBBB",
    "BSSSSSSSSSSSSSSB",
    "BOOOOOOOOOOOOOOB",
    "BOOOOOOOOOOOOOOB",
    "BOOOOOOOOOOOOOOB",
    "BOOOOOOOOOOOOOOB",
    "BOOOOOOOOOOOOOOB",
    "BOOOOOOOOOOOOOOB",
    ".BBBBBBBBBBBBBB.",
    "................",
]
FOLDER_12 = [          # para 24 px: 2 px por celda
    ".BBBB.......",
    "BRRRRBBBBBB.",
    "BRRRRRRRRRRB",
    "BBBBBBBBBBBB",
    "BOOOOOOOOOOB",
    "BOOOOOOOOOOB",
    "BOOOOOOOOOOB",
    "BOOOOOOOOOOB",
    "BOOOOOOOOOOB",
    "BOOOOOOOOOOB",
    "BOOOOOOOOOOB",
    ".BBBBBBBBBB.",
]
# Emblemas 5×5 que distinguen las carpetas especiales.
EMBLEMS = {
    "user-home": ["..#..", ".###.", "#####", ".###.", ".#.#."],
    "user-desktop": ["#####", "#...#", "#####", "..#..", ".###."],
    "folder-documents": ["#####", ".....", "#####", ".....", "###.."],
    "folder-download": ["..#..", "..#..", "#####", ".###.", "..#.."],
    "folder-music": [".####", ".#..#", ".#..#", "##.##", "##.##"],
    "folder-pictures": ["....#", "#..##", "..###", ".####", "#####"],
    "folder-videos": ["#....", "###..", "#####", "###..", "#...."],
    "folder-templates": ["#####", "#...#", "#...#", "#...#", "#####"],
    "folder-publicshare": ["..#..", ".#.#.", "#...#", ".#.#.", "..#.."],
}
# nombre extra → icono del que es copia
ICON_ALIASES = {
    "inode-directory": "folder", "folder-open": "folder", "folder-drag-accept": "folder",
    "folder-downloads": "folder-download", "folder-video": "folder-videos",
    "folder-image": "folder-pictures", "folder-images": "folder-pictures",
    "folder-sound": "folder-music", "folder-document": "folder-documents",
    "folder-home": "user-home", "folder-desktop": "user-desktop",
    "folder-remote": "folder-publicshare", "folder-network": "folder-publicshare",
    "network-workgroup": "folder-publicshare", "network-server": "folder-publicshare",
    "network": "folder-publicshare", "folder-remote-open": "folder-publicshare",
}
# Iconos que no son carpetas: nombre → {rejilla: arte}
MONITOR = {
    16: [
        "................",
        ".BBBBBBBBBBBBBB.",
        ".BOOOOOOOOOOOOB.",
        ".BOPPPPPPPPPPOB.",
        ".BOPSSPPPPPPPOB.",
        ".BOPPPPPPPPPPOB.",
        ".BOPPPPPPPPPPOB.",
        ".BOPPPPPPPPPPOB.",
        ".BOPPPPPPPPPPOB.",
        ".BOOOOOOOOOOOOB.",
        ".BBBBBBBBBBBBBB.",
        "......BRRB......",
        "......BRRB......",
        "....BBBRRBBB....",
        "....BRRRRRRB....",
        "....BBBBBBBB....",
    ],
    12: [
        "BBBBBBBBBBBB",
        "BOOOOOOOOOOB",
        "BOPPPPPPPPOB",
        "BOPSSPPPPPOB",
        "BOPPPPPPPPOB",
        "BOPPPPPPPPOB",
        "BOPPPPPPPPOB",
        "BOOOOOOOOOOB",
        "BBBBBBBBBBBB",
        "....BRRB....",
        "..BBBRRBBB..",
        "..BBBBBBBB..",
    ],
}
# "Mostrar escritorio" del panel usa user-desktop: ahí va el monitor, no una carpeta.
STANDALONE = {"desktop": MONITOR, "show-desktop": MONITOR}
# tamaño → (arte, escala, tamaños que cubre). Los rangos no dejan huecos: si
# faltara un tamaño, Qt tomaría el icono de Papirus en vez del nuestro.
ICON_SIZES = {16: (FOLDER_16, 1, (8, 20)), 24: (FOLDER_12, 2, (21, 28)),
              32: (FOLDER_16, 2, (29, 40)), 48: (FOLDER_16, 3, (41, 56)),
              64: (FOLDER_16, 4, (57, 80)), 96: (FOLDER_16, 6, (81, 512))}
EMBLEM_AT = {16: (6, 8), 12: (4, 5)}    # esquina del emblema según la rejilla


def with_emblem(art, emblem):
    ox, oy = EMBLEM_AT[len(art)]
    rows = [list(r) for r in art]
    for y, line in enumerate(emblem):
        for x, ch in enumerate(line):
            if ch == "#":
                rows[oy + y][ox + x] = "B"
    return ["".join(r) for r in rows]


def build_icons(dest):
    colors = {"B": T["--cat-brown"], "R": T["--cat-rust"], "S": T["--cat-sand"], "O": ACCENT, "P": PANEL2}
    dirs = []
    for size, (art, scale, _) in ICON_SIZES.items():
        folder = dest / f"{size}x{size}" / "places"
        folder.mkdir(parents=True, exist_ok=True)
        dirs.append(f"{size}x{size}/places")
        made = {"folder": png(art, colors, scale)}
        for name, emblem in EMBLEMS.items():
            made[name] = png(with_emblem(art, emblem), colors, scale)
        for alias, target in ICON_ALIASES.items():
            made[alias] = made[target]
        for name, arts in STANDALONE.items():
            made[name] = png(arts[len(art)], colors, scale)
        for name, data in made.items():
            (folder / f"{name}.png").write_bytes(data)
    sections = [(f"{size}x{size}/places", size, "Places", lo, hi)
                for size, (_, _, (lo, hi)) in ICON_SIZES.items()]
    # Iconos convertidos por icons.py (apps, tipos de archivo, dispositivos).
    auto = HERE / "auto-icons"
    contexts = {"apps": "Applications", "mimetypes": "MimeTypes", "devices": "Devices", "places": "Places"}
    ranges = {"96x96": (96, 29, 512), "24x24": (24, 8, 28)}
    if auto.exists():
        for folder, (size, lo, hi) in ranges.items():
            for ctx, label in contexts.items():
                src = auto / folder / ctx
                if not src.exists():
                    continue
                # Las carpetas propias (places) mandan sobre las convertidas.
                name = f"{folder}/{ctx}" if ctx != "places" else f"{folder}/places-auto"
                shutil.copytree(src, dest / name, symlinks=True)
                sections.append((name, size, label, lo, hi))
    index = ["[Icon Theme]", f"Name={ICON_NAME}", "Comment=Iconos pixel-art de pixel-desk",
             f"Inherits={ICON_PARENT},hicolor", f"Directories={','.join(s[0] for s in sections)}", ""]
    for name, size, label, lo, hi in sections:
        index += [f"[{name}]", f"Size={size}", f"Context={label}", "Type=Scalable",
                  f"MinSize={lo}", f"MaxSize={hi}", ""]
    (dest / "index.theme").write_text("\n".join(index))


# ── rofi ─────────────────────────────────────────────────────────────────────
def build_rofi(dest):
    """Tema de rofi: marco de 3 px, sin redondeos, selección en bloque."""
    dest.mkdir(parents=True, exist_ok=True)
    (dest / "pixel-desk.rasi").write_text(f"""/* pixel-desk ({'claro' if LIGHT else 'oscuro'}) — generado por theme.py, no editar a mano */
configuration {{
    show-icons: true;
    icon-theme: "{ICON_NAME}";
    display-drun: "APPS";
    display-run: "RUN";
    display-window: "VENTANAS";
    display-combi: ">";
    drun-display-format: "{{name}}";
}}

* {{
    bg: {PANEL};
    bg-alt: {PANEL2};
    fg: {INK};
    muted: {MUTED};
    accent: {ACCENT};
    on-accent: {BLACK};
    line: {LINE};
    bad: {BAD};

    background-color: transparent;
    text-color: @fg;
    font: "VT323 19";
}}

window {{
    width: 660px;
    background-color: @bg;
    border: {U}px;
    border-color: @accent;
    border-radius: 0px;
    padding: 0px;
}}

mainbox {{
    spacing: 0px;
    children: [ inputbar, message, listview, mode-switcher ];
}}

inputbar {{
    background-color: @bg-alt;
    border: 0px 0px {U}px 0px;
    border-color: @accent;
    padding: {4 * U}px {5 * U}px;
    spacing: {4 * U}px;
    children: [ prompt, entry ];
}}

prompt {{
    font: "Silkscreen Bold 11";
    text-color: @accent;
    vertical-align: 0.5;
}}

entry {{
    placeholder: "buscar...";
    placeholder-color: @muted;
    cursor: text;
    vertical-align: 0.5;
}}

message {{
    border: 0px 0px {U}px 0px;
    border-color: @line;
    padding: {3 * U}px {5 * U}px;
}}

textbox {{
    text-color: @muted;
}}

listview {{
    lines: 8;
    columns: 1;
    fixed-height: true;
    scrollbar: true;
    spacing: {U}px;
    padding: {3 * U}px;
}}

scrollbar {{
    width: {2 * U}px;
    handle-width: {2 * U}px;
    handle-color: @accent;
    background-color: @bg-alt;
    border-radius: 0px;
}}

element {{
    padding: {2 * U}px {3 * U}px;
    spacing: {4 * U}px;
    border-radius: 0px;
}}

element normal.normal, element alternate.normal {{
    background-color: transparent;
    text-color: @fg;
}}

element normal.active, element alternate.active {{
    background-color: transparent;
    text-color: @accent;
}}

element normal.urgent, element alternate.urgent {{
    background-color: transparent;
    text-color: @bad;
}}

element selected.normal, element selected.active {{
    background-color: @accent;
    text-color: @on-accent;
}}

element selected.urgent {{
    background-color: @bad;
    text-color: @on-accent;
}}

element-icon {{
    size: 24px;
    background-color: transparent;
    text-color: inherit;
}}

element-text {{
    background-color: transparent;
    text-color: inherit;
    vertical-align: 0.5;
}}

mode-switcher {{
    border: {U}px 0px 0px 0px;
    border-color: @line;
    spacing: 0px;
}}

button {{
    font: "Silkscreen 9";
    padding: {2 * U}px;
    text-color: @muted;
    background-color: @bg-alt;
}}

button selected {{
    background-color: @accent;
    text-color: @on-accent;
}}
""")


# ── instalación ──────────────────────────────────────────────────────────────
# Fuente de las apps Qt/LXQt (la eligió el usuario; formato de QFont::toString).
QT_FONT = '"Silkscreen,11,-1,5,400,0,0,0,0,0,0,0,0,0,0,1"'

PALETTE = {
    "window_color": PANEL,
    "base_color": PANEL2,
    "text_color": INK,
    "window_text_color": INK,
    "highlight_color": ACCENT,
    "highlighted_text_color": BLACK,
    "link_color": T["--sem-alt"],
    "link_visited_color": T["--sem-magic"],
    "tooltip_base_color": PANEL,
    "tooltip_text_color": INK,
}


def set_ini(text, section, values):
    """Fija claves en una sección de un .conf de Qt sin tocar el resto."""
    lines = text.splitlines()
    start = next((i for i, l in enumerate(lines) if l.strip() == f"[{section}]"), None)
    if start is None:
        if lines and lines[-1].strip():
            lines.append("")
        lines.append(f"[{section}]")
        start = len(lines) - 1
    end = next((i for i in range(start + 1, len(lines)) if lines[i].startswith("[")), len(lines))
    pending = dict(values)
    for i in range(start + 1, end):
        key = lines[i].split("=", 1)[0].strip()
        if key in pending:
            lines[i] = f"{key}={pending.pop(key)}"
    insert = end
    while insert > start + 1 and not lines[insert - 1].strip():
        insert -= 1
    lines[insert:insert] = [f"{k}={v}" for k, v in pending.items()]
    return "\n".join(lines) + "\n"


def xfconf(*args):
    return subprocess.run(["xfconf-query", "-c", "xfwm4", *args], capture_output=True, text=True)


def build():
    if OUT.exists():
        shutil.rmtree(OUT)
    build_xfwm(OUT / "xfwm4")
    build_lxqt(OUT / "lxqt")
    build_icons(OUT / "icons")
    build_rofi(OUT / "rofi")
    print(f"generado en {OUT}")


def install():
    build()
    for src, dst in ((OUT / "xfwm4", XFWM_DEST), (OUT / "lxqt", LXQT_DEST), (OUT / "icons", ICON_DEST)):
        if dst.exists():
            shutil.rmtree(dst)
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(src, dst, symlinks=True)
        print(f"instalado {dst}")
    ROFI_THEME.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(OUT / "rofi/pixel-desk.rasi", ROFI_THEME)
    print(f"instalado {ROFI_THEME}")


def apply():
    install()
    BACKUP.mkdir(exist_ok=True)
    # Solo se guarda lo que aún no tiene copia: así se conserva el estado original.
    for conf in (LXQT_CONF, PANEL_CONF, ROFI_CONF):
        if conf.exists() and not (BACKUP / conf.name).exists():
            shutil.copy2(conf, BACKUP / conf.name)
    if not (BACKUP / "xfwm4-theme").exists():
        (BACKUP / "xfwm4-theme").write_text(xfconf("-p", "/general/theme").stdout.strip() + "\n")
    print(f"copia de seguridad en {BACKUP}")
    text = LXQT_CONF.read_text()
    text = set_ini(text, "General", {"theme": LXQT_NAME, "icon_theme": ICON_NAME})
    text = set_ini(text, "Palette", PALETTE)
    text = set_ini(text, "Qt", {"style": "Fusion", "font": QT_FONT})
    LXQT_CONF.write_text(text)
    # Debian fija en la config global el icono del menú y un tema de iconos
    # propio para el panel (Papirus-Dark); ambos se sustituyen aquí.
    panel = set_ini(PANEL_CONF.read_text(), "mainmenu",
                    {"icon": str(LXQT_DEST / "mainmenu.png"), "ownIcon": "true"})
    PANEL_CONF.write_text(set_ini(panel, "General", {"iconTheme": ICON_NAME}))
    # rofi: se cambia solo la línea del tema; el resto de config.rasi se conserva.
    rofi = ROFI_CONF.read_text() if ROFI_CONF.exists() else ""
    line = f'@import "{ROFI_THEME}"'
    rofi, n = re.subn(r'^@(import|theme)\s+"[^"]*"\s*$', line, rofi, flags=re.M)
    ROFI_CONF.write_text(rofi if n else rofi.rstrip() + "\n\n" + line + "\n")
    r = xfconf("-p", "/general/theme", "-n", "-t", "string", "-s", XFWM_NAME)
    if r.returncode:
        sys.exit(f"xfconf-query falló: {r.stderr.strip()}")
    print(f"activado ({'claro' if LIGHT else 'oscuro'}): xfwm4={XFWM_NAME}, LXQt={LXQT_NAME}, "
          f"iconos={ICON_NAME}, rofi={ROFI_THEME.name}")


def revert():
    if not (BACKUP / "lxqt.conf").exists():
        sys.exit("no hay copia de seguridad: no se aplicó el tema desde aquí")
    for conf in (LXQT_CONF, PANEL_CONF, ROFI_CONF):
        if (BACKUP / conf.name).exists():
            shutil.copy2(BACKUP / conf.name, conf)
    old = (BACKUP / "xfwm4-theme").read_text().strip() or "Default"
    xfconf("-p", "/general/theme", "-s", old)
    shutil.rmtree(BACKUP)
    print(f"restaurado: xfwm4={old}, lxqt.conf, panel.conf y rofi originales")


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if a != "--light"]
    cmd = args[0] if args else ""
    actions = {"build": build, "install": install, "apply": apply, "revert": revert}
    if cmd not in actions:
        sys.exit(__doc__)
    actions[cmd]()
