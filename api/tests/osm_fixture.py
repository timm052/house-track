"""A synthetic OpenStreetMap street grid with two stations, for testing the OSM setup step and
Valhalla without downloading a real extract. `python -m tests.osm_fixture out.osm`"""

import sys

ORIGIN = (145.110, -37.830)  # south-west corner, near Box Hill
STEP = 0.002  # about 180 m
SIZE = 12


def build() -> str:
    lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<osm version="0.6" generator="housetrack-fixture">']
    nid = lambda i, j: 1 + i * SIZE + j  # noqa: E731
    for i in range(SIZE):
        for j in range(SIZE):
            lon, lat = ORIGIN[0] + j * STEP, ORIGIN[1] + i * STEP
            lines.append(f'<node id="{nid(i, j)}" version="1" lat="{lat:.6f}" lon="{lon:.6f}"/>')
    stations = [(9001, "Grid North", 3, 8), (9002, "Grid South", 10, 1)]
    for osm_id, name, i, j in stations:
        lon, lat = ORIGIN[0] + j * STEP, ORIGIN[1] + i * STEP
        lines.append(f'<node id="{osm_id}" version="1" lat="{lat:.6f}" lon="{lon:.6f}">'
                     f'<tag k="railway" v="station"/><tag k="name" v="{name}"/></node>')
    lines.append('<node id="9003" version="1" lat="-37.81" lon="145.13"><tag k="railway" v="station"/></node>')  # unnamed: skipped
    way = 1
    for i in range(SIZE):  # east-west streets, then north-south
        refs = "".join(f'<nd ref="{nid(i, j)}"/>' for j in range(SIZE))
        lines.append(f'<way id="{way}" version="1">{refs}<tag k="highway" v="residential"/><tag k="name" v="Row {i} Street"/></way>')
        way += 1
    for j in range(SIZE):
        refs = "".join(f'<nd ref="{nid(i, j)}"/>' for i in range(SIZE))
        lines.append(f'<way id="{way}" version="1">{refs}<tag k="highway" v="residential"/><tag k="name" v="Column {j} Road"/></way>')
        way += 1
    lines.append("</osm>")
    return "\n".join(lines)


if __name__ == "__main__":
    open(sys.argv[1], "w", encoding="utf-8").write(build())
