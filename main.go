// pixel-desk — escritorio pixel-art 2.5D para X11.
//
// Un binario Go que:
//  1. sirve la escena (three.js) desde un servidor local embebido,
//  2. la muestra en una ventana GTK3 + WebKitGTK del sistema,
//  3. con -desktop marca la ventana como _NET_WM_WINDOW_TYPE_DESKTOP,
//     de modo que queda detrás de todas las demás como fondo interactivo,
//  4. lanza las apps de config/apps.json cuando la escena lo pide.
//
// WebKitGTK se enlaza contra la librería de runtime (no hace falta el
// paquete -dev): por eso los prototipos de webkit_* van declarados a mano.
package main

/*
#cgo pkg-config: gtk+-3.0
#cgo LDFLAGS: -l:libwebkit2gtk-4.1.so.0
#include <gtk/gtk.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct _WebKitWebView WebKitWebView;
typedef struct _WebKitSettings WebKitSettings;

extern GtkWidget *webkit_web_view_new(void);
extern void webkit_web_view_load_uri(WebKitWebView *view, const gchar *uri);
extern WebKitSettings *webkit_web_view_get_settings(WebKitWebView *view);
extern void webkit_web_view_set_background_color(WebKitWebView *view, const GdkRGBA *rgba);
extern void webkit_settings_set_enable_webgl(WebKitSettings *s, gboolean on);
extern void webkit_settings_set_hardware_acceleration_policy(WebKitSettings *s, int policy);
extern void webkit_settings_set_enable_developer_extras(WebKitSettings *s, gboolean on);
extern void webkit_settings_set_enable_write_console_messages_to_stdout(WebKitSettings *s, gboolean on);
extern void webkit_web_view_get_snapshot(WebKitWebView *view, int region, int options,
                                         GCancellable *c, GAsyncReadyCallback cb, gpointer data);
extern cairo_surface_t *webkit_web_view_get_snapshot_finish(WebKitWebView *view, GAsyncResult *r, GError **e);

static GtkWidget *pd_view;
static char *pd_shot_path;

static void pd_snap_done(GObject *o, GAsyncResult *r, gpointer data) {
  GError *err = NULL;
  cairo_surface_t *s = webkit_web_view_get_snapshot_finish((WebKitWebView *)o, r, &err);
  if (s) {
    cairo_surface_write_to_png(s, pd_shot_path);
    cairo_surface_destroy(s);
  } else {
    fprintf(stderr, "captura fallida: %s\n", err ? err->message : "?");
  }
  gtk_main_quit();
}

static gboolean pd_snap(gpointer data) {
  webkit_web_view_get_snapshot((WebKitWebView *)pd_view, 0, 0, NULL, pd_snap_done, NULL);
  return FALSE;
}

static gboolean pd_quit(gpointer data) {
  gtk_main_quit();
  return FALSE;
}

// Pide salir desde cualquier hilo (lo usa el servidor HTTP).
static void pd_request_quit(void) { g_idle_add(pd_quit, NULL); }

// Portapapeles: GTK solo se toca desde el hilo principal, así que el texto
// viaja en un g_idle_add. gtk_clipboard_store lo deja al gestor de
// portapapeles para que sobreviva si pixel-desk se cierra.
static gboolean pd_copy_idle(gpointer data) {
  GtkClipboard *cb = gtk_clipboard_get(GDK_SELECTION_CLIPBOARD);
  gtk_clipboard_set_text(cb, (const char *)data, -1);
  gtk_clipboard_store(cb);
  g_free(data);
  return FALSE;
}
static void pd_copy(const char *text) { g_idle_add(pd_copy_idle, g_strdup(text)); }

static void pd_run(const char *url, int desktop, int accel, int w, int h, const char *shot, int shot_ms) {
  gtk_init(NULL, NULL);

  GtkWidget *win = gtk_window_new(GTK_WINDOW_TOPLEVEL);
  gtk_window_set_title(GTK_WINDOW(win), "pixel-desk");

  pd_view = webkit_web_view_new();
  WebKitSettings *s = webkit_web_view_get_settings((WebKitWebView *)pd_view);
  webkit_settings_set_enable_webgl(s, TRUE);
  // 1 = ALWAYS, 2 = NEVER (render por software)
  webkit_settings_set_hardware_acceleration_policy(s, accel ? 1 : 2);
  webkit_settings_set_enable_developer_extras(s, TRUE);
  webkit_settings_set_enable_write_console_messages_to_stdout(s, TRUE);
  GdkRGBA black = {0, 0, 0, 1};
  webkit_web_view_set_background_color((WebKitWebView *)pd_view, &black);
  gtk_container_add(GTK_CONTAINER(win), pd_view);

  if (desktop) {
    // El tipo hay que fijarlo ANTES de mapear la ventana: el gestor de
    // ventanas lo lee al mostrarla.
    gtk_window_set_type_hint(GTK_WINDOW(win), GDK_WINDOW_TYPE_HINT_DESKTOP);
    gtk_window_set_decorated(GTK_WINDOW(win), FALSE);
    gtk_window_set_skip_taskbar_hint(GTK_WINDOW(win), TRUE);
    gtk_window_set_skip_pager_hint(GTK_WINDOW(win), TRUE);
    gtk_window_stick(GTK_WINDOW(win));

    GdkDisplay *d = gdk_display_get_default();
    GdkMonitor *m = gdk_display_get_primary_monitor(d);
    if (!m) m = gdk_display_get_monitor(d, 0);
    GdkRectangle g;
    gdk_monitor_get_geometry(m, &g);
    gtk_window_move(GTK_WINDOW(win), g.x, g.y);
    gtk_window_set_default_size(GTK_WINDOW(win), g.width, g.height);
  } else {
    gtk_window_set_default_size(GTK_WINDOW(win), w, h);
  }

  g_signal_connect(win, "destroy", G_CALLBACK(gtk_main_quit), NULL);
  webkit_web_view_load_uri((WebKitWebView *)pd_view, url);
  gtk_widget_show_all(win);

  if (shot && shot[0]) {
    pd_shot_path = strdup(shot);
    g_timeout_add(shot_ms, pd_snap, NULL);
  }
  gtk_main();
}
*/
import "C"

