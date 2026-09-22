"""Purchase costs and the highest affordable bid (PLAN.md §5 Should, region pack D9).

Only Victoria is implemented. Rates are the published land transfer duty scales for contracts from
1 July 2023; check them against the State Revenue Office before relying on a figure, and update the
tables here when they change. Off-the-plan and foreign-purchaser rules are not modelled.
"""

from dataclasses import dataclass

# (upper bound, base duty at the lower bound, marginal rate, lower bound). A rate on the whole value is
# expressed with base None.
VIC_GENERAL = [
    (25_000, 0, 0.014, 0),
    (130_000, 350, 0.024, 25_000),
    (960_000, 2_870, 0.06, 130_000),
    (2_000_000, None, 0.055, 0),          # 5.5% of the total value
    (None, 110_000, 0.065, 2_000_000),
]
VIC_PPR = [(550_000, 2_870, 0.05, 130_000)]  # principal place of residence concession band
FHB_EXEMPT, FHB_CONCESSION_TOP = 600_000, 750_000


def _scale(price: int, table) -> float | None:
    for top, base, rate, low in table:
        if top is None or price <= top:
            if base is None:
                return price * rate
            return base + (price - low) * rate
    return None


def vic_duty(price: int, *, principal_residence: bool = True, first_home_buyer: bool = False) -> int:
    general = _scale(price, VIC_GENERAL)
    duty = general
    if principal_residence and 130_000 < price <= 550_000:
        duty = _scale(price, VIC_PPR)
    if first_home_buyer:
        if price <= FHB_EXEMPT:
            duty = 0
        elif price <= FHB_CONCESSION_TOP:
            duty = general * (price - FHB_EXEMPT) / (FHB_CONCESSION_TOP - FHB_EXEMPT)
    return round(duty or 0)


@dataclass
class CostSettings:
    cash_aud: int = 0                 # deposit and savings available for the purchase
    loan_preapproval_aud: int = 0
    loan_expiry: str | None = None
    first_home_buyer: bool = False
    principal_residence: bool = True
    conveyancing_aud: int = 2_000
    inspections_aud: int = 800
    other_aud: int = 3_000            # transfer and mortgage registration fees, moving, buffer

    @property
    def fixed(self) -> int:
        return self.conveyancing_aud + self.inspections_aud + self.other_aud

    @property
    def budget(self) -> int:
        return self.cash_aud + self.loan_preapproval_aud


def breakdown(price: int, s: CostSettings) -> dict:
    duty = vic_duty(price, principal_residence=s.principal_residence, first_home_buyer=s.first_home_buyer)
    total = price + duty + s.fixed
    return {"price": price, "duty": duty, "conveyancing": s.conveyancing_aud, "inspections": s.inspections_aud,
            "other": s.other_aud, "total": total, "budget": s.budget, "headroom": s.budget - total}


def max_bid(s: CostSettings) -> int:
    """Highest price (to the nearest $1,000) whose total cost fits the budget. Duty jumps at band edges,
    so this searches rather than inverting the formula."""
    lo, hi = 0, max(s.budget, 0)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if breakdown(mid, s)["total"] <= s.budget:
            lo = mid
        else:
            hi = mid - 1
    return lo // 1000 * 1000
