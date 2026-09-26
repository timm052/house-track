"""Request bodies. Value lists mirror the CHECK constraints in migrations/0001_schema_v1.sql."""

from datetime import date, datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import BaseModel, Field, model_validator

Aud = Annotated[int, Field(gt=0, le=2_000_000_000)]
Count = Annotated[int, Field(ge=0, le=20)]
Colour = Annotated[str, Field(pattern=r"^#[0-9a-f]{6}$")]

PropertyType = Literal["house", "townhouse", "unit", "apartment", "land", "other"]
BuildStatus = Literal["established", "off_the_plan", "under_construction"]
SaleMethod = Literal["auction", "eoi", "private_sale", "other"]
Outcome = Literal["sold_prior", "sold_at_auction", "sold_after_auction", "sold", "passed_in", "withdrawn", "disappeared"]
Status = Literal["watching", "inspecting", "shortlisted", "bidding", "rejected", "lost", "withdrawn", "bought"]
Stage = Literal["pre_inspection", "post_inspection"]
Stance = Literal["yes", "maybe", "no"]
GuideSource = Literal["price_statement", "advertised", "agent_verbal", "other"]
JudgementKind = Literal["estimated_reserve", "expected_sale", "walk_away"]
Portal = Literal["domain", "rea", "agency", "other"]


class PersonIn(BaseModel):
    display_name: Annotated[str, Field(min_length=1, max_length=40)]
    colour: Colour


class PersonPatch(BaseModel):
    display_name: Annotated[str, Field(min_length=1, max_length=40)] | None = None
    colour: Colour | None = None
    active: bool | None = None


class SettingIn(BaseModel):
    value: Any


class AddressIn(BaseModel):
    unit: str | None = None
    street_number: str | None = None
    street: str | None = None
    suburb: Annotated[str, Field(min_length=1)]
    postcode: Annotated[str, Field(pattern=r"^[0-9]{4}$")]
    plan_number: str | None = None
    lot_number: str | None = None

    @model_validator(mode="after")
    def identifiable(self) -> "AddressIn":
        has_street = bool(self.street_number and self.street)
        has_lot = bool(self.plan_number and self.lot_number)
        if not (has_street or has_lot):
            raise ValueError("Give a street number and street, or a plan number and lot number.")
        if bool(self.plan_number) != bool(self.lot_number):
            raise ValueError("Plan number and lot number go together.")
        return self


class CampaignIn(BaseModel):
    sale_method: SaleMethod
    listed_on: date | None = None
    auction_at: datetime | None = None
    eoi_closes_at: datetime | None = None
    continues_campaign_id: UUID | None = None


class QuickCampaignIn(CampaignIn):
    url: str | None = None
    guide_low_aud: Aud | None = None
    guide_high_aud: Aud | None = None


class ListingInspection(BaseModel):
    starts_at: datetime
    ends_at: datetime | None = None


class ListingExtras(BaseModel):
    """What the bookmarklet read from the listing, as ticked on the quick-add form (PLAN.md D12)."""
    lat: float | None = Field(default=None, ge=-45, le=-9)
    lon: float | None = Field(default=None, ge=110, le=155)
    agents: list["AgentIn"] = Field(default_factory=list, max_length=6)
    inspections: list[ListingInspection] = Field(default_factory=list, max_length=12)
    soi_url: Annotated[str, Field(pattern=r"^https?://", max_length=2000)] | None = None
    tags: list[Annotated[str, Field(max_length=40)]] = Field(default_factory=list, max_length=20)
    photos: list[Annotated[str, Field(pattern=r"^https?://", max_length=2000)]] = Field(default_factory=list, max_length=30)
    floorplans: list[Annotated[str, Field(pattern=r"^https?://", max_length=2000)]] = Field(default_factory=list, max_length=5)


class ListingUpdateIn(ListingExtras):
    """Refreshing a tracked house from its listing: the same extras plus the guide as it reads today."""
    guide_low_aud: Aud | None = None
    guide_high_aud: Aud | None = None
    sale_method: SaleMethod | None = None  # listings do switch, e.g. auction to private sale
    auction_at: datetime | None = None
    eoi_closes_at: datetime | None = None
    listed_on: date | None = None
    beds: Count | None = None
    baths: Count | None = None
    car_spaces: Count | None = None
    land_m2: Annotated[int, Field(gt=0)] | None = None
    building_m2: Annotated[int, Field(gt=0)] | None = None
    # Rooms and areas that differ from what's saved: applied when a person asked for the update (the
    # + House Track button), only reported by the unattended weekly refresh.
    apply_details: bool = True
    fill_missing: bool = False  # without apply_details: still fill in rooms and areas we have nothing for
    # What the listing itself says now (sold, under offer, archived) and its price wording, kept on the campaign.
    listing_status: str | None = Field(default=None, max_length=40)
    listing_price_text: str | None = Field(default=None, max_length=300)