import (
	"crypto/rand"
	"embed"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"unsafe"
)

//go:embed all:web
var webFS embed.FS

//go:embed config/apps.json
var defaultApps []byte

// App es un objeto lanzable de la escena. Solo se puede ejecutar lo que
// figure aquí: la página pide un id, nunca un comando.
type App struct {
	ID    string   `json:"id"`
	Label string   `json:"label"`
	Hint  string   `json:"hint"`
	Cmd   []string `json:"cmd"`
	Cwd   string   `json:"cwd,omitempty"`
	Panel string   `json:"panel,omitempty"` // abre un panel de web/panels/ en vez de lanzar Cmd
}

func init() {
	// GTK exige que todo ocurra en el hilo principal.
	runtime.LockOSThread()
}

// Rutas que añaden los cuartos (board.go, sysinfo.go…) desde su init().
// Toda ruta bajo /api/ debe envolverse con authed.
type routeFunc func(mux *http.ServeMux, authed func(http.HandlerFunc) http.HandlerFunc)

var extraRoutes []routeFunc

// dataDir devuelve (y crea) $XDG_DATA_HOME/pixel-desk para datos persistentes.
func dataDir() string {
	base := os.Getenv("XDG_DATA_HOME")
	if base == "" {
		home, _ := os.UserHomeDir()
		base = filepath.Join(home, ".local", "share")
	}
	dir := filepath.Join(base, "pixel-desk")
	os.MkdirAll(dir, 0o755)
	return dir
}

// writeFileAtomic escribe en un temporal y lo renombra: nunca deja el
// archivo a medias si el proceso muere.
func writeFileAtomic(path string, data []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// copyToClipboard pone texto en el portapapeles del sistema (CLIPBOARD) desde
// el propio proceso GTK, sin lanzar xclip. Nunca ejecuta nada.
func copyToClipboard(text string) {
	ct := C.CString(text)
	defer C.free(unsafe.Pointer(ct))
	C.pd_copy(ct)
}

func sendJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

func expand(p string) string {
	if p == "~" || strings.HasPrefix(p, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, strings.TrimPrefix(p, "~"))
		}
	}
	return p
}

func loadApps(path string) ([]App, string) {
	data, src := defaultApps, "embebida"
	if b, err := os.ReadFile(path); err == nil {
		data, src = b, path
	}
	var apps []App
	if err := json.Unmarshal(data, &apps); err != nil {
		log.Fatalf("config de apps inválida (%s): %v", src, err)
	}
	return apps, src
}

