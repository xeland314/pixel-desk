package main

// Calendario (cuarto 4).
//
// Eventos locales: $XDG_DATA_HOME/pixel-desk/calendar.json (GET/PUT /api/calendar).
//
// Suscripciones ICS de solo lectura (GET /api/calendar/feeds). La lista se lee,
// por orden, de: $PIXEL_DESK_CALENDAR, $XDG_CONFIG_HOME/pixel-desk/calendar.json
// (por defecto ~/.config/pixel-desk/calendar.json), ./config/calendar.json y, si
// no hay ninguno, del config/calendar.json embebido (lista vacía). Formato:
//
//	[
//	  { "id": "personal", "title": "PERSONAL", "url": "https://…/basic.ics", "color": "cyan" }
//	]
//
// color: orange | cyan | green | magic | red | sage. La página nunca envía URLs,
// solo recibe los eventos ya parseados; las URLs (que pueden ser secretas) no se
// registran ni se devuelven. Descarga con timeout de 10 s, máximo 5 MB, caché de
// 15 min (si falla una descarga se sigue sirviendo la caché anterior).
//
// Soporte ICS: VEVENT con DTSTART/DTEND/SUMMARY/DESCRIPTION, fechas de día
// completo y con hora, UTC (Z) y TZID (→ hora local; zona desconocida = local),
// EXDATE y RECURRENCE-ID (se excluyen de la serie), RRULE con FREQ=WEEKLY
// (con BYDAY), MONTHLY o YEARLY, INTERVAL, COUNT y UNTIL. Un RRULE más
// complejo (BYMONTHDAY, BYSETPOS, FREQ=DAILY…) se ignora y queda la primera
// aparición. Eventos de varios días: una entrada por día (máx. 31).

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed config/calendar.json
var defaultCalendarFeeds []byte

type calEvent struct {
	ID     string   `json:"id"`
	Date   string   `json:"date"`
	Time   string   `json:"time,omitempty"`
	End    string   `json:"end,omitempty"`
	Title  string   `json:"title"`
	Note   string   `json:"note,omitempty"`
	Color  string   `json:"color"`
	Repeat string   `json:"repeat,omitempty"`
	Every  int      `json:"every,omitempty"`
	Until  string   `json:"until,omitempty"`
	Skip   []string `json:"skip,omitempty"`
	Feed   string   `json:"feed,omitempty"`
}

type calData struct {
	Version int        `json:"version"`
	Events  []calEvent `json:"events"`
}

type calFeed struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	URL   string `json:"url"`
	Color string `json:"color"`
}

type calFeedInfo struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Color string `json:"color"`
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
	Count int    `json:"count"`
}

const (
	calMaxBody   = 1 << 20
	calMaxICS    = 5 << 20
	calFeedTTL   = 15 * time.Minute
	calFeedLimit = 10
	calMaxSpan   = 31
)

var (
	calMu       sync.Mutex
	calColors   = map[string]bool{"orange": true, "cyan": true, "green": true, "magic": true, "red": true, "sage": true}
	calDateRe   = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
	calTimeRe   = regexp.MustCompile(`^([01]\d|2[0-3]):[0-5]\d$`)
	calRepeats  = map[string]bool{"": true, "none": true, "weekly": true, "monthly": true, "yearly": true}
	calFeedMu   sync.Mutex
	calFeedMemo = map[string]calFeedCache{}
)

type calFeedCache struct {
	url    string
	at     time.Time
	events []calEvent
	err    string
}

func calendarPath() string { return filepath.Join(dataDir(), "calendar.json") }

func validDate(s string) bool {
	if !calDateRe.MatchString(s) {
		return false
	}
	_, err := time.Parse("2006-01-02", s)
	return err == nil
}

func clip(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}

// calSanitize descarta eventos inválidos y recorta campos: nunca se guarda basura.
func calSanitize(in []calEvent) []calEvent {
	out := make([]calEvent, 0, len(in))
	for _, e := range in {
		if e.ID == "" || e.Feed != "" || !validDate(e.Date) {
			continue
		}
		e.ID = clip(e.ID, 64)
		e.Title = clip(e.Title, 200)
		e.Note = clip(e.Note, 2000)
		if e.Time != "" && !calTimeRe.MatchString(e.Time) {
			e.Time = ""
		}
		if e.End != "" && (e.Time == "" || !calTimeRe.MatchString(e.End)) {
			e.End = ""
		}
		if !calColors[e.Color] {
			e.Color = "orange"
		}
		if !calRepeats[e.Repeat] {
			e.Repeat = ""
		}
		if e.Until != "" && !validDate(e.Until) {
			e.Until = ""
		}
		if e.Every < 0 || e.Every > 99 {
			e.Every = 0
		}
		out = append(out, e)
		if len(out) >= 20000 {
			break
		}
	}
	return out
}

