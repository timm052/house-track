from app.address import Address, address_key, display, normalise, parse
from app.listing import clean_url, recognise


def key(**parts) -> str:
    return address_key(normalise(Address(**parts)))


def test_same_dwelling_written_differently_gets_one_key():
    a = key(unit="Unit 3", street_number="12", street="Smith St.", suburb="box hill", postcode="3128")
    b = key(unit="3", street_number="12", street="SMITH STREET", suburb="Box Hill", postcode="3128")
    assert a == b == "3 12 smith street box hill 3128"


def test_street_type_only_expanded_in_last_position():
    assert normalise(Address(street="St Kilda Rd")).street == "St Kilda Road"


def test_unit_prefixes_are_stripped():
    for raw in ("Apt 4", "apartment 4", "U4", "4"):
        assert normalise(Address(unit=raw)).unit == "4"


def test_off_the_plan_lot_keys_on_plan_and_lot():
    a = normalise(Address(street="Harvest Rd", suburb="Clyde North", postcode="3978",
                          plan_number="ps 812345", lot_number="23"))
    assert a.plan_number == "PS812345"
    assert address_key(a) == "lot 23 ps812345 harvest road clyde north 3978"
    assert display(a) == "Lot 23 Harvest Road (PS812345), Clyde North 3978"


def test_parse_with_commas():
    a = parse("3/12 Smith St, Box Hill VIC 3128")
    assert (a.unit, a.street_number, a.street, a.suburb, a.postcode) == ("3", "12", "Smith Street", "Box Hill", "3128")


def test_parse_without_commas_splits_at_street_type():
    a = parse("12 Smith Street Box Hill North 3129")
    assert (a.street, a.suburb, a.postcode) == ("Smith Street", "Box Hill North", "3129")


def test_parse_unit_words():
    a = parse("Unit 5, 40 Station Rd, Ringwood 3134")
    assert (a.unit, a.street_number, a.street, a.suburb) == ("5", "40", "Station Road", "Ringwood")


def test_parse_rejects_nonsense():
    assert parse("not an address") is None


def test_listing_urls():
    url = clean_url("https://www.domain.com.au/12-smith-street-box-hill-vic-3128-2019876543?utm_source=x#top")
    assert url == "https://www.domain.com.au/12-smith-street-box-hill-vic-3128-2019876543"
    assert recognise(url) == ("domain", "2019876543")
    assert recognise("https://www.realestate.com.au/property-house-vic-box+hill-143456789") == ("rea", "143456789")
    assert recognise("https://agency.example/listing/1") == ("other", None)
