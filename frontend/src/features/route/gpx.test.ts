import { describe, expect, test } from "bun:test";
import type { Route } from "../../core/routes";
import { gpxFileName, importGpx, importSummary, routeToGpx, trackDateName, type GpxImportResult } from "./gpx";
import { testXmlParse } from "./testXml";

const ids = () => {
  let i = 0;
  return () => `id-${++i}`;
};
const imp = (text: string, fileName?: string): GpxImportResult =>
  importGpx(text, { fileName, mintId: ids(), parse: testXmlParse });
const ok = (r: GpxImportResult) => {
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r;
};

const route: Route = {
  id: "r1",
  name: `Kiel → Sønderborg & "back" <fast>`,
  waypoints: [
    { id: "a", name: "Start", lat: 54.3233, lon: 10.1394 },
    { id: "b", name: "", lat: 54.9, lon: 10.0000001 },
    { id: "c", name: "Bøje 'x'", lat: -0.5, lon: -179.25 },
  ],
  plan_speed_kn: 5,
  rev: 3,
  updated: 0,
};

describe("routeToGpx", () => {
  test("GPX 1.1 with one <rte>, escaped names, plain-decimal coords", () => {
    const xml = routeToGpx(route);
    expect(xml).toContain('<gpx version="1.1" creator="mivnav" xmlns="http://www.topografix.com/GPX/1/1">');
    expect(xml).toContain("<name>Kiel → Sønderborg &amp; &quot;back&quot; &lt;fast&gt;</name>");
    expect(xml).toContain('<rtept lat="54.3233" lon="10.1394"><name>Start</name></rtept>');
    expect(xml).toContain('<rtept lat="54.9" lon="10.0000001"/>');
    expect(xml).toContain('<rtept lat="-0.5" lon="-179.25"><name>Bøje &apos;x&apos;</name></rtept>');
    expect(xml).not.toMatch(/e-\d/); // never exponent notation
  });

  test("round-trips through import: names, order, coordinates", () => {
    const r = ok(imp(routeToGpx(route)));
    expect(r.routes).toHaveLength(1);
    const back = r.routes[0]!;
    expect(back.name).toBe(route.name);
    expect(back.waypoints.map((w) => [w.name, w.lat, w.lon])).toEqual(
      route.waypoints.map((w) => [w.name, w.lat, w.lon]),
    );
    // Fresh identity — an import never overwrites the route it came from.
    expect(back.id).not.toBe(route.id);
    expect(back.rev).toBe(0);
    expect(new Set(back.waypoints.map((w) => w.id)).size).toBe(3);
  });

  test("file name is the route name made safe", () => {
    expect(gpxFileName(route)).toBe("Kiel _ Sønderborg _ _back_ _fast_.gpx");
    expect(gpxFileName({ ...route, name: "  " })).toBe("route.gpx");
  });
});

// Shaped like OpenCPN's export: gpx/opencpn namespaces, <extensions> with
// prefixed children, <sym>/<type>/<time> per point.
const OPENCPN = `<?xml version="1.0"?>
<gpx version="1.1" creator="OpenCPN" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxx="http://www.garmin.com/xmlschemas/GpxExtensions/v3" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd" xmlns:opencpn="http://www.opencpn.org">
  <rte>
    <name>Aarhus - Samsø</name>
    <extensions>
      <opencpn:start>Aarhus</opencpn:start>
      <opencpn:end>Ballen</opencpn:end>
      <opencpn:viz>1</opencpn:viz>
      <opencpn:guid>a1b2c3d4-0000-4000-8000-000000000001</opencpn:guid>
    </extensions>
    <rtept lat="56.150000000" lon="10.233333333">
      <time>2026-06-01T08:00:00Z</time>
      <name>001</name>
      <sym>diamond</sym>
      <type>WPT</type>
      <extensions>
        <opencpn:guid>a1b2c3d4-0000-4000-8000-000000000002</opencpn:guid>
        <opencpn:viz>1</opencpn:viz>
      </extensions>
    </rtept>
    <rtept lat="56.033333333" lon="10.350000000">
      <name>002</name>
      <sym>diamond</sym>
    </rtept>
    <rtept lat="55.816666667" lon="10.633333333">
      <name>Ballen &amp; havn</name>
    </rtept>
  </rte>
</gpx>`;

// Shaped like AvNav's: a gpx: prefix on every element, CDATA names, a track
// and loose waypoints alongside the route.
const AVNAV = `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>
<!-- written by AvNav -->
<gpx:gpx xmlns:gpx="http://www.topografix.com/GPX/1/1" version="1.1" creator="avnav">
  <gpx:wpt lat="54.5" lon="11.1"><gpx:name>Mark</gpx:name></gpx:wpt>
  <gpx:rte>
    <gpx:name><![CDATA[Fehmarn <rund>]]></gpx:name>
    <gpx:rtept lat="54.43" lon="11.19"><gpx:name>Burgtiefe</gpx:name></gpx:rtept>
    <gpx:rtept lat='54.50' lon='11.32'/>
  </gpx:rte>
  <gpx:trk>
    <gpx:trkseg>
      <gpx:trkpt lat="54.0" lon="11.0"><gpx:time>2026-07-14T09:00:00Z</gpx:time></gpx:trkpt>
      <gpx:trkpt lat="54.001" lon="11.0"/>
      <gpx:trkpt lat="54.002" lon="11.0"/>
    </gpx:trkseg>
    <gpx:trkseg>
      <gpx:trkpt lat="54.002" lon="11.01"/>
    </gpx:trkseg>
  </gpx:trk>
</gpx:gpx>`;