// ── ICS ─────────────────────────────────────────────────────────────────────

type icsProp struct {
	name   string
	params map[string]string
	value  string
}

func icsUnfold(raw string) []string {
	raw = strings.ReplaceAll(raw, "\r\n", "\n")
	raw = strings.ReplaceAll(raw, "\r", "\n")
	var lines []string
	for _, l := range strings.Split(raw, "\n") {
		if (strings.HasPrefix(l, " ") || strings.HasPrefix(l, "\t")) && len(lines) > 0 {
			lines[len(lines)-1] += l[1:]
			continue
		}
		lines = append(lines, l)
	}
	return lines
}

func icsParseLine(l string) (icsProp, bool) {
	inQ := false
	colon := -1
	for i := 0; i < len(l); i++ {
		if l[i] == '"' {
			inQ = !inQ
		} else if l[i] == ':' && !inQ {
			colon = i
			break
		}
	}
	if colon <= 0 {
		return icsProp{}, false
	}
	head, val := l[:colon], l[colon+1:]
	// partir head por ';' respetando comillas
	var parts []string
	start := 0
	inQ = false
	for i := 0; i < len(head); i++ {
		if head[i] == '"' {
			inQ = !inQ
		} else if head[i] == ';' && !inQ {
			parts = append(parts, head[start:i])
			start = i + 1
		}
	}
	parts = append(parts, head[start:])
	p := icsProp{name: strings.ToUpper(parts[0]), params: map[string]string{}, value: val}
	for _, kv := range parts[1:] {
		if k, v, ok := strings.Cut(kv, "="); ok {
			p.params[strings.ToUpper(k)] = strings.Trim(v, `"`)
		}
	}
	return p, true
}