class PropertyIn(BaseModel):
    address: AddressIn
    property_type: PropertyType = "house"
    build_status: BuildStatus = "established"
    beds: Count | None = None
    baths: Count | None = None
    car_spaces: Count | None = None
    land_m2: Annotated[int, Field(gt=0)] | None = None
    building_m2: Annotated[int, Field(gt=0)] | None = None
    notes: str | None = None
    campaign: QuickCampaignIn | None = None
    gnaf_pid: str | None = None  # chosen from address autocomplete
    listing: ListingExtras | None = None  # extras from a listing capture


class PropertyPatch(BaseModel):
    address: AddressIn | None = None
    property_type: PropertyType | None = None
    build_status: BuildStatus | None = None
    beds: Count | None = None
    baths: Count | None = None
    car_spaces: Count | None = None
    land_m2: Annotated[int, Field(gt=0)] | None = None
    building_m2: Annotated[int, Field(gt=0)] | None = None
    owners_corp_fees_aud_pa: Annotated[int, Field(ge=0)] | None = None
    council_rates_aud_pa: Annotated[int, Field(ge=0)] | None = None
    notes: str | None = None
    # The values the person saw when they started editing, for the fields they changed: if any of them has
    # changed since, the save is refused (409) instead of silently undoing someone else's edit.
    expected: dict[str, Any] | None = None


class CampaignPatch(BaseModel):
    sale_method: SaleMethod | None = None
    listed_on: date | None = None
    auction_at: datetime | None = None
    eoi_closes_at: datetime | None = None
    outcome: Outcome | None = None
    outcome_on: date | None = None
    sold_price_aud: Aud | None = None
    passed_in_bid_aud: Aud | None = None
    bought_by_us: bool | None = None


class LinkIn(BaseModel):
    url: Annotated[str, Field(pattern=r"^https?://")]
    portal: Portal | None = None


class PriceGuideIn(BaseModel):
    source: GuideSource
    low_aud: Aud
    high_aud: Aud | None = None
    statement_suburb_median_aud: Aud | None = None
    observed_at: datetime | None = None
    note: str | None = None


class JudgementIn(BaseModel):
    kind: JudgementKind
    amount_aud: Aud
    note: str | None = None


class AgentIn(BaseModel):
    name: Annotated[str, Field(min_length=1)]
    agency_name: str | None = None
    office: str | None = None
    mobile: str | None = None
    email: str | None = None
    is_lead: bool = True


class OpinionIn(BaseModel):
    id: UUID | None = None  # client-generated so queued offline writes replay idempotently
    person_id: UUID | None = None  # whose opinion; defaults to the acting person
    stage: Stage
    stance: Stance
    note: str | None = None
    recorded_at: datetime | None = None
    campaign_id: UUID | None = None
    # Conflict check (D17): the latest entry the client saw; check_latest with no id means "there was none".
    expected_latest_id: UUID | None = None
    check_latest: bool = False


class StatusIn(BaseModel):
    status: Status
    reason: str | None = None
    check_latest: bool = False  # refuse if the status changed since expected_latest_id (the latest the person saw)
    expected_latest_id: UUID | None = None


# ─── geography (milestone 2) ──────────────────────────────────────────
Lon = Annotated[float, Field(ge=-180, le=180)]
Lat = Annotated[float, Field(ge=-90, le=90)]
AreaKind = Literal["hard_exclude", "soft_warn"]


class PointIn(BaseModel):
    lon: Lon
    lat: Lat


class PolygonGeometry(BaseModel):
    type: Literal["Polygon", "MultiPolygon"]
    coordinates: list[Any] = Field(min_length=1)


class AreaIn(BaseModel):
    name: Annotated[str, Field(min_length=1, max_length=80)]
    kind: AreaKind
    reason: str | None = None
    geometry: PolygonGeometry
    owner_id: UUID | None = None  # defaults to the person drawing it


class AreaPatch(BaseModel):
    name: Annotated[str, Field(min_length=1, max_length=80)] | None = None
    kind: AreaKind | None = None
    reason: str | None = None
    geometry: PolygonGeometry | None = None
    owner_id: UUID | None = None


TravelMode = Literal["walk", "drive", "transit"]


class PlaceIn(BaseModel):
    kind: Literal["station", "destination"]
    modes: list[TravelMode] | None = None  # destinations: which to work out (default all three)
    station_osm_id: int | None = None
    name: Annotated[str, Field(min_length=1, max_length=80)] | None = None
    location: PointIn | None = None
    person_id: UUID | None = None

    @model_validator(mode="after")
    def complete(self) -> "PlaceIn":
        if self.kind == "station" and self.station_osm_id is None:
            raise ValueError("Pick a station from the list.")
        if self.kind == "destination" and (self.name is None or self.location is None):
            raise ValueError("A destination needs a name and a location.")
        return self


class PlacePatch(BaseModel):
    modes: list[TravelMode] | None = None
    name: Annotated[str, Field(min_length=1, max_length=80)] | None = None
    location: PointIn | None = None
    person_id: UUID | None = None


ListingExtras.model_rebuild()
ListingUpdateIn.model_rebuild()