describe("importGpx", () => {
  test("OpenCPN-style: namespaces and extensions ignored, names kept", () => {
    const r = ok(imp(OPENCPN));
    expect(r.routes).toHaveLength(1);
    const rt = r.routes[0]!;
    expect(rt.name).toBe("Aarhus - Samsø");
    expect(rt.waypoints.map((w) => w.name)).toEqual(["001", "002", "Ballen & havn"]);
    expect(rt.waypoints[0]).toMatchObject({ lat: 56.15, lon: 10.233333333 });
    expect(r.skipped).toEqual([]);
  });

  test("AvNav-style: prefixed elements, CDATA, route + track + loose wpts", () => {
    const r = ok(imp(AVNAV));
    expect(r.routes.map((x) => x.name)).toEqual(["Fehmarn <rund>", "Track 2026-07-14"]);
    expect(r.routes[0]!.waypoints.map((w) => [w.name, w.lat, w.lon])).toEqual([
      ["Burgtiefe", 54.43, 11.19],
      ["", 54.5, 11.32],
    ]);
    // Track segments joined; the straight run north collapses to its ends.
    expect(r.routes[1]!.waypoints.map((w) => [w.lat, w.lon])).toEqual([
      [54.0, 11.0],
      [54.002, 11.0],
      [54.002, 11.01],
    ]);
    expect(r.looseWaypoints).toBe(1);
    expect(r.notes).toHaveLength(1);
    expect(importSummary(r)).toBe("2 routes · 1 loose waypoint ignored");
  });

  test("a long track is simplified under the budget", () => {
    const pts = Array.from(
      { length: 3000 },
      (_, i) => `<trkpt lat="${(55 + Math.sin(i / 20) * 0.02).toFixed(6)}" lon="${(10 + i * 0.0005).toFixed(6)}"/>`,
    ).join("");
    const r = ok(imp(`<gpx xmlns="http://www.topografix.com/GPX/1/1"><trk><name>Long</name><trkseg>${pts}</trkseg></trk></gpx>`));
    expect(r.routes[0]!.name).toBe("Long");
    const n = r.routes[0]!.waypoints.length;
    expect(n).toBeGreaterThan(10);
    expect(n).toBeLessThanOrEqual(200);
  });

  test("a route over 500 waypoints is refused, not truncated", () => {
    const pts = Array.from({ length: 501 }, (_, i) => `<rtept lat="55" lon="${(10 + i * 0.01).toFixed(2)}"/>`).join("");
    const r = ok(imp(`<gpx><rte><name>Huge</name>${pts}</rte><rte><rtept lat="1" lon="2"/></rte></gpx>`, "x.gpx"));
    expect(r.routes).toHaveLength(1);
    expect(r.routes[0]!.name).toBe("x");
    expect(r.skipped).toEqual(["“Huge”: 501 waypoints — at most 500 are allowed."]);
  });

  test("a route with an invalid point is refused (no silent dropping)", () => {
    const r = ok(imp(`<gpx><rte><name>Bad</name><rtept lat="55" lon="10"/><rtept lat="95" lon="10"/><rtept lat="55"/></rte></gpx>`));
    expect(r.routes).toHaveLength(0);
    expect(r.skipped).toEqual(["“Bad”: waypoint 2 has no valid lat/lon."]);
  });

  test("names are clamped to 64 chars; unnamed routes take the file name", () => {
    const long = "N".repeat(100);
    const r = ok(
      imp(
        `<gpx><rte><name>${long}</name><rtept lat="1" lon="1"><name>${long}</name></rtept></rte><rte><rtept lat="1" lon="1"/></rte><rte><rtept lat="1" lon="1"/></rte></gpx>`,
        "/tmp/My trip.GPX",
      ),
    );
    expect(r.routes[0]!.name).toHaveLength(64);
    expect(r.routes[0]!.waypoints[0]!.name).toHaveLength(64);
    expect(r.routes.slice(1).map((x) => x.name)).toEqual(["My trip", "My trip 2"]);
  });

  test("ids are fresh and store-valid", () => {
    const r = ok(importGpx(OPENCPN, { mintId: () => crypto.randomUUID(), parse: testXmlParse }));
    for (const id of [r.routes[0]!.id, ...r.routes[0]!.waypoints.map((w) => w.id)]) {
      expect(id).toMatch(/^[A-Za-z0-9_:-]{1,64}$/);
    }
  });

  test("malformed input: a clear error, never a throw", () => {
    expect(imp("")).toEqual({ ok: false, error: "This file is not valid XML." });
    expect(imp("<gpx><rte></gpx>")).toEqual({ ok: false, error: "This file is not valid XML." });
    expect(imp("not xml at all")).toEqual({ ok: false, error: "This file is not valid XML." });
    expect(imp('<kml xmlns="http://www.opengis.net/kml/2.2"/>')).toEqual({
      ok: false,
      error: "This file is not GPX (no <gpx> root element).",
    });
    const throwing = importGpx("<gpx/>", {
      mintId: ids(),
      parse: () => {
        throw new Error("boom");
      },
    });
    expect(throwing.ok).toBe(false);
  });

  test("an empty GPX imports nothing", () => {
    const r = ok(imp("<gpx/>"));
    expect(r.routes).toEqual([]);
    expect(importSummary(r)).toBe("0 routes");
  });
});

describe("trackDateName", () => {
  test("ISO time → Track date; junk → null", () => {
    expect(trackDateName("2026-07-14T23:30:00Z")).toBe("Track 2026-07-14");
    expect(trackDateName("yesterday")).toBeNull();
    expect(trackDateName(null)).toBeNull();
  });
});