func icsText(s string) string {
	r := strings.NewReplacer(`\n`, "\n", `\N`, "\n", `\,`, ",", `\;`, ";", `\\`, `\`)
	return strings.TrimSpace(r.Replace(s))
}

// icsTime interpreta un DTSTART/DTEND/EXDATE/UNTIL. Devuelve la hora local, y
// allDay si era una fecha sin hora.
func icsTime(value string, params map[string]string) (time.Time, bool, bool) {
	value = strings.TrimSpace(value)
	if len(value) == 8 {
		t, err := time.Parse("20060102", value)
		if err != nil {
			return time.Time{}, false, false
		}
		return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.Local), true, true
	}
	if strings.HasSuffix(value, "Z") {
		t, err := time.Parse("20060102T150405Z", value)
		if err != nil {
			return time.Time{}, false, false
		}
		return t.In(time.Local), false, true
	}
	loc := time.Local
	if tz := params["TZID"]; tz != "" {
		if l, err := time.LoadLocation(tz); err == nil {
			loc = l
		}
	}
	t, err := time.ParseInLocation("20060102T150405", value, loc)
	if err != nil {
		return time.Time{}, false, false
	}
	return t.In(time.Local), false, true
}

type icsRaw struct {
	uid, summary, desc, status string
	start, end                 time.Time
	allDay, hasEnd             bool
	rrule                      string
	exdates                    []string
	recurID                    string
	ok                         bool
}

func parseICS(raw string, feed calFeed) []calEvent {
	var evs []icsRaw
	var cur *icsRaw
	inAlarm := false
	for _, l := range icsUnfold(raw) {
		p, ok := icsParseLine(l)
		if !ok {
			continue
		}
		switch {
		case p.name == "BEGIN" && strings.EqualFold(p.value, "VEVENT"):
			cur = &icsRaw{}
			inAlarm = false
			continue
		case p.name == "END" && strings.EqualFold(p.value, "VEVENT"):
			if cur != nil && cur.ok {
				evs = append(evs, *cur)
			}
			cur = nil
			continue
		case cur == nil:
			continue
		case p.name == "BEGIN" && strings.EqualFold(p.value, "VALARM"):
			inAlarm = true
			continue
		case p.name == "END" && strings.EqualFold(p.value, "VALARM"):
			inAlarm = false
			continue
		case inAlarm:
			continue
		}
		switch p.name {
		case "UID":
			cur.uid = p.value
		case "SUMMARY":
			cur.summary = icsText(p.value)
		case "DESCRIPTION":
			cur.desc = icsText(p.value)
		case "STATUS":
			cur.status = strings.ToUpper(p.value)
		case "RRULE":
			cur.rrule = p.value
		case "DTSTART":
			if t, ad, ok := icsTime(p.value, p.params); ok {
				cur.start, cur.allDay, cur.ok = t, ad, true
			}
		case "DTEND":
			if t, _, ok := icsTime(p.value, p.params); ok {
				cur.end, cur.hasEnd = t, true
			}
		case "EXDATE":
			for _, v := range strings.Split(p.value, ",") {
				if t, _, ok := icsTime(v, p.params); ok {
					cur.exdates = append(cur.exdates, t.Format("2006-01-02"))
				}
			}
		case "RECURRENCE-ID":
			if t, _, ok := icsTime(p.value, p.params); ok {
				cur.recurID = t.Format("2006-01-02")
			}
		}
	}

	// Instancias modificadas de una serie: se excluyen de la serie original.
	override := map[string][]string{}
	for _, e := range evs {
		if e.recurID != "" && e.uid != "" {
			override[e.uid] = append(override[e.uid], e.recurID)
		}
	}

	var out []calEvent
	n := 0
	for _, e := range evs {
		if e.status == "CANCELLED" {
			continue
		}
		title := e.summary
		if title == "" {
			title = "(sin título)"
		}
		n++
		base := calEvent{
			ID:    fmt.Sprintf("%s:%s:%d", feed.ID, e.uid, n),
			Title: clip(title, 200),
			Note:  clip(e.desc, 2000),
			Color: feed.Color,
			Feed:  feed.ID,
		}
		days := 1
		if e.allDay {
			if e.hasEnd {
				days = int(e.end.Sub(e.start).Hours()/24 + 0.5)
			}
		} else if e.hasEnd && !e.end.Equal(e.start) {
			ds := time.Date(e.start.Year(), e.start.Month(), e.start.Day(), 0, 0, 0, 0, time.Local)
			de := time.Date(e.end.Year(), e.end.Month(), e.end.Day(), 0, 0, 0, 0, time.Local)
			days = int(de.Sub(ds).Hours()/24+0.5) + 1
			if days > 1 && e.end.Hour() == 0 && e.end.Minute() == 0 {
				days-- // termina justo a medianoche: no ocupa el día siguiente
			}
		}
		if days < 1 {
			days = 1
		}
		if days > calMaxSpan {
			days = calMaxSpan
		}
		skip := append(append([]string{}, e.exdates...), override[e.uid]...)
		if e.recurID != "" {
			skip = nil // la instancia modificada es un evento suelto
		}

		first := base
		first.Date = e.start.Format("2006-01-02")
		if !e.allDay {
			first.Time = e.start.Format("15:04")
			if days == 1 && e.hasEnd {
				first.End = e.end.Format("15:04")
			}
		}
		if e.rrule != "" && e.recurID == "" {
			out = append(out, icsSeries(first, e, skip)...)
		} else {
			out = append(out, first)
		}
		// días siguientes de un evento largo (sin repetición)
		for i := 1; i < days; i++ {
			d := first
			d.ID = fmt.Sprintf("%s+%d", first.ID, i)
			d.Date = e.start.AddDate(0, 0, i).Format("2006-01-02")
			d.Time, d.End = "", ""
			d.Repeat, d.Every, d.Until, d.Skip = "", 0, "", nil
			out = append(out, d)
		}
	}
	return out
}

// icsSeries traduce un RRULE sencillo a los campos repeat/every/until/skip.
// Si no se puede representar se devuelve solo la primera aparición.
func icsSeries(first calEvent, e icsRaw, skip []string) []calEvent {
	rule := map[string]string{}
	for _, kv := range strings.Split(e.rrule, ";") {
		if k, v, ok := strings.Cut(kv, "="); ok {
			rule[strings.ToUpper(k)] = strings.ToUpper(v)
		}
	}
	one := []calEvent{first}
	every := 1
	if v := rule["INTERVAL"]; v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 99 {
			return one
		}
		every = n
	}
	var kind string
	switch rule["FREQ"] {
	case "WEEKLY":
		kind = "weekly"
	case "MONTHLY":
		kind = "monthly"
	case "YEARLY":
		kind = "yearly"
	default:
		return one
	}
	if rule["BYMONTHDAY"] != "" || rule["BYSETPOS"] != "" || rule["BYWEEKNO"] != "" || rule["BYYEARDAY"] != "" {
		return one
	}
	if rule["BYDAY"] != "" && kind != "weekly" {
		return one
	}
	until := ""
	if v := rule["UNTIL"]; v != "" {
		if t, _, ok := icsTime(v, nil); ok {
			until = t.Format("2006-01-02")
		}
	}
	start := time.Date(e.start.Year(), e.start.Month(), e.start.Day(), 0, 0, 0, 0, time.Local)
	mk := func(s time.Time, id string) calEvent {
		c := first
		c.ID = id
		c.Date = s.Format("2006-01-02")
		c.Repeat, c.Every, c.Until, c.Skip = kind, every, until, skip
		if every == 1 {
			c.Every = 0
		}
		return c
	}
	count := 0
	if v := rule["COUNT"]; v != "" {
		count, _ = strconv.Atoi(v)
	}
	// COUNT se convierte en una fecha límite (Until).
	setCount := func(c *calEvent, perSeries int) {
		if perSeries <= 0 {
			return
		}
		last, _ := time.ParseInLocation("2006-01-02", c.Date, time.Local)
		switch kind {
		case "weekly":
			last = last.AddDate(0, 0, 7*every*(perSeries-1))
		case "monthly":
			last = last.AddDate(0, every*(perSeries-1), 0)
		default:
			last = last.AddDate(every*(perSeries-1), 0, 0)
		}
		if lim := last.Format("2006-01-02"); c.Until == "" || lim < c.Until {
			c.Until = lim
		}
	}
	if kind == "weekly" && rule["BYDAY"] != "" {
		wd := map[string]time.Weekday{"SU": 0, "MO": 1, "TU": 2, "WE": 3, "TH": 4, "FR": 5, "SA": 6}
		var res []calEvent
		days := strings.Split(rule["BYDAY"], ",")
		for i, d := range days {
			w, ok := wd[strings.TrimLeft(d, "+-0123456789")]
			if !ok {
				return one
			}
			s := start
			for s.Weekday() != w {
				s = s.AddDate(0, 0, 1)
			}
			c := mk(s, fmt.Sprintf("%s#%d", first.ID, i))
			// COUNT total repartido entre los días de la regla (aproximado)
			setCount(&c, (count+len(days)-1)/len(days))
			res = append(res, c)
		}
		return res
	}
	c := mk(start, first.ID)
	setCount(&c, count)
	return []calEvent{c}
}

func calFeedsConfig() []calFeed {
	var paths []string
	if p := os.Getenv("PIXEL_DESK_CALENDAR"); p != "" {
		paths = append(paths, p)
	}
	if cfg := os.Getenv("XDG_CONFIG_HOME"); cfg != "" {
		paths = append(paths, filepath.Join(cfg, "pixel-desk", "calendar.json"))
	} else if home, err := os.UserHomeDir(); err == nil {
		paths = append(paths, filepath.Join(home, ".config", "pixel-desk", "calendar.json"))
	}
	paths = append(paths, filepath.Join("config", "calendar.json"))
	raw := defaultCalendarFeeds
	for _, p := range paths {
		if b, err := os.ReadFile(p); err == nil {
			raw = b
			break
		}
	}
	var feeds []calFeed
	if err := json.Unmarshal(raw, &feeds); err != nil {
		log.Printf("calendar.json inválido: %v", err)
		return nil
	}
	var ok []calFeed
	seen := map[string]bool{}
	for _, f := range feeds {
		if f.ID == "" || seen[f.ID] || !(strings.HasPrefix(f.URL, "https://") || strings.HasPrefix(f.URL, "http://")) {
			continue
		}
		seen[f.ID] = true
		if !calColors[f.Color] {
			f.Color = "cyan"
		}
		if f.Title == "" {
			f.Title = f.ID
		}
		ok = append(ok, f)
		if len(ok) >= calFeedLimit {
			break
		}
	}
	return ok
}

var calHTTP = &http.Client{Timeout: 10 * time.Second}

func fetchICS(f calFeed) ([]calEvent, error) {
	req, err := http.NewRequest(http.MethodGet, f.URL, nil)
	if err != nil {
		return nil, errors.New("URL inválida")
	}
	req.Header.Set("User-Agent", "pixel-desk")
	resp, err := calHTTP.Do(req)
	if err != nil {
		return nil, errors.New("no se pudo descargar")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, calMaxICS+1))
	if err != nil {
		return nil, errors.New("descarga interrumpida")
	}
	if len(body) > calMaxICS {
		return nil, errors.New("archivo mayor de 5 MB")
	}
	return parseICS(string(body), f), nil
}

func calFeedsAll() ([]calFeedInfo, []calEvent) {
	feeds := calFeedsConfig()
	infos := make([]calFeedInfo, len(feeds))
	evs := make([][]calEvent, len(feeds))
	var wg sync.WaitGroup
	for i, f := range feeds {
		wg.Add(1)
		go func(i int, f calFeed) {
			defer wg.Done()
			calFeedMu.Lock()
			c, have := calFeedMemo[f.ID]
			calFeedMu.Unlock()
			if have && c.url != f.URL {
				have = false
				c = calFeedCache{}
			}
			if !have || time.Since(c.at) > calFeedTTL {
				got, err := fetchICS(f)
				if err != nil {
					log.Printf("calendario %q: %v", f.ID, err)
					c.url = f.URL
					c.err = err.Error()
					c.at = time.Now().Add(-calFeedTTL + time.Minute) // reintento en 1 min
				} else {
					c = calFeedCache{url: f.URL, at: time.Now(), events: got}
				}
				calFeedMu.Lock()
				calFeedMemo[f.ID] = c
				calFeedMu.Unlock()
			}
			evs[i] = append([]calEvent(nil), c.events...)
			infos[i] = calFeedInfo{ID: f.ID, Title: f.Title, Color: f.Color, OK: c.err == "", Error: c.err, Count: len(c.events)}
			for j := range evs[i] {
				evs[i][j].Color = f.Color
			}
		}(i, f)
	}
	wg.Wait()
	all := []calEvent{}
	for _, e := range evs {
		all = append(all, e...)
	}
	sort.SliceStable(all, func(a, b int) bool { return all[a].Date < all[b].Date })
	if len(all) > 20000 {
		all = all[:20000]
	}
	return infos, all
}

func init() {
	extraRoutes = append(extraRoutes, func(mux *http.ServeMux, authed func(http.HandlerFunc) http.HandlerFunc) {
		mux.HandleFunc("/api/calendar", authed(func(w http.ResponseWriter, r *http.Request) {
			calMu.Lock()
			defer calMu.Unlock()
			switch r.Method {
			case http.MethodGet:
				d := calData{Version: 1}
				raw, err := os.ReadFile(calendarPath())
				switch {
				case err == nil:
					if json.Unmarshal(raw, &d) != nil {
						// Corrupto: se aparta antes de servir uno vacío, porque el
						// siguiente PUT lo sobrescribiría y se perderían los eventos.
						bad := fmt.Sprintf("%s.corrupto-%d", calendarPath(), time.Now().Unix())
						os.Rename(calendarPath(), bad)
						log.Printf("calendar.json ilegible, apartado en %s", bad)
						d = calData{Version: 1}
					}
				case !errors.Is(err, fs.ErrNotExist):
					http.Error(w, "no se pudo leer el calendario", http.StatusInternalServerError)
					return
				}
				d.Version = 1
				d.Events = calSanitize(d.Events)
				sendJSON(w, d)
			case http.MethodPut:
				raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, calMaxBody))
				if err != nil {
					http.Error(w, "cuerpo demasiado grande", http.StatusRequestEntityTooLarge)
					return
				}
				var d calData
				if err := json.Unmarshal(raw, &d); err != nil {
					http.Error(w, "JSON invalido", http.StatusBadRequest)
					return
				}
				d.Version = 1
				d.Events = calSanitize(d.Events)
				out, _ := json.MarshalIndent(d, "", " ")
				if err := writeFileAtomic(calendarPath(), out); err != nil {
					http.Error(w, err.Error(), http.StatusInternalServerError)
					return
				}
				sendJSON(w, map[string]bool{"ok": true})
			default:
				http.Error(w, "metodo no permitido", http.StatusMethodNotAllowed)
			}
		}))
		mux.HandleFunc("/api/calendar/feeds", authed(func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodGet {
				http.Error(w, "metodo no permitido", http.StatusMethodNotAllowed)
				return
			}
			infos, evs := calFeedsAll()
			sendJSON(w, map[string]any{"feeds": infos, "events": evs})
		}))
	})
}
