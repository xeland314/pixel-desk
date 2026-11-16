package main

import (
	"strings"
	"testing"
	"time"
)

const testICS = "BEGIN:VCALENDAR\r\n" +
	"BEGIN:VEVENT\r\nUID:a1\r\nDTSTART;VALUE=DATE:20261120\r\nDTEND;VALUE=DATE:20261123\r\nSUMMARY:Viaje\\, largo\r\nEND:VEVENT\r\n" +
	"BEGIN:VEVENT\r\nUID:a2\r\nDTSTART:20261116T150000Z\r\nDTEND:20261116T160000Z\r\nSUMMARY:Reunion UTC\r\n" +
	" con linea plegada\r\nDESCRIPTION:linea1\\nlinea2\r\nBEGIN:VALARM\r\nTRIGGER:-PT10M\r\nSUMMARY:no\r\nEND:VALARM\r\nEND:VEVENT\r\n" +
	"BEGIN:VEVENT\r\nUID:a3\r\nDTSTART;TZID=America/Guayaquil:20261117T090000\r\nDTEND;TZID=America/Guayaquil:20261117T100000\r\nSUMMARY:Local TZ\r\nEND:VEVENT\r\n" +
	"BEGIN:VEVENT\r\nUID:a4\r\nDTSTART:20261102T100000\r\nSUMMARY:Semanal LU y MI\r\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6\r\nEXDATE:20261111T100000\r\nEND:VEVENT\r\n" +
	"BEGIN:VEVENT\r\nUID:a5\r\nDTSTART;VALUE=DATE:20261201\r\nSUMMARY:Cada 2 meses\r\nRRULE:FREQ=MONTHLY;INTERVAL=2;UNTIL=20270601\r\nEND:VEVENT\r\n" +
	"BEGIN:VEVENT\r\nUID:a6\r\nDTSTART;VALUE=DATE:20261205\r\nSUMMARY:Diario ignorado\r\nRRULE:FREQ=DAILY\r\nEND:VEVENT\r\n" +
	"BEGIN:VEVENT\r\nUID:a7\r\nDTSTART;VALUE=DATE:20261206\r\nSUMMARY:Cancelado\r\nSTATUS:CANCELLED\r\nEND:VEVENT\r\n" +
	"END:VCALENDAR\r\n"

func TestParseICS(t *testing.T) {
	time.Local = time.UTC
	evs := parseICS(testICS, calFeed{ID: "t", Title: "T", Color: "cyan"})
	byTitle := map[string][]calEvent{}
	for _, e := range evs {
		byTitle[e.Title] = append(byTitle[e.Title], e)
		if e.Feed != "t" || e.Color != "cyan" {
			t.Errorf("feed/color mal: %+v", e)
		}
	}
	// día completo de 3 días (DTEND exclusivo): 20, 21, 22
	if v := byTitle["Viaje, largo"]; len(v) != 3 || v[0].Date != "2026-11-20" || v[2].Date != "2026-11-22" || v[0].Time != "" {
		t.Errorf("viaje: %+v", v)
	}
	if v := byTitle["Reunion UTCcon linea plegada"]; len(v) != 1 || v[0].Time != "15:00" || v[0].End != "16:00" || v[0].Note != "linea1\nlinea2" {
		t.Errorf("utc: %+v", v)
	}
	// 09:00 Guayaquil (UTC-5) = 14:00 UTC
	if v := byTitle["Local TZ"]; len(v) != 1 || v[0].Time != "14:00" {
		t.Errorf("tzid: %+v", v)
	}
	v := byTitle["Semanal LU y MI"]
	if len(v) != 2 || v[0].Repeat != "weekly" || v[0].Date != "2026-11-02" || v[1].Date != "2026-11-04" || v[0].Until != "2026-11-16" || len(v[0].Skip) != 1 || v[0].Skip[0] != "2026-11-11" {
		t.Errorf("semanal: %+v", v)
	}
	if v := byTitle["Cada 2 meses"]; len(v) != 1 || v[0].Repeat != "monthly" || v[0].Every != 2 || v[0].Until != "2027-06-01" {
		t.Errorf("mensual: %+v", v)
	}
	if v := byTitle["Diario ignorado"]; len(v) != 1 || v[0].Repeat != "" {
		t.Errorf("diario: %+v", v)
	}
	if _, ok := byTitle["Cancelado"]; ok {
		t.Error("el cancelado no debe salir")
	}
	if _, ok := byTitle["no"]; ok {
		t.Error("el VALARM no debe contarse")
	}
}

func TestSanitize(t *testing.T) {
	in := []calEvent{
		{ID: "1", Date: "2026-02-30", Title: "malo"},
		{ID: "", Date: "2026-02-10", Title: "sin id"},
		{ID: "2", Date: "2026-02-10", Time: "25:00", End: "10:00", Title: strings.Repeat("x", 500), Color: "nope", Repeat: "daily"},
		{ID: "3", Date: "2026-02-10", Title: "feed", Feed: "x"},
	}
	out := calSanitize(in)
	if len(out) != 1 || out[0].Time != "" || out[0].End != "" || out[0].Color != "orange" || out[0].Repeat != "" || len([]rune(out[0].Title)) != 200 {
		t.Errorf("sanitize: %+v", out)
	}
}