func launch(a App) error {
	if len(a.Cmd) == 0 {
		return fmt.Errorf("sin comando")
	}
	args := make([]string, len(a.Cmd))
	for i, s := range a.Cmd {
		args[i] = expand(s)
	}
	cmd := exec.Command(args[0], args[1:]...)
	if a.Cwd != "" {
		cmd.Dir = expand(a.Cwd)
	} else if home, err := os.UserHomeDir(); err == nil {
		cmd.Dir = home
	}
	// Sesión propia: la app sobrevive si pixel-desk se cierra.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	go cmd.Wait()
	return nil
}

func main() {
	desktop := flag.Bool("desktop", false, "ventana tipo escritorio (detrás de todo, pantalla completa)")
	dev := flag.Bool("dev", false, "servir ./web desde disco en vez de lo embebido (recargar con F5)")
	config := flag.String("config", "config/apps.json", "ruta a la lista de apps")
	width := flag.Int("w", 960, "ancho en modo ventana")
	height := flag.Int("h", 600, "alto en modo ventana")
	software := flag.Bool("software", false, "desactivar aceleración por GPU")
	theme := flag.String("theme", "dark", "tema de la escena: dark o light")
	px := flag.Int("px", 3, "tamaño de un píxel de escena en pantalla (6 = grueso, 3 = fino, 2 = muy fino)")
	room := flag.Int("room", 1, "cuarto inicial (1 escritorio, 2 tablero, 3 monitor, 4 calendario)")
	shot := flag.String("shot", "", "guardar una captura PNG y salir")
	shotMs := flag.Int("shot-ms", 2500, "espera antes de la captura (ms)")
	flag.Parse()

	apps, src := loadApps(*config)
	byID := map[string]App{}
	for _, a := range apps {
		byID[a.ID] = a
	}

	tokenBytes := make([]byte, 16)
	if _, err := rand.Read(tokenBytes); err != nil {
		log.Fatal(err)
	}
	token := hex.EncodeToString(tokenBytes)

	var root fs.FS
	if *dev {
		root = os.DirFS("web")
	} else {
		sub, err := fs.Sub(webFS, "web")
		if err != nil {
			log.Fatal(err)
		}
		root = sub
	}

	// El token evita que otra página abierta en el navegador pueda pedir
	// lanzamientos a este puerto local.
	authed := func(h http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("X-Desk-Token") != token {
				http.Error(w, "token", http.StatusForbidden)
				return
			}
			h(w, r)
		}
	}

	mux := http.NewServeMux()
	files := http.FileServer(http.FS(root))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		files.ServeHTTP(w, r)
	})
	mux.HandleFunc("/api/apps", authed(func(w http.ResponseWriter, r *http.Request) {
		type pub struct {
			ID    string `json:"id"`
			Label string `json:"label"`
			Hint  string `json:"hint"`
			Panel string `json:"panel,omitempty"`
		}
		out := make([]pub, 0, len(apps))
		for _, a := range apps {
			out = append(out, pub{a.ID, a.Label, a.Hint, a.Panel})
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(out)
	}))
	mux.HandleFunc("/api/launch", authed(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "POST", http.StatusMethodNotAllowed)
			return
		}
		a, ok := byID[r.URL.Query().Get("id")]
		if !ok {
			http.Error(w, "id desconocido", http.StatusNotFound)
			return
		}
		if err := launch(a); err != nil {
			log.Printf("no se pudo lanzar %s: %v", a.ID, err)
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		log.Printf("lanzado: %s", a.ID)
		w.WriteHeader(http.StatusNoContent)
	}))
	mux.HandleFunc("/api/quit", authed(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
		C.pd_request_quit()
	}))
	for _, add := range extraRoutes {
		add(mux, authed)
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Fatal(err)
	}
	go func() { log.Fatal(http.Serve(ln, mux)) }()

	url := fmt.Sprintf("http://127.0.0.1:%d/?t=%s", ln.Addr().(*net.TCPAddr).Port, token)
	url += fmt.Sprintf("&px=%d&theme=%s&room=%d", *px, *theme, *room)
	if *desktop {
		url += "&desktop=1"
	}
	log.Printf("pixel-desk · %d apps (config %s) · %s", len(apps), src, url)

	curl := C.CString(url)
	cshot := C.CString(*shot)
	defer C.free(unsafe.Pointer(curl))
	defer C.free(unsafe.Pointer(cshot))
	b := func(v bool) C.int {
		if v {
			return 1
		}
		return 0
	}
	C.pd_run(curl, b(*desktop), b(!*software), C.int(*width), C.int(*height), cshot, C.int(*shotMs))
}
