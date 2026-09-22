"""A miniature G-NAF release: same folder layout, file names and column names as the real zip,
with a handful of Victorian addresses."""

import zipfile
from pathlib import Path

ROOT = "G-NAF/G-NAF FEBRUARY 2026/Standard"

ADDRESS_DETAIL_COLS = (
    "ADDRESS_DETAIL_PID|DATE_CREATED|DATE_LAST_MODIFIED|DATE_RETIRED|BUILDING_NAME|LOT_NUMBER_PREFIX|LOT_NUMBER|"
    "LOT_NUMBER_SUFFIX|FLAT_TYPE_CODE|FLAT_NUMBER_PREFIX|FLAT_NUMBER|FLAT_NUMBER_SUFFIX|LEVEL_TYPE_CODE|"
    "LEVEL_NUMBER_PREFIX|LEVEL_NUMBER|LEVEL_NUMBER_SUFFIX|NUMBER_FIRST_PREFIX|NUMBER_FIRST|NUMBER_FIRST_SUFFIX|"
    "NUMBER_LAST_PREFIX|NUMBER_LAST|NUMBER_LAST_SUFFIX|STREET_LOCALITY_PID|LOCATION_DESCRIPTION|LOCALITY_PID|"
    "ALIAS_PRINCIPAL|POSTCODE|PRIVATE_STREET|LEGAL_PARCEL_ID|CONFIDENCE|ADDRESS_SITE_PID|LEVEL_GEOCODED_CODE|"
    "PROPERTY_PID|GNAF_PROPERTY_PID|PRIMARY_SECONDARY"
)


def detail(pid, *, flat="", number="", number_last="", lot="", parcel="", street, locality, postcode,
           retired="", alias="P"):
    cols = ADDRESS_DETAIL_COLS.split("|")
    values = dict.fromkeys(cols, "")
    values.update(ADDRESS_DETAIL_PID=pid, DATE_CREATED="2020-01-01", DATE_RETIRED=retired, LOT_NUMBER=lot,
                  FLAT_TYPE_CODE="UNIT" if flat else "", FLAT_NUMBER=flat, NUMBER_FIRST=number,
                  NUMBER_LAST=number_last, STREET_LOCALITY_PID=street, LOCALITY_PID=locality,
                  ALIAS_PRINCIPAL=alias, POSTCODE=postcode, LEGAL_PARCEL_ID=parcel, CONFIDENCE="2")
    return "|".join(values[c] for c in cols)


FILES = {
    "VIC_ADDRESS_DETAIL_psv.psv": [
        ADDRESS_DETAIL_COLS,
        detail("GAVIC0001", number="12", street="VIC_SL1", locality="VIC_L1", postcode="3128"),
        detail("GAVIC0002", flat="3", number="12", street="VIC_SL1", locality="VIC_L1", postcode="3128"),
        detail("GAVIC0003", lot="23", parcel="23\\PS812345", street="VIC_SL2", locality="VIC_L2", postcode="3978"),
        detail("GAVIC0004", number="14", number_last="16", street="VIC_SL1", locality="VIC_L1", postcode="3128"),
        detail("GAVIC0005", number="99", street="VIC_SL1", locality="VIC_L1", postcode="3128", retired="2024-01-01"),
    ],
    "VIC_ADDRESS_DEFAULT_GEOCODE_psv.psv": [
        "ADDRESS_DEFAULT_GEOCODE_PID|DATE_CREATED|DATE_RETIRED|ADDRESS_DETAIL_PID|GEOCODE_TYPE_CODE|LONGITUDE|LATITUDE",
        "1|2020-01-01||GAVIC0001|PC|145.1201|-37.8201",
        "2|2020-01-01||GAVIC0002|BC|145.1202|-37.8202",
        "3|2020-01-01||GAVIC0003|PC|145.3301|-38.0901",
        "4|2020-01-01||GAVIC0004|STL|145.1210|-37.8210",
        "5|2020-01-01||GAVIC0005|PC|145.1299|-37.8299",
    ],
    "VIC_STREET_LOCALITY_psv.psv": [
        "STREET_LOCALITY_PID|DATE_CREATED|DATE_RETIRED|STREET_CLASS_CODE|STREET_NAME|STREET_TYPE_CODE|"
        "STREET_SUFFIX_CODE|LOCALITY_PID|GNAF_STREET_PID|GNAF_STREET_CONFIDENCE|GNAF_RELIABILITY_CODE",
        "VIC_SL1|2020-01-01||C|SMITH|STREET||VIC_L1|1|2|4",
        "VIC_SL2|2020-01-01||C|HARVEST|ROAD||VIC_L2|2|2|4",
    ],
    "VIC_LOCALITY_psv.psv": [
        "LOCALITY_PID|DATE_CREATED|DATE_RETIRED|LOCALITY_NAME|PRIMARY_POSTCODE|LOCALITY_CLASS_CODE|STATE_PID|"
        "GNAF_LOCALITY_PID|GNAF_RELIABILITY_CODE",
        "VIC_L1|2020-01-01||BOX HILL|3128|G|2|1|5",
        "VIC_L2|2020-01-01||CLYDE NORTH|3978|G|2|2|5",
    ],
}


def build_zip(directory: Path) -> Path:
    path = directory / "g-naf_feb26_allstates_gda2020_psv_1022.zip"
    with zipfile.ZipFile(path, "w") as zf:
        for name, lines in FILES.items():
            zf.writestr(f"{ROOT}/{name}", "\n".join(lines) + "\n")
        zf.writestr(f"{ROOT}/NSW_LOCALITY_psv.psv", "LOCALITY_PID\n")  # other states are ignored
    return path
